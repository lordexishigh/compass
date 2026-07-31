import { createHash } from 'node:crypto';

import { recordAudit } from '@compass/auth';
import { toIso, type Instant } from '@compass/clock';
import type { ScopedDb } from '@compass/db';
import { KnowledgeStore, recordAbsence } from '@compass/knowledge-model';

import type { MemoAssertion, MemoSourceChannel, ResolvedWindow } from './assertion.js';
import {
  extractMemo,
  type ExtractionRefusal,
  type ExtractorPort,
} from './extract.js';
import {
  SUBJECT_CONFIDENCE_THRESHOLD,
  resolveSubject,
  type SubjectCandidate,
  type SubjectResolution,
} from './subject.js';

/**
 * `submitMemo` — the one door into the org model.
 *
 * All three intakes call this and do nothing else of consequence: the Slack adapter verifies a
 * signature and calls it, the Resend adapter verifies a signature and calls it, the web form
 * calls it. That is what makes "a memo submitted through each of the three channels produces an
 * identical row apart from the source field" true by construction rather than by three
 * carefully-matched implementations that drift apart on the first bug fix.
 *
 * ## The four outcomes, and why none of them is "saved with a warning"
 *
 * A submission ends in exactly one of: `recorded`, `refused`, `needs_subject`, or
 * `subject_unknown`. Three of those persist nothing. There is deliberately no "saved but
 * unresolved" state, because a memo the report cannot act on is worse than no memo — the
 * manager believes they have told Compass something, and tomorrow's report contradicts them
 * anyway with no explanation available to either party.
 *
 * ## Why `unavailable` writes through the roster service
 *
 * An accepted `unavailable` memo becomes an Absence, and it becomes one by calling
 * `recordAbsence` — the roster's single writer — with `source: 'memo'` and the memo's own key
 * as `sourceRef`. It does not touch the `absences` table and it does not implement suppression.
 * That matters for a reason beyond tidiness: the suppression rule in
 * `packages/analysis/src/absence-suppression.ts` reads Absence rows and states a reason with a
 * link to whatever produced them, so routing memos through the same writer means the memo path
 * inherits suppression, the reason sentence and the citation for free — and there is exactly
 * one implementation to be right. `tools/quality-gates/tests/roster-single-writer.test.ts`
 * fails the build if this file ever observes an `absence` directly.
 */

export interface MemoSubmission {
  readonly rawText: string;
  readonly channel: MemoSourceChannel;
  /** Null for a memo that arrived without a resolvable author (an unmatched email address). */
  readonly authorUserId: string | null;
  readonly now: Instant;
  readonly timezone: string;
  /**
   * Set when the manager has already chosen from `needs_subject` candidates. Skips resolution
   * and binds the memo to exactly this entity, recording that a human decided.
   */
  readonly chosenSubjectKey?: string;
  /**
   * The candidates that were offered, echoed back with the choice.
   *
   * Stored on the memo so "why is this about Marcus Hale rather than Marcus Webb" is answerable
   * later. Without it the row would say a human chose but not what they chose *between*, which
   * is the half that makes the record worth keeping.
   */
  readonly offeredCandidates?: readonly SubjectCandidate[];
}

export interface RecordedMemo {
  readonly status: 'recorded';
  readonly memoKey: string;
  readonly assertion: MemoAssertion;
  readonly window: ResolvedWindow;
  readonly subjectKey: string;
  readonly subjectLabel: string;
  /** Set when the memo also wrote an Absence through the roster service. */
  readonly absenceKey: string | null;
  /** The sentence the channel replies with. */
  readonly detail: string;
}

export interface NeedsSubject {
  readonly status: 'needs_subject';
  readonly candidates: readonly SubjectCandidate[];
  readonly detail: string;
  /**
   * Everything needed to finish once a candidate is chosen. Held by the caller rather than
   * persisted: a half-written memo in the table would appear on the memo list as though it
   * were in force.
   */
  readonly pending: { readonly rawText: string; readonly channel: MemoSourceChannel };
}

export interface SubjectUnknown {
  readonly status: 'subject_unknown';
  readonly detail: string;
}

export type MemoOutcome = RecordedMemo | ExtractionRefusal | NeedsSubject | SubjectUnknown;

