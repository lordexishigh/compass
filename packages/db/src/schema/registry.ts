import { getTableName, is } from 'drizzle-orm';
import { PgTable, type PgColumn } from 'drizzle-orm/pg-core';

import {
  absences,
  blockers,
  branchRefs,
  commits,
  companies,
  developers,
  feedbackEntries,
  features,
  identityLinks,
  managerMemos,
  objectives,
  projects,
  pullRequests,
  recommendations,
  releaseTags,
  repositories,
  reviews,
  risks,
  sprints,
  teamMemberships,
  teams,
  tickets,
  trackedProjects,
  trackedRepositories,
  unmatchedIdentities,
  wins,
  workingCalendars,
} from './entities.js';
// `corrections` is deliberately not imported: a Correction is a contradiction
// between beliefs, not one entity's version history, so it belongs to no single
// registry entry. Its append-only guarantee comes from `APPEND_ONLY_TABLE_NAMES`.
import { entityVersions, sprintScopeChanges, ticketStatusTransitions } from './history.js';

/**
 * The entity registry: one declaration per knowledge entity, and the single place
 * that answers "what does the model actually contain".
 *
 * The registry is what makes the convention checkable rather than aspirational.
 * `packages/db/tests/schema.test.ts` walks it and fails if any entry's table
 * lacks `organization_id`, `natural_key`, `first_seen_at` or `last_seen_at`, or
 * has no append-only history companion. It is also what the knowledge-model store
 * drives: `observe()` reads `trackedFields` to diff, `instantFields` to convert
 * at the SQL boundary, and `historyTables` for nothing at all — that list exists
 * so the schema test can assert the pairing.
 *
 * Adding an entity therefore means adding it here, which means the test and the
 * snapshot builder both learn about it in the same commit.
 */

/** The closed vocabulary of entity kinds. Snapshot keys and `entity_versions.entity_kind` use these. */
export const ENTITY_KINDS = [
  'absence',
  'blocker',
  'branch_ref',
  'commit',
  'company',
  'developer',
  'feature',
  'feedback',
  'identity_link',
  'manager_memo',
  'objective',
  'project',
  'pull_request',
  'recommendation',
  'release_tag',
  'repository',
  'review',
  'risk',
  'sprint',
  'team',
  'team_membership',
  'ticket',
  'tracked_project',
  'tracked_repository',
  'unmatched_identity',
  'win',
  'working_calendar',
] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];

/** A table that follows the named-entity convention. */
export type NamedEntityTable = PgTable & {
  readonly id: PgColumn;
  readonly organizationId: PgColumn;
  readonly naturalKey: PgColumn;
  readonly firstSeenAt: PgColumn;
  readonly lastSeenAt: PgColumn;
  readonly beliefAt: PgColumn;
  readonly version: PgColumn;
};

export interface NamedEntityDefinition {
  readonly kind: EntityKind;
  readonly table: NamedEntityTable;
  /**
   * The fields whose change constitutes a new version, by drizzle property name.
   * Convention columns are never tracked: `last_seen_at` moving is a sighting,
   * not a change of belief, and treating it as one would make every entity gain a
   * version on every run.
   */
  readonly trackedFields: readonly string[];
  /** Tracked fields stored as `timestamptz`; converted at the SQL boundary only. */
  readonly instantFields: readonly string[];
  /** Append-only tables that carry this entity's history. At least one, always. */
  readonly historyTables: readonly string[];
  /** How the entity comes to exist. Observed entities are never hand-created. */
  readonly origin: 'declared' | 'observed';
}

const VERSIONS = getTableName(entityVersions);

const define = (
  kind: EntityKind,
  table: NamedEntityTable,
  origin: NamedEntityDefinition['origin'],
  trackedFields: readonly string[],
  instantFields: readonly string[] = [],
  extraHistory: readonly string[] = [],
): NamedEntityDefinition => ({
  kind,
  table,
  origin,
  trackedFields,
  instantFields,
  historyTables: [VERSIONS, ...extraHistory],
});

const JUDGEMENT_FIELDS = [
  'subjectKind',
  'subjectKey',
  'teamKey',
  'summary',
  'state',
  'cause',
  'detectedAt',
  'resolvedAt',
  'evidence',
] as const;

