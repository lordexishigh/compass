import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
  type PgColumn,
} from 'drizzle-orm/pg-core';

import { entityStateColumns, instantColumn, organizationId } from './columns.js';
import { organizations } from './tables.js';

/**
 * The named entities of the knowledge model.
 *
 * Every table here is one entity family, stored as a first-class row keyed by a
 * stable natural key, carrying `first_seen_at` / `last_seen_at` / `belief_at` /
 * `version`, and paired with an append-only history companion (see
 * `./history.ts` and the registry in `./registry.ts`).
 *
 * Two groups sit side by side and it is worth naming the difference:
 *
 *  - **Observed** entities are projected from connector records: Project,
 *    Repository, Feature, Ticket, Sprint, PullRequest, Review, Commit, BranchRef,
 *    ReleaseTag, and the Blocker/Risk rows that a source states outright.
 *  - **Declared** entities are configured by a manager and never invented from
 *    artifacts: Company, Objective, Team, Developer, IdentityLink, Absence,
 *    WorkingCalendar. The connector port has no roster artifact on purpose —
 *    guessing that a git email is a person is precisely what `IdentityLink` and
 *    `UnmatchedIdentity` exist to prevent.
 *
 * Tracked fields are real typed columns rather than a jsonb blob, so the analysis
 * layer can read the model without parsing, and so a column added without a
 * migration is a compile error rather than a silently absent key.
 */

/** Every entity row starts with these. */
const entityBase = () => ({
  id: uuid('id').primaryKey(),
  organizationId: organizationId().references(() => organizations.id),
  ...entityStateColumns(),
});

type EntityBaseShape = {
  readonly organizationId: PgColumn;
  readonly naturalKey: PgColumn;
  readonly lastSeenAt: PgColumn;
};

/**
 * The natural key is unique per organization — that uniqueness *is* the
 * idempotency guarantee, enforced by the database rather than by a code path
 * remembering to check first.
 */
const entityConstraints = (tableName: string, table: EntityBaseShape) => [
  unique(`${tableName}_org_natural_key`).on(table.organizationId, table.naturalKey),
  index(`${tableName}_org_last_seen_idx`).on(table.organizationId, table.lastSeenAt),
];

// ---------------------------------------------------------------------------
// Declared entities: the org chart a manager configures.
// ---------------------------------------------------------------------------

export const companies = pgTable(
  'companies',
  {
    ...entityBase(),
    name: text('name').notNull(),
    /** IANA zone the company reports in when a team has no calendar of its own. */
    timezone: text('timezone').notNull(),
  },
  (table) => entityConstraints('companies', table),
);

/**
 * An objective, effective-dated. `is_current` is the manager's declaration of
 * which objective today's work is measured against; alignment verdicts in
 * `mvp-goals-and-alignment` are computed against the current one only.
 */
export const objectives = pgTable(
  'objectives',
  {
    ...entityBase(),
    objectiveKind: text('objective_kind').notNull(),
    parentObjectiveKey: text('parent_objective_key'),
    title: text('title').notNull(),
    effectiveFrom: instantColumn('effective_from').notNull(),
    effectiveUntil: instantColumn('effective_until').notNull(),
    isCurrent: boolean('is_current').notNull(),
  },
  (table) => entityConstraints('objectives', table),
);

export const teams = pgTable(
  'teams',
  {
    ...entityBase(),
    name: text('name').notNull(),
    /** `scrum` or `kanban`. Decides which sprint questions are even asked. */
    methodology: text('methodology').notNull(),
    projectKey: text('project_key'),
    objectiveKey: text('objective_key'),
    conversationKey: text('conversation_key'),
    timezone: text('timezone').notNull(),
  },
  (table) => entityConstraints('teams', table),
);

/**
 * A person, as the roster declares them.
 *
 * `anonymizedAt` and `pseudonym` are the anonymization decision, mirrored onto the
 * entity from `anonymizations` so the *pure* analysis path can read it. That matters:
 * `developerName` in `@compass/analysis` is the single choke point every name in every
 * report flows through, and it is a function of the snapshot alone — no database, no
 * clock. Putting the decision on the entity is what lets one three-line change in that
 * function anonymise every section of every future report at once.
 *
 * Both are tracked fields, so anonymising appends an `entity_versions` row like any
 * other change of belief. Two consequences follow and both are wanted: a report
 * regenerated for a past instant resolves the name that was in force *then*, and the
 * change itself is recorded in a table the database refuses to let anything update or
 * delete.
 */
