import { describe, expect, it } from 'vitest';

import {
  NON_SEMANTIC_REPORT_FIELDS,
  NOTHING_CHANGED_STATEMENT,
  addDays,
  changedItemDiffs,
  diffReports,
  fieldChangesBetween,
  generateStructuredReport,
  type ReportItem,
  type StructuredReport,
} from '@compass/analysis';

import { SEED_NOW, buildSeedSnapshot } from './helpers/seed-snapshot.js';

/**
 * The diff engine, against the real seeded corpus rather than a hand-built pair.
 *
 * The seed plants the hard cases on purpose — a blocked-then-merged ticket, a sprint whose scope
 * changed mid-flight, an item that persists for days accruing age — so two consecutive simulated days
 * exercise added, removed *and* changed in one pair. A fixture built by hand would only contain the
 * cases whoever wrote it thought of, and the interesting ones here are the ones nobody would.
 */

const snapshot = buildSeedSnapshot({ scope: { kind: 'team', teamKey: 'platform' } });

/** A report for the seeded platform team at an offset from the seed's own `now`. */
const reportAt = (offsetDays: number): StructuredReport =>
  generateStructuredReport(snapshot, addDays(SEED_NOW, offsetDays));

const today = reportAt(0);
const yesterday = reportAt(-1);

describe('items are keyed by stable id', () => {
  it('classifies every item as added, removed, changed or unchanged', () => {
    const diff = diffReports(yesterday, today);

    const statuses = new Set(
      diff.sections.flatMap((section) => section.items.map((item) => item.status)),
    );

    expect(statuses.size, 'the seeded pair produced no item rows at all').toBeGreaterThan(0);
    for (const status of statuses) {
      expect(['added', 'removed', 'changed', 'unchanged']).toContain(status);
    }
  });

  it('matches an item to its prior self by stable id, not by position', () => {
    /**
     * The property the whole view rests on.
     *
     * Items are ordered by severity, so an item that moved from third to first must be one `changed`
     * or `unchanged` row and not an add/remove pair. This asserts it directly: every id present in
     * both reports appears exactly once, with both sides populated.
     */
    const diff = diffReports(yesterday, today);

    const beforeIds = new Set(yesterday.sections.flatMap((s) => s.items.map((i) => i.stableId)));
    const afterIds = new Set(today.sections.flatMap((s) => s.items.map((i) => i.stableId)));
    const inBoth = [...beforeIds].filter((id) => afterIds.has(id));

    expect(inBoth.length, 'no item persisted across the two days, so this asserts nothing').toBeGreaterThan(0);

    const rows = diff.sections.flatMap((section) => section.items);
    for (const id of inBoth) {
      const matching = rows.filter((row) => row.stableId === id);
      expect(matching, `\`${id}\` produced ${matching.length} rows instead of one`).toHaveLength(1);
      expect(matching[0]?.before, `\`${id}\` lost its earlier side`).not.toBeNull();
      expect(matching[0]?.after, `\`${id}\` lost its later side`).not.toBeNull();
      expect(['changed', 'unchanged']).toContain(matching[0]?.status);
    }
  });

  it('lists the changed fields on a changed item, and none on the others', () => {
    const diff = diffReports(yesterday, today);
    const rows = diff.sections.flatMap((section) => section.items);

    const changed = rows.filter((row) => row.status === 'changed');
    expect(changed.length, 'the seeded pair produced no changed item').toBeGreaterThan(0);

    for (const row of changed) {
      expect(row.changedFields.length, `${row.stableId} is \`changed\` with no fields named`).toBeGreaterThan(0);
      for (const change of row.changedFields) {
        // Both sides are shown, and they differ — a "change" whose two sides are equal would mean
        // the comparison found something the reader cannot see.
        expect(change.before).not.toBe(change.after);
        expect(change.field.length).toBeGreaterThan(0);
      }
    }

    for (const row of rows.filter((entry) => entry.status !== 'changed')) {
      expect(row.changedFields, `${row.stableId} is ${row.status} but names changed fields`).toEqual([]);
    }
  });

  it('gives an added item no earlier side and a removed item no later one', () => {
    const diff = diffReports(yesterday, today);
    const rows = diff.sections.flatMap((section) => section.items);

    for (const row of rows.filter((entry) => entry.status === 'added')) {
      expect(row.before, `${row.stableId} is added but carries an earlier side`).toBeNull();
      expect(row.after).not.toBeNull();
    }
    for (const row of rows.filter((entry) => entry.status === 'removed')) {
      expect(row.after, `${row.stableId} is removed but carries a later side`).toBeNull();
      expect(row.before).not.toBeNull();
    }
  });
});

