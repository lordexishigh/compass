import {
  configurationAt,
  entitiesAt,
  projectTrackedAt,
  repositoryTrackedAt,
  resolvedBoolean,
  resolvedText,
  teamDeveloperKeysAt,
} from './configuration.js';
import { compareStable, type Instant, type TimeWindow } from './instant.js';

/**
 * The analysis input contract.
 *
 * This is a *structural mirror* of `KnowledgeSnapshot` from
 * @compass/knowledge-model, declared here for the same reason `Instant` is:
 * @compass/knowledge-model depends on @compass/db, so an `import type` from it
 * would put a database package in this package's manifest, and the whole point of
 * the analysis layer is that its manifest is empty. TypeScript compares these
 * structurally, so a real `KnowledgeSnapshot` is assignable to
 * `AnalysisSnapshot` with no import edge in either direction.
 *
 * The two shapes cannot drift silently: `packages/pipeline` is the layer that
 * holds both, and `packages/pipeline/tests/contract.test.ts` assigns a real
 * snapshot to this type in both directions. If the knowledge model adds or renames
 * a collection, that test stops compiling.
 *
 * Three properties are guaranteed by the producer and relied on absolutely here:
 * the data is fully materialized (no promises, no lazy loading), it is plain
 * serialisable JSON (no `Date`, no `Map`), and every collection is already sorted
 * by a documented stable key.
 */

/** A tracked field value, as the knowledge model canonicalises it. */
export type FieldValue = string | number | boolean | null | readonly unknown[] | Readonly<Record<string, unknown>>;

export interface AnalysisElapsedFact {
  readonly ageDays: number;
  readonly staleDays: number;
  readonly seenToday: boolean;
  readonly trail: readonly boolean[];
}

export interface AnalysisEntity {
  readonly kind: string;
  readonly naturalKey: string;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly beliefAt: number;
  readonly version: number;
  readonly elapsed: AnalysisElapsedFact;
  readonly fields: Readonly<Record<string, FieldValue>>;
}

export interface AnalysisEntityVersion {
  readonly entityKind: string;
  readonly entityNaturalKey: string;
  readonly version: number;
  readonly changedFields: readonly string[];
  readonly trackedFields: Readonly<Record<string, unknown>>;
  readonly observedAt: number;
  readonly evidenceSourceKey: string | null;
  readonly evidenceSourceRecordId: string | null;
}

export interface AnalysisTicketTransition {
  readonly ticketKey: string;
  readonly sourceKey: string;
  readonly sourceRecordId: string;
  readonly fromStatus: string | null;
  readonly toStatus: string;
  readonly fromStatusCategory: string | null;
  readonly toStatusCategory: string;
  readonly actorDeveloperKey: string | null;
  readonly transitionedAt: number;
}

export interface AnalysisSprintScopeChange {
  readonly sprintKey: string;
  readonly ticketKey: string;
  readonly sourceKey: string;
  readonly sourceRecordId: string;
  readonly change: string;
  readonly actorDeveloperKey: string | null;
  readonly changedAt: number;
  readonly afterSprintStart: boolean;
}

export interface AnalysisCorrection {
  readonly subjectKind: string;
  readonly subjectKey: string;
  readonly priorVersion: number;
  readonly priorBelief: string;
  readonly newBelief: string;
  readonly contradiction: string;
  readonly evidenceKind: string;
  readonly evidenceLabel: string;
  readonly evidenceSourceKey: string;
  readonly evidenceSourceRecordId: string;
  readonly observedAt: number;
  readonly detectedAt: number;
}

export interface AnalysisIngestRun {
  readonly connectorId: string;
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly status: string;
  readonly totalRecords: number;
}

export interface AnalysisCollections {
  readonly entities: readonly AnalysisEntity[];
  readonly entityCounts: readonly { readonly kind: string; readonly count: number }[];
  readonly entityVersions: readonly AnalysisEntityVersion[];
  readonly ticketTransitions: readonly AnalysisTicketTransition[];
  readonly sprintScopeChanges: readonly AnalysisSprintScopeChange[];
  readonly corrections: readonly AnalysisCorrection[];
  readonly ingestRuns: readonly AnalysisIngestRun[];
}

export type AnalysisScope = { readonly kind: 'team'; readonly teamKey: string } | { readonly kind: 'merged' };

export interface AnalysisSnapshot {
  readonly organizationId: string;
  readonly scope: AnalysisScope;
  /** The instant the snapshot represents. Supplied, never read from a clock. */
  readonly instant: Instant;
  readonly timezone: string;
  readonly window: TimeWindow;
  readonly collections: AnalysisCollections;
}