/**
 * `memo:<iso instant>:<channel>:<text digest>` — and the digest earns its place.
 *
 * Keyed on the instant, the channel *and* the text, which makes re-submitting the identical
 * memo idempotent rather than duplicative. That is not a hypothetical nicety: Slack retries an
 * event whose acknowledgement it did not see, and Resend retries an inbound webhook the same
 * way, so the same sentence arriving twice is the ordinary case rather than the strange one.
 * Without the digest the key would also collide for two *different* memos submitted in the same
 * millisecond on the same channel — `observe` would treat the second as an edit of the first and
 * silently overwrite what the manager said.
 *
 * Truncated to 12 hex characters: this is a collision-avoidance discriminator inside a key that
 * already contains the instant and the channel, not a security boundary.
 */
export const memoKey = (submittedAt: Instant, channel: MemoSourceChannel, rawText: string): string =>
  `memo:${toIso(submittedAt)}:${channel}:${createHash('sha256').update(rawText.trim()).digest('hex').slice(0, 12)}`;

export interface SubmitMemoDependencies {
  readonly scoped: ScopedDb;
  readonly extractor: ExtractorPort;
}

export async function submitMemo(
  dependencies: SubmitMemoDependencies,
  submission: MemoSubmission,
): Promise<MemoOutcome> {
  const { scoped, extractor } = dependencies;
  const store = new KnowledgeStore(scoped);

  const extraction = await extractMemo(extractor, {
    rawText: submission.rawText,
    now: submission.now,
    timezone: submission.timezone,
  });
  if (extraction.status === 'refused') return extraction;

  const { assertion, window } = extraction;

  // ---- the subject ----------------------------------------------------------
  let subjectKey: string;
  let subjectLabel: string;
  let confidence: number;
  let candidates: readonly SubjectCandidate[] | null = null;
  let disambiguatedByUserId: string | null = null;

  if (submission.chosenSubjectKey !== undefined) {
    // The manager already answered. Their choice is authoritative and is recorded as such —
    // confidence 1 because a human decided, not because the matcher improved.
    const chosen = submission.chosenSubjectKey;
    subjectKey = chosen;
    subjectLabel =
      submission.offeredCandidates?.find((candidate) => candidate.subjectKey === chosen)?.label ?? chosen;
    confidence = 1;
    candidates = submission.offeredCandidates ?? null;
    disambiguatedByUserId = submission.authorUserId;
  } else {
    const resolution: SubjectResolution = await resolveSubject(store, assertion.subjectKind, assertion.subjectHint);

    if (resolution.status === 'not_found') {
      return { status: 'subject_unknown', detail: resolution.detail };
    }
    if (resolution.status === 'ambiguous' || resolution.confidence < SUBJECT_CONFIDENCE_THRESHOLD) {
      const offered =
        resolution.status === 'ambiguous'
          ? resolution.candidates
          : [
              {
                subjectKind: assertion.subjectKind,
                subjectKey: resolution.subjectKey,
                label: resolution.label,
                reason: 'the closest match, but not close enough to assume',
              },
            ];
      return {
        status: 'needs_subject',
        candidates: offered,
        detail: resolution.status === 'ambiguous' ? resolution.detail : 'Compass is not sure who this is about.',
        pending: { rawText: submission.rawText, channel: submission.channel },
      };
    }

    subjectKey = resolution.subjectKey;
    subjectLabel = resolution.label;
    confidence = resolution.confidence;
  }

  // ---- persist the memo -----------------------------------------------------
  const key = memoKey(submission.now, submission.channel, submission.rawText);

  await store.observe({
    kind: 'manager_memo',
    naturalKey: key,
    fields: {
      authorUserId: submission.authorUserId,
      submittedAt: submission.now,
      // Verbatim. The record of what was actually said outlives every change to the extractor.
      rawText: submission.rawText,
      memoKind: assertion.kind,
      status: 'active',
      extracted: { ...assertion, extractorId: extraction.extractorId },
      subjectKind: assertion.subjectKind,
      subjectKey,
      subjectConfidence: confidence,
      subjectCandidates: candidates,
      disambiguatedByUserId,
      effectiveFrom: window.effectiveFrom,
      effectiveUntil: window.effectiveUntil,
      openEnded: window.openEnded,
      sourceChannel: submission.channel,
    },
    observedAt: submission.now,
    evidence: null,
  });

  await recordAudit(scoped, {
    action: 'memo.created',
    actorUserId: submission.authorUserId,
    targetKind: 'manager_memo',
    targetId: key,
    before: null,
    after: {
      memoKind: assertion.kind,
      subjectKind: assertion.subjectKind,
      subjectKey,
      sourceChannel: submission.channel,
      effectiveFrom: window.effectiveFrom,
      effectiveUntil: window.effectiveUntil,
      openEnded: window.openEnded,
      subjectConfidence: confidence,
    },
    occurredAt: submission.now,
  });

  if (disambiguatedByUserId !== null) {
    await recordAudit(scoped, {
      action: 'memo.disambiguated',
      actorUserId: disambiguatedByUserId,
      targetKind: 'manager_memo',
      targetId: key,
      before: null,
      after: { subjectKey, chosenBy: disambiguatedByUserId },
      occurredAt: submission.now,
    });
  }

  // ---- the effect that needs a second row -----------------------------------
  const absenceKey = await applyUnavailable(store, assertion, window, subjectKey, key, submission.now);

  return {
    status: 'recorded',
    memoKey: key,
    assertion,
    window,
    subjectKey,
    subjectLabel,
    absenceKey,
    detail: describeRecorded(assertion, subjectLabel, window, absenceKey !== null),
  };
}

