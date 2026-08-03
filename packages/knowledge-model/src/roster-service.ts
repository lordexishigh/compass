import type { Instant } from '@compass/clock';

import { identityNaturalKey, normalizeIdentityValue, type IdentityKind } from './identity.js';
import type { KnowledgeStore, StoredEntity } from './store.js';

/**
 * The roster service: the one write path for everything a manager configures.
 *
 * Every function here appends through `KnowledgeStore.observe`, which is the shared
 * effective-dated helper the whole model already uses — a tracked field moving appends a
 * row to `entity_versions` and never rewrites one. There is deliberately **no update**
 * anywhere in this file and no `db.update()` reachable from it, because the acceptance
 * criterion "a report generated for a past instant resolves team membership and tracked
 * repos as they were effective at that instant" is only true for as long as that holds.
 * Removing a team member sets `active` to false at an instant; it does not erase the row
 * that says they were on the team when the work happened.
 *
 * ## Why this is a service and not four repositories
 *
 * Absence has a documented single-writer rule: `alpha-configuration-and-identity-roster-004`
 * requires that absences are created *only* through the roster API, because a Manager Memo
 * can also state one and two independent writers would mean two shapes of Absence row and
 * a suppression rule that worked for one of them. So the memo path calls
 * `recordAbsence` here rather than reaching for the store itself, and
 * `tools/quality-gates` asserts that this module is the only caller that observes an
 * `absence`.
 *
 * ## Instants
 *
 * Nothing here reads a clock. `at` is the instant the manager acted, resolved at the
 * process edge and threaded down, which is what makes a configuration change reproducible
 * and what lets a test place a change *before* a past report and see the report follow it.
 */

// ---------------------------------------------------------------------------
// Teams, membership and the working calendar
// ---------------------------------------------------------------------------

export interface TeamInput {
  readonly key: string;
  readonly name: string;
  readonly methodology: 'scrum' | 'kanban';
  readonly projectKey: string | null;
  readonly objectiveKey: string | null;
  readonly conversationKey: string | null;
  readonly timezone: string;
}

export interface ConfigurationWrite {
  readonly naturalKey: string;
  /** `created`, `changed` or `unchanged` — an unchanged write appends nothing. */
  readonly outcome: string;
  readonly version: number;
}

export async function upsertTeam(
  store: KnowledgeStore,
  input: TeamInput,
  at: Instant,
): Promise<ConfigurationWrite> {
  const result = await store.observe({
    kind: 'team',
    naturalKey: input.key,
    fields: {
      name: input.name,
      methodology: input.methodology,
      projectKey: input.projectKey,
      objectiveKey: input.objectiveKey,
      conversationKey: input.conversationKey,
      timezone: input.timezone,
    },
    observedAt: at,
    evidence: null,
  });

  return { naturalKey: result.naturalKey, outcome: result.outcome, version: result.version };
}

/** `<team>:<developer>` — one membership per pair, stable across leaving and rejoining. */
export const teamMembershipKey = (teamKey: string, developerKey: string): string =>
  `${teamKey}:${developerKey}`;

export interface TeamMembershipInput {
  readonly teamKey: string;
  readonly developerKey: string;
  readonly membershipRole?: 'member' | 'lead';
  /** False removes the person from the team. The row stays; it is the evidence. */
  readonly active: boolean;
}

/**
 * Adds or removes a team member.
 *
 * Removal is `active: false` and not a delete, for the reason the whole model is
 * append-only: last Tuesday's report attributed work to this person as a member of this
 * team, and a delete would make that report unexplainable. The membership's own history
 * answers "were they on the team then".
 */
export async function setTeamMembership(
  store: KnowledgeStore,
  input: TeamMembershipInput,
  at: Instant,
): Promise<ConfigurationWrite> {
  const result = await store.observe({
    kind: 'team_membership',
    naturalKey: teamMembershipKey(input.teamKey, input.developerKey),
    fields: {
      teamKey: input.teamKey,
      developerKey: input.developerKey,
      membershipRole: input.membershipRole ?? 'member',
      active: input.active,
    },
    observedAt: at,
    evidence: null,
  });

  return { naturalKey: result.naturalKey, outcome: result.outcome, version: result.version };
}

/** ISO weekday numbers: 1 = Monday … 7 = Sunday. */
export const ISO_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/** Monday to Friday — what a calendar means before anybody configures one. */
export const DEFAULT_WORKING_WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5];

export class InvalidCalendarError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.name = 'InvalidCalendarError';
    this.detail = detail;
  }
}