describe('the non-semantic allowlist is excluded', () => {
  it('reports no change when only an allowlisted field differs', () => {
    /**
     * The criterion, asserted on the allowlist itself rather than on a hard-coded field name.
     *
     * Iterating `NON_SEMANTIC_REPORT_FIELDS` means adding a fourth entry to that constant extends
     * this test automatically — which is the whole reason the diff reads the determinism gate's list
     * instead of declaring its own.
     */
    expect(NON_SEMANTIC_REPORT_FIELDS.length).toBeGreaterThan(0);

    for (const field of NON_SEMANTIC_REPORT_FIELDS) {
      const before = { stableId: 'x', headline: 'same', [field]: 'yesterday-value' };
      const after = { stableId: 'x', headline: 'same', [field]: 'today-value' };

      expect(
        fieldChangesBetween(before, after),
        `\`${field}\` is on the allowlist but was reported as a change`,
      ).toEqual([]);
    }
  });

  it('still reports a semantic field beside an allowlisted one', () => {
    // The guard against the exclusion being too broad: a real change must survive alongside one that
    // is filtered, or the test above would pass on a differ that reported nothing at all.
    const changes = fieldChangesBetween(
      { runId: 'a', severityScore: 10 },
      { runId: 'b', severityScore: 40 },
    );

    expect(changes.map((change) => change.field)).toEqual(['severityScore']);
    expect(changes[0]?.before).toBe('10');
    expect(changes[0]?.after).toBe('40');
  });

  it('names a field that exists on only one side rather than skipping it', () => {
    const changes = fieldChangesBetween({ headline: 'a' }, { headline: 'a', changeClause: 'reviewer added' });

    expect(changes.map((change) => change.field)).toEqual(['changeClause']);
    // `<absent>` rather than `null`: a key that does not exist and a key set to null are different
    // facts, and a diff that rendered them identically would hide one of them.
    expect(changes[0]?.before).toBe('<absent>');
  });
});

describe('a report diffed against itself', () => {
  it('yields zero differences', () => {
    const diff = diffReports(today, today);

    expect(diff.addedCount).toBe(0);
    expect(diff.removedCount).toBe(0);
    expect(diff.changedCount).toBe(0);
    expect(diff.reportFieldChanges).toEqual([]);
    expect(diff.hasChanges).toBe(false);
    expect(changedItemDiffs(diff)).toEqual([]);
  });

  it('says so in the product’s own voice rather than rendering two identical columns', () => {
    // Criterion 002's wording lives on the diff, not in the component, so every consumer says it the
    // same way. The view test asserts the page prints exactly this.
    expect(diffReports(today, today).statement).toBe(NOTHING_CHANGED_STATEMENT);
    expect(diffReports(today, today).statement).toContain('Nothing material changed');
  });

  it('still accounts for every item as unchanged', () => {
    const diff = diffReports(today, today);
    const itemCount = today.sections.reduce((sum, section) => sum + section.items.length, 0);

    expect(itemCount, 'the seeded report has no items, so this asserts nothing').toBeGreaterThan(0);
    expect(diff.unchangedCount).toBe(itemCount);
  });

  it('holds for every seeded team, not just the one', () => {
    // A per-team assertion, because an id derived from something report-scoped rather than
    // entity-scoped would show up on one team's data and not another's.
    for (const teamKey of ['platform', 'checkout', 'insights'] as const) {
      const report = generateStructuredReport(
        buildSeedSnapshot({ scope: { kind: 'team', teamKey } }),
        SEED_NOW,
      );
      expect(diffReports(report, report).hasChanges, `${teamKey} diffed against itself has changes`).toBe(
        false,
      );
    }
  });
});

describe('the summary sentence', () => {
  it('counts what moved instead of adjectives', () => {
    const diff = diffReports(yesterday, today);

    expect(diff.hasChanges).toBe(true);
    expect(diff.statement).not.toBe(NOTHING_CHANGED_STATEMENT);
    // It ends as a sentence and names at least one count.
    expect(diff.statement).toMatch(/\.$/);
    expect(diff.statement).toMatch(/\d/);
  });

  it('is true rather than reassuring when only a report-level figure moved', () => {
    /**
     * The honesty case: identical items, a moved projection.
     *
     * A diff that said "nothing material changed" because every item matched, while the projected
     * completion date had moved a week, would be exactly the confident polish this product refuses.
     */
    const moved: StructuredReport = {
      ...today,
      // `totalOpen`, which is what `ReviewQueue` actually calls the size of the queue. This said
      // `depth` — a field the type has never had — so the object was only accepted because an excess
      // property does not fail an assertion at runtime. `tsc -p tsconfig.tests.json` is what caught it.
      findings: { ...today.findings, reviewQueue: { ...today.findings.reviewQueue, totalOpen: 99 } },
    };

    const diff = diffReports(today, moved);

    expect(diff.changedCount).toBe(0);
    expect(diff.addedCount).toBe(0);
    expect(diff.hasChanges, 'a moved report-level figure must not read as "nothing changed"').toBe(true);
    expect(diff.reportFieldChanges.map((change) => change.field)).toContain('findings');
    expect(diff.statement).toContain('report-level');
  });
});

