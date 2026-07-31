import { SECTIONS } from '@compass/analysis';
import { instantFromIso, timeWindow, type Instant } from '@compass/clock';
import type {
  FreshnessReport,
  SourceFreshness,
  StoredReportBundle,
  StoredReportEvidence,
  StoredReportItem,
  StoredReportSection,
} from '@compass/db';

/**
 * A stored report, as the pipeline would have written it.
 *
 * Hand-built rather than produced by running the pipeline: these tests are about
 * the *view*, and a fixture that needed a database would mean the assertions
 * that matter most — six headings, no chart, every claim linked — only ran when
 * PostgreSQL happened to be up.
 */

export const TIMEZONE = 'Europe/London';
export const REPORT_INSTANT: Instant = instantFromIso('2026-07-31T07:30:00Z');
export const WINDOW = timeWindow(instantFromIso('2026-07-29T23:00:00Z'), instantFromIso('2026-07-30T23:00:00Z'));

let evidenceCounter = 0;

function evidence(
  reportItemId: string,
  kind: string,
  label: string,
  artifactId: string,
  typed: Partial<Pick<StoredReportEvidence, 'commitSha' | 'pullRequestNumber' | 'issueKey'>> = {},
): StoredReportEvidence {
  evidenceCounter += 1;
  return {
    id: `evidence-${evidenceCounter}`,
    reportItemId,
    ordinal: evidenceCounter,
    kind,
    label,
    sourceKey: kind === 'issue' || kind === 'sprint' ? 'primary-tracker' : 'primary-code',
    sourceRecordId: artifactId,
    commitSha: typed.commitSha ?? null,
    pullRequestNumber: typed.pullRequestNumber ?? null,
    issueKey: typed.issueKey ?? null,
    artifactKind: kind,
    artifactId,
  };
}

interface ItemSpec {
  readonly stableId: string;
  readonly headline: string;
  readonly detail: string;
  readonly prose: string;
  readonly ageDays?: number;
  readonly changeClause?: string;
  readonly withLadder?: boolean;
  readonly evidence: readonly (readonly [kind: string, label: string, artifactId: string])[];
}

function item(spec: ItemSpec, ordinal: number): StoredReportItem {
  const id = `item-${spec.stableId}`;
  return {
    id,
    ordinal,
    stableId: spec.stableId,
    headline: spec.headline,
    detail: spec.detail,
    prose: spec.prose,
    changeTag: 'unchanged',
    ageDays: spec.ageDays ?? 0,
    changeClause: spec.changeClause ?? null,
    ladder:
      spec.withLadder === true
        ? {
            notches: [
              { rung: 'R1', label: 'committed', crossed: true, reachable: true, statement: null },
              { rung: 'R2', label: 'merged', crossed: true, reachable: true, statement: null },
              { rung: 'R3', label: 'accepted', crossed: true, reachable: true, statement: null },
              { rung: 'R4', label: 'released', crossed: false, reachable: true, statement: null },
              {
                rung: 'R5',
                label: 'deployed',
                crossed: false,
                reachable: false,
                statement: 'no deploy signal available',
              },
            ],
            highestCrossed: 'R3',
            highestCrossedLabel: 'accepted',
            highestContiguous: 'R3',
            deploySignalAvailable: false,
          }
        : null,
    payload: { stableId: spec.stableId, headline: spec.headline },
    evidence: spec.evidence.map(([kind, label, artifactId]) =>
      evidence(
        id,
        kind,
        label,
        artifactId,
        kind === 'commit'
          ? { commitSha: artifactId.split(':').at(-1) ?? artifactId }
          : kind === 'pull_request'
            ? { pullRequestNumber: Number.parseInt(label.replace('#', ''), 10) }
            : kind === 'issue'
              ? { issueKey: label }
              : {},
      ),
    ),
  };
}

const ITEMS: Readonly<Record<string, readonly ItemSpec[]>> = {
  yesterday: [
    {
      stableId: 'yesterday:ticket:DEV-501',
      headline: 'DEV-501 via #883 — Batch the checkout writer',
      detail: 'Reached R3 accepted.',
      prose:
        'DEV-501 via #883 — Batch the checkout writer — so it reached R3 accepted and nothing above that. Evidence: DEV-501, #883 — traced to 2 artifacts you can open.',
      ageDays: 1,
      withLadder: true,
      evidence: [
        ['issue', 'DEV-501', 'issue-DEV-501'],
        ['pull_request', '#883', 'pr-883'],
      ],
    },
  ],
  progress: [
    {
      stableId: 'progress:sprint:primary-tracker:sprint-43',
      headline: 'Sprint 43 is 62% complete',
      detail: '24 of 39 points.',
      prose:
        'Sprint 43 is 62% complete — 24 of 39 points — which is behind the pace the elapsed schedule implies.',
      ageDays: 8,
      evidence: [['sprint', 'Sprint 43', 'sprint-43']],
    },
  ],
  blockers: [
    {
      stableId: 'blocker:ticket:DEV-522:tracker_flag',
      headline: 'DEV-522 is flagged blocked in the tracker',
      detail: 'The tracker said so; Compass did not infer it.',
      prose:
        'DEV-522 is flagged blocked in the tracker — so it has held for 6 days and is stated as a blocker rather than as slow progress.',
      ageDays: 6,
      changeClause: 'reviewer added, age unchanged',
      evidence: [['issue', 'DEV-522', 'issue-DEV-522']],
    },
  ],
  risks: [
    {
      stableId: 'risk:sprint:sprint-43:scope_added_after_start',
      headline: '1 item entered Sprint 43 after it started',
      detail: 'DEV-530.',
      prose: '1 item entered Sprint 43 after it started — which Compass rates medium severity and new.',
      ageDays: 3,
      evidence: [['sprint', 'Sprint 43', 'sprint-43']],
    },
  ],
  recommendations: [
    {
      stableId: 'recommendation:blocker:DEV-522',
      headline: 'Marcus Hale — find out what DEV-522 is waiting on',
      detail: 'It has been flagged for 6 days.',
      prose:
        'Marcus Hale — find out what DEV-522 is waiting on — and it is one step, finishable today.',
      evidence: [['issue', 'DEV-522', 'issue-DEV-522']],
    },
  ],
  wins: [
    {
      stableId: 'win:ticket:DEV-501',
      headline: 'DEV-501 landed the batch writer, 8 points',
      detail: 'Merged and accepted.',
      prose:
        'DEV-501 landed the batch writer, 8 points — because it crossed the threshold T8a sets.',
      ageDays: 1,
      evidence: [['commit', '7a8b9c0', 'checkout-web:7a8b9c0d1e2f']],
    },
  ],
};

