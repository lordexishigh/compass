import {
  PROGRESS_CAUSE_KINDS,
  createEmptyStructuredReport,
  emptyCalibrationAudit,
  thresholdRef,
  type CalibrationVerdict,
  type Instant,
  type ItemCause,
  type ReportItem,
  type SectionKey,
  type StructuredReport,
} from '@compass/analysis';
import { instantFromIso, timeWindow } from '@compass/clock';

/**
 * Report fixtures for the renderer tests.
 *
 * These are built from `createEmptyStructuredReport` and then filled, rather than
 * hand-written as literals, so a change to the report shape breaks compilation
 * here instead of quietly leaving these fixtures behind.
 */

export const INSTANT: Instant = instantFromIso('2026-07-31T08:12:00Z');

/**
 * The collar's verdict for a team whose points mean nothing.
 *
 * The correlation is taken from `emptyCalibrationAudit()` and given a coefficient,
 * rather than being written out as a literal: the whole point of the shape is that a
 * coefficient cannot exist without the sample size and spread beside it, and a
 * fixture that assembled one by hand would be the first place that stopped being
 * true.
 */
const CALIBRATION_VERDICT: CalibrationVerdict = {
  verdict: 'points_uninformative',
  sampleSize: 12,
  correlation: {
    ...emptyCalibrationAudit().statistics.pointToElapsed,
    sampleSize: 12,
    coefficientBasisPoints: 1_200,
    absoluteCoefficientBasisPoints: 1_200,
  },
  correlationThreshold: thresholdRef('T12'),
  sampleThreshold: thresholdRef('T13'),
  ticketKeys: [],
  statement: 'Your points have not tracked elapsed working days for 4 sprints, so this date is a cycle-time guess.',
};
export const WINDOW = timeWindow(instantFromIso('2026-07-29T23:00:00Z'), instantFromIso('2026-07-30T23:00:00Z'));

/** Six days before the report instant, so an "unchanged since" age renders as a real number. */
export const FIRST_SEEN_AT: Instant = instantFromIso('2026-07-25T08:12:00Z');

/**
 * One fixture item, with the change-awareness fields filled in.
 *
 * A builder rather than a literal so the renderer tests exercise items shaped exactly as the
 * analysis core emits them: `cause` in particular is not decoration here — `progressClause` chooses
 * a figure's interpretation template by `cause.causeKind`, so a fixture with the wrong cause would
 * silently fall through to the change-tag fallback and the pace, collar and rate clauses would
 * never be tested.
 */
export function fixtureItem(
  spec: Omit<ReportItem, 'cause' | 'firstSeenAt' | 'severityScore' | 'signalOnsetAt'> & {
    readonly cause?: ItemCause;
    readonly firstSeenAt?: Instant;
    readonly severityScore?: number;
  },
): ReportItem {
  return {
    firstSeenAt: spec.firstSeenAt ?? FIRST_SEEN_AT,
    severityScore: spec.severityScore ?? 0,
    signalOnsetAt: spec.firstSeenAt ?? FIRST_SEEN_AT,
    cause: spec.cause ?? { entityRef: `fixture:${spec.stableId}`, causeKind: 'fixture', causeDiscriminator: '' },
    ...spec,
  };
}

/** The cause of one Progress figure, which is what the renderer keys its clause on. */
const progressCause = (causeKind: string, entityKey = 'process'): ItemCause => ({
  entityRef: `progress:${entityKey}`,
  causeKind,
  causeDiscriminator: '',
});

export function emptyReport(): StructuredReport {
  return createEmptyStructuredReport({
    organizationId: '11111111-1111-4111-8111-111111111111',
    scope: { kind: 'team', teamKey: 'platform' },
    instant: INSTANT,
    timezone: 'Europe/London',
    window: WINDOW,
    coverage: [
      { sourceKey: 'primary-code', status: 'complete', detail: 'primary-code answered the full window.' },
      { sourceKey: 'primary-tracker', status: 'complete', detail: 'primary-tracker answered the full window.' },
      { sourceKey: 'team-chat', status: 'complete', detail: 'team-chat answered the full window.' },
      {
        sourceKey: 'archive-code',
        status: 'unavailable',
        detail: 'archive-code returned 429 after exhausting its hourly quota of 5000 requests.',
      },
    ],
  });
}

