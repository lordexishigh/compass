import { unavailableCoverage, worstCoverageStatus } from './coverage.js';
import type { SourceCoverage, SourceHealthEntry, SourceHealthReport } from './coverage.js';
import { sortRecords } from './ordering.js';
import { connectorResult, fetchArtifact } from './port.js';
import type { ConnectorCapabilities, ConnectorPort, ConnectorRequest, ConnectorResult } from './port.js';
import { ARTIFACT_KINDS, ARTIFACT_SOURCE_KIND } from './records.js';
import type {
  ArtifactKind,
  BranchRefRecord,
  CommitRecord,
  ConnectorRecordEnvelope,
  IssueRecord,
  IssueTransitionRecord,
  MessageRecord,
  PullRequestRecord,
  ReleaseTagRecord,
  ReviewRecord,
  SprintRecord,
  SprintScopeChangeRecord,
} from './records.js';

/**
 * Several ports behind one port.
 *
 * ## Why this exists at all
 *
 * A real organization has three sources — a code host, a tracker and named chat channels — and three
 * connectors that answer for them. Everything above the port takes **one** `ConnectorPort`: the ingest
 * entry point, the pipeline, the report. That is deliberate and worth keeping, because a caller that took
 * a *list* would have to decide which member answers which question, and deciding that is exactly the
 * provider knowledge no layer above the port is allowed to have.
 *
 * So the fan-out lives here, below the port, in a class that names no provider. Composing a seeded
 * provider with nothing is the zero-config demo; composing a code host with a tracker and a chat source
 * is a connected organization; and the layers above cannot tell those two apart — which is the whole
 * claim the architecture makes.
 *
 * ## Why it is a `ConnectorPort` itself and not a helper
 *
 * Because then it is covered by the same conformance suite every provider runs, and
 * `tests/composite.test.ts` runs it. A merge function called from the composition root would be the one
 * piece of connector logic in the system with no contract test — and the properties it can break are
 * precisely the subtle ones: canonical ordering across two merged result sets, and a `complete` status
 * derived from coverage that came from two places.
 *
 * ## The one rule that carries the honesty
 *
 * An artifact is asked **only of the members that claim it**. That is not an optimisation. If a
 * composite asked all three members for `commits`, the tracker and the chat source would each answer
 * with a truthful `capability_absent` coverage record, `worstStatus` would read the merged coverage as
 * degraded, and every report would state that its commits were incomplete when they were not. The
 * freshness line would be permanently, confidently wrong. So the routing is by declared capability, and
 * when *nothing* claims an artifact the composite says `capability_absent` in its own voice rather than
 * returning a bare empty list.
 */

/**
 * Sources ordered by key, by UTF-16 code unit and never `localeCompare`.
 *
 * The same rule `compareRecords` states for records, for the same reason: two deployments composing the
 * same members must describe themselves identically, and a locale-sensitive comparison would make that
 * depend on the machine.
 */
const bySourceKey = (left: { readonly sourceKey: string }, right: { readonly sourceKey: string }): number =>
  left.sourceKey === right.sourceKey ? 0 : left.sourceKey < right.sourceKey ? -1 : 1;

export interface CompositeConnectorConfig {
  /**
   * The id the ingest journal records for a run.
   *
   * Passed in rather than derived, because it is what `ingestRunRowId` keys a run on: a value that
   * changed shape when a manager connected a third source would make yesterday's run and today's
   * unrelatable, and the archive's continuity is the product.
   */
  readonly connectorId: string;
  readonly members: readonly ConnectorPort[];
}

export class EmptyCompositionError extends Error {
  constructor() {
    super(
      'A composite connector was built with no members. That is refused rather than treated as "an ' +
        'organization with no sources": a port that answers every question with an empty list is ' +
        'indistinguishable from one whose sources are all down, and the report would state a quiet day ' +
        'rather than an unconfigured deployment. Compose the seeded provider instead — that is what the ' +
        'zero-config demo is.',
    );
    this.name = 'EmptyCompositionError';
  }
}

export class CompositeConnector implements ConnectorPort {
  readonly connectorId: string;
  readonly #members: readonly ConnectorPort[];

  constructor(config: CompositeConnectorConfig) {
    if (config.members.length === 0) throw new EmptyCompositionError();
    this.connectorId = config.connectorId;
    this.#members = [...config.members];
  }

  /**
   * The union of what the members can do.
   *
   * `deploySignal` is an OR because one source saying it has deploy signal is enough for R5 to be
   * reachable. `chatScope` is `opted_in_conversations` when any member reads chat, because that is the
   * strongest claim the composite is entitled to make and the weaker one would misdescribe it.
   */
  capabilities(): ConnectorCapabilities {
    const memberCapabilities = this.#members.map((member) => member.capabilities());

    const artifacts = Object.fromEntries(
      ARTIFACT_KINDS.map((artifact) => [
        artifact,
        memberCapabilities.some((capability) => capability.artifacts[artifact]),
      ]),
    ) as Record<ArtifactKind, boolean>;

    const sources = memberCapabilities
      .flatMap((capability) => capability.sources)
      // Sorted so two composites built from the same members in a different order describe themselves
      // identically — the contract asserts capabilities are stable, and a caller comparing two
      // deployments should not see a difference that is only assembly order.
      .sort(bySourceKey);

    return {
      connectorId: this.connectorId,
      artifacts,
      deploySignal: memberCapabilities.some((capability) => capability.deploySignal),
      chatScope: memberCapabilities.some((capability) => capability.chatScope === 'opted_in_conversations')
        ? 'opted_in_conversations'
        : 'none',
      sources,
    };
  }

