/**
 * @compass/memos — Manager Memos: the manager's write access to the org model.
 *
 * Layer position: above `knowledge-model` and `db`, below the request edge. It writes
 * through the roster service rather than reaching for the Absence table, so the single-writer
 * rule that owns suppression stays intact.
 *
 * The read side is deliberately *not* here. Analysis honours a memo by reading the
 * `manager_memo` entity out of the snapshot it already receives — see
 * `packages/analysis/src/memos.ts` — because the analysis core imports nothing and must stay a
 * pure function of (snapshot, instant). This package's job ends when the row is written.
 */

export {
  InvalidAssertionError,
  MEMO_KINDS,
  MEMO_KIND_LABEL,
  MEMO_SOURCE_CHANNELS,
  MEMO_SUBJECT_KINDS,
  SUBJECT_KINDS_FOR_MEMO_KIND,
  isMemoKind,
  isMemoSourceChannel,
  isMemoSubjectKind,
  parseAssertion,
  resolveWindow,
  type MemoAssertion,
  type MemoKind,
  type MemoSourceChannel,
  type MemoSubjectKind,
  type ResolvedWindow,
} from './assertion.js';

export {
  REFUSAL_SENTENCE,
  extractMemo,
  isRefusal,
  type ExtractionOutcome,
  type ExtractionRefusal,
  type ExtractionRequest,
  type ExtractionSuccess,
  type ExtractorPort,
  type RefusalReason,
} from './extract.js';

export { DETERMINISTIC_EXTRACTOR_ID, DeterministicExtractor } from './deterministic-extractor.js';

export {
  SUBJECT_CONFIDENCE_THRESHOLD,
  isConfident,
  resolveDeveloperSubject,
  resolveKeyedSubject,
  resolveSubject,
  type SubjectCandidate,
  type SubjectResolution,
} from './subject.js';

export {
  memoKey,
  submitMemo,
  type MemoOutcome,
  type MemoSubmission,
  type NeedsSubject,
  type RecordedMemo,
  type SubjectUnknown,
  type SubmitMemoDependencies,
} from './service.js';