export function withItems(
  report: StructuredReport,
  items: Partial<Record<SectionKey, readonly ReportItem[]>>,
): StructuredReport {
  return {
    ...report,
    sections: report.sections.map((section) => ({ ...section, items: items[section.key] ?? section.items })),
  };
}

/**
 * A report with something in every one of the six sections, and with the findings
 * that back those items, so the renderer's `stableId` joins actually resolve and
 * every interpretation template gets exercised.
 */
export function fullReport(): StructuredReport {
  const base = emptyReport();

  const yesterdayItem: ReportItem = fixtureItem({
    stableId: 'yesterday:DEV-501:merged',
    headline: 'DEV-501 merged as #883, the batch writer',
    detail: 'Reached R2 merged. Evidence: DEV-501, #883.',
    changeTag: 'resolved',
    ageDays: 1,
    evidence: [
      { kind: 'issue', label: 'DEV-501', sourceKey: 'primary-tracker', sourceRecordId: 'issue-1' },
      { kind: 'pull_request', label: '#883', sourceKey: 'primary-code', sourceRecordId: 'pr-883' },
      { kind: 'commit', label: '7a8b9c0', sourceKey: 'primary-code', sourceRecordId: 'commit-1' },
    ],
    ladder: {
      notches: [],
      highestCrossed: 'R2',
      highestCrossedLabel: 'merged',
      highestContiguous: 'R2',
      deploySignalAvailable: false,
      rungSuffix: 'merged, not yet integrated',
    },
  });

  const sprintItem: ReportItem = fixtureItem({
    stableId: 'v1:0000000000000001',
    cause: progressCause(PROGRESS_CAUSE_KINDS.sprint, 'primary-tracker:sprint-43'),
    headline: 'Sprint 43 is 62% complete, 24 of 39 points, against "Cut checkout latency"',
    detail: '32 items were committed at the start and 4 were added since.',
    changeTag: 'unchanged',
    ageDays: 6,
    evidence: [{ kind: 'sprint', label: 'Sprint 43', sourceKey: 'primary-tracker', sourceRecordId: 'sprint-43' }],
  });

  const projectionItem: ReportItem = fixtureItem({
    stableId: 'v1:0000000000000002',
    cause: progressCause(PROGRESS_CAUSE_KINDS.projection),
    headline: 'Projected completion 2026-08-14',
    detail: 'Between 2026-08-11 and 2026-08-19.',
    changeTag: 'unchanged',
    ageDays: 0,
    evidence: [],
  });

  const velocityItem: ReportItem = fixtureItem({
    stableId: 'v1:0000000000000003',
    cause: progressCause(PROGRESS_CAUSE_KINDS.velocity),
    headline: 'Velocity averages 31 points across the last 3 completed sprints',
    detail: 'Sprint 40: 28 points; Sprint 41: 33 points; Sprint 42: 32 points.',
    changeTag: 'improved',
    ageDays: 0,
    evidence: [],
  });

  const blockerItem: ReportItem = fixtureItem({
    stableId: 'blocker:ticket:CHK-701:no_movement',
    headline: 'CHK-701 has not moved in 6 working days',
    detail: 'Last transition to In Progress on 2026-07-21.',
    changeTag: 'unchanged',
    ageDays: 6,
    changeClause: 'reviewer added, age unchanged',
    evidence: [{ kind: 'issue', label: 'CHK-701', sourceKey: 'primary-tracker', sourceRecordId: 'issue-701' }],
  });

  const riskItem: ReportItem = fixtureItem({
    stableId: 'risk:sprint:sprint-43:scope_added_after_start',
    headline: '4 items entered Sprint 43 after it started',
    detail: 'CHK-880, CHK-881, CHK-882, CHK-883.',
    changeTag: 'worsened',
    ageDays: 3,
    changeClause: 'high severity, worsened, against 2 at the start of this window',
    evidence: [{ kind: 'sprint', label: 'Sprint 43', sourceKey: 'primary-tracker', sourceRecordId: 'sprint-43' }],
  });

  const recommendationItem: ReportItem = fixtureItem({
    stableId: 'recommendation:review:CHK-701',
    headline: 'Priya Raman: ask Dev Patel to review #883 today',
    detail: 'It has been open 6 days with no first review.',
    changeTag: 'new',
    ageDays: 0,
    changeClause: 'today',
    evidence: [{ kind: 'pull_request', label: '#883', sourceKey: 'primary-code', sourceRecordId: 'pr-883' }],
  });

  const winItem: ReportItem = fixtureItem({
    stableId: 'win:ticket:DEV-501',
    headline: 'DEV-501 landed the batch writer, 8 points',
    detail: 'Merged and released in v2.14.',
    changeTag: 'resolved',
    ageDays: 1,
    evidence: [{ kind: 'release', label: 'v2.14', sourceKey: 'primary-code', sourceRecordId: 'tag-214' }],
  });

  const report = withItems(base, {
    yesterday: [yesterdayItem],
    progress: [sprintItem, projectionItem, velocityItem],
    blockers: [blockerItem],
    risks: [riskItem],
    recommendations: [recommendationItem],
    wins: [winItem],
  });

  return {
    ...report,
    sections: report.sections.map((section) =>
      section.items.length === 0
        ? section
        : { ...section, summary: `${section.items.length} thing to read in ${section.title}` },
    ),
    findings: {
      ...report.findings,
      progress: {
        mode: 'sprint',
        sprint: {
          sprintKey: 'primary-tracker:sprint-43',
          sprintName: 'Sprint 43',
          goal: 'Cut checkout latency',
          state: 'active',
          startAt: instantFromIso('2026-07-20T09:00:00Z'),
          endAt: instantFromIso('2026-08-03T17:00:00Z'),
          completedAt: null,
          elapsedWorkingDays: 8,
          committed: { tickets: 32, points: 35, ticketKeys: [] },
          addedMidSprint: { tickets: 4, points: 4, ticketKeys: [] },
          currentScope: { tickets: 36, points: 39, ticketKeys: [] },
          completed: { tickets: 22, points: 24, ticketKeys: [] },
          remaining: { tickets: 14, points: 15, ticketKeys: [] },
          basis: 'story_points',
          basisThreshold: thresholdRef('T3'),
          unestimatedTicketKeys: [],
          completionPercent: 62,
          completionPercentOfCommitment: 69,
          reconciliation: [],
          evidence: [],
        },
        velocity: {
          kind: 'measured',
          basis: 'story_points',
          samples: [],
          meanPoints: 31,
          medianPoints: 32,
          meanTickets: 25,
          trend: 'rising',
          trendBasisPoints: 800,
          statement: 'Velocity averages 31 points across the last 3 completed sprints.',
        },
      },
      projection: {
        kind: 'projected',
        instant: instantFromIso('2026-08-14T17:00:00Z'),
        utcDate: '2026-08-14',
        band: {
          earliestInstant: instantFromIso('2026-08-11T17:00:00Z'),
          latestInstant: instantFromIso('2026-08-19T17:00:00Z'),
          earliestUtcDate: '2026-08-11',
          latestUtcDate: '2026-08-19',
          spanDays: 8,
          confidence: 'low',
        },
        method: 'cycle_time',
        reasoning: {
          method: 'cycle_time',
          formula: 'remaining / rate',
          inputs: [],
          assumptions: [],
          selectedByVerdicts: ['points_uninformative'],
          confidence: 'low',
        },
        selectedByVerdicts: ['points_uninformative'],
        calibration: CALIBRATION_VERDICT,
        statement: 'Between 2026-08-11 and 2026-08-19, from cycle time over the trailing window.',
      },
      blockers: [
        {
          stableId: blockerItem.stableId,
          signal: 'status_dwell',
          threshold: thresholdRef('T1'),
          measured: { value: 6, unit: 'working_days' },
          subject: { kind: 'ticket', key: 'CHK-701', label: 'CHK-701' },
          ownerDeveloperKey: null,
          ownerName: null,
          headline: blockerItem.headline,
          detail: blockerItem.detail,
          ageDays: 6,
          detectedAt: instantFromIso('2026-07-25T09:00:00Z'),
          evidence: [...blockerItem.evidence],
        },
      ],
      risks: [
        {
          stableId: riskItem.stableId,
          cause: 'scope_added_after_start',
          severity: 'high',
          trend: 'worsened',
          subject: { kind: 'sprint', key: 'sprint-43', label: 'Sprint 43' },
          measured: { value: 4, unit: 'count' },
          priorValue: 2,
          priorAt: instantFromIso('2026-07-29T23:00:00Z'),
          priorBasis: 'measured_at_window_start',
          threshold: thresholdRef('T6'),
          ageDays: 3,
          headline: riskItem.headline,
          detail: riskItem.detail,
          evidence: [...riskItem.evidence],
        },
      ],
      recommendations: [
        {
          stableId: recommendationItem.stableId,
          // The same cause the section item carries, so the finding and the item agree — which is
          // the join a rejection is keyed on.
          cause: recommendationItem.cause,
          source: 'review_bottleneck',
          actor: { kind: 'developer', key: 'priya', displayName: 'Priya Raman' },
          object: { kind: 'pull_request', key: 'primary-code:pr-883', label: '#883' },
          step: 'ask Dev Patel to review #883 today',
          rationale: recommendationItem.detail,
          urgency: 'today',
          evidence: [...recommendationItem.evidence],
        },
      ],
      wins: [
        {
          stableId: winItem.stableId,
          ticketKey: 'DEV-501',
          unitOfWork: 'DEV-501',
          title: 'the batch writer',
          rung: 'R4',
          rungLabel: 'released',
          crossedAt: instantFromIso('2026-07-30T11:41:00Z'),
          points: 8,
          ageWorkingDays: 1,
          qualifiedBy: 'story_points',
          thresholds: [thresholdRef('T8a'), thresholdRef('T8b')],
          minimumRung: 'R2',
          creditedDeveloperKey: 'priya',
          creditedName: 'Priya Raman',
          headline: winItem.headline,
          detail: winItem.detail,
          evidence: [...winItem.evidence],
        },
      ],
    },
  };
}

