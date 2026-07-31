/**
 * A seeded pseudo-random stream, because `Math.random` cannot be checked in.
 *
 * The seed dataset has to be regenerable byte for byte on any machine, which
 * rules out the host RNG, host locale and host clock alike. This is mulberry32
 * over an FNV-1a hash of a string seed: two lines of arithmetic, no dependency,
 * identical output everywhere.
 *
 * The stream is *ordered state*. Every draw advances it, so inserting a draw in
 * the middle of the generator shifts everything after it. That is intentional:
 * it makes an accidental change to generation visible as a large diff rather
 * than as a silent one-record difference.
 */
export interface Rng {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** An integer in [min, max], inclusive at both ends. */
  between(min: number, max: number): number;
  /** One element of a non-empty array. */
  pick<TItem>(items: readonly TItem[]): TItem;
  /** True with the given probability. */
  chance(probability: number): boolean;
}

export class EmptySelectionError extends Error {
  constructor() {
    super('Cannot pick from an empty array; the fixture that feeds this list is empty.');
    this.name = 'EmptySelectionError';
  }
}

/** FNV-1a, 32-bit. Stable across engines because every step is masked to u32. */
export function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function createRng(seed: string): Rng {
  let state = hashSeed(seed);

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let drawn = state;
    drawn = Math.imul(drawn ^ (drawn >>> 15), drawn | 1);
    drawn ^= drawn + Math.imul(drawn ^ (drawn >>> 7), drawn | 61);
    return ((drawn ^ (drawn >>> 14)) >>> 0) / 4294967296;
  };

  const int = (maxExclusive: number): number => {
    if (maxExclusive <= 0) return 0;
    return Math.floor(next() * maxExclusive);
  };

  return {
    next,
    int,
    between: (min, max) => min + int(max - min + 1),
    pick<TItem>(items: readonly TItem[]): TItem {
      if (items.length === 0) throw new EmptySelectionError();
      const chosen = items[int(items.length)];
      // `int` is bounded by `items.length`, so this is unreachable; it exists to
      // satisfy `noUncheckedIndexedAccess`-style narrowing without a cast.
      if (chosen === undefined) throw new EmptySelectionError();
      return chosen;
    },
    chance: (probability) => next() < probability,
  };
}