export const developers = pgTable(
  'developers',
  {
    ...entityBase(),
    displayName: text('display_name').notNull(),
    teamKey: text('team_key'),
    active: boolean('active').notNull(),
    /** Set once the person's name has been withdrawn from future reports. */
    anonymizedAt: instantColumn('anonymized_at'),
    /** The stable stand-in. Non-null exactly when `anonymized_at` is. */
    pseudonym: text('pseudonym'),
  },
  (table) => entityConstraints('developers', table),
);

/**
 * One declared mapping from a source's own identifier to a Developer.
 *
 * `identity_value` is stored normalised (trimmed, lower-cased) because that is
 * the form the resolver compares. Nothing else about an identity is used for
 * matching — in particular never the display name.
 */
export const identityLinks = pgTable(
  'identity_links',
  {
    ...entityBase(),
    identityKind: text('identity_kind').notNull(),
    identityValue: text('identity_value').notNull(),
    developerKey: text('developer_key').notNull(),
    /** How the link came to exist. `declared` is the only MVP value. */
    origin: text('origin').notNull(),
  },
  (table) => [
    ...entityConstraints('identity_links', table),
    index('identity_links_org_lookup_idx').on(table.organizationId, table.identityKind, table.identityValue),
  ],
);

/**
 * An actor no IdentityLink covers.
 *
 * The row exists so the artifact is neither dropped nor guessed at. A manager can
 * see "six commits from an address Compass cannot place" and fix the roster,
 * instead of wondering where the work went.
 *
 * The occurrence count is the size of `witness_refs`, a sorted set of
 * `sourceKey:sourceRecordId` strings, rather than a counter that gets incremented.
 * That distinction matters: a counter would grow every time the same window was
 * re-ingested, and "ingest the same window three times and nothing changes" is a
 * property this model has to keep. A set union is idempotent under replay and
 * still monotone under an overlapping window, so the count only rises when a
 * genuinely new artifact is seen.
 */
export const unmatchedIdentities = pgTable(
  'unmatched_identities',
  {
    ...entityBase(),
    identityKind: text('identity_kind').notNull(),
    identityValue: text('identity_value').notNull(),
    /** Recorded for display only. Never used to match. */
    displayName: text('display_name'),
    /** Always `witness_refs.length`. Stored so it is queryable without parsing. */
    occurrenceCount: integer('occurrence_count').notNull(),
    witnessRefs: jsonb('witness_refs').$type<readonly string[]>().notNull(),
    artifactKinds: jsonb('artifact_kinds').$type<readonly string[]>().notNull(),
    sourceKeys: jsonb('source_keys').$type<readonly string[]>().notNull(),
  },
  (table) => entityConstraints('unmatched_identities', table),
);

/**
 * A person's absence, and the reason a stalled-work finding about them is suppressed.
 *
 * `source` records where the absence came from — `manual` for the roster screen,
 * `memo` for a Manager Memo that stated it. Both go through the same roster service,
 * which is the sole write path; the field says which door was used, not which code
 * wrote the row. `packages/analysis/src/absence-suppression.ts` is the only place
 * that reads these to suppress a finding, and a quality gate asserts it stays that way.
 */
export const absences = pgTable(
  'absences',
  {
    ...entityBase(),
    developerKey: text('developer_key').notNull(),
    /** `leave`, `holiday`, `on_call` — open vocabulary, stated verbatim. */
    absenceKind: text('absence_kind').notNull(),
    startAt: instantColumn('start_at').notNull(),
    endAt: instantColumn('end_at').notNull(),
    note: text('note'),
    /** `manual` or `memo`. Shown in the roster so a reader can check the claim. */
    source: text('source').notNull(),
    /** For `memo`, the ManagerMemo natural key that stated it. Null for `manual`. */
    sourceRef: text('source_ref'),
  },
  (table) => entityConstraints('absences', table),
);

