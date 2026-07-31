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
 * **Each field is length-prefixed** — `4:v1|36:1111…|16:ticket:PLAT-742|…` — rather than joined
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
 */
function fnv1a64(value: string): bigint {
  const bytes = new TextEncoder().encode(value);
  let hash = FNV_OFFSET_BASIS;

  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & SIXTY_FOUR_BITS;
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
  const digest = fnv1a64(canonicalIdentityString(identity)).toString(16).padStart(16, '0');
  return `${STABLE_ID_VERSION}:${digest}`;
}

/** The shape a stable id always has. Used by the report invariant gate. */
export const STABLE_ID_PATTERN = /^v1:[0-9a-f]{16}$/;

export const isStableItemId = (value: string): boolean => STABLE_ID_PATTERN.test(value);

/**
 * An entity reference from a kind and a natural key.
 *
 * A one-line helper that exists to stop `ticket:${key}` and `ticket:` + key drifting apart
 * across two dozen call sites — the separator is decided here and nowhere else.
 */
export const entityRef = (kind: string, naturalKey: string): string => `${kind}:${naturalKey}`;
