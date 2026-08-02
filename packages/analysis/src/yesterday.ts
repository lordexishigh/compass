import {
  orderedEvidence,
  pullRequestEvidence,
  pullRequestLabel,
  releaseEvidence,
  ticketEvidence,
  type EvidenceRef,
} from './evidence.js';
import { compareNumbers, compareStable, windowContains, type Instant } from './instant.js';
import { entityRef, stableItemId } from './identity.js';
import {
  assessLadder,
  indexArtifactsByTicket,
  type CommitGraph,
  type LadderResult,
  type WorkUnitArtifacts,
} from './ladder.js';
import {
  DONE_STATUS_CATEGORY,
  entitiesOfKind,
  instantField,
  projectInScope,
  repositoryInScope,
  scopedReleaseTags,
  textField,
  textListField,
  type AnalysisEntity,
  type AnalysisSnapshot,
  type ResolvedScope,
} from './snapshot.js';

/**
 * Yesterday: what actually finished inside the report window.
 *
 * This is the section a manager reads first and the one they will check against
 * their own memory, so its definition is narrow and written down rather than
 * inferred from whatever the data happened to contain.
 *
 * Three things qualify, and only these three:
 *
 *  1. **A tracker transition into a done-category status** — and specifically a
 *     transition *into* done from something that was not done. A ticket that was
 *     already done and got touched again did not finish yesterday.
 *  2. **A pull request merge.** The merge instant, not the close instant: a
 *     closed-unmerged pull request is abandoned work, not completed work, and
 *     reporting it as a win would be the report lying to make the day look
 *     better.
 *  3. **A release or tag being cut.** A release is its own event with its own
 *     audience; it is never folded into a ticket.
 *
 * Everything else is deliberately excluded. A commit is not a completion — it is
 * the beginning of one, and counting pushes as achievements is precisely the
 * telemetry-flavoured measurement this product exists to replace.
 *
 * The window is half-open `[start, end)`, matching @compass/clock and the ingest
 * layer exactly. An event at `window.end` belongs to *tomorrow's* report and
 * appears in exactly one of the two, never both and never neither.
 */
export const QUALIFYING_YESTERDAY_EVENTS = Object.freeze([
  Object.freeze({
    kind: 'ticket_accepted' as const,
    source: 'ticket_status_transition',
    rule: 'toStatusCategory === "done" and fromStatusCategory !== "done", transitionedAt inside [window.start, window.end)',
  }),
  Object.freeze({
    kind: 'pull_request_merged' as const,
    source: 'pull_request',
    rule: 'mergedAt is set and falls inside [window.start, window.end)',
  }),
  Object.freeze({
    kind: 'release_cut' as const,
    source: 'release_tag',
    rule: 'releasedAt falls inside [window.start, window.end)',
  }),
]);

export type YesterdayEventKind = (typeof QUALIFYING_YESTERDAY_EVENTS)[number]['kind'];

/**
 * How two events become one item.
 *
 * The dedup key is the **unit of work**, not the artifact:
 *
 *  - a ticket contributes `ticket:<ITEM-KEY>`;
 *  - a merged pull request contributes `ticket:<ITEM-KEY>` for each work item it
 *    declares, so a merge and its ticket collapse into one line naming both;
 *  - a merged pull request that declares no work item contributes
 *    `pull_request:<naturalKey>` — it is still real work, it just has no tracker
 *    identity to merge into;
 *  - a release contributes `release:<naturalKey>` and never merges into a ticket.
 *
 * The link from pull request to ticket is the one the *forge* declared. Compass
 * never joins a merge to a ticket because the timing lines up or the author
 * matches; a wrong join would put someone's work under someone else's heading and
 * the report would state it as fact.
 *
 * A pull request naming several tickets appears on each ticket's line. That is
 * deliberate: the manager cares that CHK-701 landed, and the fact that it shared
 * a pull request with CHK-702 is visible in both lines' evidence.
 */
export const YESTERDAY_DEDUP_KEY =
  'unit of work: `ticket:<itemKey>` when the tracker or the forge names one, else `pull_request:<naturalKey>`, else `release:<naturalKey>`';

/**
 * The documented stable ordering key.
 *
 * `completedAt` ascending, then unit-of-work key ascending by code unit. Ties are
 * broken by the key rather than left to the sort's stability, so the sequence is
 * identical no matter what order the collections were walked in — which is what
 * makes two runs over one snapshot byte-identical.
 */
export const YESTERDAY_ORDER_KEY = 'completedAt ascending, then unitOfWork (which begins with the ticket key) ascending';

export interface YesterdayEvent {
  readonly kind: YesterdayEventKind;
  readonly at: number;
  /** The artifact the event happened to, spelled as a human would say it. */
  readonly label: string;
}