/**
 * Which team a person is on, effective-dated.
 *
 * `developers.team_key` also names a team, and the two are not redundant: that field
 * is the person's *current* home team and is what a roster screen shows first, while
 * this entity is the append-only record of the membership itself — joined when,
 * removed when, in what role. A report generated for a past instant resolves
 * membership from *this* history, which is why removing somebody today does not
 * rewrite last Tuesday's Yesterday section.
 *
 * Removal sets `active` to false rather than deleting: the row is the evidence that
 * the person was on the team when the work happened.
 */
export const teamMemberships = pgTable(
  'team_memberships',
  {
    ...entityBase(),
    teamKey: text('team_key').notNull(),
    developerKey: text('developer_key').notNull(),
    /** `member` or `lead`. Open vocabulary; nothing in analysis branches on it yet. */
    membershipRole: text('membership_role').notNull(),
    active: boolean('active').notNull(),
  },
  (table) => [
    ...entityConstraints('team_memberships', table),
    index('team_memberships_org_team_idx').on(table.organizationId, table.teamKey),
    index('team_memberships_org_developer_idx').on(table.organizationId, table.developerKey),
  ],
);

/**
 * A team's working days and holidays.
 *
 * Every threshold in the product is expressed in *working* days — "has not moved for
 * 3 working days" — so this is the table those numbers are measured against. Without
 * it the count is Monday-to-Friday UTC, which is a reasonable default and a wrong
 * answer for a team that works Sunday to Thursday.
 *
 * `workingWeekdays` is a sorted set of ISO weekday numbers (1 = Monday … 7 = Sunday)
 * rather than a bitmask, because the roster screen renders it and a bitmask would be
 * one more thing to decode before a human could check it. `holidays` is a sorted set
 * of `YYYY-MM-DD` civil dates in the team's own zone.
 */
export const workingCalendars = pgTable(
  'working_calendars',
  {
    ...entityBase(),
    teamKey: text('team_key').notNull(),
    /** ISO weekday numbers, 1 = Monday. Sorted, deduplicated. */
    workingWeekdays: jsonb('working_weekdays').$type<readonly number[]>().notNull(),
    /** `YYYY-MM-DD` civil dates in `timezone`. Sorted, deduplicated. */
    holidays: jsonb('holidays').$type<readonly string[]>().notNull(),
    /** The zone the holiday dates are civil dates *in*. */
    timezone: text('timezone').notNull(),
  },
  (table) => [
    ...entityConstraints('working_calendars', table),
    index('working_calendars_org_team_idx').on(table.organizationId, table.teamKey),
  ],
);

/**
 * The manager's decision about a repository, separate from the repository itself.
 *
 * Repository is an *observed* entity — a connector reports it — and whether Compass
 * tracks it is *declared*. Keeping them apart is what makes archival survive the next
 * ingest: if `archived` were a tracked field on `repositories`, every ingest would
 * observe the repo without it and diff it straight back to tracked. The connector
 * would be silently overruling the manager once a day.
 *
 * `naturalKey` is the repository's own natural key, so the join needs no surrogate.
 * Archiving is append-only like everything else, so "when did we stop tracking this"
 * is answerable and a past report still resolves the repo as tracked.
 */
export const trackedRepositories = pgTable(
  'tracked_repositories',
  {
    ...entityBase(),
    repositoryKey: text('repository_key').notNull(),
    /** False once archived. Prior data and prior reports are untouched either way. */
    tracked: boolean('tracked').notNull(),
    archivedAt: instantColumn('archived_at'),
    note: text('note'),
  },
  (table) => [
    ...entityConstraints('tracked_repositories', table),
    index('tracked_repositories_org_repo_idx').on(table.organizationId, table.repositoryKey),
  ],
);

/** The same decision for a project. See `trackedRepositories` for why it is its own table. */
export const trackedProjects = pgTable(
  'tracked_projects',
  {
    ...entityBase(),
    projectKey: text('project_key').notNull(),
    tracked: boolean('tracked').notNull(),
    archivedAt: instantColumn('archived_at'),
    note: text('note'),
  },
  (table) => [
    ...entityConstraints('tracked_projects', table),
    index('tracked_projects_org_project_idx').on(table.organizationId, table.projectKey),
  ],
);

