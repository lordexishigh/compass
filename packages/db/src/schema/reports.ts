import { boolean, index, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

import { instantColumn, organizationId } from './columns.js';
import { ingestRuns, organizations } from './tables.js';

/**
 * Persisted reports.
 *
 * A report row is not a cache of something recomputable. It is what a manager
 * read on a given morning, and Compass has to be able to show it back to them
 * unchanged — after the tracker has been corrected, after the sprint has closed,
 * after the analysis thresholds have moved. So three things are stored, not one:
 *
 *  1. the **verbatim structured payload**, exactly as the analysis core emitted
 *     it, canonically serialised;
 *  2. the **rendered prose**, exactly as it was shown; and
 *  3. the **content hash** over the payload with the documented non-semantic
 *     fields removed, which is what makes "the same report" a checkable claim
 *     rather than an eyeball comparison.
 *
 * The payload is stored as canonical JSON text rather than as `jsonb` where
 * byte-identity matters, because `jsonb` normalises key order and whitespace: it
 * would round-trip to an *equal* value but not to the same bytes, and the whole
 * determinism gate is stated in bytes. The parsed form is kept alongside it in
 * `payload` for querying.
 */

/** The six sections, by database ordinal. Never insertion order — see below. */
export const REPORT_SECTION_COUNT = 6;

export const reports = pgTable(
  'reports',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    /** `team` or `merged`. */
    scopeKind: text('scope_kind').notNull(),
    /** The team key, or `*` for a merged report. Never null, so the key is total. */
    scopeKey: text('scope_key').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    /** The instant the report was generated *for*. Time travel sets this. */
    reportInstant: instantColumn('report_instant').notNull(),
    /** That instant as a civil date in `timezone` — what the masthead prints. */
    reportDate: text('report_date').notNull(),
    timezone: text('timezone').notNull(),
    windowStart: instantColumn('window_start').notNull(),
    windowEnd: instantColumn('window_end').notNull(),
    /** sha256 over the canonical payload, non-semantic fields excluded. */
    contentHash: text('content_hash').notNull(),
    /** The structured payload, verbatim, as canonical JSON text. */
    payloadJson: text('payload_json').notNull(),
    /** The same payload parsed, so a query can reach inside it. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    /** The prose a manager actually read, whole-report. */
    prose: text('prose').notNull(),
    /**
     * The change line, as it was rendered: what moved since the previous report.
     *
     * Its own column rather than re-derived by each channel, because the email and Slack read the
     * *stored* report rather than re-rendering it — that is what stops the page and the inbox
     * disagreeing about what Compass said. Deriving the line again in the delivery path would
     * reintroduce exactly that divergence for the one sentence that decides how the rest of the
     * report is read. Defaults to empty, which is the honest value for a report written before
     * change-awareness existed.
     */
    changeLine: text('change_line').notNull().default(''),
    /** Which renderer produced `prose` — `template` or `narrated`. */
    rendererId: text('renderer_id').notNull(),
    /**
     * True when narration was attempted and this report was rendered by the
     * template renderer instead.
     *
     * A separate boolean rather than an inference from `renderer_id`, because the
     * two answer different questions. `renderer_id = 'template'` is also the
     * honest value on a deployment with no Anthropic key, where nothing was
     * attempted and nothing degraded. This column says *narration was supposed to
     * happen and did not*, which is the number an operator alerts on and the fact
     * the page discloses above the report.
     */
    fallbackRenderer: boolean('fallback_renderer').notNull().default(false),
    /**
     * Why, in one sentence, in the product's voice.
     *
     * Null exactly when `fallback_renderer` is false. Shown to the reader — a
     * degraded report that will not say how it was degraded is the "confident
     * polish" this product exists to refuse.
     */
    fallbackReason: text('fallback_reason'),
    /** complete | partial | unavailable. Never inferred from a row count. */
    coverageStatus: text('coverage_status').notNull(),
    /** The ingest run this report was computed against, when there was one. */
    ingestRunId: uuid('ingest_run_id').references(() => ingestRuns.id),
    /** When generation happened. Non-semantic: excluded from `content_hash`. */
    generatedAt: instantColumn('generated_at').notNull(),
  },
  (table) => [
    unique('reports_org_scope_instant_key').on(
      table.organizationId,
      table.scopeKind,
      table.scopeKey,
      table.reportInstant,
    ),
    index('reports_org_scope_date_idx').on(table.organizationId, table.scopeKind, table.scopeKey, table.reportDate),
  ],
);

/**
 * One row per section — always six, always in the same order.
 *
 * `ordinal` is an explicit column and is uniquely constrained per report. Order
 * is a product guarantee ("a manager learns the geography of the page in two
 * days"), and relying on insertion order to express it would mean the guarantee
 * held only for as long as nobody added a `LIMIT` or a parallel insert.
 */
export const reportSections = pgTable(
  'report_sections',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    reportId: uuid('report_id')
      .notNull()
      .references(() => reports.id),
    /** yesterday | progress | blockers | risks | recommendations | wins. */
    sectionKey: text('section_key').notNull(),
    /** 1–6, fixed forever. */
    ordinal: integer('ordinal').notNull(),
    title: text('title').notNull(),
    /** The section's prose, as rendered. */
    prose: text('prose').notNull(),
    /** The structured section, verbatim. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    itemCount: integer('item_count').notNull(),
    /** What the section says when it has nothing to say. Never blank. */
    emptyStatement: text('empty_statement').notNull(),
    summary: text('summary'),
  },
  (table) => [
    unique('report_sections_report_ordinal_key').on(table.reportId, table.ordinal),
    unique('report_sections_report_section_key').on(table.reportId, table.sectionKey),
    index('report_sections_org_idx').on(table.organizationId),
  ],
);