export interface WorkingCalendarInput {
  readonly teamKey: string;
  /** ISO weekday numbers. Deduplicated and sorted before it is written. */
  readonly workingWeekdays: readonly number[];
  /** `YYYY-MM-DD` civil dates in `timezone`. Deduplicated and sorted. */
  readonly holidays: readonly string[];
  readonly timezone: string;
}

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Sets a team's working days and holidays.
 *
 * Validated here rather than at the HTTP edge, because the roster API is not the only
 * caller: the boot script provisions a calendar too, and a weekday `9` written by a seed
 * would silently make every working-day count wrong in a way no threshold could reveal.
 *
 * A calendar with no working days is refused. It would make every elapsed measurement
 * zero, so every threshold would read as un-crossed and the product would go quiet
 * without ever saying why — the worst possible failure for a tool whose job is to notice.
 */
export async function setWorkingCalendar(
  store: KnowledgeStore,
  input: WorkingCalendarInput,
  at: Instant,
): Promise<ConfigurationWrite> {
  const weekdays = [...new Set(input.workingWeekdays)].sort((left, right) => left - right);

  for (const day of weekdays) {
    if (!Number.isInteger(day) || day < 1 || day > 7) {
      throw new InvalidCalendarError(
        `\`${day}\` is not an ISO weekday. Use 1 for Monday through 7 for Sunday.`,
      );
    }
  }
  if (weekdays.length === 0) {
    throw new InvalidCalendarError(
      'A working calendar needs at least one working day. With none, every elapsed measurement in the product ' +
        'would be zero working days and no threshold could ever be crossed — Compass would go quiet without saying why.',
    );
  }

  const holidays = [...new Set(input.holidays.map((date) => date.trim()))].filter((date) => date.length > 0).sort();
  for (const date of holidays) {
    if (!CIVIL_DATE.test(date)) {
      throw new InvalidCalendarError(`\`${date}\` is not a \`YYYY-MM-DD\` date.`);
    }
  }

  if (input.timezone.trim().length === 0) {
    throw new InvalidCalendarError('A working calendar needs the zone its holiday dates are dates in.');
  }

  const result = await store.observe({
    kind: 'working_calendar',
    naturalKey: input.teamKey,
    fields: {
      teamKey: input.teamKey,
      workingWeekdays: weekdays,
      holidays,
      timezone: input.timezone.trim(),
    },
    observedAt: at,
    evidence: null,
  });

  return { naturalKey: result.naturalKey, outcome: result.outcome, version: result.version };
}

// ---------------------------------------------------------------------------
// Tracked repositories and projects
// ---------------------------------------------------------------------------

export interface TrackingInput {
  readonly key: string;
  readonly tracked: boolean;
  readonly note?: string | null;
}

/**
 * Tracks or archives a repository.
 *
 * `archivedAt` is written when tracking stops and cleared when it resumes, so the row
 * carries *when* rather than only *whether* — which is the question a manager asks three
 * months later when a repository stopped appearing in reports.
 *
 * Nothing about the repository's own rows changes, and that is the acceptance criterion:
 * prior commits, prior pull requests and every report that cited them are untouched.
 * Only future ingest windows skip it — see `packages/ingest/src/tracking.ts`.
 */
export async function setRepositoryTracking(
  store: KnowledgeStore,
  input: TrackingInput,
  at: Instant,
): Promise<ConfigurationWrite> {
  const result = await store.observe({
    kind: 'tracked_repository',
    naturalKey: input.key,
    fields: {
      repositoryKey: input.key,
      tracked: input.tracked,
      archivedAt: input.tracked ? null : at,
      note: input.note ?? null,
    },
    observedAt: at,
    evidence: null,
  });

  return { naturalKey: result.naturalKey, outcome: result.outcome, version: result.version };
}

export async function setProjectTracking(
  store: KnowledgeStore,
  input: TrackingInput,
  at: Instant,
): Promise<ConfigurationWrite> {
  const result = await store.observe({
    kind: 'tracked_project',
    naturalKey: input.key,
    fields: {
      projectKey: input.key,
      tracked: input.tracked,
      archivedAt: input.tracked ? null : at,
      note: input.note ?? null,
    },
    observedAt: at,
    evidence: null,
  });

  return { naturalKey: result.naturalKey, outcome: result.outcome, version: result.version };
}

// ---------------------------------------------------------------------------
// Developers and identity links
// ---------------------------------------------------------------------------

