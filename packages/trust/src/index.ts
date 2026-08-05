/**
 * @compass/trust — the published legal and trust content.
 *
 * Layer position: the very bottom, beside `@compass/clock`. It depends on nothing at all — the content is
 * typed data and pure functions — which is what lets both the web app (which renders it) and the worker
 * (whose notice job diffs it) read the *same* declaration.
 *
 * That sharing is the whole reason it is a package rather than a module in `apps/web`. The 30-day
 * subprocessor commitment is only kept if the job that sends the notice and the page that publishes the
 * list cannot disagree about what the list is, and two apps cannot import each other.
 */
export {
  AUTOMATED_DECISIONS,
  DPIA,
  NO_RANKING_STANCE,
  POLICY_DOCUMENTS,
  PRIVACY_POLICY,
  SUBPROCESSORS,
  SUBPROCESSOR_NOTICE_DAYS,
  TERMS,
  TRUST_CONTACT,
  describeSubprocessorChanges,
  subprocessorDigest,
  type PolicyDocument,
  type PolicySection,
  type Subprocessor,
} from './content.js';
