/**
 * Stable item identity — the one place a report item's id is derived.
 *
 * ## Why identity is the foundation of this product
 *
 * A daily report that showed the same three blockers every morning as though they were news
 * would be worthless within a week. Everything that stops that — "day 6" instead of "new", the
 * change tag, the presence trail, a dismissal that sticks, a snooze that expires — depends on
 * one thing: the same condition producing the *same identifier* tomorrow. So the id is derived
 * from the condition, and from nothing else.
 *
 * ## What it is derived from, and what it must never contain
 *
 * Exactly four inputs, canonicalised and hashed:
 *
 *  - `organizationId` — the tenant. Two organizations with a ticket called `DEV-1` stalled for
 *    the same reason are two different items.
 *  - `entityRef` — the thing the item is *about*, as `kind:naturalKey` (`ticket:PLAT-742`).
 *    The natural key, never a surrogate row id: a re-ingest must not renumber it.
 *  - `causeKind` — *why* this item exists (`status_dwell`, `no_reviewer`, `off_goal`). One
 *    entity can carry several items at once, and they are not the same item.
 *  - `causeDiscriminator` — the remaining coordinate when the three above still collide, such
 *    as the reviewer a review-wait is about. Empty string when the cause needs no further
 *    distinction, which is the common case.
 *
 * It contains **no report id, no run id, no instant and no counter**. That is not a stylistic
 * preference: a timestamp component would make every item new every morning, which is precisely
 * the failure this module exists to prevent, and a run id would silently do the same. The
 * absence is asserted directly in `tests/identity.test.ts` rather than left to review.
 *
 * ## Why a hand-written hash rather than SHA-256
 *
 * `packages/analysis` declares zero runtime dependencies and `tools/quality-gates`'
 * analysis-purity gate names `node:crypto` as a forbidden import — the analysis core has to be
 * a pure function of its snapshot so the determinism gate can replay it anywhere. So the hash
 * is implemented here in plain TypeScript.
 *
 * That is sound because an item id is an **identifier, not a secret**. Nothing is authorised by
 * knowing one, nothing is hidden by not knowing one, and there is no adversary to whom a
 * preimage would be worth anything — feedback actions are authorised by a signed token or a
 * session, never by presenting an item id. What the id needs is determinism and collision
 * resistance across the few thousand items an organization accumulates, and 64 bits of FNV-1a
 * gives that with an enormous margin: the birthday bound for a one-in-a-million collision
 * chance sits around six million distinct items in a single tenant.
 *
 * ## The version tag
 *
 * Every id is prefixed `v1:`. If the cause key of some detector ever has to change shape, the
 * prefix is bumped in one place and the break is *visible* — every item becomes new on one
 * day, which is a decision somebody makes deliberately rather than a silent churn nobody
 * notices until a manager's dismissals stop sticking.
 */

/** Bumped only for a deliberate, org-wide identity reset. See the note above. */
export const STABLE_ID_VERSION = 'v1';

/** The four coordinates that decide whether two items are the same item. */
export interface ItemIdentity {
  readonly organizationId: string;
  /** `kind:naturalKey` — `ticket:PLAT-742`, `pull_request:checkout-web#9201`. */
  readonly entityRef: string;
  /** Why the item exists: `status_dwell`, `no_reviewer`, `off_goal`, `scope_added_after_start`. */
  readonly causeKind: string;
  /** The remaining coordinate, or `''` when the cause needs none. */
  readonly causeDiscriminator?: string;
}

/**
 * The readable form of an identity, for logs, debugging and the evidence gutter.
 *
 * Kept alongside the hashed id rather than replaced by it. The design brief asks that every
 * claim carry its receipt, and "which item is `v1:8f2c…`" is a question somebody will ask at
 * 09:00 with a manager on the phone. This is the answer.
 *
 * The organization is deliberately absent: this is for a human reading one tenant's logs, and
 * the tenant is the context they are already in. The *hash* is what carries the tenant.
 */
export function itemCauseKey(identity: ItemIdentity): string {
  const discriminator = identity.causeDiscriminator ?? '';
  return discriminator.length === 0
    ? `${identity.entityRef}:${identity.causeKind}`
    : `${identity.entityRef}:${identity.causeKind}:${discriminator}`;
}