/**
 * One row per claim: a Yesterday completion, a blocker, a risk, a
 * recommendation, a win, a progress figure.
 *
 * This is the row the web view links *from*. Its evidence lives in
 * `report_item_evidence` with the identifiers kept apart as typed columns, so
 * resolving "which artifact page does this claim open" is a lookup rather than a
 * re-parse of the prose.
 */
export const reportItems = pgTable(
  'report_items',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    reportId: uuid('report_id')
      .notNull()
      .references(() => reports.id),
    reportSectionId: uuid('report_section_id')
      .notNull()
      .references(() => reportSections.id),
    ordinal: integer('ordinal').notNull(),
    /** Derived from the entity and the cause, so the same condition on two days
     *  is one item with a history rather than two unrelated ones. */
    stableId: text('stable_id').notNull(),
    headline: text('headline').notNull(),
    detail: text('detail').notNull(),
    /**
     * The sentences the renderer wrote for this claim.
     *
     * Stored beside the section's prose rather than derived from it: the web
     * view attaches an evidence marker to each claim's own paragraph, and
     * splitting the section string back apart by index would attach one claim's
     * evidence to another's sentences the first time a renderer emitted a
     * paragraph that was not an item.
     */
    prose: text('prose').notNull(),
    /**
     * The three coordinates `stable_id` was derived from.
     *
     * Stored as typed columns rather than left inside `payload`, because they are what a
     * *feedback row* is keyed on: a manager clicking "dismiss" gives Compass an item id, and
     * the handler has to turn that into the coordinates a verdict is recorded against. Reading
     * them out of a jsonb blob would work until the payload shape moved; a column will not.
     */
    causeEntityRef: text('cause_entity_ref').notNull(),
    causeKind: text('cause_kind').notNull(),
    /** `''` when the cause needs no further distinction — never null, so the key is total. */
    causeDiscriminator: text('cause_discriminator').notNull(),
    /** new | unchanged | worsened | improved | resolved. */
    changeTag: text('change_tag').notNull(),
    /** The age of the *condition*, from the knowledge model's own history. */
    ageDays: integer('age_days').notNull(),
    /**
     * The first report that carried this item id.
     *
     * A different fact from `age_days`, and the column tomorrow's report reads back: the change
     * tag is computed against these rows, so the age a persisting item accrues is carried
     * forward here rather than recomputed from a condition's own clock.
     */
    firstSeenAt: instantColumn('first_seen_at').notNull(),
    /**
     * The one ordered quantity the next report compares this item against. Higher is worse.
     *
     * Persisted because the comparison is between *reports*, not between snapshots: tomorrow's
     * run reads this number to decide whether the same condition worsened, and re-deriving it
     * from a snapshot that has since moved would compare today against today.
     */
    severityScore: integer('severity_score').notNull(),
    /** When the underlying condition began — what an "already resolved" verdict is keyed on. */
    signalOnsetAt: instantColumn('signal_onset_at').notNull(),
    /** `accepted` | `resurfaced`, when a manager's own verdict is on this item. */
    feedbackState: text('feedback_state'),
    /** The run-in italic clause. Never a badge saying NEW. */
    changeClause: text('change_clause'),
    /** The five-notch completion meter, on Yesterday and Wins items only. */
    ladder: jsonb('ladder').$type<Record<string, unknown>>(),
    hasLadder: boolean('has_ladder').notNull(),
    /** The structured item, verbatim. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    unique('report_items_section_ordinal_key').on(table.reportSectionId, table.ordinal),
    unique('report_items_section_stable_id_key').on(table.reportSectionId, table.stableId),
    index('report_items_org_report_idx').on(table.organizationId, table.reportId),
  ],
);

/**
 * The evidence behind one claim, one row per reference.
 *
 * `commit_sha`, `pull_request_number` and `issue_key` are discrete typed
 * columns rather than a blob, because the acceptance criterion the web view has
 * to meet is that every claim carries a link that *resolves* — and a link that
 * resolves needs an identifier the artifact page can look up, not a label it has
 * to guess the shape of. Exactly one of the three is set for a code or tracker
 * artifact; a branch, release, sprint or message reference sets none of them and
 * is resolved by `(artifact_kind, artifact_id)` instead.
 */
export const reportItemEvidence = pgTable(
  'report_item_evidence',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    reportId: uuid('report_id')
      .notNull()
      .references(() => reports.id),
    reportItemId: uuid('report_item_id')
      .notNull()
      .references(() => reportItems.id),
    ordinal: integer('ordinal').notNull(),
    /** commit | pull_request | issue | branch | release | message | memo | sprint. */
    kind: text('kind').notNull(),
    /** What a human would say out loud: `CHK-701`, `#9201`, `7a8b9c0`. */
    label: text('label').notNull(),
    sourceKey: text('source_key').notNull(),
    sourceRecordId: text('source_record_id').notNull(),
    commitSha: text('commit_sha'),
    pullRequestNumber: integer('pull_request_number'),
    issueKey: text('issue_key'),
    /** The in-app artifact route this evidence opens. */
    artifactKind: text('artifact_kind').notNull(),
    artifactId: text('artifact_id').notNull(),
  },
  (table) => [
    unique('report_item_evidence_item_ordinal_key').on(table.reportItemId, table.ordinal),
    index('report_item_evidence_org_artifact_idx').on(table.organizationId, table.artifactKind, table.artifactId),
  ],
);