export function storedBundle(): StoredReportBundle {
  evidenceCounter = 0;

  const sections: StoredReportSection[] = SECTIONS.map((definition) => {
    const specs = ITEMS[definition.key] ?? [];
    const items = specs.map((spec, index) => item(spec, index + 1));
    return {
      id: `section-${definition.key}`,
      sectionKey: definition.key,
      ordinal: definition.index,
      title: definition.title,
      prose: [`${definition.title} carries what follows — so this section carries ${items.length} item.`]
        .concat(items.map((entry) => entry.prose))
        .join('\n\n'),
      payload: { key: definition.key },
      itemCount: items.length,
      emptyStatement: `Nothing crossed a threshold for ${definition.title}.`,
      summary: items.length === 0 ? null : `${items.length} thing to read in ${definition.title}`,
      items,
    };
  });

  return {
    report: {
      id: 'report-1',
      organizationId: '00000000-0000-4000-8000-000000000001',
      scopeKind: 'team',
      scopeKey: 'platform',
      schemaVersion: 1,
      reportInstant: REPORT_INSTANT,
      reportDate: '2026-07-31',
      timezone: TIMEZONE,
      window: WINDOW,
      contentHash: 'a'.repeat(64),
      payloadJson: '{}',
      payload: {},
      prose: 'the whole report',
      rendererId: 'template',
      coverageStatus: 'partial',
      ingestRunId: 'run-1',
      generatedAt: REPORT_INSTANT,
    },
    sections,
  };
}

/** An empty section in every slot — the "nothing happened" rendering. */
export function emptyBundle(): StoredReportBundle {
  const bundle = storedBundle();
  return {
    ...bundle,
    sections: bundle.sections.map((section) => ({ ...section, items: [], itemCount: 0, summary: null, prose: section.emptyStatement })),
  };
}

const source = (
  sourceKey: string,
  overrides: Partial<SourceFreshness> = {},
): SourceFreshness => ({
  sourceKey,
  sourceKind: 'code',
  status: 'complete',
  reason: 'ok',
  detail: `${sourceKey} answered the full window (12 records).`,
  lastObservedAt: instantFromIso('2026-07-30T18:00:00Z'),
  requestedWindow: WINDOW,
  coveredWindow: WINDOW,
  recordCount: 12,
  artifacts: ['commits'],
  ...overrides,
});

export function freshnessWithMissingSource(): FreshnessReport {
  return {
    hasIngestRecord: true,
    ingestRunId: 'run-1',
    connectorId: 'seed:northwind-v1',
    startedAt: instantFromIso('2026-07-31T07:00:00Z'),
    completedAt: instantFromIso('2026-07-31T07:02:00Z'),
    window: WINDOW,
    totalRecords: 24,
    overallStatus: 'partial',
    sources: [
      source('primary-code'),
      source('primary-tracker', { sourceKind: 'tracker' }),
      source('legacy-code', {
        status: 'unavailable',
        reason: 'rate_limited',
        detail: 'legacy-code returned 429 after exhausting its hourly quota.',
        lastObservedAt: null,
        coveredWindow: null,
        recordCount: 0,
      }),
    ],
    missingSourceKeys: ['legacy-code'],
  };
}

export function freshnessComplete(): FreshnessReport {
  const partial = freshnessWithMissingSource();
  return {
    ...partial,
    overallStatus: 'complete',
    sources: partial.sources.filter((entry) => entry.sourceKey !== 'legacy-code'),
    missingSourceKeys: [],
  };
}

/** No ingest has ever been journalled: the "state nothing" case. */
export function freshnessAbsent(): FreshnessReport {
  return {
    hasIngestRecord: false,
    ingestRunId: null,
    connectorId: null,
    startedAt: null,
    completedAt: null,
    window: null,
    totalRecords: 0,
    overallStatus: 'unavailable',
    sources: [],
    missingSourceKeys: [],
  };
}