export interface DeveloperInput {
  readonly key: string;
  readonly displayName: string;
  readonly teamKey: string | null;
  readonly active: boolean;
}

/**
 * The anonymization state already on a Developer row.
 *
 * Read before every ordinary write and carried forward, and that is not defensive
 * plumbing — it is the whole safety of the feature. `developer` is a *declared* entity
 * with a complete tracked field set, so an observation must name every field including
 * `anonymizedAt` and `pseudonym`. A roster edit that named them as null would silently
 * un-anonymise somebody, and `provisionRoster` runs on every boot, so "silently" would
 * mean "every time the container restarts".
 *
 * Exported so `roster.ts` and this module cannot disagree about it.
 */
export async function currentAnonymization(
  store: KnowledgeStore,
  developerKey: string,
): Promise<{ readonly anonymizedAt: Instant | null; readonly pseudonym: string | null }> {
  const prior = await store.read('developer', developerKey);
  if (prior === null) return { anonymizedAt: null, pseudonym: null };

  const anonymizedAt = prior.fields['anonymizedAt'];
  const pseudonym = prior.fields['pseudonym'];

  return {
    anonymizedAt: typeof anonymizedAt === 'number' ? (anonymizedAt as Instant) : null,
    pseudonym: typeof pseudonym === 'string' && pseudonym.length > 0 ? pseudonym : null,
  };
}

export async function upsertDeveloper(
  store: KnowledgeStore,
  input: DeveloperInput,
  at: Instant,
): Promise<ConfigurationWrite> {
  const held = await currentAnonymization(store, input.key);

  const result = await store.observe({
    kind: 'developer',
    naturalKey: input.key,
    fields: {
      displayName: input.displayName,
      teamKey: input.teamKey,
      active: input.active,
      // Carried, never restated. Renaming somebody on the roster screen is not a
      // decision about whether their name appears in reports.
      anonymizedAt: held.anonymizedAt,
      pseudonym: held.pseudonym,
    },
    observedAt: at,
    evidence: null,
  });

  return { naturalKey: result.naturalKey, outcome: result.outcome, version: result.version };
}

export class UnknownDeveloperError extends Error {
  readonly detail: string;

  constructor(developerKey: string) {
    const detail =
      `There is no person with the key \`${developerKey}\` on this roster, so there is nothing to ` +
      'anonymise. Check the roster screen for the exact key — anonymization is keyed on the person, ' +
      'not on a name, precisely so that two people with the same name cannot be confused.';
    super(detail);
    this.name = 'UnknownDeveloperError';
    this.detail = detail;
  }
}

/**
 * Withdraws a person's name from every future report, or puts it back.
 *
 * The write is an ordinary observation, which is the point: it appends an
 * `entity_versions` row like any other change of belief, and that table refuses UPDATE
 * and DELETE in the database itself. So "anonymised on the 3rd" is a fact nothing can
 * quietly remove, and a report regenerated for the 2nd still resolves the real name —
 * because effective-dated resolution reads the version in force at the instant asked
 * about, not today's.
 *
 * The `anonymizations` table and the audit entry are written by the caller at the web
 * edge, which is the layer that knows who is asking. This function is deliberately
 * ignorant of the actor: the knowledge model records what is true, not who said so.
 */
export async function setDeveloperAnonymization(
  store: KnowledgeStore,
  input: {
    readonly developerKey: string;
    /** Null puts the real name back. Non-null is the stand-in to print. */
    readonly pseudonym: string | null;
    readonly at: Instant;
  },
): Promise<ConfigurationWrite> {
  const prior = await store.read('developer', input.developerKey);
  if (prior === null) throw new UnknownDeveloperError(input.developerKey);

  const displayName = prior.fields['displayName'];
  const teamKey = prior.fields['teamKey'];

  const result = await store.observe({
    kind: 'developer',
    naturalKey: input.developerKey,
    fields: {
      // The real name stays on the row. Anonymization is a decision about what Compass
      // *prints*, and deleting the name here would make the act unreversible for the
      // wrong reason — a mistaken erasure request has to be fixable, deliberately.
      displayName: typeof displayName === 'string' ? displayName : input.developerKey,
      teamKey: typeof teamKey === 'string' ? teamKey : null,
      active: prior.fields['active'] === true,
      anonymizedAt: input.pseudonym === null ? null : input.at,
      pseudonym: input.pseudonym,
    },
    observedAt: input.at,
    evidence: null,
  });

  return { naturalKey: result.naturalKey, outcome: result.outcome, version: result.version };
}