const JUDGEMENT_INSTANTS = ['detectedAt', 'resolvedAt'] as const;

export const NAMED_ENTITIES: readonly NamedEntityDefinition[] = [
  define('company', companies, 'declared', ['name', 'timezone']),
  define(
    'objective',
    objectives,
    'declared',
    ['objectiveKind', 'parentObjectiveKey', 'title', 'effectiveFrom', 'effectiveUntil', 'isCurrent'],
    ['effectiveFrom', 'effectiveUntil'],
  ),
  define('team', teams, 'declared', [
    'name',
    'methodology',
    'projectKey',
    'objectiveKey',
    'conversationKey',
    'timezone',
  ]),
  // `anonymizedAt` and `pseudonym` are tracked, so withdrawing a name appends a version
  // rather than rewriting one — which is what makes the act auditable and what lets a
  // report regenerated for a past instant still resolve the name in force then.
  define(
    'developer',
    developers,
    'declared',
    ['displayName', 'teamKey', 'active', 'anonymizedAt', 'pseudonym'],
    ['anonymizedAt'],
  ),
  define('team_membership', teamMemberships, 'declared', [
    'teamKey',
    'developerKey',
    'membershipRole',
    'active',
  ]),
  define('working_calendar', workingCalendars, 'declared', [
    'teamKey',
    'workingWeekdays',
    'holidays',
    'timezone',
  ]),
  // The manager's tracking decision, declared, deliberately *not* a field on the
  // observed Repository/Project it names. See `entities.ts` for why.
  define(
    'tracked_repository',
    trackedRepositories,
    'declared',
    ['repositoryKey', 'tracked', 'archivedAt', 'note'],
    ['archivedAt'],
  ),
  define(
    'tracked_project',
    trackedProjects,
    'declared',
    ['projectKey', 'tracked', 'archivedAt', 'note'],
    ['archivedAt'],
  ),
  define('identity_link', identityLinks, 'declared', ['identityKind', 'identityValue', 'developerKey', 'origin']),
  define('unmatched_identity', unmatchedIdentities, 'observed', [
    'identityKind',
    'identityValue',
    'displayName',
    'occurrenceCount',
    'witnessRefs',
    'artifactKinds',
    'sourceKeys',
  ]),
  define(
    'absence',
    absences,
    'declared',
    ['developerKey', 'absenceKind', 'startAt', 'endAt', 'note', 'source', 'sourceRef'],
    ['startAt', 'endAt'],
  ),
  define('project', projects, 'observed', ['name', 'teamKey', 'methodology', 'defaultBranch']),
  define('repository', repositories, 'observed', ['name', 'projectKey', 'defaultBranch']),
  define('feature', features, 'observed', ['projectKey', 'title', 'status', 'statusCategory']),
  define(
    'ticket',
    tickets,
    'observed',
    [
      'projectKey',
      'featureKey',
      'itemKey',
      'title',
      'status',
      'statusCategory',
      'itemType',
      'priority',
      'estimatePoints',
      'labels',
      'assigneeDeveloperKey',
      'reporterDeveloperKey',
      'sprintKey',
      'flaggedBlocked',
      'createdAt',
      'resolvedAt',
    ],
    ['createdAt', 'resolvedAt'],
    [getTableName(ticketStatusTransitions)],
  ),
  define(
    'sprint',
    sprints,
    'observed',
    ['projectKey', 'name', 'goal', 'state', 'startAt', 'endAt', 'completedAt', 'committedItemKeys'],
    ['startAt', 'endAt', 'completedAt'],
    [getTableName(sprintScopeChanges)],
  ),
  define(
    'pull_request',
    pullRequests,
    'observed',
    [
      'repositoryKey',
      'displayNumber',
      'title',
      'state',
      'authorDeveloperKey',
      'authorIdentityKey',
      'createdAt',
      'mergedAt',
      'closedAt',
      'sourceBranch',
      'targetBranch',
      'headRevisionId',
      'mergeRevisionId',
      'linkedItemKeys',
      'requestedReviewerKeys',
    ],
    ['createdAt', 'mergedAt', 'closedAt'],
  ),
  define(
    'review',
    reviews,
    'observed',
    ['pullRequestKey', 'reviewerDeveloperKey', 'verdict', 'submittedAt', 'commentCount'],
    ['submittedAt'],
  ),
  define(
    'commit',
    commits,
    'observed',
    [
      'repositoryKey',
      'revisionId',
      'authorDeveloperKey',
      'unmatchedIdentityKey',
      'authorIdentityKey',
      'authoredAt',
      'message',
      'changedFileCount',
      'branchName',
      'parentRevisionIds',
      'ticketKey',
    ],
    ['authoredAt'],
  ),
  define('branch_ref', branchRefs, 'observed', ['repositoryKey', 'name', 'revisionId', 'isDefault']),
  define(
    'release_tag',
    releaseTags,
    'observed',
    ['repositoryKey', 'name', 'revisionId', 'releasedAt', 'description'],
    ['releasedAt'],
  ),
  define('blocker', blockers, 'observed', JUDGEMENT_FIELDS, JUDGEMENT_INSTANTS),
  define('risk', risks, 'observed', [...JUDGEMENT_FIELDS, 'severity'], JUDGEMENT_INSTANTS),
  define('recommendation', recommendations, 'observed', [...JUDGEMENT_FIELDS, 'action'], JUDGEMENT_INSTANTS),
  define('win', wins, 'observed', JUDGEMENT_FIELDS, JUDGEMENT_INSTANTS),
  // The manager's own assertion. Every field an effect depends on is tracked, so a
  // memo edited or expired appends a version rather than rewriting one — which is what
  // lets a report generated for a past instant honour the memo that was in force then
  // and a later report stop honouring it, from the same row.
  define(
    'manager_memo',
    managerMemos,
    'declared',
    [
      'authorUserId',
      'submittedAt',
      'rawText',
      'memoKind',
      'status',
      'extracted',
      'subjectKind',
      'subjectKey',
      'subjectConfidence',
      'subjectCandidates',
      'disambiguatedByUserId',
      'effectiveFrom',
      'effectiveUntil',
      'openEnded',
      'sourceChannel',
    ],
    ['submittedAt', 'effectiveFrom', 'effectiveUntil'],
  ),
  define(
    'feedback',
    feedbackEntries,
    'declared',
    [
      'reportItemStableId',
      'causeEntityRef',
      'causeKind',
      'causeDiscriminator',
      'authorUserId',
      'action',
      'reason',
      'note',
      'snoozeUntil',
      'severityScoreAtVerdict',
      'sourceChannel',
      'reportId',
      'submittedAt',
    ],
    ['submittedAt', 'snoozeUntil'],
  ),
];

