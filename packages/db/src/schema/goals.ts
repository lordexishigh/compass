import { boolean, doublePrecision, index, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

import { instantColumn, organizationId } from './columns.js';
import { organizations } from './tables.js';

/**
 * The goal hierarchy store, and the alignment links resolved against it.
 *
 * Alignment is the claim Compass is positioned on, so the chain it resolves
 * against has to be a stored, editable, *versioned* object rather than a config
 * file somebody edited last quarter. Three tables, each append-only:
 *
 *  - `objective_versions` — the chain itself: company objective → quarter
 *    objective → sprint goal. One row per revision of one node.
 *  - `objective_scope_links` — the chain downward: which Feature or ticket a
 *    manager has attached to which node. One row per revision of one attachment.
 *  - `objective_links` — the *output* of resolution: which node a commit or ticket
 *    resolved to, through which tier, with the exact evidence.
 *
 * ## Effective dating: two axes, and the reason for both
 *
 * This is the definition the rest of Compass reuses — `alpha-configuration-and-
 * identity-roster` applies the same shape to teams, projects and repositories — so
 * it is worth being exact about which instant answers which question.
 *
 *  - **`effective_from` / `effective_until` — the goal's own horizon.** "Q3 runs
 *    1 July to 30 September." Business data the manager states. `effective_until`
 *    is nullable and null means open-ended; it is *never* written to seal a row
 *    that has been superseded.
 *  - **`recorded_at` — when Compass came to believe this wording.** An edit appends
 *    a revision with a later `recorded_at` and touches nothing. A revision is
 *    therefore in force over `[recorded_at, next revision's recorded_at)`, which is
 *    derived rather than stored.
 *
 * The end of a belief window is deliberately *not* a column, for the same reason
 * `sprint_scope_changes.after_sprint_start` is not one: writing it would mean
 * UPDATEing a row that a persisted report has already cited, and these tables are
 * append-only precisely so that cannot happen. The one implementation of the
 * derivation is `goalHierarchyAt` in `packages/analysis/src/goal-hierarchy.ts`, and
 * every reader goes through it — the report pipeline, the goals API's `?at=`
 * parameter and the tests alike.
 *
 * An archive is an append too: `archived = true` on a new revision. The history of
 * a goal abandoned mid-quarter survives the abandonment, which is what lets a
 * manager ask in October what August's report was measured against.
 */

/**
 * One revision of one goal node.
 *
 * `node_id` is the stable identity and is chosen to be a thing a human recognises
 * — an objective is its own key (`OBJ-Q3-PLAT`), a sprint goal is
 * `PLAT/Sprint 46` — because these ids are printed verbatim in the evidence panel
 * as the chain a verdict resolved through. A surrogate would make the panel
 * unreadable.
 */
export const objectiveVersions = pgTable(
  'objective_versions',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    nodeId: text('node_id').notNull(),
    /** 1 for the first statement of this goal, then one higher per edit. */
    revision: integer('revision').notNull(),
    /** `company`, `quarter` or `sprint_goal`. */
    objectiveKind: text('objective_kind').notNull(),
    parentNodeId: text('parent_node_id'),
    title: text('title').notNull(),
    /** The goal's own horizon. Null `effective_until` means open-ended. */
    effectiveFrom: instantColumn('effective_from').notNull(),
    effectiveUntil: instantColumn('effective_until'),
    /** The manager's declaration that today's work is measured against this goal. */
    isCurrent: boolean('is_current').notNull(),
    /** An archive is a new revision, never a delete. */
    archived: boolean('archived').notNull(),
    /** `declared` (a manager wrote it) or `observed` (synced from a sprint goal). */
    origin: text('origin').notNull(),
    /** What a `sprint_goal` node belongs to: `sprint`, and the sprint's natural key. */
    subjectKind: text('subject_kind'),
    subjectKey: text('subject_key'),
    /** When this revision was recorded — the belief axis. Supplied, never `now()`. */
    recordedAt: instantColumn('recorded_at').notNull(),
    /** Who edited it. Null for a sync, which is nobody's opinion. */
    recordedBy: text('recorded_by'),
    /** Why, in the manager's words. Null when there was nothing to say. */
    changeNote: text('change_note'),
  },
  (table) => [
    unique('objective_versions_org_node_revision_key').on(table.organizationId, table.nodeId, table.revision),
    index('objective_versions_org_node_recorded_idx').on(table.organizationId, table.nodeId, table.recordedAt),
  ],
);

