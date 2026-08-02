import { SECTIONS, sentencesWithNumbers } from '@compass/analysis';
import { instantFromIso } from '@compass/clock';
import {
  findClaimsCitingArtifact,
  findEvidenceForArtifact,
  findLatestReportForDate,
  loadFreshness,
  loadReportBundle,
  reportItemEvidence,
  reportItems,
  reportSections,
  reports,
} from '@compass/db';
import { interpretationClauseIn } from '@compass/renderers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ensureDailyReport,
  loadLatestReport,
  reportHash,
  runReportPipeline,
  type ReportPipelineResult,
} from '@compass/pipeline';

import {
  INGEST_WINDOW,
  NOW,
  ORGANIZATION_ID,
  REPORT_WINDOW,
  TEAM_KEY,
  TIMEZONE,
  createPipelineHarness,
  type PipelineHarness,
} from './helpers/harness.js';

let harness: PipelineHarness;
let result: ReportPipelineResult;

const SCOPE = { kind: 'team', teamKey: TEAM_KEY } as const;
const SCOPE_COLUMNS = { scopeKind: 'team', scopeKey: TEAM_KEY };

const request = (overrides: Record<string, unknown> = {}) => ({
  organizationId: ORGANIZATION_ID,
  scope: SCOPE,
  now: NOW,
  timezone: TIMEZONE,
  window: REPORT_WINDOW,
  ingestWindow: INGEST_WINDOW,
  runId: '44444444-4444-4444-8444-000000000001',
  connector: harness.connector,
  database: harness.database.db,
  ...overrides,
});

beforeAll(async () => {
  harness = await createPipelineHarness();
  result = await runReportPipeline(request());
}, 120_000);

afterAll(async () => {
  await harness.close();
});

const scoped = () => harness.database.scopedFor(ORGANIZATION_ID);

describe('the pipeline runs the layers in order', () => {
  it('ingests, snapshots, syncs goals, analyses, renders, persists and records links, in that order', () => {
    expect(result.stages).toEqual([
      'ingest-window',
      'build-snapshot',
      // Between the snapshot and the analysis, and in that order for a reason: the
      // goal hierarchy is projected from the model and then *read back*, so a
      // manager's edit — which lives only in the store — is what the next report
      // resolves against.
      'sync-goals',
      // The prior report for this scope and the manager's feedback ledger, loaded together and
      // immediately before the analysis that is *told* about them. The analysis core reads no
      // database, so change-awareness and suppression cannot be queries it makes; they have to be
      // values handed in, and this is the stage that turns rows into those values.
      'load-change-history',
      'analyse',
      'render',
      // Narration runs *after* the deterministic render, so the document a manager
      // can read already exists before a model is asked for anything. It appears in
      // the stage list even with no narrator configured, because "narration was
      // considered and skipped" is a different fact from "there is no such stage".
      'narrate',
      'persist',
      // After the report rather than during analysis: the analysis core is pure and
      // cannot write the audit trail of its own verdicts.
      'record-objective-links',
    ]);
  });

  it('resolves the goal hierarchy for the report instant and aligns against it', () => {
    expect(result.goalHierarchy.resolvedAt).toBe(NOW);
    expect(result.goalHierarchy.nodes.length).toBeGreaterThan(0);
    // Every resolved subject leaves a row; unattributed work deliberately leaves
    // none, so this is a floor rather than an equality.
    expect(result.objectiveLinkCount).toBeGreaterThan(0);
    expect(result.objectiveLinkCount).toBeLessThanOrEqual(result.report.findings.alignment.resolutions.length);
  });

  it('pulls the window through the port and journals the run', async () => {
    expect(result.ingest?.summary.totalRecords).toBeGreaterThan(0);

    const freshness = await loadFreshness(scoped(), REPORT_WINDOW);
    expect(freshness.hasIngestRecord).toBe(true);
    expect(freshness.ingestRunId).toBe(result.ingest?.runId);
  });

  it('hands the analysis core a materialized snapshot for the report instant', () => {
    expect(result.snapshot.instant).toBe(NOW);
    expect(result.snapshot.collections.entities.length).toBeGreaterThan(0);
  });
});