// ---------------------------------------------------------------------------
// Observed entities: projected from connector records.
// ---------------------------------------------------------------------------

export const projects = pgTable(
  'projects',
  {
    ...entityBase(),
    name: text('name').notNull(),
    teamKey: text('team_key'),
    methodology: text('methodology'),
    defaultBranch: text('default_branch'),
  },
  (table) => entityConstraints('projects', table),
);

export const repositories = pgTable(
  'repositories',
  {
    ...entityBase(),
    name: text('name').notNull(),
    projectKey: text('project_key'),
    defaultBranch: text('default_branch'),
  },
  (table) => entityConstraints('repositories', table),
);

/**
 * A Feature is a parent work item — the thing a manager calls "the work" —
 * holding its Project and gathering child Tickets through `tickets.feature_key`.
 */
export const features = pgTable(
  'features',
  {
    ...entityBase(),
    projectKey: text('project_key').notNull(),
    title: text('title').notNull(),
    status: text('status'),
    statusCategory: text('status_category'),
  },
  (table) => [...entityConstraints('features', table), index('features_org_project_idx').on(table.organizationId, table.projectKey)],
);

export const tickets = pgTable(
  'tickets',
  {
    ...entityBase(),
    projectKey: text('project_key').notNull(),
    /** The parent Feature's natural key, or null for unparented work. */
    featureKey: text('feature_key'),
    itemKey: text('item_key').notNull(),
    title: text('title').notNull(),
    status: text('status').notNull(),
    statusCategory: text('status_category').notNull(),
    itemType: text('item_type').notNull(),
    priority: text('priority'),
    estimatePoints: doublePrecision('estimate_points'),
    labels: jsonb('labels').$type<readonly string[]>().notNull(),
    assigneeDeveloperKey: text('assignee_developer_key'),
    reporterDeveloperKey: text('reporter_developer_key'),
    sprintKey: text('sprint_key'),
    /** The tracker's own blocked marker, carried through verbatim. */
    flaggedBlocked: boolean('flagged_blocked').notNull(),
    createdAt: instantColumn('created_at').notNull(),
    resolvedAt: instantColumn('resolved_at'),
  },
  (table) => [
    ...entityConstraints('tickets', table),
    index('tickets_org_feature_idx').on(table.organizationId, table.featureKey),
    index('tickets_org_sprint_idx').on(table.organizationId, table.sprintKey),
  ],
);

export const sprints = pgTable(
  'sprints',
  {
    ...entityBase(),
    projectKey: text('project_key').notNull(),
    name: text('name').notNull(),
    goal: text('goal'),
    state: text('state').notNull(),
    startAt: instantColumn('start_at').notNull(),
    endAt: instantColumn('end_at').notNull(),
    completedAt: instantColumn('completed_at'),
    committedItemKeys: jsonb('committed_item_keys').$type<readonly string[]>().notNull(),
  },
  (table) => entityConstraints('sprints', table),
);

export const pullRequests = pgTable(
  'pull_requests',
  {
    ...entityBase(),
    repositoryKey: text('repository_key').notNull(),
    displayNumber: doublePrecision('display_number').notNull(),
    title: text('title').notNull(),
    state: text('state').notNull(),
    authorDeveloperKey: text('author_developer_key'),
    /**
     * The identifier the source itself attributed this to — `email:priya@acme.example`.
     *
     * Retained whether or not a link matched, and *that* is the point: attribution is
     * re-resolved through IdentityLink when a report is generated, so a merge or an
     * un-merge lands in the next report with no re-ingest, and removing a link makes
     * the artifact unattributed again instead of leaving a stale name on it. Without
     * this column the observed identity is lost the moment it matches, and un-merge
     * could only be approximated.
     */
    authorIdentityKey: text('author_identity_key'),
    createdAt: instantColumn('created_at').notNull(),
    mergedAt: instantColumn('merged_at'),
    closedAt: instantColumn('closed_at'),
    sourceBranch: text('source_branch').notNull(),
    targetBranch: text('target_branch').notNull(),
    headRevisionId: text('head_revision_id').notNull(),
    mergeRevisionId: text('merge_revision_id'),
    linkedItemKeys: jsonb('linked_item_keys').$type<readonly string[]>().notNull(),
    requestedReviewerKeys: jsonb('requested_reviewer_keys').$type<readonly string[]>().notNull(),
  },
  (table) => entityConstraints('pull_requests', table),
);