export class IdentityClaimedError extends Error {
  readonly detail: string;

  constructor(identityKey: string, heldBy: string) {
    const detail =
      `\`${identityKey}\` is already linked to ${heldBy}. One identifier belongs to at most one person — ` +
      'remove the existing link first if it is wrong, so the change is two deliberate acts rather than a silent ' +
      'reassignment of somebody else’s work.';
    super(detail);
    this.name = 'IdentityClaimedError';
    this.detail = detail;
  }
}

export interface IdentityLinkInput {
  readonly kind: IdentityKind;
  readonly value: string;
  readonly developerKey: string;
  /** `declared` for the roster screen, `merged` when it came from the unmatched queue. */
  readonly origin?: 'declared' | 'merged';
}

/**
 * How many artifacts an attribution change moves, and which they are.
 *
 * Returned by every identity write so the UI can state it — "6 commits and 2 pull
 * requests will be attributed to Priya Raman" — rather than reporting a success with no
 * consequence attached. A number a manager can check is what makes a merge reversible in
 * practice: they see what it did before they have to decide whether it was right.
 */
/**
 * One artifact, identified well enough to be linked to.
 *
 * The `kind` travels with the key because a key alone cannot be turned into a link: the
 * artifact route is `/artifact/<kind>/<id>`, so a bare list of natural keys could only ever
 * be rendered as text. That is exactly what the unmatched queue used to do — the criterion
 * asks for "a sample artifact link" and it had a sample artifact *string*.
 *
 * The href is deliberately **not** built here. `artifactHref` lives in `@compass/pipeline`,
 * which sits above the knowledge model, so this layer names the artifact and the web edge
 * turns it into a path — the same division `view-model.ts` already uses for report evidence.
 */
export interface AttributionArtifactRef {
  /** An `ARTIFACT_ROUTE_KINDS` member, so the web edge can route it. */
  readonly kind: 'commit' | 'pull_request';
  readonly key: string;
}

export interface AttributionImpact {
  readonly identityKey: string;
  readonly commitCount: number;
  readonly pullRequestCount: number;
  readonly totalCount: number;
  /** Up to a few artifacts, for the sample link the queue shows. */
  readonly sampleArtifacts: readonly AttributionArtifactRef[];
}

const SAMPLE_LIMIT = 3;

/**
 * Counts the artifacts an identifier currently accounts for.
 *
 * Reads `authorIdentityKey`, which ingest records whether or not a link matched. That is
 * the only field that answers this question after the fact: `authorDeveloperKey` says who
 * the artifact was attributed to at ingest time, which is exactly what a merge is about to
 * change.
 */
export async function attributionImpact(
  store: KnowledgeStore,
  identityKey: string,
): Promise<AttributionImpact> {
  const [commits, pullRequests] = await Promise.all([store.list('commit'), store.list('pull_request')]);

  const matches = (entity: StoredEntity): boolean =>
    entity.fields['authorIdentityKey'] === identityKey ||
    // Commits ingested before an identity was ever linked carry the unmatched key too.
    entity.fields['unmatchedIdentityKey'] === identityKey;

  const matchingCommits = commits.filter(matches);
  const matchingPullRequests = pullRequests.filter(matches);

  return {
    identityKey,
    commitCount: matchingCommits.length,
    pullRequestCount: matchingPullRequests.length,
    totalCount: matchingCommits.length + matchingPullRequests.length,
    sampleArtifacts: interleavedSample(matchingCommits, matchingPullRequests),
  };
}

/**
 * A sample that shows both kinds when both exist.
 *
 * Round-robin rather than "commits, then pull requests, then slice": concatenating meant an
 * identifier with three or more commits never sampled a pull request at all, so the queue's
 * evidence was systematically one kind. A manager checking whether a merge is right wants to
 * see the shape of what it moves, and "three commits" when there are also nine pull requests
 * understates it.
 *
 * Falls back to whichever list still has entries once the other runs out, so an
 * identifier that only ever committed still shows three commits.
 */
function interleavedSample(
  commits: readonly StoredEntity[],
  pullRequests: readonly StoredEntity[],
): readonly AttributionArtifactRef[] {
  const sample: AttributionArtifactRef[] = [];

  for (let index = 0; sample.length < SAMPLE_LIMIT; index += 1) {
    const commit = commits[index];
    const pullRequest = pullRequests[index];
    if (commit === undefined && pullRequest === undefined) break;

    if (commit !== undefined) sample.push({ kind: 'commit', key: commit.naturalKey });
    if (sample.length < SAMPLE_LIMIT && pullRequest !== undefined) {
      sample.push({ kind: 'pull_request', key: pullRequest.naturalKey });
    }
  }

  return sample;
}