describe('one report row, six sections, in the fixed order', () => {
  it('persists exactly one report for (organization, team, instant)', async () => {
    const rows = await scoped().selectFrom(reports);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.scopeKind).toBe('team');
    expect(rows[0]?.scopeKey).toBe(TEAM_KEY);
  });

  it('persists exactly six sections with ordinals 1..6 in the fixed order', async () => {
    const rows = await scoped().selectFrom(reportSections);
    expect(rows).toHaveLength(6);

    const byOrdinal = [...rows].sort((left, right) => left.ordinal - right.ordinal);
    expect(byOrdinal.map((row) => row.ordinal)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(byOrdinal.map((row) => row.sectionKey)).toEqual([
      'yesterday',
      'progress',
      'blockers',
      'risks',
      'recommendations',
      'wins',
    ]);
    expect(byOrdinal.map((row) => row.title)).toEqual(SECTIONS.map((section) => section.title));
  });

  it('reads the bundle back in ordinal order rather than in row order', async () => {
    const bundle = await loadReportBundle(scoped(), result.stored.id);

    expect(bundle?.sections.map((section) => section.sectionKey)).toEqual(SECTIONS.map((section) => section.key));
    expect(bundle?.sections.map((section) => section.ordinal)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('refuses to persist a report that lost a section', async () => {
    const broken = { ...result.report, sections: result.report.sections.slice(0, 4) };
    const { persistReport } = await import('@compass/pipeline');

    await expect(
      persistReport(scoped(), {
        report: broken,
        rendered: result.rendered,
        generatedAt: NOW,
        ingestRunId: null,
      }),
    ).rejects.toThrow();
  });
});

describe('the structured payload is retained verbatim', () => {
  it('stores the canonical serialisation of the whole report, byte for byte', async () => {
    const { canonicalJson } = await import('@compass/pipeline');

    expect(result.stored.payloadJson).toBe(canonicalJson(result.report));
    expect(JSON.parse(result.stored.payloadJson)).toEqual(JSON.parse(canonicalJson(result.report)));
  });

  it('stores each section payload verbatim beside its rendered prose', async () => {
    const bundle = await loadReportBundle(scoped(), result.stored.id);
    const { canonicalJson } = await import('@compass/pipeline');

    for (const [position, section] of (bundle?.sections ?? []).entries()) {
      const source = result.report.sections[position];
      if (source === undefined) throw new Error('missing source section');

      expect(canonicalJson(section.payload)).toBe(canonicalJson(source));
      expect(section.prose).toBe(result.rendered.sections[position]?.prose);
      expect(section.prose.length).toBeGreaterThan(0);
    }
  });

  it('stores every item payload verbatim, with its evidence split into typed columns', async () => {
    const bundle = await loadReportBundle(scoped(), result.stored.id);
    const { canonicalJson } = await import('@compass/pipeline');

    const items = (bundle?.sections ?? []).flatMap((section) => section.items);
    expect(items.length).toBeGreaterThan(0);

    for (const item of items) {
      expect(item.payload['stableId']).toBe(item.stableId);
      expect(canonicalJson(item.payload)).toContain('"headline"');
    }
  });

  it('records a content hash that ignores only the documented non-semantic fields', () => {
    expect(result.stored.contentHash).toBe(reportHash(result.report));
    expect(result.stored.contentHash).toHaveLength(64);
  });
});

describe('the pipeline never reads the system clock', () => {
  it('generates the report for the instant it was given, not for now', () => {
    expect(result.report.instant).toBe(NOW);
    expect(result.stored.reportInstant).toBe(NOW);
    expect(result.stored.generatedAt).toBe(NOW);
  });

  it('dates the row in the team timezone from that instant', () => {
    expect(result.stored.reportDate).toBe('2026-07-31');
    expect(result.stored.timezone).toBe(TIMEZONE);
  });

  it('produces the same report twice for the same instant, into the same row', async () => {
    const second = await runReportPipeline(request({ runId: '44444444-4444-4444-8444-000000000002' }));

    expect(second.stored.id).toBe(result.stored.id);
    expect(second.stored.contentHash).toBe(result.stored.contentHash);
    expect(second.rendered.text).toBe(result.rendered.text);

    const rows = await scoped().selectFrom(reports);
    expect(rows, 'a replay must overwrite, not accumulate').toHaveLength(1);
    expect(await scoped().selectFrom(reportSections)).toHaveLength(6);
  }, 120_000);

  it('produces a different report for a different instant, in its own row', async () => {
    const earlier = instantFromIso('2026-07-30T07:30:00Z');
    const other = await runReportPipeline(
      request({ now: earlier, runId: '44444444-4444-4444-8444-000000000003', skipIngest: true }),
    );

    expect(other.stored.id).not.toBe(result.stored.id);
    expect(other.stored.reportDate).toBe('2026-07-30');
    expect((await scoped().selectFrom(reports)).length).toBeGreaterThan(1);
  }, 120_000);
});

describe('the report says something about this team', () => {
  it('finds the merged, accepted work in Yesterday', () => {
    const yesterday = result.report.sections[0];
    expect(yesterday?.key).toBe('yesterday');
    expect(yesterday?.items.length, 'DEV-501 merged and was accepted inside the window').toBeGreaterThan(0);
  });

  it('finds the tracker-flagged blocker', () => {
    const blockers = result.report.sections[2];
    expect(blockers?.key).toBe('blockers');
    expect(blockers?.items.some((item) => item.headline.includes('DEV-522'))).toBe(true);
  });

  it('renders prose in every section, and interprets every quantity in it', () => {
    for (const section of result.rendered.sections) {
      expect(section.prose.length, section.key).toBeGreaterThan(0);
    }
    for (const { sentence } of sentencesWithNumbers(result.rendered.prose)) {
      expect(interpretationClauseIn(sentence.text), sentence.text).not.toBeNull();
    }
  });

  it('states the unavailable source rather than presenting the report as complete', () => {
    expect(result.report.coverage.map((note) => note.sourceKey)).toContain('legacy-code');
    expect(result.stored.coverageStatus).toBe('partial');
    expect(result.rendered.freshness).toContain('legacy-code');
  });
});

describe('per-claim evidence resolves to an artifact', () => {
  it('writes an evidence row per reference, with the identifier in its own column', async () => {
    const rows = await scoped().selectFrom(reportItemEvidence);
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(row.artifactKind.length).toBeGreaterThan(0);
      expect(row.artifactId.length).toBeGreaterThan(0);
      if (row.kind === 'issue') expect(row.issueKey).toBe(row.label);
      if (row.kind === 'pull_request') expect(row.pullRequestNumber).not.toBeNull();
      if (row.kind === 'commit') expect(row.commitSha).not.toBeNull();
    }
  });

  it('gives every claim in every section at least one resolvable reference', async () => {
    const bundle = await loadReportBundle(scoped(), result.stored.id);

    for (const section of bundle?.sections ?? []) {
      for (const item of section.items) {
        expect(
          item.evidence.length,
          `${section.sectionKey}/${item.stableId} carries no evidence`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('resolves an artifact back to the claims that cited it', async () => {
    const [reference] = await scoped().selectFrom(reportItemEvidence).limit(1);
    if (reference === undefined) throw new Error('no evidence was written');

    const found = await findEvidenceForArtifact(scoped(), reference.artifactKind, reference.artifactId);
    expect(found.length).toBeGreaterThan(0);

    const claims = await findClaimsCitingArtifact(scoped(), reference.artifactKind, reference.artifactId);
    expect(claims.length).toBeGreaterThan(0);
    expect(claims[0]?.sectionKey.length).toBeGreaterThan(0);
    expect(claims[0]?.reportDate).toBe('2026-07-31');
  });

  it('returns nothing rather than throwing for an artifact nobody cited', async () => {
    expect(await findEvidenceForArtifact(scoped(), 'commit', 'nothing:0000000')).toEqual([]);
    expect(await findClaimsCitingArtifact(scoped(), 'commit', 'nothing:0000000')).toEqual([]);
  });
});

describe('the cold-start read path', () => {
  it('returns the report already written rather than generating a second one', async () => {
    const before = (await scoped().selectFrom(reports)).length;
    const ensured = await ensureDailyReport(request({ runId: '44444444-4444-4444-8444-000000000004' }));

    expect(ensured.generated).toBe(false);
    expect(ensured.result).toBeNull();
    expect(ensured.bundle.sections).toHaveLength(6);
    expect((await scoped().selectFrom(reports)).length).toBe(before);
  }, 120_000);

  it('carries the freshness the view needs, from the ingest journal', async () => {
    const ensured = await ensureDailyReport(request({ runId: '44444444-4444-4444-8444-000000000005' }));

    expect(ensured.freshness.hasIngestRecord).toBe(true);
    expect(ensured.freshness.sources.map((source) => source.sourceKey)).toContain('legacy-code');
    expect(ensured.freshness.missingSourceKeys).toContain('legacy-code');
    expect(ensured.freshness.completedAt).not.toBeNull();
  }, 120_000);

  it('generates on demand when no report exists for the day', async () => {
    const fresh = instantFromIso('2026-07-29T07:30:00Z');
    const ensured = await ensureDailyReport(
      request({ now: fresh, window: undefined, runId: '44444444-4444-4444-8444-000000000006', skipIngest: true }),
    );

    expect(ensured.generated).toBe(true);
    expect(ensured.bundle.report.reportDate).toBe('2026-07-29');
    expect(ensured.bundle.sections).toHaveLength(6);

    const stored = await findLatestReportForDate(scoped(), SCOPE_COLUMNS, '2026-07-29');
    expect(stored?.id).toBe(ensured.bundle.report.id);
  }, 120_000);

  it('regenerates when forced, into the same row', async () => {
    const ensured = await ensureDailyReport(
      request({ runId: '44444444-4444-4444-8444-000000000007', force: true, skipIngest: true }),
    );

    expect(ensured.generated).toBe(true);
    expect(ensured.bundle.report.id).toBe(result.stored.id);
    expect(await scoped().selectFrom(reportSections, undefined)).toHaveLength(6 * 3);
  }, 120_000);

  it('reads the newest report without writing anything', async () => {
    const before = (await scoped().selectFrom(reportItems)).length;
    const latest = await loadLatestReport(harness.database.db, ORGANIZATION_ID, SCOPE);

    expect(latest?.bundle.sections).toHaveLength(6);
    expect(latest?.bundle.report.reportDate).toBe('2026-07-31');
    expect((await scoped().selectFrom(reportItems)).length).toBe(before);
  });

  it('says nothing rather than inventing a shell for an organization with no report', async () => {
    expect(await loadLatestReport(harness.database.db, ORGANIZATION_ID, { kind: 'merged' })).toBeNull();
  });
});
