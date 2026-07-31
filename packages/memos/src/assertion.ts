import { instantFromIso, type Instant } from '@compass/clock';

/**
 * The closed five-kind assertion schema, and the validator that refuses everything else.
 *
 * This module is the reason Manager Memos are safe to act on. A memo changes what the
 * report says — it suppresses a finding, it changes a completion percentage, it moves the
 * blame for a blocker onto somebody outside the org — so the thing that decides *what a
 * memo means* has to be a closed set with no fallback branch.
 *
 * ## Why refusal rather than a sixth kind
 *
 * The obvious design is a `context_note` catch-all: anything the extractor cannot place
 * becomes a note, nothing breaks, no manager is ever told "no". That is exactly the failure
 * this schema exists to prevent. A manager who writes "deprioritise the billing work until
 * the vendor answers" and gets silence has been told their instruction was understood. It
 * was not. It was filed as a comment and the report went on asserting the same thing it
 * asserted yesterday. **An assertion Compass cannot represent has to be refused out loud**,
 * which is why `extractMemo` can return a refusal and why `context_note` is a kind a manager
 * chooses rather than a bucket the parser falls into.
 *
 * ## Why validation is strict and never coerces
 *
 * The extractor is a language model. Its output is untrusted in exactly the way ingested
 * ticket titles are untrusted, and the failure mode is quieter: a coerced field produces a
 * memo that is *almost* what the manager said. `"unavailble"` corrected to `unavailable`,
 * a missing `effectiveUntil` defaulted to open-ended, a `counterparty` of `""` accepted —
 * each of those is a suppression rule firing on a date range nobody chose. So unknown keys
 * are rejected, missing keys are rejected, wrong types are rejected, and nothing is
 * defaulted. The only two outcomes are "exactly this assertion" and "no assertion".
 */

// ---------------------------------------------------------------------------
// The closed vocabularies
// ---------------------------------------------------------------------------

/**
 * The five kinds. **Exactly five, forever, by construction.**
 *
 * Mirrored by a CHECK constraint in `0008_manager_memos.sql`. Two gates rather than one
 * because they fail differently and both failures matter: the validator produces a sentence
 * a manager reads, and the constraint makes a sixth value unwritable by any path at all —
 * including a migration script or a psql session. Every downstream effect switches on this
 * value, and an unrecognised kind would land in no branch: the effect would simply not
 * happen, with nothing anywhere to see.
 */
export const MEMO_KINDS = [
  'unavailable',
  'descoped',
  'reprioritized',
  'external_blocker',
  'context_note',
] as const;

export type MemoKind = (typeof MEMO_KINDS)[number];

export const isMemoKind = (value: unknown): value is MemoKind =>
  typeof value === 'string' && (MEMO_KINDS as readonly string[]).includes(value);

/** What each kind asserts, in the product's voice. Shown on the memo screen. */
export const MEMO_KIND_LABEL: Readonly<Record<MemoKind, string>> = {
  unavailable: 'somebody is out',
  descoped: 'work was dropped from the sprint',
  reprioritized: 'work changed priority',
  external_blocker: 'an outside party is blocking us',
  context_note: 'context Compass could not have known',
};

/**
 * The entity kinds a memo can be about.
 *
 * Deliberately narrower than the model's full entity vocabulary: a memo is an assertion a
 * manager makes about work or people, and there is no sentence a manager types that is
 * usefully "about" a commit or a branch ref. Mirrored by a CHECK constraint.
 */
export const MEMO_SUBJECT_KINDS = ['developer', 'team', 'sprint', 'ticket', 'project'] as const;

export type MemoSubjectKind = (typeof MEMO_SUBJECT_KINDS)[number];

export const isMemoSubjectKind = (value: unknown): value is MemoSubjectKind =>
  typeof value === 'string' && (MEMO_SUBJECT_KINDS as readonly string[]).includes(value);

/** The three intakes. The memo row is identical across all three apart from this. */
export const MEMO_SOURCE_CHANNELS = ['email', 'slack', 'web'] as const;

export type MemoSourceChannel = (typeof MEMO_SOURCE_CHANNELS)[number];