const BY_KIND: ReadonlyMap<EntityKind, NamedEntityDefinition> = new Map(
  NAMED_ENTITIES.map((definition) => [definition.kind, definition]),
);

export class UnknownEntityKindError extends Error {
  constructor(kind: string) {
    super(`\`${kind}\` is not a knowledge entity kind. Add it to ENTITY_KINDS and NAMED_ENTITIES together.`);
    this.name = 'UnknownEntityKindError';
  }
}

export function namedEntity(kind: EntityKind): NamedEntityDefinition {
  const definition = BY_KIND.get(kind);
  if (!definition) throw new UnknownEntityKindError(kind);
  return definition;
}

export function isEntityKind(value: unknown): value is EntityKind {
  return typeof value === 'string' && BY_KIND.has(value as EntityKind);
}

/** Table name per kind — what the schema test and the snapshot builder report. */
export function entityTableName(kind: EntityKind): string {
  return getTableName(namedEntity(kind).table as PgTable);
}

export function isNamedEntityTable(table: unknown): table is NamedEntityTable {
  if (!is(table, PgTable)) return false;
  const candidate = table as unknown as Record<string, unknown>;
  return (
    ['id', 'organizationId', 'naturalKey', 'firstSeenAt', 'lastSeenAt', 'beliefAt', 'version'] as const
  ).every((property) => candidate[property] !== undefined);
}