export interface IdentityLinkResult extends ConfigurationWrite {
  readonly identityKey: string;
  readonly developerKey: string;
  readonly impact: AttributionImpact;
}

/**
 * The `developerKey` of a link that names nobody.
 *
 * An unlink and an un-merge both leave the row in place and set this, rather than deleting
 * it, so that *when* the identifier stopped resolving is on disk. Declared here rather than
 * beside `removeIdentityLink` because `addIdentityLink` below is the reader that matters:
 * this value is the difference between "history" and "a claim".
 */
export const UNLINKED_DEVELOPER_KEY = '';

/**
 * Links an identifier to a developer.
 *
 * A collision — the identifier already belongs to somebody *else* — is refused by name
 * rather than resolved by recency. A silent winner would move a person's commits onto
 * another person and the report would state that as fact, which is the single most
 * damaging thing this surface could do.
 *
 * An **unlinked** row is not a collision. `removeIdentityLink` and `unmergeIdentity` both
 * leave the row behind with `UNLINKED_DEVELOPER_KEY`, and comparing that against the incoming
 * key made every one of those rows a permanent wall: unlinking `priya@acme.example` and
 * linking it again — to Marcus or back to Priya — was refused with "already linked to ." And
 * it made un-merge a one-way door, which defeats the point of having it: merging an
 * identifier into the wrong person, undoing that, then merging it into the right person is
 * *the* recovery path, and the second merge could not happen. A row naming nobody is a record
 * that the identifier once resolved, not a person still holding it.
 */
export async function addIdentityLink(
  store: KnowledgeStore,
  input: IdentityLinkInput,
  at: Instant,
): Promise<IdentityLinkResult> {
  const identityKey = identityNaturalKey(input.kind, input.value);
  const existing = await store.read('identity_link', identityKey);

  const heldBy = existing === null ? UNLINKED_DEVELOPER_KEY : String(existing.fields['developerKey'] ?? '');
  // Nobody holds an unlinked or un-merged identifier, so there is nothing to collide with.
  if (heldBy.length > 0 && heldBy !== input.developerKey) {
    throw new IdentityClaimedError(identityKey, heldBy);
  }

  const result = await store.observe({
    kind: 'identity_link',
    naturalKey: identityKey,
    fields: {
      identityKind: input.kind,
      identityValue: normalizeIdentityValue(input.kind, input.value),
      developerKey: input.developerKey,
      origin: input.origin ?? 'declared',
    },
    observedAt: at,
    evidence: null,
  });

  return {
    naturalKey: result.naturalKey,
    outcome: result.outcome,
    version: result.version,
    identityKey,
    developerKey: input.developerKey,
    impact: await attributionImpact(store, identityKey),
  };
}

/**
 * Unlinks an identifier. The artifacts revert to unattributed; none is touched.
 *
 * `developerKey` is set to the empty string rather than the row being deleted, and the
 * distinction is the acceptance criterion. Attribution is resolved through this table when
 * a report is generated, so a link that names nobody attributes nobody — and the commits
 * that were attributed a moment ago become "could not be tied to a person", which is the
 * honest state. Deleting the row would work too, but would lose *when* the link was
 * removed, and that is the fact somebody will want when a name disappears from a report.
 *
 * The row it leaves behind is history, not a claim: `addIdentityLink` treats
 * `UNLINKED_DEVELOPER_KEY` as unheld, so the identifier can be linked again afterwards.
 */
export async function removeIdentityLink(
  store: KnowledgeStore,
  input: { readonly kind: IdentityKind; readonly value: string },
  at: Instant,
): Promise<IdentityLinkResult | null> {
  const identityKey = identityNaturalKey(input.kind, input.value);
  const existing = await store.read('identity_link', identityKey);
  if (existing === null) return null;

  const priorDeveloperKey = String(existing.fields['developerKey'] ?? '');

  const result = await store.observe({
    kind: 'identity_link',
    naturalKey: identityKey,
    fields: {
      identityKind: input.kind,
      identityValue: normalizeIdentityValue(input.kind, input.value),
      developerKey: UNLINKED_DEVELOPER_KEY,
      origin: 'declared',
    },
    observedAt: at,
    evidence: null,
  });

  return {
    naturalKey: result.naturalKey,
    outcome: result.outcome,
    version: result.version,
    identityKey,
    developerKey: priorDeveloperKey,
    impact: await attributionImpact(store, identityKey),
  };
}