// ---------------------------------------------------------------------------
// Readers
//
// Tracked fields arrive as `FieldValue`, so every read is a narrowing. These
// helpers do that narrowing in one place and return a *stated* fallback rather
// than casting: a ticket whose `estimatePoints` came back as a string is
// unestimated, not silently zero, because zero would be counted in a completion
// percentage and a manager would have no way to see where it came from.
// ---------------------------------------------------------------------------

export const textField = (entity: AnalysisEntity, field: string): string | null => {
  const value = entity.fields[field];
  return typeof value === 'string' ? value : null;
};

export const numberField = (entity: AnalysisEntity, field: string): number | null => {
  const value = entity.fields[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

export const booleanField = (entity: AnalysisEntity, field: string): boolean => entity.fields[field] === true;

export const instantField = (entity: AnalysisEntity, field: string): Instant | null => {
  const value = numberField(entity, field);
  return value === null ? null : (value as Instant);
};

/** A list-valued field as strings, with non-strings dropped rather than coerced. */
export const textListField = (entity: AnalysisEntity, field: string): readonly string[] => {
  const value = entity.fields[field];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
};

/** Entities of one kind, in the snapshot's documented order. */
export const entitiesOfKind = (snapshot: AnalysisSnapshot, kind: string): readonly AnalysisEntity[] =>
  snapshot.collections.entities.filter((entity) => entity.kind === kind);

/** @snapshotAccessor a keyed lookup over materialized data; nothing about it is time-relative. */
export function entityByKey(snapshot: AnalysisSnapshot, kind: string, naturalKey: string): AnalysisEntity | null {
  return (
    snapshot.collections.entities.find((entity) => entity.kind === kind && entity.naturalKey === naturalKey) ?? null
  );
}

/**
 * An index by natural key, for the detectors that resolve many keys at once.
 *
 * @snapshotAccessor reshapes a collection into a map; the detectors that consume it are the ones told the instant.
 */
export function indexOfKind(snapshot: AnalysisSnapshot, kind: string): ReadonlyMap<string, AnalysisEntity> {
  const index = new Map<string, AnalysisEntity>();
  for (const entity of entitiesOfKind(snapshot, kind)) index.set(entity.naturalKey, entity);
  return index;
}

// ---------------------------------------------------------------------------
// Scope
//
// `configuration.ts` imports nothing from this file's scope section, so the
// dependency runs one way: readers here, temporal resolution there, and scope
// composed from both.
// ---------------------------------------------------------------------------

/**
 * The projects and repositories a report is about.
 *
 * A team-scoped report is not "every ticket in the organization". The team names
 * its project; the project names its repositories. Anything that resolves to
 * neither is out of scope and is *stated* as such rather than quietly counted —
 * `unscopedProjectKeys` is what the coverage note is written from.
 *
 * A merged report keeps every project. That is the documented meaning of merged,
 * and the cross-team prioritiser above this layer is what bounds the prose.
 *
 * ## Scope is effective-dated
 *
 * This used to resolve the snapshot's *current* belief, with a note saying that doing it
 * properly needed the roster's version history. It does, and the history is right there in
 * `collections.entityVersions`, so `configuration.ts` resolves it and this function uses
 * the answer. Team membership and repository tracking are read as of `snapshot.instant`.
 *
 * That is what makes a report for a past instant stable: archiving a repository this
 * morning does not retroactively empty last Tuesday's Yesterday section, and somebody who
 * has since left the team is still credited with the work they did while they were on it.
 */
export interface ResolvedScope {
  readonly kind: 'team' | 'merged';
  readonly teamKey: string | null;
  readonly teamName: string | null;
  readonly methodology: string | null;
  readonly projectKeys: readonly string[];
  readonly repositoryKeys: readonly string[];
  readonly developerKeys: readonly string[];
  /** Projects that exist in the snapshot but sit outside this report's scope. */
  readonly unscopedProjectKeys: readonly string[];
  /**
   * Repositories excluded because they were archived at the report's instant.
   *
   * Named rather than merely absent, so the masthead can state it. A repository that
   * silently stopped appearing is the kind of gap a manager notices weeks later and
   * cannot explain.
   */
  readonly archivedRepositoryKeys: readonly string[];
  readonly archivedProjectKeys: readonly string[];
}

/**
 * @snapshotAccessor resolves configuration as of `snapshot.instant`, which is a parameter
 * of the snapshot rather than a clock read — the same rule every other module here follows.
 */
export function resolveScope(snapshot: AnalysisSnapshot): ResolvedScope {
  const instant = snapshot.instant;
  const configuration = configurationAt(snapshot, instant);

  // Projects and repositories that *existed* at the instant. A repository configured
  // after the fact is not part of a report about a day before it was known.
  const liveProjects = entitiesAt(snapshot, 'project', instant).map((project) => project.naturalKey);
  const liveRepositories = entitiesAt(snapshot, 'repository', instant);

  const trackedRepositories = liveRepositories.filter((repository) =>
    repositoryTrackedAt(configuration, repository.naturalKey),
  );
  const allProjects = liveProjects.filter((key) => projectTrackedAt(configuration, key));

  if (snapshot.scope.kind === 'merged') {
    return {
      kind: 'merged',
      teamKey: null,
      teamName: null,
      methodology: null,
      projectKeys: [...allProjects].sort(compareStable),
      repositoryKeys: trackedRepositories.map((repository) => repository.naturalKey).sort(compareStable),
      developerKeys: entitiesAt(snapshot, 'developer', instant)
        .filter((developer) => resolvedBoolean(developer, 'active'))
        .map((developer) => developer.naturalKey)
        .sort(compareStable),
      unscopedProjectKeys: [],
      archivedRepositoryKeys: configuration.archivedRepositoryKeys,
      archivedProjectKeys: configuration.archivedProjectKeys,
    };
  }

  const teamKey = snapshot.scope.teamKey;
  const team = entityByKey(snapshot, 'team', teamKey);
  const teamProject = team === null ? null : textField(team, 'projectKey');

  // Projects claimed by the team directly, plus the one the team names. Both
  // directions are needed: `project.teamKey` is configured, `team.projectKey` is
  // the team's own declaration, and either may be the one that was filled in.
  const projectKeys = [
    ...new Set(
      [
        ...entitiesAt(snapshot, 'project', instant)
          .filter((project) => resolvedText(project, 'teamKey') === teamKey)
          .map((project) => project.naturalKey),
        ...(teamProject === null ? [] : [teamProject]),
      ].filter((key) => key.length > 0 && projectTrackedAt(configuration, key)),
    ),
  ].sort(compareStable);

  const scoped = new Set(projectKeys);
  const repositoryKeys = trackedRepositories
    .filter((repository) => {
      const projectKey = resolvedText(repository, 'projectKey');
      // A repository with no declared project is included for a single-project
      // team and excluded otherwise: guessing which of three teams owns it would
      // put someone else's merge in this team's Yesterday.
      return projectKey === null ? projectKeys.length === 1 : scoped.has(projectKey);
    })
    .map((repository) => repository.naturalKey)
    .sort(compareStable);

  return {
    kind: 'team',
    teamKey,
    teamName: team === null ? null : textField(team, 'name'),
    methodology: team === null ? null : textField(team, 'methodology'),
    projectKeys,
    repositoryKeys,
    // Membership as it stood at the instant, from the roster's own history — so a person
    // who left last month is still credited with what they did before they did.
    developerKeys: teamDeveloperKeysAt(snapshot, teamKey, instant),
    unscopedProjectKeys: allProjects.filter((key) => !scoped.has(key)).sort(compareStable),
    archivedRepositoryKeys: configuration.archivedRepositoryKeys,
    archivedProjectKeys: configuration.archivedProjectKeys,
  };
}

/** Whether a project key falls inside the report's scope. */
export const projectInScope = (scope: ResolvedScope, projectKey: string | null): boolean =>
  scope.kind === 'merged' || (projectKey !== null && scope.projectKeys.includes(projectKey));

export const repositoryInScope = (scope: ResolvedScope, repositoryKey: string | null): boolean =>
  scope.kind === 'merged' || (repositoryKey !== null && scope.repositoryKeys.includes(repositoryKey));

/** The tickets this report is about, in snapshot order. */
export const scopedTickets = (snapshot: AnalysisSnapshot, scope: ResolvedScope): readonly AnalysisEntity[] =>
  entitiesOfKind(snapshot, 'ticket').filter((ticket) => projectInScope(scope, textField(ticket, 'projectKey')));

export const scopedSprints = (snapshot: AnalysisSnapshot, scope: ResolvedScope): readonly AnalysisEntity[] =>
  entitiesOfKind(snapshot, 'sprint').filter((sprint) => projectInScope(scope, textField(sprint, 'projectKey')));

export const scopedPullRequests = (snapshot: AnalysisSnapshot, scope: ResolvedScope): readonly AnalysisEntity[] =>
  entitiesOfKind(snapshot, 'pull_request').filter((pullRequest) =>
    repositoryInScope(scope, textField(pullRequest, 'repositoryKey')),
  );

export const scopedReleaseTags = (snapshot: AnalysisSnapshot, scope: ResolvedScope): readonly AnalysisEntity[] =>
  entitiesOfKind(snapshot, 'release_tag').filter((tag) =>
    repositoryInScope(scope, textField(tag, 'repositoryKey')),
  );

export const scopedCommits = (snapshot: AnalysisSnapshot, scope: ResolvedScope): readonly AnalysisEntity[] =>
  entitiesOfKind(snapshot, 'commit').filter((commit) =>
    repositoryInScope(scope, textField(commit, 'repositoryKey')),
  );

/**
 * Reviews, indexed by the pull request they were submitted against.
 *
 * @snapshotAccessor a grouping of already-materialized rows; the callers that measure their ages take the instant.
 */
export function reviewsByPullRequest(snapshot: AnalysisSnapshot): ReadonlyMap<string, readonly AnalysisEntity[]> {
  const index = new Map<string, AnalysisEntity[]>();
  for (const review of entitiesOfKind(snapshot, 'review')) {
    const pullRequestKey = textField(review, 'pullRequestKey');
    if (pullRequestKey === null) continue;
    const bucket = index.get(pullRequestKey);
    if (bucket === undefined) index.set(pullRequestKey, [review]);
    else bucket.push(review);
  }
  return index;
}

/**
 * Transitions for one ticket, oldest first — the snapshot's own order.
 *
 * @snapshotAccessor a grouping of append-only history; every transition carries its own event time.
 */
export function transitionsByTicket(snapshot: AnalysisSnapshot): ReadonlyMap<string, readonly AnalysisTicketTransition[]> {
  const index = new Map<string, AnalysisTicketTransition[]>();
  for (const transition of snapshot.collections.ticketTransitions) {
    const bucket = index.get(transition.ticketKey);
    if (bucket === undefined) index.set(transition.ticketKey, [transition]);
    else bucket.push(transition);
  }
  return index;
}

/**
 * The display label for a developer key — their name if the roster holds one,
 * otherwise the key itself. Never a guess, and never an email address.
 *
 * @snapshotAccessor a roster lookup for display; a person's name does not depend on when you ask.
 */
export function developerName(snapshot: AnalysisSnapshot, developerKey: string | null): string | null {
  if (developerKey === null) return null;
  const developer = entityByKey(snapshot, 'developer', developerKey);
  if (developer === null) return developerKey;

  /**
   * Anonymization, and the reason it is three lines here rather than a pass over the
   * finished report.
   *
   * This function is the single choke point every developer name in every section flows
   * through — Blockers' owner, Risks' concentration, Recommendations' actor, Wins'
   * credit, the review queue, the workload. So substituting here anonymises the whole
   * report at once, in the pure layer, with no string rewriting afterwards and no
   * chance of one detector being missed. A post-hoc scrub over rendered prose would be
   * the opposite: unbounded, unverifiable, and one new detector away from leaking.
   *
   * The real name stays on the row and is still resolvable for a *past* instant,
   * because `pseudonym` is an effective-dated tracked field like everything else. That
   * is what makes yesterday's report still say what it said.
   */
  const pseudonym = textField(developer, 'pseudonym');
  if (pseudonym !== null && instantField(developer, 'anonymizedAt') !== null) return pseudonym;

  return textField(developer, 'displayName') ?? developerKey;
}

/**
 * The status category an item was in at `instant`, by replaying its transitions.
 *
 * `null` when no transition had happened yet — which is a real answer meaning
 * "Compass has no observation of this item's state at that moment", and is
 * deliberately not treated as `todo`. Two callers need it and they must agree:
 * the work-concentration risk reconstructs yesterday's in-flight set with it, and
 * the carryover rate reconstructs each sprint's unfinished set. A second copy
 * would let the two drift, and then a manager could read a carryover rate that
 * disagreed with a trend computed from the same history.
 */
export function statusCategoryAt(
  transitions: readonly { readonly toStatusCategory: string; readonly transitionedAt: number }[],
  instant: Instant,
): string | null {
  let category: string | null = null;
  let at = -Infinity;
  for (const transition of transitions) {
    if (transition.transitionedAt > instant) continue;
    if (transition.transitionedAt >= at) {
      at = transition.transitionedAt;
      category = transition.toStatusCategory;
    }
  }
  return category;
}

/** Status categories the tracker considers finished. */
export const DONE_STATUS_CATEGORY = 'done';

/** Status categories that mean "not started" — excluded from dwell and WIP. */
export const TODO_STATUS_CATEGORY = 'todo';

export const isDone = (entity: AnalysisEntity): boolean =>
  textField(entity, 'statusCategory') === DONE_STATUS_CATEGORY;

export const isInFlight = (entity: AnalysisEntity): boolean => {
  const category = textField(entity, 'statusCategory');
  return category !== DONE_STATUS_CATEGORY && category !== TODO_STATUS_CATEGORY;
};

/** `blocked` as the tracker itself spells it, in either the flag or the status. */
export const BLOCKED_STATUS_PATTERN = /blocked/i;

export const looksBlocked = (ticket: AnalysisEntity): boolean =>
  !isDone(ticket) &&
  (booleanField(ticket, 'flaggedBlocked') || BLOCKED_STATUS_PATTERN.test(textField(ticket, 'status') ?? ''));