/**
 * A Kanban team's report: the same six sections, a Progress section with no percentage.
 *
 * Built beside `fullReport` rather than derived from it, because the two Progress payloads
 * are *different shapes* — the whole point of the discriminated union is that a Kanban
 * team's flow has no `sprint` and no `velocity` to override. Spreading one over the other
 * would produce an object neither arm describes, and the renderer's clause selection would
 * then be tested against a payload the analysis core cannot emit.
 *
 * The four flow items carry the four Kanban cause kinds, which is what `progressClause`
 * keys on: without them the WIP, cycle-time and aging figures would fall through to the
 * change-tag fallback and their clauses would never be exercised.
 */
export function kanbanReport(): StructuredReport {
  const base = emptyReport();

  const flowItem: ReportItem = fixtureItem({
    stableId: 'v1:00000000000000a1',
    cause: progressCause(PROGRESS_CAUSE_KINDS.kanbanFlow, 'insights'),
    headline: '3 items finished in this window, 22 are in flight, and the median item has been taking 6 days from start to finish',
    detail: 'This team runs Kanban, so this section reports flow.',
    changeTag: 'unchanged',
    ageDays: 0,
    evidence: [{ kind: 'issue', label: 'INS-204', sourceKey: 'primary-tracker', sourceRecordId: 'issue-204' }],
  });

  const wipItem: ReportItem = fixtureItem({
    stableId: 'v1:00000000000000a2',
    cause: progressCause(PROGRESS_CAUSE_KINDS.kanbanWip, 'insights'),
    headline: '22 items are in flight across 2 columns — In Progress 12, In Review 10',
    detail: 'In Progress: INS-105, INS-106. In Review: INS-118.',
    changeTag: 'unchanged',
    ageDays: 0,
    evidence: [{ kind: 'issue', label: 'INS-105', sourceKey: 'primary-tracker', sourceRecordId: 'issue-105' }],
  });

  const CYCLE_TIME_STATEMENT =
    'Over the last 28 days the median item took 6 days from start to finish and the slowest sixth took 8 or more, across 12 finished items.';
  const CYCLE_TIME_TREND_STATEMENT =
    'Cycle time is lengthening: a median of 5 days over the earlier 14-day half, against 7 days over the later half.';

  const cycleTimeItem: ReportItem = fixtureItem({
    stableId: 'v1:00000000000000a3',
    cause: progressCause(PROGRESS_CAUSE_KINDS.kanbanCycleTime, 'insights'),
    // Both sentences, exactly as `generate.ts` composes them: the trend has to be in the
    // headline to reach the prose at all, and a fixture that kept it in `detail` would test
    // a rendering the analysis core does not produce.
    headline: `${CYCLE_TIME_STATEMENT} ${CYCLE_TIME_TREND_STATEMENT}`,
    detail: 'Measured over the trailing 28 days from INS-141.',
    changeTag: 'unchanged',
    ageDays: 0,
    evidence: [{ kind: 'issue', label: 'INS-141', sourceKey: 'primary-tracker', sourceRecordId: 'issue-141' }],
  });

  const agingItem: ReportItem = fixtureItem({
    stableId: 'v1:00000000000000a4',
    cause: progressCause(PROGRESS_CAUSE_KINDS.kanbanAging, 'insights'),
    headline: '2 items have been in flight longer than the 8-day P85: INS-105 at 19 days in In Progress, INS-118 at 11 days in In Review',
    detail: 'INS-105 "Timezone conversion shifts the settlement date" has been in In Progress for 19 days.',
    changeTag: 'unchanged',
    ageDays: 0,
    evidence: [{ kind: 'issue', label: 'INS-105', sourceKey: 'primary-tracker', sourceRecordId: 'issue-105' }],
  });

  const report = withItems(base, { progress: [flowItem, wipItem, cycleTimeItem, agingItem] });

  return {
    ...report,
    findings: {
      ...report.findings,
      progress: {
        mode: 'kanban',
        reason: 'team_runs_kanban',
        statement: 'This team runs Kanban, so this section reports flow.',
        flow: {
          windowDays: 1,
          throughput: { completedItems: 3, ticketKeys: ['INS-198', 'INS-201', 'INS-204'] },
          workInProgress: {
            items: 22,
            ticketKeys: ['INS-105', 'INS-106', 'INS-118'],
            byColumn: [
              { column: 'In Progress', items: 12, ticketKeys: ['INS-105', 'INS-106'] },
              { column: 'In Review', items: 10, ticketKeys: ['INS-118'] },
            ],
            statement: wipItem.headline,
            evidence: [...wipItem.evidence],
          },
          cycleTime: {
            kind: 'measured',
            sampleSize: 12,
            medianDays: 6,
            p85Days: 8,
            percentile: 0.85,
            trailingDays: 28,
            ticketKeys: ['INS-141'],
            trend: {
              kind: 'measured',
              direction: 'lengthening',
              halfDays: 14,
              earlierMedianDays: 5,
              earlierSampleSize: 5,
              laterMedianDays: 7,
              laterSampleSize: 7,
              changeBasisPoints: 4_000,
              statement: CYCLE_TIME_TREND_STATEMENT,
            },
            statement: CYCLE_TIME_STATEMENT,
            evidence: [...cycleTimeItem.evidence],
          },
          aging: {
            kind: 'measured',
            p85Days: 8,
            percentile: 0.85,
            items: [
              { ticketKey: 'INS-105', title: 'Timezone conversion shifts the settlement date', column: 'In Progress', ageDays: 19 },
              { ticketKey: 'INS-118', title: 'Late-arriving events never update the rollup', column: 'In Review', ageDays: 11 },
            ],
            unmeasurableTicketKeys: [],
            statement: agingItem.headline,
            evidence: [...agingItem.evidence],
          },
          statement: flowItem.headline,
          evidence: [...flowItem.evidence],
        },
      },
    },
  };
}
