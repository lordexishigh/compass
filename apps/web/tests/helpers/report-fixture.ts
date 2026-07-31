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
  /**
   * The alignment payload, as the analysis core attaches it to the item and the
   * pipeline stores it inside `payload`. Present on alignment claims only.
   */
  readonly alignment?: Record<string, unknown>;
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
    payload: {
      stableId: spec.stableId,
      headline: spec.headline,
      ...(spec.alignment === undefined ? {} : { alignment: spec.alignment }),
    },
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
    /**
     * An OFF-GOAL verdict resolved semantically, and an unattributed question.
     *
     * Both live in Risks, both carry the payload the evidence panel reads, and both
     * are here because the one-click criterion has to be asserted against the real
     * component tree rather than against the analysis core's return value.
     */
    {
      stableId: 'alignment:off_goal:OBJ-Q2-BILL',
      headline:
        'OFF-GOAL — 3 open items and 2 commits serve OBJ-Q2-BILL, "Migrate every merchant off the legacy billing client", which is not a current objective',
      detail: 'PLAT-742, PLAT-743 match OBJ-Q2-BILL more closely than the goal chain they sit on.',
      prose:
        'OFF-GOAL — 3 open items and 2 commits serve OBJ-Q2-BILL — so Compass resolved this semantically at 0.62 confidence against the 0.30 threshold T17 sets.',
      ageDays: 4,
      alignment: {
        kind: 'off_goal',
        label: 'OFF-GOAL',
        resolvedTier: 'semantic',
        confidence: 0.6154,
        threshold: 0.3,
        thresholdId: 'T17',
        objectiveNodeId: 'OBJ-Q2-BILL',
        objectiveTitle: 'Migrate every merchant off the legacy billing client',
        question: null,
        subjectLabels: ['PLAT-742', 'PLAT-743', 'PLAT-744'],
        evidence: {
          tier: 'semantic',
          chainNodeIds: ['OBJ-Q2-BILL', 'OBJ-CO-1'],
          chainTitles: ['Migrate every merchant off the legacy billing client', 'Take a payment fastest'],
          score: 0.6154,
          threshold: 0.3,
          comparedTextA: 'Migrate the legacy billing client onto the new SDK',
          comparedTextB: 'Migrate every merchant off the legacy billing client',
          matchedTokens: ['billing', 'client', 'legacy', 'migrate'],
        },
      },
      evidence: [['issue', 'PLAT-742', 'issue-PLAT-742']],
    },
    {
      stableId: 'alignment:unattributed:commits',
      headline: '2 commits could not be tied to a sprint objective',
      detail: 'a1b2c36, a1b2c38 name no tracker key in a commit message or a branch.',
      prose:
        '2 commits could not be tied to a sprint objective — so Compass is asking what they served rather than naming anyone.',
      alignment: {
        kind: 'unattributed',
        label: null,
        resolvedTier: 'unattributed',
        confidence: 0.0833,
        threshold: 0.3,
        thresholdId: 'T17',
        objectiveNodeId: null,
        objectiveTitle: null,
        question: 'What were these 2 commits for?',
        subjectLabels: ['a1b2c36', 'a1b2c38'],
        evidence: {
          tier: 'unattributed',
          score: 0.0833,
          threshold: 0.3,
          comparedTextA: 'bump the lockfile after the audit',
          comparedTextB: 'Halve p95 latency on the tokenization path',
          matchedTokens: ['after'],
          question: 'What were these 2 commits for?',
        },
      },
      evidence: [['commit', 'a1b2c36', 'platform-api:a1b2c36']],
    },
    /**
     * An inferred verdict whose highlight has to land on the recorded offset.
     *
     * The branch names the same key twice on purpose: a component that searched for
     * the substring again would underline the first occurrence, and the offset says
     * the second. Only one of those is what Compass actually matched.
     */
    {
      stableId: 'alignment:off_goal:OBJ-Q1-LEGACY',
      headline: 'OFF-GOAL — 1 commit serves OBJ-Q1-LEGACY, which is not a current objective',
      detail: 'Found the key in the branch name.',
      prose:
        'OFF-GOAL — 1 commit serves OBJ-Q1-LEGACY — so Compass resolved this from an inferred tracker key at 1.00 confidence against the 0.30 threshold T17 sets.',
      alignment: {
        kind: 'off_goal',
        label: 'OFF-GOAL',
        resolvedTier: 'inferred',
        confidence: 1,
        threshold: 0.3,
        thresholdId: 'T17',
        objectiveNodeId: 'OBJ-Q1-LEGACY',
        objectiveTitle: 'Retire the legacy importer',
        question: null,
        subjectLabels: ['b2c3d40'],
        evidence: {
          tier: 'inferred',
          chainNodeIds: ['OBJ-Q1-LEGACY'],
          chainTitles: ['Retire the legacy importer'],
          matchedSubstring: 'PLAT-742',
          // The *second* occurrence, at character 27 of the branch name.
          matchedOffset: 27,
          matchedIn: 'branch_name',
          searchedText: 'feature/PLAT-742-rebase-of-PLAT-742',
          via: 'ticket_key_in_branch',
        },
      },
      evidence: [['commit', 'b2c3d40', 'platform-api:b2c3d40']],
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
