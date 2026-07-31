import { SECTIONS } from '@compass/analysis';
import { instantFromIso } from '@compass/clock';
import { loadFreshness, loadReportBundle, reportSections, reports } from '@compass/db';
import { createMigratedTestDatabase, type TestDatabase } from '@compass/db/testing';
import { KnowledgeStore, provisionRoster } from '@compass/knowledge-model';
import { RENDERER_ID } from '@compass/renderers';
import { loadSeedFixtures, resolveSeededRun, seedBundle, type SeededRun } from '@compass/seed-connector';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SEED_TIMEZONE, rosterFromFixtures } from '../src/bootstrap.js';
import { describeColdStart, warmDailyReport } from '../src/cold-start.js';

/**
 * The cold start, end to end, over the real seeded substrate.
 *
 * Everything else in the repo tests one layer. This tests the promise: a clean
 * database plus the checked-in seed plus one call, and a manager can read a
 * six-section report. It runs against a real migrated engine and the *real*
 * generated dataset — not the small pipeline fixture — because the failure this
 * catches is the one where every layer is individually correct and the seeded org
 * still produces an empty report.
 *
 * The worker is a process edge, so it is one of the few places allowed to name the
 * seed package at all; the pipeline's own tests are forbidden from doing so, which
 * is why this coverage has to live here.
 */

let database: TestDatabase;
let run: SeededRun;

/** Inside the seeded span, so no day-shift note is involved. */
const HOST_NOW = instantFromIso('2026-07-30T07:15:00Z');

beforeAll(async () => {
  const bundle = seedBundle();
  run = resolveSeededRun({ hostNow: HOST_NOW, env: {} });

  database = await createMigratedTestDatabase({
    organizationId: bundle.organizationId,
    name: 'Northwind Systems',
    slug: 'northwind-systems',
    timezone: SEED_TIMEZONE,
    at: new Date(bundle.window.start),
  });

  // The roster is configuration, not an observation — exactly as `bootstrap()`
  // provisions it on a real boot.
  const store = new KnowledgeStore(database.scopedFor(bundle.organizationId));
  await provisionRoster(store, rosterFromFixtures(loadSeedFixtures(), SEED_TIMEZONE, bundle.window.start));
}, 240_000);

afterAll(async () => {
  await database?.close();
});

const scoped = () => database.scopedFor(run.organizationId);

let warmed: Awaited<ReturnType<typeof warmDailyReport>>;

describe('a clean database plus the seed produces a readable report', () => {
  beforeAll(async () => {
    warmed = await warmDailyReport(database.db, run);
  }, 240_000);

  it('generates rather than finding one already there', () => {
    expect(warmed.generated).toBe(true);
    expect(warmed.reportId.length).toBeGreaterThan(0);
  });

  it('writes exactly one report with exactly six sections', async () => {
    expect(await scoped().selectFrom(reports)).toHaveLength(1);
    expect(await scoped().selectFrom(reportSections)).toHaveLength(6);
    expect(warmed.sectionCount).toBe(6);
  });

  it('dates the report in the team timezone from the resolved instant', () => {
    expect(warmed.reportDate).toBe('2026-07-30');
    expect(run.timezone).toBe('Europe/London');
    expect(run.timeShiftNote).toBeNull();
  });

  it('holds the six sections in the fixed order, with prose in each', async () => {
    const bundle = await loadReportBundle(scoped(), warmed.reportId);

    expect(bundle?.sections.map((section) => section.sectionKey)).toEqual(SECTIONS.map((section) => section.key));
    expect(bundle?.sections.map((section) => section.ordinal)).toEqual([1, 2, 3, 4, 5, 6]);

    for (const section of bundle?.sections ?? []) {
      expect(section.prose.length, `${section.sectionKey} rendered no prose`).toBeGreaterThan(0);
      expect(section.title.length).toBeGreaterThan(0);
    }
  });

  it('says something about this team rather than six stated absences', async () => {
    const bundle = await loadReportBundle(scoped(), warmed.reportId);
    const items = (bundle?.sections ?? []).flatMap((section) => section.items);

    // The whole point of the seeded dataset is that a cold start has content. Six
    // empty sections would be honest and useless, and the demo would read as a
    // broken product.
    expect(items.length, 'the seeded cold start produced an empty report').toBeGreaterThan(0);
  });

  it('gives every claim at least one artifact a reader can open', async () => {
    const bundle = await loadReportBundle(scoped(), warmed.reportId);

    for (const section of bundle?.sections ?? []) {
      for (const item of section.items) {
        expect(item.evidence.length, `${section.sectionKey}/${item.stableId} carries no evidence`).toBeGreaterThan(0);
        for (const reference of item.evidence) {
          expect(reference.artifactKind.length).toBeGreaterThan(0);
          expect(reference.artifactId.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('journals the ingest, so the freshness panel has real values to show', async () => {
    const freshness = await loadFreshness(scoped(), run.window);

    expect(freshness.hasIngestRecord).toBe(true);
    expect(freshness.completedAt).not.toBeNull();
    expect(freshness.sources.length).toBeGreaterThan(0);
  });

  it('degrades honestly about the source the fixture declares as down', async () => {
    const freshness = await loadFreshness(scoped(), run.window);
    const bundle = await loadReportBundle(scoped(), warmed.reportId);

    // The seed plants one unavailable source on purpose. A cold start that called
    // itself complete would be the exact dishonesty this product replaces.
    expect(freshness.missingSourceKeys.length).toBeGreaterThan(0);
    expect(bundle?.report.coverageStatus).not.toBe('complete');
    expect(warmed.coverageComplete).toBe(false);
  });

  it('renders the whole document through the deterministic template renderer', async () => {
    const bundle = await loadReportBundle(scoped(), warmed.reportId);

    // No Anthropic key is needed for a cold start, and the row records which
    // renderer wrote the prose so the page can say so rather than imply narration.
    expect(bundle?.report.rendererId).toBe(RENDERER_ID);
    expect(bundle?.report.prose.length).toBeGreaterThan(0);

    for (const section of SECTIONS) {
      expect(bundle?.report.prose, `${section.title} is absent from the document text`).toContain(
        section.title.toUpperCase(),
      );
    }
  });
});

describe('the second boot is a read', () => {
  it('finds the report the first boot wrote rather than writing another', async () => {
    const again = await warmDailyReport(database.db, run);

    expect(again.generated).toBe(false);
    expect(again.reportId).toBe(warmed.reportId);
    expect(await scoped().selectFrom(reports)).toHaveLength(1);
    expect(await scoped().selectFrom(reportSections)).toHaveLength(6);
  }, 240_000);

  it('regenerates into the same row when forced', async () => {
    const forced = await warmDailyReport(database.db, run, { force: true });

    expect(forced.generated).toBe(true);
    expect(forced.reportId).toBe(warmed.reportId);
    expect(await scoped().selectFrom(reports)).toHaveLength(1);
  }, 240_000);
});

describe('the line an operator reads', () => {
  it('names the report, the day, the section count and the coverage', () => {
    const line = describeColdStart({
      bootstrap: {
        organizationId: run.organizationId,
        organizationCreated: false,
        teamKeys: [run.teamKey],
        developerCount: 12,
        rosterCreated: 0,
        rosterChanged: 0,
      },
      run,
      ...warmed,
      elapsedMillis: 4_200,
    });

    expect(line).toContain('cold start complete in 4.2s');
    expect(line).toContain(warmed.reportId);
    expect(line).toContain(run.teamKey);
    expect(line).toContain('6 sections');
    expect(line).toContain('coverage incomplete — the report says which source is missing');
  });
});