/**
 * The canonical string the hash is taken over.
 *
 * Exported so a test can assert what does and does not reach the hash, which is the only way to
 * prove "no report id, no run id, no timestamp" about a function whose output is opaque.
 *
 * **Each field is length-prefixed** — `2:v1|36:1111…|16:ticket:PLAT-742|…` — rather than joined
 * on a separator. A natural key legitimately contains colons (`checkout-web:9201`) and could
 * contain a space or almost anything else a tracker permits, so any separator would eventually
 * be ambiguous: `a:b` + `c` and `a` + `b:c` must never canonicalise to the same bytes, or two
 * unrelated conditions would silently share one id and one manager's dismissal would suppress
 * the other's item. A length prefix is unambiguous whatever the field contains, and unlike a NUL
 * delimiter it keeps this file plain printable ASCII that `grep` and a reviewer can both read.
 */
export function canonicalIdentityString(identity: ItemIdentity): string {
  return [
    STABLE_ID_VERSION,
    identity.organizationId,
    identity.entityRef,
    identity.causeKind,
    identity.causeDiscriminator ?? '',
  ]
    .map((field) => `${field.length}:${field}`)
    .join('|');
}

const FNV_OFFSET_BASIS = 0xcbf2_9ce4_8422_2325n;
const FNV_PRIME = 0x0000_0100_0000_01b3n;
const SIXTY_FOUR_BITS = 0xffff_ffff_ffff_ffffn;

/**
 * FNV-1a, 64-bit, over the UTF-8 bytes of `value`.
 *
 * Written out rather than imported because this package may not import `node:crypto` (see the
 * module note). BigInt rather than a two-word 32-bit split: the multiply is exact, the code says
 * what the specification says, and this runs a few dozen times per report — not a hot path.
 *
 * ## Why the UTF-8 encoding is also written out
 *
 * `new TextEncoder()` used to stand here and it did not compile. This package sets `types: []` on
 * purpose — the same zero-dependency stance that bans `node:crypto` — so `TextEncoder` is as
 * undeclared as `Buffer` is, and the build failed with `TS2304: Cannot find name 'TextEncoder'`.
 * That one error broke `pnpm build:packages` for the whole monorepo while lint, arch and every test
 * suite stayed green, because vitest resolves sources and Node happens to expose the global at
 * runtime. Encoding the code points here keeps the package honestly dependency-free.
 *
 * The bytes are identical to `TextEncoder`'s for every input, which matters because ids already
 * minted must not move: ASCII is one byte per character, a surrogate pair becomes the four-byte
 * form of its code point, and an *unpaired* surrogate becomes U+FFFD exactly as the encoding
 * standard requires. `tests/identity.test.ts` pins that equivalence.
 */
function fnv1a64(value: string): bigint {
  let hash = FNV_OFFSET_BASIS;

  const mix = (byte: number): void => {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & SIXTY_FOUR_BITS;
  };

  for (let index = 0; index < value.length; index += 1) {
    let codePoint = value.charCodeAt(index);

    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const low = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = (codePoint - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
        index += 1;
      } else {
        // A high surrogate with no low one is not a character. The standard replaces it.
        codePoint = 0xfffd;
      }
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      codePoint = 0xfffd;
    }

    if (codePoint < 0x80) {
      mix(codePoint);
    } else if (codePoint < 0x800) {
      mix(0xc0 | (codePoint >> 6));
      mix(0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x1_0000) {
      mix(0xe0 | (codePoint >> 12));
      mix(0x80 | ((codePoint >> 6) & 0x3f));
      mix(0x80 | (codePoint & 0x3f));
    } else {
      mix(0xf0 | (codePoint >> 18));
      mix(0x80 | ((codePoint >> 12) & 0x3f));
      mix(0x80 | ((codePoint >> 6) & 0x3f));
      mix(0x80 | (codePoint & 0x3f));
    }
  }

  return hash;
}

/**
 * The stable id of one report item: `v1:` and sixteen lowercase hex digits.
 *
 * Deterministic across processes, releases and machines — it reads no clock, no counter and no
 * ambient state, which is what lets the ten-day simulation in `tests/identity.test.ts` assert
 * one id across ten generated reports.
 */