/**
 * An `unavailable` memo becomes an Absence — through the roster service, never directly.
 *
 * The other kinds need no second row: `descoped`, `reprioritized`, `external_blocker` and
 * `context_note` are honoured by analysis reading the memo itself out of the snapshot, so
 * writing a shadow copy of each into some other table would create a second thing to keep in
 * step. `unavailable` is the exception because suppression already exists and already reads
 * Absence rows — so the memo path joins that road rather than building a parallel one.
 */
async function applyUnavailable(
  store: KnowledgeStore,
  assertion: MemoAssertion,
  window: ResolvedWindow,
  subjectKey: string,
  memoNaturalKey: string,
  now: Instant,
): Promise<string | null> {
  if (assertion.kind !== 'unavailable') return null;

  // An open-ended absence needs *some* end instant, because the suppression predicate is a
  // half-open range and a null end would read as "covers nothing". A year is long enough to
  // mean "until somebody says otherwise" and short enough that a forgotten memo stops
  // suppressing findings eventually rather than never.
  const endAt = window.effectiveUntil ?? ((window.effectiveFrom + OPEN_ENDED_ABSENCE_MILLIS) as Instant);

  const result = await recordAbsence(
    store,
    {
      developerKey: subjectKey,
      kind: 'leave',
      startAt: window.effectiveFrom,
      endAt,
      note: assertion.subjectHint === subjectKey ? null : `From a memo: “${assertion.subjectHint} is out”`,
      // The provenance the roster screen displays and the report links to. Written here rather
      // than accepted over HTTP precisely so it cannot be forged: `/api/roster/absences`
      // refuses `source: 'memo'`.
      source: 'memo',
      sourceRef: memoNaturalKey,
    },
    now,
  );

  return result.naturalKey;
}

/** A year, for an absence a manager left open-ended. */
const OPEN_ENDED_ABSENCE_MILLIS = 365 * 24 * 60 * 60 * 1000;

function describeRecorded(
  assertion: MemoAssertion,
  subjectLabel: string,
  window: ResolvedWindow,
  wroteAbsence: boolean,
): string {
  const until = window.openEnded ? 'until you say otherwise' : `until ${toIso(window.effectiveUntil ?? window.effectiveFrom).slice(0, 10)}`;

  switch (assertion.kind) {
    case 'unavailable':
      return wroteAbsence
        ? `Noted: ${subjectLabel} is out ${until}. Stalled-work findings naming them are withheld while that holds, ` +
            'and the report says why, with a link back to this memo.'
        : `Noted: ${subjectLabel} is out ${until}.`;
    case 'descoped':
      return `Noted: ${subjectLabel} is out of the sprint ${until}. Sprint completion is recomputed without it and ` +
        'the Progress section says the scope changed.';
    case 'external_blocker':
      return `Noted: ${subjectLabel} is blocked by ${assertion.counterparty ?? 'an outside party'} ${until}. The ` +
        'blocker is attributed to them rather than to the team.';
    case 'reprioritized':
      return `Noted: ${subjectLabel} changed priority ${until}. The report cites this memo where it mentions it.`;
    case 'context_note':
      return `Noted, against ${subjectLabel}. The report cites this memo rather than acting on it.`;
  }
}
