import { compareInstants } from '@compass/clock';

import type { ConnectorRecordEnvelope } from './records.js';

/**
 * The documented ordering key for every artifact family:
 *
 *   occurredAt asc, then sourceKey asc, then sourceRecordId asc
 *
 * String comparison is by UTF-16 code unit, never `localeCompare`, so the order
 * is identical on every machine and in every locale. Determinism at the report
 * boundary starts here: if two connectors return the same set in a different
 * order, the report hash changes for no semantic reason.
 */
export function compareRecords(left: ConnectorRecordEnvelope, right: ConnectorRecordEnvelope): number {
  const byTime = compareInstants(left.occurredAt, right.occurredAt);
  if (byTime !== 0) return byTime;
  if (left.sourceKey !== right.sourceKey) return left.sourceKey < right.sourceKey ? -1 : 1;
  if (left.sourceRecordId !== right.sourceRecordId) return left.sourceRecordId < right.sourceRecordId ? -1 : 1;
  return 0;
}

/** Returns a new array in canonical order; never mutates the input. */
export function sortRecords<TRecord extends ConnectorRecordEnvelope>(records: readonly TRecord[]): readonly TRecord[] {
  return [...records].sort(compareRecords);
}

export function isInCanonicalOrder(records: readonly ConnectorRecordEnvelope[]): boolean {
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1];
    const current = records[index];
    if (previous === undefined || current === undefined) continue;
    if (compareRecords(previous, current) > 0) return false;
  }
  return true;
}

/** The natural key a record is deduplicated by across overlapping windows. */
export function recordIdentity(record: ConnectorRecordEnvelope): string {
  return `${record.sourceKey}::${record.sourceRecordId}`;
}