export interface YesterdayItem {
  /**
   * Derived from the unit of work alone — never from the report, the run or the
   * position in the list. The same completion referenced tomorrow (in an elapsed
   * fact, or by a piece of feedback) resolves to the same id.
   */
  readonly stableId: string;
  readonly unitOfWork: string;
  readonly ticketKey: string | null;
  readonly title: string;
  /**
   * When this unit finished landing: the *latest* qualifying instant inside the
   * window. A ticket marked done at 11:05 whose pull request merged at 18:40
   * finished at 18:40, because until the merge nothing had changed for anyone
   * else.
   */
  readonly completedAt: number;
  readonly events: readonly YesterdayEvent[];
  /** Every artifact named on this line: ticket key, pull request number, tag. */
  readonly artifacts: readonly EvidenceRef[];
  readonly ladder: LadderResult;
  readonly assigneeDeveloperKey: string | null;
}

interface Accumulator {
  unitOfWork: string;
  ticketKey: string | null;
  title: string;
  completedAt: number;
  events: YesterdayEvent[];
  artifacts: EvidenceRef[];
  ticket: AnalysisEntity | null;
  pullRequests: AnalysisEntity[];
  releaseTags: AnalysisEntity[];
  doneAt: Instant | null;
  assigneeDeveloperKey: string | null;
}

export interface YesterdayOptions {
  readonly deploySignalAvailable: boolean;
  /**
   * The parent-edge graph the R3 and R4 detectors walk.
   *
   * Built once per report by the caller rather than per item: a report over the
   * seeded organization holds a few thousand commits, and rebuilding the index for
   * each of forty Yesterday lines turned a millisecond of work into a second of it.
   */
  readonly graph: CommitGraph;
}

/**
 * The Yesterday items for one report window.
 *
 * Takes `instant` explicitly even though the window does most of the work: the
 * completion ladder's higher rungs depend on releases that may be cut after the
 * window closes but before the report is generated, and "was this released yet"
 * is a question about *now*.
 */
export function detectYesterdayItems(
  snapshot: AnalysisSnapshot,
  instant: Instant,
  scope: ResolvedScope,
  options: YesterdayOptions,
): readonly YesterdayItem[] {
  const window = snapshot.window;
  const artifactsByTicket = indexArtifactsByTicket(snapshot);
  const ticketsByItemKey = new Map<string, AnalysisEntity>();
  for (const ticket of entitiesOfKind(snapshot, 'ticket')) {
    ticketsByItemKey.set(textField(ticket, 'itemKey') ?? ticket.naturalKey, ticket);
  }

  const units = new Map<string, Accumulator>();

  const unitFor = (unitOfWork: string, ticketKey: string | null): Accumulator => {
    const existing = units.get(unitOfWork);
    if (existing !== undefined) return existing;

    const ticket = ticketKey === null ? null : (ticketsByItemKey.get(ticketKey) ?? null);
    const linked: WorkUnitArtifacts | undefined = ticketKey === null ? undefined : artifactsByTicket.get(ticketKey);
    const created: Accumulator = {
      unitOfWork,
      ticketKey,
      title: ticket === null ? '' : (textField(ticket, 'title') ?? ''),
      completedAt: 0,
      events: [],
      artifacts: ticket === null ? [] : [ticketEvidence(ticket)],
      ticket,
      pullRequests: [...(linked?.pullRequests ?? [])],
      releaseTags: [],
      doneAt: null,
      assigneeDeveloperKey: ticket === null ? null : textField(ticket, 'assigneeDeveloperKey'),
    };
    units.set(unitOfWork, created);
    return created;
  };

  const record = (unit: Accumulator, event: YesterdayEvent): void => {
    unit.events.push(event);
    if (event.at > unit.completedAt) unit.completedAt = event.at;
  };

  // ---- 1. tracker transitions into done -----------------------------------
  for (const transition of snapshot.collections.ticketTransitions) {
    if (transition.toStatusCategory !== DONE_STATUS_CATEGORY) continue;
    if (transition.fromStatusCategory === DONE_STATUS_CATEGORY) continue;
    if (!windowContains(window, transition.transitionedAt as Instant)) continue;

    const ticket = ticketsByItemKey.get(transition.ticketKey);
    if (ticket === undefined) continue;
    if (!projectInScope(scope, textField(ticket, 'projectKey'))) continue;

    const unit = unitFor(`ticket:${transition.ticketKey}`, transition.ticketKey);
    unit.doneAt = transition.transitionedAt as Instant;
    record(unit, { kind: 'ticket_accepted', at: transition.transitionedAt, label: transition.ticketKey });
  }

  // ---- 2. pull request merges ---------------------------------------------
  for (const pullRequest of entitiesOfKind(snapshot, 'pull_request')) {
    const mergedAt = instantField(pullRequest, 'mergedAt');
    if (mergedAt === null || !windowContains(window, mergedAt)) continue;
    if (!repositoryInScope(scope, textField(pullRequest, 'repositoryKey'))) continue;

    const linkedKeys = textListField(pullRequest, 'linkedItemKeys').filter((key) => {
      const ticket = ticketsByItemKey.get(key);
      return ticket !== undefined && projectInScope(scope, textField(ticket, 'projectKey'));
    });

    const targets: readonly string[] =
      linkedKeys.length > 0 ? linkedKeys : [`pull_request:${pullRequest.naturalKey}`];

    for (const target of targets) {
      const isTicket = !target.startsWith('pull_request:');
      const unit = unitFor(isTicket ? `ticket:${target}` : target, isTicket ? target : null);

      if (!isTicket) {
        unit.title = textField(pullRequest, 'title') ?? '';
        unit.assigneeDeveloperKey = textField(pullRequest, 'authorDeveloperKey');
      }
      if (!unit.pullRequests.some((candidate) => candidate.naturalKey === pullRequest.naturalKey)) {
        unit.pullRequests.push(pullRequest);
      }
      unit.artifacts.push(pullRequestEvidence(pullRequest));
      record(unit, { kind: 'pull_request_merged', at: mergedAt, label: pullRequestLabel(pullRequest) });
    }
  }

  // ---- 3. releases --------------------------------------------------------
  for (const tag of scopedReleaseTags(snapshot, scope)) {
    const releasedAt = instantField(tag, 'releasedAt');
    if (releasedAt === null || !windowContains(window, releasedAt)) continue;

    const unit = unitFor(`release:${tag.naturalKey}`, null);
    unit.title = textField(tag, 'description') ?? (textField(tag, 'name') ?? '');
    unit.releaseTags.push(tag);
    unit.artifacts.push(releaseEvidence(tag));
    record(unit, { kind: 'release_cut', at: releasedAt, label: textField(tag, 'name') ?? tag.naturalKey });
  }

  // Every release in the repository is offered to the ladder, not only the ones
  // cut inside the window: "was this merge released?" is answered by the newest
  // tag, which is usually newer than the window.
  const allTags = scopedReleaseTags(snapshot, scope);

  return [...units.values()]
    .map((unit) => finalise(snapshot.organizationId, unit, allTags, options))
    .sort(
      (left, right) =>
        compareNumbers(left.completedAt, right.completedAt) || compareStable(left.unitOfWork, right.unitOfWork),
    );
}