  /**
   * One artifact, asked of the members that claim it, merged back into one result.
   *
   * The records are re-sorted across the merged set rather than concatenated: each member returns its
   * own canonically-ordered list, and two ordered lists appended are not ordered. The contract asserts
   * canonical order on the result, so this is the line that keeps the composite conformant.
   */
  async #answer<TRecord>(artifact: ArtifactKind, request: ConnectorRequest): Promise<ConnectorResult<TRecord>> {
    const claiming = this.#members.filter((member) => member.capabilities().artifacts[artifact]);

    if (claiming.length === 0) {
      // Nothing here can answer. Said in the composite's own voice, as an absent *capability* — not as
      // "not configured", because the organization may well have sources; none of them serves this
      // family. The distinction is what the report reads to choose its sentence.
      const sourceKind = ARTIFACT_SOURCE_KIND[artifact];
      return connectorResult(artifact, request.window, [], [
        unavailableCoverage({
          sourceKey: `no-${sourceKind}-source`,
          sourceKind,
          artifact,
          requestedWindow: request.window,
          observedAt: request.now,
          reason: 'capability_absent',
          detail:
            `no-${sourceKind}-source: no connected source can answer for ${artifact.replace(/_/g, ' ')}, so ` +
            'Compass has stated that rather than reporting an empty day.',
        }),
      ]);
    }

    const results = await Promise.all(
      claiming.map(async (member) => await fetchArtifact(member, artifact, request)),
    );

    const records = sortRecords(
      results.flatMap((result) => result.records) as readonly ConnectorRecordEnvelope[],
    ) as readonly TRecord[];
    const coverage: readonly SourceCoverage[] = results.flatMap((result) => result.coverage);

    return connectorResult(artifact, request.window, records, coverage);
  }

  async fetchCommits(request: ConnectorRequest): Promise<ConnectorResult<CommitRecord>> {
    return await this.#answer('commits', request);
  }

  async fetchPullRequests(request: ConnectorRequest): Promise<ConnectorResult<PullRequestRecord>> {
    return await this.#answer('pull_requests', request);
  }

  async fetchReviews(request: ConnectorRequest): Promise<ConnectorResult<ReviewRecord>> {
    return await this.#answer('reviews', request);
  }

  async fetchBranchRefs(request: ConnectorRequest): Promise<ConnectorResult<BranchRefRecord>> {
    return await this.#answer('branch_refs', request);
  }

  async fetchReleaseTags(request: ConnectorRequest): Promise<ConnectorResult<ReleaseTagRecord>> {
    return await this.#answer('release_tags', request);
  }

  async fetchIssues(request: ConnectorRequest): Promise<ConnectorResult<IssueRecord>> {
    return await this.#answer('issues', request);
  }

  async fetchIssueTransitions(request: ConnectorRequest): Promise<ConnectorResult<IssueTransitionRecord>> {
    return await this.#answer('issue_transitions', request);
  }

  async fetchSprints(request: ConnectorRequest): Promise<ConnectorResult<SprintRecord>> {
    return await this.#answer('sprints', request);
  }

  async fetchSprintScopeChanges(request: ConnectorRequest): Promise<ConnectorResult<SprintScopeChangeRecord>> {
    return await this.#answer('sprint_scope_changes', request);
  }

  async fetchMessages(request: ConnectorRequest): Promise<ConnectorResult<MessageRecord>> {
    return await this.#answer('messages', request);
  }

  /**
   * Every member's health, in one report.
   *
   * `overall` is the worst status across all of them, which is the only honest reduction: a report built
   * from a healthy code host and a throttled tracker is not a complete picture, and a panel that showed
   * "complete" because two of three answered would be the confident-polish failure this product refuses.
   */
  async reportSourceHealth(request: ConnectorRequest): Promise<SourceHealthReport> {
    const reports = await Promise.all(this.#members.map(async (member) => await member.reportSourceHealth(request)));

    // A fresh mutable array on purpose: `SourceHealthReport.sources` is inferred from a zod schema, so it
    // is a mutable `SourceHealthEntry[]` and a `readonly` local would not assign to it.
    const sources: SourceHealthEntry[] = reports.flatMap((report) => report.sources).sort(bySourceKey);

    return {
      connectorId: this.connectorId,
      window: request.window,
      observedAt: request.now,
      overall: worstCoverageStatus(sources.map((source) => source.status)),
      sources,
    };
  }
}