export const reviews = pgTable(
  'reviews',
  {
    ...entityBase(),
    pullRequestKey: text('pull_request_key').notNull(),
    reviewerDeveloperKey: text('reviewer_developer_key'),
    verdict: text('verdict').notNull(),
    submittedAt: instantColumn('submitted_at').notNull(),
    commentCount: doublePrecision('comment_count').notNull(),
  },
  (table) => [
    ...entityConstraints('reviews', table),
    index('reviews_org_pull_request_idx').on(table.organizationId, table.pullRequestKey),
  ],
);

export const commits = pgTable(
  'commits',
  {
    ...entityBase(),
    repositoryKey: text('repository_key').notNull(),
    revisionId: text('revision_id').notNull(),
    /** Null when no IdentityLink matched. Never a name-similarity guess. */
    authorDeveloperKey: text('author_developer_key'),
    /** Set when the author could not be resolved, so the work is still visible. */
    unmatchedIdentityKey: text('unmatched_identity_key'),
    /** The identifier the source attributed this to. See `pullRequests.authorIdentityKey`. */
    authorIdentityKey: text('author_identity_key'),
    authoredAt: instantColumn('authored_at').notNull(),
    message: text('message').notNull(),
    changedFileCount: doublePrecision('changed_file_count').notNull(),
    branchName: text('branch_name'),
    parentRevisionIds: jsonb('parent_revision_ids').$type<readonly string[]>().notNull(),
    /** The ticket key named in the commit message, if any. Never inferred. */
    ticketKey: text('ticket_key'),
  },
  (table) => [
    ...entityConstraints('commits', table),
    index('commits_org_author_idx').on(table.organizationId, table.authorDeveloperKey),
  ],
);

export const branchRefs = pgTable(
  'branch_refs',
  {
    ...entityBase(),
    repositoryKey: text('repository_key').notNull(),
    name: text('name').notNull(),
    revisionId: text('revision_id').notNull(),
    isDefault: boolean('is_default').notNull(),
  },
  (table) => entityConstraints('branch_refs', table),
);

export const releaseTags = pgTable(
  'release_tags',
  {
    ...entityBase(),
    repositoryKey: text('repository_key').notNull(),
    name: text('name').notNull(),
    revisionId: text('revision_id').notNull(),
    releasedAt: instantColumn('released_at').notNull(),
    description: text('description'),
  },
  (table) => entityConstraints('release_tags', table),
);

// ---------------------------------------------------------------------------
// The four judgement families the report is made of.
// ---------------------------------------------------------------------------

/**
 * The shape shared by Blocker, Risk, Recommendation and Win.
 *
 * `subject_kind` / `subject_key` point at the entity the judgement is about, and
 * together with the cause they form the natural key — never the report id and
 * never the run id. That is what makes the same condition on consecutive days one
 * row with a growing `last_seen_at`, which is what "day 6" is counted from.
 */
const judgementColumns = () => ({
  subjectKind: text('subject_kind').notNull(),
  subjectKey: text('subject_key').notNull(),
  teamKey: text('team_key'),
  summary: text('summary').notNull(),
  /** `open` or `resolved`. A resolved row is kept; history is never deleted. */
  state: text('state').notNull(),
  detectedAt: instantColumn('detected_at').notNull(),
  resolvedAt: instantColumn('resolved_at'),
  evidence: jsonb('evidence').$type<readonly Record<string, string>[]>().notNull(),
});

export const blockers = pgTable(
  'blockers',
  {
    ...entityBase(),
    ...judgementColumns(),
    /** Why Compass believes it is blocked, e.g. `tracker_flag`. */
    cause: text('cause').notNull(),
  },
  (table) => entityConstraints('blockers', table),
);