// ---------------------------------------------------------------------------
// Absences — the sole write path
// ---------------------------------------------------------------------------

export class InvalidAbsenceError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.name = 'InvalidAbsenceError';
    this.detail = detail;
  }
}

export interface AbsenceInput {
  readonly developerKey: string;
  /** `leave`, `holiday`, `on_call` — open vocabulary, stated verbatim in the report. */
  readonly kind: string;
  readonly startAt: Instant;
  readonly endAt: Instant;
  readonly note?: string | null;
  /** Where it came from. `memo` carries the ManagerMemo key in `sourceRef`. */
  readonly source: 'manual' | 'memo';
  readonly sourceRef?: string | null;
}

/** `<developer>:<start>` — one absence per person per start instant. */
export const absenceKey = (developerKey: string, startAt: Instant): string => `${developerKey}:${startAt}`;

/**
 * Records an absence. **The only way an Absence row comes to exist.**
 *
 * That single-writer rule is the acceptance criterion, and it exists because two
 * producers write absences: a manager on the roster screen, and a Manager Memo that said
 * "Priya is out until Thursday". Two independent inserts would mean two shapes of row —
 * one with a source, one without; one validated, one not — and the suppression rule would
 * work for whichever shape its author had in mind. So the memo path calls this function.
 * `tools/quality-gates/tests/roster-single-writer.test.ts` asserts nothing else observes
 * an `absence`.
 *
 * A zero-length or inverted range is refused. An absence that covers no instant would
 * suppress nothing while appearing in the roster as though it did, which is worse than an
 * error: the manager would believe they had explained the silence.
 */
export async function recordAbsence(
  store: KnowledgeStore,
  input: AbsenceInput,
  at: Instant,
): Promise<ConfigurationWrite> {
  if (input.developerKey.trim().length === 0) {
    throw new InvalidAbsenceError('An absence needs the person it is about.');
  }
  if (input.kind.trim().length === 0) {
    throw new InvalidAbsenceError('An absence needs a kind — `leave`, `holiday`, `on_call` or your own word for it.');
  }
  if (input.endAt <= input.startAt) {
    throw new InvalidAbsenceError(
      'An absence must end after it starts. A range covering no instant would suppress nothing while appearing in ' +
        'the roster as though it did.',
    );
  }
  if (input.source === 'memo' && (input.sourceRef ?? '').trim().length === 0) {
    throw new InvalidAbsenceError(
      'An absence from a memo must name the memo. The report links to the source so a reader can check the claim.',
    );
  }

  const result = await store.observe({
    kind: 'absence',
    naturalKey: absenceKey(input.developerKey, input.startAt),
    fields: {
      developerKey: input.developerKey,
      absenceKind: input.kind.trim(),
      startAt: input.startAt,
      endAt: input.endAt,
      note: input.note ?? null,
      source: input.source,
      sourceRef: input.sourceRef ?? null,
    },
    observedAt: at,
    evidence: null,
  });

  return { naturalKey: result.naturalKey, outcome: result.outcome, version: result.version };
}

/**
 * Ends an absence early, by moving its end instant.
 *
 * Still an append: the prior range is in `entity_versions`, so a report generated while
 * the longer range was in force still explains itself.
 */
export async function endAbsence(
  store: KnowledgeStore,
  input: { readonly naturalKey: string; readonly endAt: Instant },
  at: Instant,
): Promise<ConfigurationWrite | null> {
  const existing = await store.read('absence', input.naturalKey);
  if (existing === null) return null;

  const startAt = Number(existing.fields['startAt']) as Instant;
  if (input.endAt <= startAt) {
    throw new InvalidAbsenceError('An absence must end after it starts.');
  }

  const result = await store.observe({
    kind: 'absence',
    naturalKey: input.naturalKey,
    fields: {
      developerKey: existing.fields['developerKey'] ?? null,
      absenceKind: existing.fields['absenceKind'] ?? null,
      startAt,
      endAt: input.endAt,
      note: existing.fields['note'] ?? null,
      source: existing.fields['source'] ?? 'manual',
      sourceRef: existing.fields['sourceRef'] ?? null,
    },
    observedAt: at,
    evidence: null,
  });

  return { naturalKey: result.naturalKey, outcome: result.outcome, version: result.version };
}
