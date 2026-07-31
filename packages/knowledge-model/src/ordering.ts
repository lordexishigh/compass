/**
 * Canonical ordering at the snapshot boundary.
 *
 * Determinism leaks through incidental order more easily than anywhere else:
 * unordered SQL results, insertion-ordered maps, locale-dependent comparison.
 * Every collection that reaches the pure layer is sorted here, by a documented
 * stable key, with code-unit comparison — never `localeCompare`.
 */
export function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareNumbers(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Sorts a copy by a documented string key. Ties keep no incidental order. */
export function sortByStableKey<TItem>(items: readonly TItem[], key: (item: TItem) => string): readonly TItem[] {
  return [...items].sort((left, right) => compareStable(key(left), key(right)));
}

/** Sorts by a composite key, in the order the parts are given. */
export function sortByCompositeKey<TItem>(
  items: readonly TItem[],
  key: (item: TItem) => readonly (string | number)[],
): readonly TItem[] {
  return [...items].sort((left, right) => {
    const leftKey = key(left);
    const rightKey = key(right);
    const length = Math.max(leftKey.length, rightKey.length);
    for (let index = 0; index < length; index += 1) {
      const leftPart = leftKey[index];
      const rightPart = rightKey[index];
      if (leftPart === undefined) return rightPart === undefined ? 0 : -1;
      if (rightPart === undefined) return 1;
      const comparison =
        typeof leftPart === 'number' && typeof rightPart === 'number'
          ? compareNumbers(leftPart, rightPart)
          : compareStable(String(leftPart), String(rightPart));
      if (comparison !== 0) return comparison;
    }
    return 0;
  });
}

export function isSortedByStableKey<TItem>(items: readonly TItem[], key: (item: TItem) => string): boolean {
  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1];
    const current = items[index];
    if (previous === undefined || current === undefined) continue;
    if (compareStable(key(previous), key(current)) > 0) return false;
  }
  return true;
}