export function stableItemId(identity: ItemIdentity): string {
  // Three of the four coordinates are mandatory, and a missing one is refused rather than hashed.
  // A degenerate id is unusually expensive to discover later: dismissals, snoozes and corrections
  // are all keyed on it, so an item whose `entityRef` was empty would quietly share one id with
  // every other such item and one manager's dismissal would suppress unrelated findings. Only
  // `causeDiscriminator` may be empty — that is its documented common case.
  for (const [field, value] of [
    ['organizationId', identity.organizationId],
    ['entityRef', identity.entityRef],
    ['causeKind', identity.causeKind],
  ] as const) {
    if (value.length === 0) {
      throw new DegenerateItemIdentityError(field);
    }
  }

  const digest = fnv1a64(canonicalIdentityString(identity)).toString(16).padStart(16, '0');
  return `${STABLE_ID_VERSION}:${digest}`;
}

export class DegenerateItemIdentityError extends Error {
  readonly detail: string;

  constructor(field: 'organizationId' | 'entityRef' | 'causeKind') {
    const detail =
      `A report item's \`${field}\` is empty, so no stable id can be derived for it. Every feedback ` +
      'action — dismiss, snooze, correction — is keyed on that id, and a degenerate one would make ' +
      'unrelated findings share it.';
    super(detail);
    this.name = 'DegenerateItemIdentityError';
    this.detail = detail;
  }
}

/**
 * The shape a stable id always has. Used by the report invariant gate.
 *
 * Built from `STABLE_ID_VERSION` rather than spelling `v1` a second time, so the module's claim
 * that a reset is "bumped in one place" is actually true. Hard-coding the literal here meant a
 * version bump would leave this pattern rejecting every id the same file had just minted.
 */
export const STABLE_ID_PATTERN = new RegExp(`^${STABLE_ID_VERSION}:[0-9a-f]{16}$`);

export const isStableItemId = (value: string): boolean => STABLE_ID_PATTERN.test(value);

/**
 * An entity reference from a kind and a natural key.
 *
 * A one-line helper that exists to stop `ticket:${key}` and `ticket:` + key drifting apart
 * across two dozen call sites — the separator is decided here and nowhere else.
 */
export const entityRef = (kind: string, naturalKey: string): string => `${kind}:${naturalKey}`;

/**
 * A short deterministic digest, for folding a *set* of things into one natural key.
 *
 * The unattributed question is the caller: it is about a set of commits rather than one entity, and
 * a natural key listing every SHA would be unbounded and unreadable in exactly the log line
 * `itemCauseKey` exists to be read in.
 *
 * Twelve hex digits of the same FNV-1a the ids use, and it carries the same caveat for the same
 * reason: an identifier, never a secret. Nothing is authorised by knowing one. Collision resistance
 * is what matters, and at twelve digits two different commit sets in one team's window colliding is
 * far below the odds of the item ids themselves colliding, which the note at the top of this file
 * already sizes.
 */
export const shortDigest = (value: string): string => fnv1a64(value).toString(16).padStart(16, '0').slice(0, 12);

/**
 * The three tenant-independent coordinates, as a value a detector can carry.
 *
 * Identical to `ItemIdentity` minus the organization, and that omission is the point: the
 * tenant belongs to the *report*, while these three belong to the *condition*. A feedback
 * record is keyed on exactly these — never on the derived digest — so a dismissal survives a
 * deliberate `STABLE_ID_VERSION` bump instead of being orphaned by it.
 *
 * `causeDiscriminator` is required here rather than optional, unlike on `ItemIdentity`. A
 * value that travels through a database column, a URL and an HMAC payload cannot afford an
 * `undefined` that one layer spells as absent and another as the empty string: the two would
 * hash differently and a manager's dismissal would stop matching its own item.
 */
export interface ItemCause {
  readonly entityRef: string;
  readonly causeKind: string;
  readonly causeDiscriminator: string;
}

/** The pair every report item carries: the derived id, and what it was derived from. */
export interface IdentifiedItem {
  readonly stableId: string;
  readonly cause: ItemCause;
}

/**
 * A cause, and the id it derives to, in one call.
 *
 * Detectors spread this rather than assigning `stableId` and `cause` separately, so the two
 * physically cannot disagree — and `assertItemIdsMatchTheirCause` re-checks it over the whole
 * report for the paths that still build the pair by hand.
 */
export const identifyItem = (organizationId: string, cause: ItemCause): IdentifiedItem => ({
  stableId: stableItemId({ organizationId, ...cause }),
  cause,
});