export const risks = pgTable(
  'risks',
  {
    ...entityBase(),
    ...judgementColumns(),
    cause: text('cause').notNull(),
    /** `low` | `medium` | `high`, carried as text so it is readable in psql. */
    severity: text('severity').notNull(),
  },
  (table) => entityConstraints('risks', table),
);

export const recommendations = pgTable(
  'recommendations',
  {
    ...entityBase(),
    ...judgementColumns(),
    cause: text('cause').notNull(),
    /** The single action, written as an imperative sentence. */
    action: text('action').notNull(),
  },
  (table) => entityConstraints('recommendations', table),
);

export const wins = pgTable(
  'wins',
  {
    ...entityBase(),
    ...judgementColumns(),
    cause: text('cause').notNull(),
  },
  (table) => entityConstraints('wins', table),
);

// ---------------------------------------------------------------------------
// The manager's own hand.
// ---------------------------------------------------------------------------

/**
 * A Manager Memo: the one place the manager writes *into* the org model.
 *
 * Every other declared entity is configuration. This one is an assertion about the
 * world that contradicts what Compass inferred — "Marcus is out", "we dropped that
 * from the sprint", "the vendor is blocking us" — and the report has to honour it.
 *
 * ## Why the kind is a closed five and the database says so too
 *
 * `memo_kind` carries a CHECK against exactly `unavailable`, `descoped`,
 * `reprioritized`, `external_blocker`, `context_note`. The application validates the
 * same five before it ever reaches here, and that duplication is the point: the
 * validator is what produces a *refusal* a manager can read, and the constraint is
 * what makes "a sixth kind was quietly written by a script" impossible rather than
 * merely unlikely. An open vocabulary here would turn every downstream `switch` into
 * a silent no-op branch — the effect would just not happen, with nothing to see.
 *
 * `memo_kind` is NOT NULL, unlike the placeholder this replaces. A memo only exists
 * once extraction has classified it: an unclassifiable line is refused and never
 * persisted, and a memo whose *subject* is ambiguous waits for the manager to pick a
 * candidate rather than landing here half-formed. So there is no state in which a row
 * exists without a kind, and allowing one would have meant every reader carrying a
 * branch for a case the write path cannot produce.
 *
 * ## Effective dating, and the exactly-one rule
 *
 * `effective_from` is always set. Either `effective_until` names the end or
 * `open_ended` is true, never both and never neither — a CHECK enforces the
 * biconditional. "Out until Thursday" and "out indefinitely" are different
 * assertions, and a memo that was silently open-ended because a date failed to parse
 * would suppress findings forever.
 *
 * ## The subject, and its confidence
 *
 * `subject_kind` + `subject_key` bind the memo to one entity. `subject_confidence`
 * records how sure resolution was, and `subject_candidates` + `disambiguated_by_user_id`
 * record the case where it was not sure enough and a human chose — so "why is this
 * memo about Marcus Hale rather than Marcus Webb" is answerable a month later.
 *
 * `raw_text` is verbatim, always, and is never re-parsed into anything: it is the
 * record of what the manager actually said, which has to survive every later change
 * to the extractor.
 */
