import {
  PROGRESS_ITEM_IDS,
  createEmptyStructuredReport,
  thresholdRef,
  type Instant,
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
export const WINDOW = timeWindow(instantFromIso('2026-07-29T23:00:00Z'), instantFromIso('2026-07-30T23:00:00Z'));

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

  const yesterdayItem: ReportItem = {
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
    },
  };

  const sprintItem: ReportItem = {
    stableId: PROGRESS_ITEM_IDS.sprint('primary-tracker:sprint-43'),
    headline: 'Sprint 43 is 62% complete, 24 of 39 points, against "Cut checkout latency"',
    detail: '32 items were committed at the start and 4 were added since.',
    changeTag: 'unchanged',
    ageDays: 6,
    evidence: [{ kind: 'sprint', label: 'Sprint 43', sourceKey: 'primary-tracker', sourceRecordId: 'sprint-43' }],
  };

  const projectionItem: ReportItem = {
    stableId: PROGRESS_ITEM_IDS.projection,
    headline: 'Projected completion 2026-08-14',
    detail: 'Between 2026-08-11 and 2026-08-19.',
    changeTag: 'unchanged',
    ageDays: 0,
    evidence: [],
  };

  const velocityItem: ReportItem = {
    stableId: PROGRESS_ITEM_IDS.velocity,
    headline: 'Velocity averages 31 points across the last 3 completed sprints',
    detail: 'Sprint 40: 28 points; Sprint 41: 33 points; Sprint 42: 32 points.',
    changeTag: 'improved',
    ageDays: 0,
    evidence: [],
  };

  const blockerItem: ReportItem = {
    stableId: 'blocker:ticket:CHK-701:no_movement',
    headline: 'CHK-701 has not moved in 6 working days',
    detail: 'Last transition to In Progress on 2026-07-21.',
    changeTag: 'unchanged',
    ageDays: 6,
    changeClause: 'reviewer added, age unchanged',
    evidence: [{ kind: 'issue', label: 'CHK-701', sourceKey: 'primary-tracker', sourceRecordId: 'issue-701' }],
  };

  const riskItem: ReportItem = {
    stableId: 'risk:sprint:sprint-43:scope_added_after_start',
    headline: '4 items entered Sprint 43 after it started',
    detail: 'CHK-880, CHK-881, CHK-882, CHK-883.',
    changeTag: 'worsened',
    ageDays: 3,
    changeClause: 'high severity, worsened, against 2 at the start of this window',
    evidence: [{ kind: 'sprint', label: 'Sprint 43', sourceKey: 'primary-tracker', sourceRecordId: 'sprint-43' }],
  };

  const recommendationItem: ReportItem = {
    stableId: 'recommendation:review:CHK-701',
    headline: 'Priya Raman: ask Dev Patel to review #883 today',
    detail: 'It has been open 6 days with no first review.',
    changeTag: 'new',
    ageDays: 0,
    changeClause: 'today',
    evidence: [{ kind: 'pull_request', label: '#883', sourceKey: 'primary-code', sourceRecordId: 'pr-883' }],
  };

  const winItem: ReportItem = {
    stableId: 'win:ticket:DEV-501',
    headline: 'DEV-501 landed the batch writer, 8 points',
    detail: 'Merged and released in v2.14.',
    changeTag: 'resolved',
    ageDays: 1,
    evidence: [{ kind: 'release', label: 'v2.14', sourceKey: 'primary-code', sourceRecordId: 'tag-214' }],
  };

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
        reasoning: { method: 'cycle_time', formula: 'remaining / rate', inputs: [], assumptions: [] },
        calibration: {
          verdict: 'points_uninformative',
          sampleSize: 9,
          correlationBasisPoints: 1200,
          correlationThreshold: thresholdRef('T12'),
          sampleThreshold: thresholdRef('T13'),
          ticketKeys: [],
          statement:
            'Your points have not tracked elapsed days for 4 sprints, so this date is a cycle-time guess.',
        },
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