export const isMemoSourceChannel = (value: unknown): value is MemoSourceChannel =>
  typeof value === 'string' && (MEMO_SOURCE_CHANNELS as readonly string[]).includes(value);

/**
 * Which subject kinds each memo kind may be about.
 *
 * `unavailable` is about a person and nothing else — "the sprint is unavailable" is not an
 * assertion, and accepting it would write an Absence keyed to a sprint that the suppression
 * rule would then look for under a developer key and never find. The rest are constrained
 * for the same reason: the effect knows what it is looking at.
 */
export const SUBJECT_KINDS_FOR_MEMO_KIND: Readonly<Record<MemoKind, readonly MemoSubjectKind[]>> = {
  unavailable: ['developer'],
  descoped: ['ticket'],
  reprioritized: ['ticket'],
  external_blocker: ['ticket'],
  // The one deliberately wide kind: a note can be about anything a manager can name.
  context_note: [...MEMO_SUBJECT_KINDS],
};

// ---------------------------------------------------------------------------
// The assertion
// ---------------------------------------------------------------------------

/**
 * What the extractor produces: a typed assertion, not yet bound to an entity id.
 *
 * `subjectHint` is the name as the manager wrote it — "Marcus", "the payments ticket" — and
 * is deliberately *not* an entity key. Resolution is a separate, testable step that may
 * refuse to guess (see `subject.ts`); letting the extractor emit an entity key directly
 * would put a language model in charge of deciding which of two people named Marcus a
 * suppression applies to.
 */
export interface MemoAssertion {
  readonly kind: MemoKind;
  readonly subjectKind: MemoSubjectKind;
  readonly subjectHint: string;
  /** ISO-8601. The instant the assertion starts applying. */
  readonly effectiveFrom: string;
  /** ISO-8601, or null exactly when `openEnded` is true. */
  readonly effectiveUntil: string | null;
  readonly openEnded: boolean;
  /**
   * The outside party, for `external_blocker`. Required for that kind and null for every
   * other — a blocker attributed to nobody outside is just a blocker.
   */
  readonly counterparty: string | null;
}

/** The same assertion with its instants parsed, which is what the service persists. */
export interface ResolvedWindow {
  readonly effectiveFrom: Instant;
  readonly effectiveUntil: Instant | null;
  readonly openEnded: boolean;
}

export class InvalidAssertionError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.name = 'InvalidAssertionError';
    this.detail = detail;
  }
}

/** The exact keys an assertion may carry. An unknown key is a rejection, not a warning. */
const ASSERTION_KEYS: readonly string[] = [
  'kind',
  'subjectKind',
  'subjectHint',
  'effectiveFrom',
  'effectiveUntil',
  'openEnded',
  'counterparty',
];

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const nonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

/**
 * Validates one extraction output against the closed schema.
 *
 * Throws `InvalidAssertionError` with a sentence naming the problem. Never returns a
 * partially-valid assertion and never fills a field in: the caller's only two options are to
 * persist exactly what came back or to refuse, and that is the whole design.
 */
