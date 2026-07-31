import { index, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

import { instantColumn, organizationId } from './columns.js';
import { organizations } from './tables.js';
import { reports } from './reports.js';

/**
 * NarrationTrace: one row per attempt to have a model write one section.
 *
 * Every narration is traced, not only the failures. That is the point of the table:
 * the claim Compass makes is "the LLM originated nothing", and a claim like that is
 * only worth anything if it can be audited after the fact. Six weeks later, a
 * manager disputing a sentence should be answerable with the model id, the prompt
 * version, the hash of the exact prompt, which attempt this was, and what the
 * grounding validator said about it.
 *
 * ## Why the prompt is hashed rather than stored
 *
 * The prompt contains the section payload, and the payload is already stored
 * verbatim on `report_sections.payload`. Storing it twice would double the row size
 * of the busiest write in the system to hold a second copy of bytes that are
 * already there. The hash covers the prompt version, the system prompt and the user
 * message, so "was this written from the payload we have?" is a comparison rather
 * than a diff — and a prompt edit that changed behaviour changes the hash even when
 * the payload did not.
 *
 * ## Not append-only, and deliberately so
 *
 * A trace row is never corrected, but it is also not a Correction: it records an
 * event, and the event is keyed by `(report, section, attempt)`. Re-running the
 * pipeline for the same instant replaces the report's rows — including these —
 * because a replayed run's traces describe the report that now exists, and keeping
 * the superseded run's attempts would make "how many attempts did this report take"
 * unanswerable.
 */
export const narrationTraces = pgTable(
  'narration_traces',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId().references(() => organizations.id),
    reportId: uuid('report_id')
      .notNull()
      .references(() => reports.id),
    /** yesterday | progress | blockers | risks | recommendations | wins. */
    sectionKey: text('section_key').notNull(),
    /** `anthropic`, or a testkit fake's id. Never inferred from the model name. */
    narratorId: text('narrator_id').notNull(),
    /** The pinned model id that answered — `claude-sonnet-5`. */
    model: text('model').notNull(),
    /** sha256 over (prompt version, system prompt, user message). */
    promptHash: text('prompt_hash').notNull(),
    /** `narrate-section/1`. Bumped whenever the prompt text changes. */
    promptVersion: text('prompt_version').notNull(),
    /** 1-based. Unique per (report, section). */
    attempt: integer('attempt').notNull(),
    /** How many attempts this section consumed in total. Same on every row. */
    attemptCount: integer('attempt_count').notNull(),
    /** grounded | rejected | refused | unavailable | malformed. */
    outcome: text('outcome').notNull(),
    /**
     * The tokens the validator could not trace, named.
     *
     * Stored as text rather than counted, because "it rejected 3 tokens" is not
     * actionable and "it invented `#999917`" is. This is the column somebody reads
     * when the fallback rate moves.
     */
    untraceableTokens: text('untraceable_tokens').array().notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    proseLength: integer('prose_length').notNull(),
    /** One sentence, in the product's voice. What the log line said. */
    detail: text('detail').notNull(),
    /** Passed in by the edge. This layer never reads a clock. */
    recordedAt: instantColumn('recorded_at').notNull(),
  },
  (table) => [
    unique('narration_traces_report_section_attempt_key').on(table.reportId, table.sectionKey, table.attempt),
    index('narration_traces_org_outcome_idx').on(table.organizationId, table.outcome),
    index('narration_traces_report_idx').on(table.reportId),
  ],
);
