import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { instantFromIso, timeWindow, type Instant as ClockInstant } from '@compass/clock';
import { describe, expect, it } from 'vitest';

import {
  SECTIONS,
  SECTION_ORDER,
  SectionOrderError,
  assertSixSectionsInOrder,
  compareStable,
  createEmptyStructuredReport,
  sectionCounts,
  sectionDefinition,
  sectionOf,
  windowContains,
  type Instant as AnalysisInstant,
  type StructuredReport,
} from '@compass/analysis';

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { dependencies?: Record<string, string> };

const instant = instantFromIso('2026-07-30T08:00:00Z');
const window = timeWindow(instantFromIso('2026-07-29T00:00:00Z'), instantFromIso('2026-07-30T00:00:00Z'));

const report = (): StructuredReport =>
  createEmptyStructuredReport({
    organizationId: '11111111-1111-4111-8111-111111111111',
    scope: { kind: 'team', teamKey: 'platform' },
    instant,
    timezone: 'Europe/London',
    window,
  });

describe('purity', () => {
  it('declares no runtime dependencies at all', () => {
    expect(packageJson.dependencies ?? {}).toEqual({});
  });

  it('shares the Instant brand with @compass/clock without importing it', () => {
    const fromClock: ClockInstant = instant;
    const asAnalysis: AnalysisInstant = fromClock;
    const backToClock: ClockInstant = asAnalysis;

    expect(backToClock).toBe(instant);
  });

  it('applies the same half-open window rule as the clock package', () => {
    expect(windowContains(window, window.start)).toBe(true);
    expect(windowContains(window, window.end)).toBe(false);
  });

  it('orders strings by code unit so a locale cannot change a report', () => {
    expect(compareStable('Z', 'a')).toBe(-1);
    expect(compareStable('a', 'a')).toBe(0);
  });
});

describe('the Six Spine', () => {
  it('is the same six sections in the same order', () => {
    expect(SECTION_ORDER).toEqual(['yesterday', 'progress', 'blockers', 'risks', 'recommendations', 'wins']);
    expect(SECTIONS.map((section) => section.numeral)).toEqual(['01', '02', '03', '04', '05', '06']);
    expect(SECTIONS.map((section) => section.title)).toEqual([
      'Yesterday',
      'Progress',
      'Blockers',
      'Risks',
      'Recommendations',
      'Wins',
    ]);
  });

  it('gives every section a stated empty case rather than a blank space', () => {
    for (const section of SECTIONS) {
      expect(section.emptyStatement.length).toBeGreaterThan(0);
      expect(section.emptyStatement.endsWith('.')).toBe(true);
    }
  });

  it('is frozen, so no caller can reorder the spine at runtime', () => {
    expect(Object.isFrozen(SECTIONS)).toBe(true);
    expect(Object.isFrozen(sectionDefinition('wins'))).toBe(true);
  });

  it('rejects an unknown section', () => {
    // @ts-expect-error the section key is deliberately not one of the six
    expect(() => sectionDefinition('velocity')).toThrow();
  });
});

describe('the structured report', () => {
  it('always has the six sections in fixed order', () => {
    const built = report();

    expect(() => assertSixSectionsInOrder(built)).not.toThrow();
    expect(built.sections.map((section) => section.key)).toEqual([...SECTION_ORDER]);
    expect(built.schemaVersion).toBe(1);
  });

  it('reports zero counts for the spine rather than omitting sections', () => {
    expect(sectionCounts(report())).toEqual([
      { key: 'yesterday', count: 0 },
      { key: 'progress', count: 0 },
      { key: 'blockers', count: 0 },
      { key: 'risks', count: 0 },
      { key: 'recommendations', count: 0 },
      { key: 'wins', count: 0 },
    ]);
  });

  it('is a pure function of its input: two calls are deeply equal', () => {
    expect(JSON.stringify(report())).toBe(JSON.stringify(report()));
  });

  it('carries the instant it was asked about, not one it read', () => {
    expect(report().instant).toBe(instant);
  });

  it('fails loudly if a section is dropped or reordered', () => {
    const shuffled: StructuredReport = {
      ...report(),
      sections: [...report().sections].reverse(),
    };
    const truncated: StructuredReport = { ...report(), sections: report().sections.slice(0, 5) };

    expect(() => assertSixSectionsInOrder(shuffled)).toThrow(SectionOrderError);
    expect(() => assertSixSectionsInOrder(truncated)).toThrow(SectionOrderError);
  });

  it('looks a section up by key', () => {
    expect(sectionOf(report(), 'blockers').title).toBe('Blockers');
  });
});