function finalise(
  organizationId: string,
  unit: Accumulator,
  allTags: readonly AnalysisEntity[],
  options: YesterdayOptions,
): YesterdayItem {
  const ladder = assessLadder(
    {
      ticket: unit.ticket,
      pullRequests: unit.pullRequests,
      commits: [],
      // Every tag in scope, not only the ones cut inside the window: "is this
      // merge inside a release?" is answered by walking every tag's ancestry, and
      // the tag that contains a Wednesday merge is often cut on the Friday.
      releaseTags: allTags,
      doneAt: unit.doneAt,
    },
    { deploySignalAvailable: options.deploySignalAvailable, graph: options.graph },
  );

  return {
    stableId: stableItemId({
      organizationId,
      entityRef: entityRef('unit_of_work', unit.unitOfWork),
      causeKind: 'completed',
    }),
    unitOfWork: unit.unitOfWork,
    ticketKey: unit.ticketKey,
    title: unit.title,
    completedAt: unit.completedAt,
    events: [...unit.events].sort(
      (left, right) => compareNumbers(left.at, right.at) || compareStable(left.label, right.label),
    ),
    artifacts: orderedEvidence(unit.artifacts),
    ladder,
    assigneeDeveloperKey: unit.assigneeDeveloperKey,
  };
}

/**
 * The one-line headline for a Yesterday item, ending in its rung suffix.
 *
 * Names every artifact involved, because "CHK-701 landed" and "CHK-701 landed
 * via #9201" are different claims and only the second one can be checked. And it
 * always ends `— merged, not yet released` or whatever the ladder actually found,
 * because "landed" on its own is the overloaded word this product exists to stop
 * using: a manager who reads that a ticket landed and then discovers it is sitting
 * unreleased on trunk has been misled by one missing clause.
 *
 * The suffix is appended here, in the pure layer, rather than by each renderer —
 * so `tests/report-invariants.test.ts` can assert that no Yesterday line exists
 * without one, and the web view, the email and the plain-text form cannot
 * disagree about it.
 */
export function yesterdayHeadline(item: YesterdayItem): string {
  return `${yesterdaySubject(item)} — ${item.ladder.rungSuffix}`;
}

/** The headline without its rung suffix: the artifacts and the title. */
export function yesterdaySubject(item: YesterdayItem): string {
  const pullRequests = item.artifacts.filter((reference) => reference.kind === 'pull_request');
  const releases = item.artifacts.filter((reference) => reference.kind === 'release');

  if (item.ticketKey !== null) {
    const via = pullRequests.length === 0 ? '' : ` via ${pullRequests.map((reference) => reference.label).join(' and ')}`;
    const title = item.title.length > 0 ? ` — ${item.title}` : '';
    return `${item.ticketKey}${via}${title}`;
  }
  if (releases.length > 0) {
    return `${releases.map((reference) => reference.label).join(', ')} was cut${item.title.length > 0 ? ` — ${item.title}` : ''}`;
  }
  const label = pullRequests[0]?.label ?? item.unitOfWork;
  return `${label} merged${item.title.length > 0 ? ` — ${item.title}` : ''}`;
}