export function parseAssertion(value: unknown): MemoAssertion {
  const record = asRecord(value);
  if (record === null) {
    throw new InvalidAssertionError('An assertion must be a JSON object of fields.');
  }

  const unknownKeys = Object.keys(record).filter((key) => !ASSERTION_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    // Rejected rather than ignored: an extra key means the extractor answered a different
    // question than the one asked, and the fields it *did* fill are no longer trustworthy.
    throw new InvalidAssertionError(
      `An assertion carries only ${ASSERTION_KEYS.join(', ')}; this one also carried ${unknownKeys.join(', ')}.`,
    );
  }

  const kind = record['kind'];
  if (!isMemoKind(kind)) {
    throw new InvalidAssertionError(
      `\`${String(kind)}\` is not one of the five kinds Compass can represent (${MEMO_KINDS.join(', ')}).`,
    );
  }

  const subjectKind = record['subjectKind'];
  if (!isMemoSubjectKind(subjectKind)) {
    throw new InvalidAssertionError(
      `\`${String(subjectKind)}\` is not a subject kind (${MEMO_SUBJECT_KINDS.join(', ')}).`,
    );
  }

  const allowed = SUBJECT_KINDS_FOR_MEMO_KIND[kind];
  if (!allowed.includes(subjectKind)) {
    throw new InvalidAssertionError(
      `A \`${kind}\` memo is about ${allowed.join(' or ')}, not a ${subjectKind}.`,
    );
  }

  const subjectHint = nonEmptyString(record['subjectHint']);
  if (subjectHint === null) {
    throw new InvalidAssertionError('An assertion must name its subject, as the manager wrote it.');
  }

  const openEnded = record['openEnded'];
  if (typeof openEnded !== 'boolean') {
    throw new InvalidAssertionError('`openEnded` must be true or false, never absent.');
  }

  const effectiveFrom = nonEmptyString(record['effectiveFrom']);
  if (effectiveFrom === null) {
    throw new InvalidAssertionError('An assertion must say when it starts applying.');
  }

  const rawUntil = record['effectiveUntil'];
  if (rawUntil !== null && typeof rawUntil !== 'string') {
    throw new InvalidAssertionError('`effectiveUntil` must be an ISO-8601 instant or null.');
  }
  const effectiveUntil = rawUntil === null ? null : nonEmptyString(rawUntil);

  // The biconditional the database also enforces. Both halves are real mistakes: an
  // open-ended memo carrying an end date is ambiguous about which one wins, and a closed one
  // carrying no end date suppresses findings forever.
  if (openEnded && effectiveUntil !== null) {
    throw new InvalidAssertionError('An open-ended assertion cannot also have an end date.');
  }
  if (!openEnded && effectiveUntil === null) {
    throw new InvalidAssertionError(
      'An assertion must either end on a date or be explicitly open-ended. It cannot be neither.',
    );
  }

  const rawCounterparty = record['counterparty'];
  if (rawCounterparty !== null && typeof rawCounterparty !== 'string') {
    throw new InvalidAssertionError('`counterparty` must be a name or null.');
  }
  const counterparty = rawCounterparty === null ? null : nonEmptyString(rawCounterparty);

  if (kind === 'external_blocker' && counterparty === null) {
    throw new InvalidAssertionError(
      'An external blocker must name the outside party. A blocker attributed to nobody is just a blocker.',
    );
  }
  if (kind !== 'external_blocker' && counterparty !== null) {
    throw new InvalidAssertionError(`A \`${kind}\` memo has no counterparty to name.`);
  }

  return { kind, subjectKind, subjectHint, effectiveFrom, effectiveUntil, openEnded, counterparty };
}

/**
 * The assertion's window as instants.
 *
 * Separate from `parseAssertion` because the shape and the *time* fail differently: a
 * malformed date is the extractor's mistake, while an inverted range is a mistake the
 * manager may well have made ("out from the 5th until the 2nd"), and the second deserves its
 * own sentence.
 */
export function resolveWindow(assertion: MemoAssertion): ResolvedWindow {
  let effectiveFrom: Instant;
  try {
    effectiveFrom = instantFromIso(assertion.effectiveFrom);
  } catch {
    throw new InvalidAssertionError(
      `\`${assertion.effectiveFrom}\` is not an ISO-8601 instant, so Compass cannot tell when this starts.`,
    );
  }

  if (assertion.effectiveUntil === null) {
    return { effectiveFrom, effectiveUntil: null, openEnded: true };
  }

  let effectiveUntil: Instant;
  try {
    effectiveUntil = instantFromIso(assertion.effectiveUntil);
  } catch {
    throw new InvalidAssertionError(
      `\`${assertion.effectiveUntil}\` is not an ISO-8601 instant, so Compass cannot tell when this stops.`,
    );
  }

  if (effectiveUntil <= effectiveFrom) {
    throw new InvalidAssertionError(
      'An assertion must end after it starts. A range covering no instant would change nothing while ' +
        'appearing on the memo list as though it did.',
    );
  }

  return { effectiveFrom, effectiveUntil, openEnded: false };
}