/**
 * A declared attachment of a work item to a goal node.
 *
 * This is the "down to Feature/epic and ticket" half of the chain, and the half a
 * manager edits when the structural resolution is wrong. Detaching appends a
 * revision with `detached = true`, so the report that cited the link six weeks ago
 * still resolves.
 */
export const objectiveScopeLinks = pgTable(
  'objective_scope_links',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    /** Stable across revisions: `<node>|<subject kind>|<subject key>`. */
    linkKey: text('link_key').notNull(),
    revision: integer('revision').notNull(),
    nodeId: text('node_id').notNull(),
    /** `feature`, `ticket`, `sprint` or `project`. */
    subjectKind: text('subject_kind').notNull(),
    subjectKey: text('subject_key').notNull(),
    effectiveFrom: instantColumn('effective_from').notNull(),
    effectiveUntil: instantColumn('effective_until'),
    detached: boolean('detached').notNull(),
    recordedAt: instantColumn('recorded_at').notNull(),
    recordedBy: text('recorded_by'),
  },
  (table) => [
    unique('objective_scope_links_org_link_revision_key').on(table.organizationId, table.linkKey, table.revision),
    index('objective_scope_links_org_subject_idx').on(table.organizationId, table.subjectKind, table.subjectKey),
  ],
);

/**
 * One resolved alignment link: what this commit or ticket serves, and how Compass
 * knows.
 *
 * Written per (report instant, subject), so the row is the audit trail of a
 * verdict a manager may argue with weeks later. Which columns are populated says
 * which tier resolved it, and that is deliberate rather than tidy:
 *
 *  - `configured` — `chain_node_ids` holds the full chain, leaf first.
 *  - `inferred` — `matched_substring`, `matched_offset` and `matched_in` hold the
 *    exact string and where it was found, so the panel can underline it in place.
 *  - `semantic` — `score`, `threshold`, `compared_text_a` and `compared_text_b`
 *    hold the whole comparison.
 *
 * There is no row for unattributed work, and that absence is the point: no link,
 * no verdict. The count of unattributed subjects is the difference between the
 * subjects resolved and the rows written, and the report states it as a question.
 */
export const objectiveLinks = pgTable(
  'objective_links',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    /** The instant the resolution was computed *for*. Time travel sets this. */
    reportInstant: instantColumn('report_instant').notNull(),
    /** `commit` or `ticket`. */
    subjectKind: text('subject_kind').notNull(),
    subjectKey: text('subject_key').notNull(),
    /** What a human says out loud: `PLAT-742`, `4f5a6b7`. */
    subjectLabel: text('subject_label').notNull(),
    /** `configured`, `inferred` or `semantic`. Never `unattributed`. */
    source: text('source').notNull(),
    nodeId: text('node_id'),
    nodeRevision: integer('node_revision'),
    /** The chain, leaf first, exactly as the verdict resolved it. */
    chainNodeIds: jsonb('chain_node_ids').$type<readonly string[]>().notNull(),
    matchedSubstring: text('matched_substring'),
    matchedOffset: integer('matched_offset'),
    /** `commit_message` or `branch_name`. */
    matchedIn: text('matched_in'),
    score: doublePrecision('score'),
    threshold: doublePrecision('threshold'),
    comparedTextA: text('compared_text_a'),
    comparedTextB: text('compared_text_b'),
    /** Whether the objective above this node is the current one. */
    servesCurrentObjective: boolean('serves_current_objective'),
    recordedAt: instantColumn('recorded_at').notNull(),
  },
  (table) => [
    unique('objective_links_org_instant_subject_key').on(
      table.organizationId,
      table.reportInstant,
      table.subjectKind,
      table.subjectKey,
    ),
    index('objective_links_org_subject_idx').on(table.organizationId, table.subjectKind, table.subjectKey),
    index('objective_links_org_node_idx').on(table.organizationId, table.nodeId),
  ],
);