describe('reading order', () => {
  it('puts items present today first, in today’s order', () => {
    const diff = diffReports(yesterday, today);

    for (const section of diff.sections) {
      const presentToday = section.items.filter((item) => item.after !== null).map((item) => item.stableId);
      const todaysOrder = today.sections
        .find((candidate) => candidate.key === section.key)!
        .items.map((item) => item.stableId);

      // The right-hand column is the one a reviewer reads top to bottom; it has to read like the
      // report does.
      expect(presentToday).toEqual(todaysOrder);
    }
  });

  it('groups departed items after them', () => {
    const diff = diffReports(yesterday, today);

    for (const section of diff.sections) {
      const firstRemoved = section.items.findIndex((item) => item.status === 'removed');
      if (firstRemoved === -1) continue;
      // Once removals start, nothing present today follows.
      for (const item of section.items.slice(firstRemoved)) {
        expect(item.status).toBe('removed');
      }
    }
  });

  it('walks the same rows the jump control walks', () => {
    const diff = diffReports(yesterday, today);
    const jumpTargets = changedItemDiffs(diff);

    // A "next change" that skipped a row the page had marked would be worse than no control.
    const markedRows = diff.sections.flatMap((section) =>
      section.items.filter((item) => item.status !== 'unchanged'),
    );

    expect(jumpTargets.length).toBeGreaterThan(0);
    expect(jumpTargets.map((row) => row.stableId)).toEqual(markedRows.map((row) => row.stableId));
  });
});

describe('the six sections', () => {
  it('are emitted in the spine’s fixed order', () => {
    const diff = diffReports(yesterday, today);

    expect(diff.sections.map((section) => section.key)).toEqual(
      today.sections.map((section) => section.key),
    );
    expect(diff.sections.map((section) => section.index)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('marks a section as changed when only its own prose moved', () => {
    const withNewSummary: StructuredReport = {
      ...today,
      sections: today.sections.map((section, index) =>
        index === 0 ? { ...section, summary: 'A different lead sentence.' } : section,
      ),
    };

    const diff = diffReports(today, withNewSummary);
    const first = diff.sections[0]!;

    expect(first.changedCount).toBe(0);
    expect(first.sectionFieldChanges.map((change) => change.field)).toEqual(['summary']);
    expect(first.hasChanges, 'a changed section lead is a change').toBe(true);
    expect(diff.hasChanges).toBe(true);
  });

  it('counts per section, and the totals are the sum of them', () => {
    const diff = diffReports(yesterday, today);

    const sum = (pick: (section: (typeof diff.sections)[number]) => number): number =>
      diff.sections.reduce((total, section) => total + pick(section), 0);

    expect(diff.addedCount).toBe(sum((section) => section.addedCount));
    expect(diff.removedCount).toBe(sum((section) => section.removedCount));
    expect(diff.changedCount).toBe(sum((section) => section.changedCount));
    expect(diff.unchangedCount).toBe(sum((section) => section.unchangedCount));
  });
});

describe('a hand-built pair, for the cases the seed does not contain', () => {
  const item = (overrides: Partial<ReportItem> & Pick<ReportItem, 'stableId'>): ReportItem =>
    ({
      cause: { entityRef: 'ticket:DEV-1', kind: 'status_dwell', scopeKey: 'platform' },
      headline: 'DEV-1 is blocked',
      detail: 'It has not moved.',
      changeTag: 'unchanged',
      ageDays: 3,
      firstSeenAt: SEED_NOW,
      severityScore: 30,
      signalOnsetAt: SEED_NOW,
      evidence: [],
      ...overrides,
    }) as ReportItem;

  const reportWith = (items: readonly ReportItem[]): StructuredReport => ({
    ...today,
    sections: today.sections.map((section, index) =>
      index === 0 ? { ...section, items } : { ...section, items: [] },
    ),
  });

  it('reports an item that appeared as added and one that left as removed', () => {
    const before = reportWith([item({ stableId: 'kept' }), item({ stableId: 'gone' })]);
    const after = reportWith([item({ stableId: 'kept' }), item({ stableId: 'fresh' })]);

    const diff = diffReports(before, after);
    const rows = diff.sections[0]!.items;

    expect(rows.map((row) => `${row.stableId}:${row.status}`)).toEqual([
      'kept:unchanged',
      'fresh:added',
      'gone:removed',
    ]);
    expect(diff.addedCount).toBe(1);
    expect(diff.removedCount).toBe(1);
    expect(diff.changedCount).toBe(0);
  });

  it('names exactly the fields that moved on a changed item', () => {
    const before = reportWith([item({ stableId: 'kept', ageDays: 3, severityScore: 30 })]);
    const after = reportWith([item({ stableId: 'kept', ageDays: 4, severityScore: 45 })]);

    const changed = diffReports(before, after).sections[0]!.items[0]!;

    expect(changed.status).toBe('changed');
    expect(changed.changedFields.map((change) => change.field)).toEqual(['ageDays', 'severityScore']);
    expect(changed.changedFields[0]).toEqual({ field: 'ageDays', before: '3', after: '4' });
  });

  it('treats an emptied section as removals rather than as an absent section', () => {
    const before = reportWith([item({ stableId: 'only' })]);
    const after = reportWith([]);

    const diff = diffReports(before, after);

    expect(diff.removedCount).toBe(1);
    expect(diff.sections[0]!.items[0]!.status).toBe('removed');
    // The Six Spine never reorders and never loses a section: an empty section is still a section.
    expect(diff.sections).toHaveLength(6);
  });
});