export const managerMemos = pgTable(
  'manager_memos',
  {
    ...entityBase(),
    authorUserId: uuid('author_user_id'),
    submittedAt: instantColumn('submitted_at').notNull(),
    /** Verbatim. Never normalised, never re-parsed — the record of what was said. */
    rawText: text('raw_text').notNull(),
    /** One of the closed five. CHECK-constrained in the migration. */
    memoKind: text('memo_kind').notNull(),
    /** `active` while it applies, `expired` once the clock passed `effective_until`. */
    status: text('status').notNull(),
    /** The validated typed assertion, as the closed schema produced it. */
    extracted: jsonb('extracted'),

    /** The entity this memo asserts something about. */
    subjectKind: text('subject_kind').notNull(),
    subjectKey: text('subject_key').notNull(),
    /** 0–1. Below the threshold, a human chose from `subject_candidates`. */
    subjectConfidence: doublePrecision('subject_confidence').notNull(),
    /** The 2–3 candidates offered, when resolution had to ask. Null when it did not. */
    subjectCandidates: jsonb('subject_candidates'),
    /** Who resolved the ambiguity. Null when there was none to resolve. */
    disambiguatedByUserId: uuid('disambiguated_by_user_id'),

    effectiveFrom: instantColumn('effective_from').notNull(),
    /** Null exactly when `open_ended` is true; a CHECK enforces the pairing. */
    effectiveUntil: instantColumn('effective_until'),
    openEnded: boolean('open_ended').notNull(),

    /** `email` | `slack` | `web` — which of the three intakes carried it. */
    sourceChannel: text('source_channel').notNull(),
  },
  (table) => [
    ...entityConstraints('manager_memos', table),
    index('manager_memos_org_subject_idx').on(table.organizationId, table.subjectKind, table.subjectKey),
    index('manager_memos_org_effective_idx').on(table.organizationId, table.effectiveFrom),
  ],
);

/**
 * A manager's verdict on one report item, keyed by the item's stable id so the
 * verdict survives the next report.
 */
export const feedbackEntries = pgTable(
  'feedback_entries',
  {
    ...entityBase(),
    /**
     * The derived id of the item the verdict was given on.
     *
     * Kept for the lookup — it is what a URL, a Slack button value and an index all use — but it
     * is **not** what the verdict is keyed on. The three `cause_*` columns are. A digest is a
     * function of `STABLE_ID_VERSION`, and that tag exists precisely so identity can be reset
     * deliberately; keying dismissals on the digest would silently orphan every one of them the
     * day it moved, which is the opposite of a reset a manager notices.
     */
    reportItemStableId: text('report_item_stable_id').notNull(),
    /** `kind:naturalKey` — `ticket:PLAT-742`. The condition's own coordinates. */
    causeEntityRef: text('cause_entity_ref').notNull(),
    causeKind: text('cause_kind').notNull(),
    /** `''` when the cause needs none. Never null: the key has to be total. */
    causeDiscriminator: text('cause_discriminator').notNull(),
    authorUserId: uuid('author_user_id'),
    /**
     * The closed vocabulary: `dismiss_risk` | `off_goal_flag_wrong` | `accept_recommendation` |
     * `reject_recommendation` | `blocker_already_resolved` | `snooze`.
     *
     * Constrained in the database as well as in `@compass/analysis`, so a sixth value cannot be
     * written by any path — a verdict the pipeline does not understand would be a row that
     * silently suppressed nothing.
     */
    action: text('action').notNull(),
    /** The manager's own words. Required by the UI for a dismissal; nullable here. */
    reason: text('reason'),
    note: text('note'),
    /** Non-null only for `snooze`. Half-open: the item returns at this instant. */
    snoozeUntil: instantColumn('snooze_until'),
    /**
     * The severity score at the moment of the verdict.
     *
     * The baseline a dismissed risk's return is measured against. Null means "no baseline", which
     * suppresses indefinitely rather than resurfacing on the first measurement — a baseline of
     * zero would make every dismissal last exactly one day.
     */
    severityScoreAtVerdict: integer('severity_score_at_verdict'),
    /** `web` | `email` | `slack`. Where the click came from, for the audit. */
    sourceChannel: text('source_channel').notNull(),
    /**
     * The report the manager was reading, recorded but deliberately **not** a foreign key.
     *
     * `saveReport` deletes and rewrites the report row on every replay — a backfill, a
     * Correction, a cold start re-running today — so a real reference would either break the
     * replay with a constraint violation or force the replay to delete the feedback. Feedback
     * outlives the page it was given on: that is the whole point of it.
     */
    reportId: uuid('report_id'),
    submittedAt: instantColumn('submitted_at').notNull(),
  },
  (table) => [
    ...entityConstraints('feedback_entries', table),
    index('feedback_entries_org_item_idx').on(table.organizationId, table.reportItemStableId),
    index('feedback_entries_org_cause_idx').on(
      table.organizationId,
      table.causeEntityRef,
      table.causeKind,
      table.causeDiscriminator,
    ),
  ],
);
