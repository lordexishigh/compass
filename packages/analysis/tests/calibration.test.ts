import { describe, expect, it } from 'vitest';

import {
  CALIBRATION_TRAILING_SPRINTS,
  ESTIMATE_COVERAGE_TRAILING_DAYS,
  MILLIS_PER_HOUR,
  PROCESS_VERDICTS,
  PROCESS_VERDICT_RULES,
  THRESHOLDS,
  THRESHOLD_IDS,
  auditProcessCalibration,
  canonicalReportJson,
  compareNumbers,
  compareStable,
  completedSprints,
  generateStructuredReport,
  medianOf,
  resolveScope,
  scopedSprints,
  workingDaysBetween,
  type AnalysisSnapshot,
  type CalibrationAudit,
  type Instant,
  type ProcessVerdictName,
} from '@compass/analysis';

import {
  SEED_NOW,
  buildSeedSnapshot,
  seedSnapshotWithoutEstimationNoise,
  wellRunTeamSnapshot,
} from './helpers/seed-snapshot.js';

/**
 * The Process Calibration Audit.
 *
 * Two properties are asserted throughout, and each of them is the reason a
 * statistic like this is usually worthless:
 *
 *  1. **No number travels alone.** A correlation carries its sample size and its
 *     spread; a coverage percentage carries both counts; a carryover rate names the
 *     tickets that were carried. A verdict states the constant it was compared
 *     against. Every one of those is checkable by a manager, which is the whole
 *     point of auditing the data rather than asserting a conclusion about it.
 *  2. **Every verdict has a negative case.** The seeded organization is
 *     deliberately pathological, so a verdict that fires on it proves nothing on
 *     its own — a detector that returned `true` unconditionally would pass. So
 *     every verdict is asserted against `wellRunTeamSnapshot()`, a constructed team
 *     with nothing wrong with it, and must *not* fire there.
 */
const audit = (snapshot: AnalysisSnapshot, instant: Instant = SEED_NOW): CalibrationAudit =>
  auditProcessCalibration(snapshot, instant, resolveScope(snapshot));

const seeded = (teamKey: 'platform' | 'checkout' | 'insights'): AnalysisSnapshot =>
  buildSeedSnapshot({ scope: { kind: 'team', teamKey } });

const platform = audit(seeded('platform'));
const checkout = audit(seeded('checkout'));
const insights = audit(seeded('insights'));
const wellRun = audit(wellRunTeamSnapshot());

describe('the well-run team is the negative control for the whole audit', () => {
  it('reaches no verdict at all', () => {
    expect(
      wellRun.verdictNames,
      'a team with correlated estimates, no carryover, no churn, consistent dwell and nothing stale must produce no findings',
    ).toEqual([]);
  });

  it('has real samples behind every statistic, so the silence is a measurement', () => {
    const statistics = wellRun.statistics;

    expect(statistics.pointToElapsed.sampleSize).toBeGreaterThanOrEqual(THRESHOLDS.T13.value);
    expect(statistics.estimateCoverage.totalTickets).toBeGreaterThan(0);
    expect(statistics.carryover.perSprint.length).toBeGreaterThan(0);
    expect(statistics.statusDwell.perStatus.length).toBeGreaterThan(0);
    expect(statistics.scopeChurn.perSprint.length).toBeGreaterThan(0);
    expect(wellRun.completedSprintCount).toBeGreaterThanOrEqual(THRESHOLDS.T7.value);
  });

  it('says so in the product’s own voice rather than printing an empty object', () => {
    expect(wellRun.statement).toContain('nothing that would stop you trusting the numbers');
  });
});

// ---------------------------------------------------------------------------
// 001 — correlation, coverage, carryover
// ---------------------------------------------------------------------------

describe('the correlation never travels without its sample size and spread', () => {
  /**
   * Structural, not textual.
   *
   * Walks the whole canonical report — every statistic, every verdict, every
   * sentence's supporting payload — and demands that any object carrying a
   * correlation-shaped number also carries the `sampleSize` and `spread` that make
   * it interpretable. A grep for `r:` would pass the day somebody named the field
   * `coefficient`; this does not.
   */
  // `^r$` exactly, not `^r` — a prefix alternation would match `rate`, `rung` and
  // `reachable`, and a test that flags every field beginning with the letter r is
  // not checking anything.
  const CORRELATION_KEY = /^r$|^(correlation|coefficient|pearson)/i;

  const offenders = (value: unknown, path: string): string[] => {
    if (Array.isArray(value)) return value.flatMap((entry, index) => offenders(entry, `${path}[${index}]`));
    if (value === null || typeof value !== 'object') return [];

    const record = value as Record<string, unknown>;
    const found: string[] = [];
    const carriesCoefficient = Object.keys(record).some(
      (key) => CORRELATION_KEY.test(key) && typeof record[key] === 'number',
    );
    if (carriesCoefficient && (record['sampleSize'] === undefined || record['spread'] === undefined)) {
      found.push(`${path} carries a coefficient with no ${record['sampleSize'] === undefined ? 'sampleSize' : 'spread'}`);
    }
    for (const [key, entry] of Object.entries(record)) found.push(...offenders(entry, `${path}.${key}`));
    return found;
  };

  it.each(['platform', 'checkout', 'insights'] as const)('emits no bare coefficient anywhere in the %s report', (teamKey) => {
    const report = generateStructuredReport(seeded(teamKey), SEED_NOW);

    expect(offenders(JSON.parse(canonicalReportJson(report)), 'report')).toEqual([]);
  });

  it('declares no field named `r` in the audit at all', () => {
    const json = JSON.stringify(platform);

    expect(json).not.toContain('"r":');
  });

  it('carries n and a four-number spread on the correlation itself', () => {
    const correlation = platform.statistics.pointToElapsed;

    expect(correlation.sampleSize).toBe(correlation.samples.length);
    expect(correlation.ticketKeys.length).toBe(correlation.sampleSize);
    for (const spread of [correlation.spread.elapsedWorkingDays, correlation.spread.estimatePoints]) {
      expect(spread.spread).toBe(spread.maximum - spread.minimum);
      expect(spread.median).toBeGreaterThanOrEqual(spread.minimum);
      expect(spread.median).toBeLessThanOrEqual(spread.maximum);
    }
  });

  it('matches a hand-computed n and spread on the seeded platform team', () => {
    // Recomputed here from the snapshot's own transition history rather than
    // asserted as a literal: the figure the audit reports has to be the figure the
    // arithmetic gives, and a literal would only prove the seed had not moved.
    const snapshot = seeded('platform');
    const scope = resolveScope(snapshot);
    const inScope = new Set(
      snapshot.collections.entities
        .filter((entity) => entity.kind === 'ticket' && scope.projectKeys.includes(entity.fields['projectKey'] as string))
        .map((entity) => entity.fields['itemKey'] as string),
    );

    const elapsed: number[] = [];
    const points: number[] = [];
    for (const ticketKey of [...inScope].sort()) {
      const ticket = snapshot.collections.entities.find(
        (entity) => entity.kind === 'ticket' && entity.fields['itemKey'] === ticketKey,
      );
      const estimate = ticket?.fields['estimatePoints'];
      if (typeof estimate !== 'number' || estimate <= 0) continue;

      const history = snapshot.collections.ticketTransitions.filter(
        (transition) => transition.ticketKey === ticketKey,
      );
      const startedAt = history.find((transition) => transition.toStatusCategory === 'in_progress')?.transitionedAt;
      const finishedAt = [...history].reverse().find((transition) => transition.toStatusCategory === 'done')
        ?.transitionedAt;
      if (startedAt === undefined || finishedAt === undefined || finishedAt <= startedAt) continue;
      if (finishedAt > SEED_NOW) continue;

      elapsed.push(workingDaysBetween(startedAt as Instant, finishedAt as Instant));
      points.push(estimate);
    }

    const correlation = platform.statistics.pointToElapsed;
    const sortedElapsed = [...elapsed].sort((left, right) => left - right);

    expect(correlation.sampleSize).toBe(elapsed.length);
    expect(correlation.spread.elapsedWorkingDays.minimum).toBe(sortedElapsed[0]);
    expect(correlation.spread.elapsedWorkingDays.maximum).toBe(sortedElapsed[sortedElapsed.length - 1]);
    expect(correlation.spread.estimatePoints.minimum).toBe(Math.min(...points));
    expect(correlation.spread.estimatePoints.maximum).toBe(Math.max(...points));
  });
});

describe('estimate coverage states both counts over a documented window', () => {
  it('is estimated ÷ total, with both numbers and the window length', () => {
    const coverage = platform.statistics.estimateCoverage;

    expect(coverage.trailingDays).toBe(ESTIMATE_COVERAGE_TRAILING_DAYS);
    expect(coverage.estimatedTickets + coverage.unestimatedTicketKeys.length).toBe(coverage.totalTickets);
    expect(coverage.coverageBasisPoints).toBe(
      Math.round((coverage.estimatedTickets * 10_000) / coverage.totalTickets),
    );
    expect(coverage.statement).toContain(String(coverage.totalTickets));
  });

  it('matches a hand-computed figure on the seeded platform team', () => {
    const snapshot = seeded('platform');
    const scope = resolveScope(snapshot);
    const from = SEED_NOW - ESTIMATE_COVERAGE_TRAILING_DAYS * 24 * 60 * 60 * 1000;

    const inWindow = snapshot.collections.entities.filter((entity) => {
      if (entity.kind !== 'ticket') return false;
      if (!scope.projectKeys.includes(entity.fields['projectKey'] as string)) return false;
      const createdAt = entity.fields['createdAt'];
      return typeof createdAt === 'number' && createdAt >= from && createdAt < SEED_NOW;
    });
    const estimated = inWindow.filter((entity) => {
      const points = entity.fields['estimatePoints'];
      return typeof points === 'number' && points > 0;
    });

    expect(platform.statistics.estimateCoverage.totalTickets).toBe(inWindow.length);
    expect(platform.statistics.estimateCoverage.estimatedTickets).toBe(estimated.length);
  });

  it('reports 0 of 0 rather than dividing by nothing', () => {
    const empty = audit(wellRunTeamSnapshot(), (SEED_NOW + 400 * 24 * 60 * 60 * 1000) as Instant);

    expect(empty.statistics.estimateCoverage.totalTickets).toBe(0);
    expect(empty.statistics.estimateCoverage.coverageBasisPoints).toBe(0);
    expect(empty.statistics.estimateCoverage.statement).toContain('no estimating discipline to measure');
  });
});

describe('carryover is per trailing sprint plus a mean, naming the carried keys', () => {
  it('emits a row per trailing sprint and never more than the documented window', () => {
    expect(platform.trailingSprints).toBe(CALIBRATION_TRAILING_SPRINTS);
    expect(platform.statistics.carryover.perSprint.length).toBeLessThanOrEqual(CALIBRATION_TRAILING_SPRINTS);
    expect(platform.statistics.carryover.perSprint.length).toBeGreaterThan(0);
  });

  it('names every carried ticket and keeps the count and the key list in step', () => {
    for (const row of platform.statistics.carryover.perSprint) {
      expect(row.carriedTicketKeys.length, `${row.sprintName} counts and names different numbers`).toBe(
        row.carriedTickets,
      );
      expect([...row.carriedTicketKeys].sort()).toEqual([...row.carriedTicketKeys]);
      expect(row.rateBasisPoints).toBe(
        row.committedTickets === 0 ? 0 : Math.round((row.carriedTickets * 10_000) / row.committedTickets),
      );
      expect(row.carriedTickets).toBeLessThanOrEqual(row.committedTickets);
    }
  });

  it('states a mean of the per-sprint rates', () => {
    const measured = platform.statistics.carryover.perSprint.filter((row) => row.committedTickets > 0);
    const mean = Math.round(measured.reduce((sum, row) => sum + row.rateBasisPoints, 0) / measured.length);

    expect(platform.statistics.carryover.meanRateBasisPoints).toBe(mean);
  });

  it('carries no carryover at all for a team that finishes what it commits to', () => {
    for (const row of wellRun.statistics.carryover.perSprint) {
      expect(row.carriedTicketKeys).toEqual([]);
      expect(row.rateBasisPoints).toBe(0);
      expect(row.breachedThreshold).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 002 — dwell, churn, double count, stale
// ---------------------------------------------------------------------------

describe('status dwell is per status with n and a spread', () => {
  it('emits a row per workflow status, sorted, with a sample size', () => {
    const perStatus = checkout.statistics.statusDwell.perStatus;

    expect(perStatus.length).toBeGreaterThan(0);
    expect(perStatus.map((row) => row.status)).toEqual([...perStatus.map((row) => row.status)].sort());
    for (const row of perStatus) {
      expect(row.sampleSize).toBeGreaterThan(0);
      expect(row.spread.unit).toBe('hours');
      expect(row.spread.spread).toBe(row.spread.maximum - row.spread.minimum);
      expect(row.spreadOverMedianBasisPoints).toBe(
        row.spread.median === 0 ? 0 : Math.round((row.spread.spread * 10_000) / row.spread.median),
      );
    }
  });

  it('produces the hand-computed spread for the well-run team’s In Progress status', () => {
    // Four items per sprint dwell 48, 60, 72 and 84 hours, cycled — so the spread is
    // 84 − 48 = 36 hours against a median of (60 + 72) ÷ 2 = 66, which is 0.55 times
    // the median and inside T22.
    const inProgress = wellRun.statistics.statusDwell.perStatus.find((row) => row.status === 'In Progress');

    expect(inProgress).toBeDefined();
    expect(inProgress?.sampleSize).toBe(12);
    expect(inProgress?.spread.minimum).toBe(48);
    expect(inProgress?.spread.maximum).toBe(84);
    expect(inProgress?.spread.spread).toBe(36);
    expect(inProgress?.spread.median).toBe(66);
    expect(inProgress?.spreadOverMedianBasisPoints).toBe(5455);
    expect(inProgress?.inconsistent).toBe(false);
  });

  it('produces the hand-computed spread for the busiest status on the seeded workflow', () => {
    // Recomputed from the seeded snapshot's own transition history, over the window
    // the statistic documents — the trailing five completed sprints — rather than
    // asserted as a literal. That checks the arithmetic *and* the window: a spread
    // measured over the whole of history would pass a literal assertion and quietly
    // stop being a statement about the trailing sprints.
    const snapshot = seeded('platform');
    const scope = resolveScope(snapshot);
    const starts = completedSprints(scopedSprints(snapshot, scope), SEED_NOW)
      .slice(-CALIBRATION_TRAILING_SPRINTS)
      .map((sprint) => sprint.fields['startAt'])
      .filter((value): value is number => typeof value === 'number');

    expect(starts.length, 'the seeded platform team must have trailing sprints to bound the window').toBeGreaterThan(0);
    const from = Math.min(...starts);

    const inScope = new Set(
      snapshot.collections.entities
        .filter((entity) => entity.kind === 'ticket' && scope.projectKeys.includes(entity.fields['projectKey'] as string))
        .map((entity) => entity.fields['itemKey'] as string),
    );

    const dwellHours = new Map<string, number[]>();
    for (const ticketKey of [...inScope].sort(compareStable)) {
      const ordered = snapshot.collections.ticketTransitions
        .filter((transition) => transition.ticketKey === ticketKey)
        .sort(
          (left, right) =>
            compareNumbers(left.transitionedAt, right.transitionedAt) ||
            compareStable(left.sourceRecordId, right.sourceRecordId),
        );

      for (let index = 0; index + 1 < ordered.length; index += 1) {
        const entered = ordered[index]!;
        const departed = ordered[index + 1]!;
        if (entered.transitionedAt < from || departed.transitionedAt > SEED_NOW) continue;
        const bucket = dwellHours.get(entered.toStatus) ?? [];
        bucket.push(Math.round((departed.transitionedAt - entered.transitionedAt) / MILLIS_PER_HOUR));
        dwellHours.set(entered.toStatus, bucket);
      }
    }

    const busiest = [...dwellHours.entries()].sort(
      ([leftStatus, left], [rightStatus, right]) =>
        compareNumbers(right.length, left.length) || compareStable(leftStatus, rightStatus),
    )[0];

    expect(busiest, 'the seeded workflow must produce at least one closed dwell interval').toBeDefined();
    const [status, hours] = busiest!;
    const sorted = [...hours].sort(compareNumbers);
    const reported = platform.statistics.statusDwell.perStatus.find((row) => row.status === status);

    expect(reported, `${status} was measured by hand but the audit never reported it`).toBeDefined();
    expect(reported?.sampleSize).toBe(sorted.length);
    expect(reported?.spread.minimum).toBe(sorted[0]);
    expect(reported?.spread.maximum).toBe(sorted[sorted.length - 1]);
    expect(reported?.spread.spread).toBe(sorted[sorted.length - 1]! - sorted[0]!);
    expect(reported?.spread.median).toBe(medianOf(sorted));
    expect(reported?.spread.unit).toBe('hours');
  });
});

describe('scope churn names what came in and what went out', () => {
  it('states the added keys, the removed keys and the committed baseline', () => {
    const churning = audit(wellRunTeamSnapshot({ churn: true }));
    const rows = churning.statistics.scopeChurn.perSprint.filter(
      (row) => row.addedTicketKeys.length + row.removedTicketKeys.length > 0,
    );

    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.addedTicketKeys.length).toBe(2);
    expect(row.removedTicketKeys.length).toBe(1);
    expect(row.committedBaseline).toBeGreaterThan(0);
    expect(row.churnBasisPoints).toBe(Math.round((3 * 10_000) / row.committedBaseline));
    expect(row.breachedThreshold).toBe(true);
  });

  it('reflects the seeded mid-sprint scope change in the rate', () => {
    // `Sprint 46` is the sprint in flight, and the generated dataset adds items to
    // every sprint after it starts. The churn statistic has to see them.
    const changed = platform.statistics.scopeChurn.perSprint.filter(
      (row) => row.addedTicketKeys.length + row.removedTicketKeys.length > 0,
    );

    expect(changed.length, 'the seeded dataset changes sprint scope after the start').toBeGreaterThan(0);
    for (const row of changed) {
      expect(row.churnBasisPoints).toBeGreaterThan(0);
      expect(row.churnBasisPoints).toBe(
        Math.round(((row.addedTicketKeys.length + row.removedTicketKeys.length) * 10_000) / row.committedBaseline),
      );
    }
  });

  it('reports zero churn for a sprint nobody rewrote', () => {
    for (const row of wellRun.statistics.scopeChurn.perSprint) {
      expect(row.addedTicketKeys).toEqual([]);
      expect(row.removedTicketKeys).toEqual([]);
      expect(row.churnBasisPoints).toBe(0);
    }
  });
});

describe('sub-task double counting names the parents', () => {
  it('names the seeded double-counted parent, with a count and a share', () => {
    // `process-hygiene-plat`: PLAT-901 carries 8 points and its two sub-tasks carry
    // 5 and 3, so every points total spanning both levels counts that work twice.
    const doubleCount = platform.statistics.subTaskDoubleCount;

    expect(doubleCount.doubleCountedParentKeys).toContain('PLAT-901');
    expect(doubleCount.doubleCountedParents).toBe(doubleCount.doubleCountedParentKeys.length);
    expect(doubleCount.parentTickets).toBeGreaterThanOrEqual(doubleCount.doubleCountedParents);
    expect(doubleCount.shareBasisPoints).toBe(
      Math.round((doubleCount.doubleCountedParents * 10_000) / doubleCount.parentTickets),
    );
    expect(doubleCount.statement).toContain('PLAT-901');
    expect(doubleCount.statement).toContain('twice');
  });

  it('does not name a sub-task family whose parent carries no estimate', () => {
    expect(checkout.statistics.subTaskDoubleCount.doubleCountedParentKeys).toEqual([]);
    expect(checkout.statistics.subTaskDoubleCount.statement).toContain('No work item in scope has sub-tasks');
  });
});

describe('stale status uses three working days of silence and names every item', () => {
  const stale = platform.statistics.staleStatus;

  it('applies the documented threshold of three working days', () => {
    expect(stale.dwellThreshold.id).toBe('T23');
    expect(stale.dwellThreshold.value).toBe(3);
    expect(stale.dwellThreshold.unit).toBe('working_days');
  });

  it('names the seeded stale ticket', () => {
    // `process-hygiene-plat`: PLAT-905 entered In Progress on 2026-07-22 and was
    // never touched again — seven working days before the report instant.
    expect(stale.staleTicketKeys).toContain('PLAT-905');
    const row = stale.stale.find((entry) => entry.ticketKey === 'PLAT-905');
    expect(row?.inProgressWorkingDays).toBe(7);
    expect(row?.workingDaysSinceActivity, 'nothing has ever been committed against it').toBeNull();
  });

  it('does not name an item that only just moved', () => {
    // PLAT-906 entered In Progress yesterday: it fails the dwell limb.
    expect(stale.staleTicketKeys).not.toContain('PLAT-906');
  });

  it('does not name an item that has been pushed to, however long it has been open', () => {
    // PLAT-907 has been In Progress for a fortnight and was committed to yesterday:
    // it passes the dwell limb and fails the activity limb. Long-running work is not
    // stalled work, and a rule that could not tell them apart would be useless.
    expect(stale.staleTicketKeys).not.toContain('PLAT-907');
  });

  it('keeps the count, the key list and the incidence in step', () => {
    expect(stale.staleTicketKeys.length).toBe(stale.staleTickets);
    expect(stale.stale.length).toBe(stale.staleTickets);
    expect(stale.incidenceBasisPoints).toBe(Math.round((stale.staleTickets * 10_000) / stale.inProgressTickets));
    expect(stale.staleTickets).toBeLessThanOrEqual(stale.inProgressTickets);
  });

  it('finds nothing stale on a team with nothing in flight', () => {
    expect(wellRun.statistics.staleStatus.staleTicketKeys).toEqual([]);
    expect(wellRun.statistics.staleStatus.incidenceBasisPoints).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 003 — the six verdicts, and their documented thresholds
// ---------------------------------------------------------------------------

describe('the verdict vocabulary is closed and every entry names a documented threshold', () => {
  it('enumerates exactly six verdicts', () => {
    expect([...PROCESS_VERDICTS]).toEqual([
      'points_uninformative',
      'estimates_sparse',
      'scope_is_fiction',
      'workflow_inconsistent',
      'statuses_stale',
      'insufficient_history',
    ]);
  });

  it.each([...PROCESS_VERDICTS])('gives %s a statistic and at least one documented threshold constant', (name) => {
    const rule = PROCESS_VERDICT_RULES[name];

    expect(rule.statistic.length, `${name} names no statistic`).toBeGreaterThan(0);
    expect(rule.thresholdIds.length, `${name} cites no threshold`).toBeGreaterThan(0);
    for (const id of rule.thresholdIds) {
      expect(THRESHOLD_IDS, `${name} cites ${id}, which thresholds.ts does not declare`).toContain(id);
      // A documented threshold is a *number* with a statement, not a name.
      expect(typeof THRESHOLDS[id].value).toBe('number');
      expect(THRESHOLDS[id].statement.length).toBeGreaterThan(20);
    }
  });

  it('carries the statistic, the value and the threshold into every emitted verdict', () => {
    const all = [platform, checkout, insights, audit(wellRunTeamSnapshot({ churn: true }))].flatMap(
      (entry) => entry.verdicts,
    );

    expect(all.length).toBeGreaterThan(0);
    for (const verdict of all) {
      const rule = PROCESS_VERDICT_RULES[verdict.name];
      expect(verdict.statistic, verdict.name).toBe(rule.statistic);
      expect(typeof verdict.value).toBe('number');
      expect(THRESHOLD_IDS, `${verdict.name} was compared against an undeclared threshold`).toContain(
        verdict.threshold.id,
      );
      expect(rule.thresholdIds, `${verdict.name} cites a threshold its own rule does not list`).toContain(
        verdict.threshold.id,
      );
      expect(verdict.threshold.value).toBe(THRESHOLDS[verdict.threshold.id].value);
      expect(verdict.sampleSize).toBeGreaterThanOrEqual(0);
      expect(verdict.statement.length).toBeGreaterThan(30);
      // Every threshold the rule cites is carried into the output, not just the one
      // that happened to fire — so a reader can see the whole comparison.
      const carried = [verdict.threshold, ...verdict.supportingThresholds].map((threshold) => threshold.id);
      for (const id of carried) expect(rule.thresholdIds).toContain(id);
    }
  });

  it('emits verdicts in the fixed declaration order, so the output is stable', () => {
    for (const entry of [platform, checkout, insights]) {
      const positions = entry.verdictNames.map((name) => PROCESS_VERDICTS.indexOf(name));
      expect([...positions].sort((left, right) => left - right)).toEqual(positions);
    }
  });
});

describe('points_uninformative fires below |r| = 0.30 with n at or above 10', () => {
  it('fires on the seeded platform team, with a hand-checkable n and spread', () => {
    const verdict = platform.verdicts.find((entry) => entry.name === 'points_uninformative');
    const correlation = platform.statistics.pointToElapsed;

    expect(verdict, 'the seeded estimation noise must produce this verdict').toBeDefined();
    expect(correlation.sampleSize).toBeGreaterThanOrEqual(THRESHOLDS.T13.value);
    expect(correlation.absoluteCoefficientBasisPoints).not.toBeNull();
    expect(correlation.absoluteCoefficientBasisPoints!).toBeLessThan(THRESHOLDS.T12.value);
    expect(verdict?.value).toBe(correlation.absoluteCoefficientBasisPoints);
    expect(verdict?.sampleSize).toBe(correlation.sampleSize);
    expect(verdict?.threshold.id).toBe('T12');
    expect(verdict?.supportingThresholds.map((threshold) => threshold.id)).toEqual(['T13']);
    // The spread is stated in the same breath as the coefficient.
    expect(verdict?.statement).toContain(String(correlation.spread.elapsedWorkingDays.maximum));
  });

  it('clears once the estimation noise is removed from the same dataset', () => {
    // Same tickets, same durations, same sprints — only the point values change, to
    // ones that track the measured duration. Nothing else about the team is
    // different, so the verdict must turn off.
    const corrected = audit(seedSnapshotWithoutEstimationNoise({ scope: { kind: 'team', teamKey: 'platform' } }));

    expect(corrected.verdictNames).not.toContain('points_uninformative');
    expect(corrected.statistics.pointToElapsed.sampleSize).toBe(platform.statistics.pointToElapsed.sampleSize);
    expect(corrected.statistics.pointToElapsed.absoluteCoefficientBasisPoints!).toBeGreaterThanOrEqual(
      THRESHOLDS.T12.value,
    );
  });

  it('refuses the verdict below the sample floor rather than reporting noise', () => {
    // The Kanban team carries no points at all, so the sample is empty: no
    // correlation, and specifically no `points_uninformative` claim about it.
    expect(insights.statistics.pointToElapsed.sampleSize).toBeLessThan(THRESHOLDS.T13.value);
    expect(insights.verdictNames).not.toContain('points_uninformative');
  });
});

describe('estimates_sparse fires below 60% coverage', () => {
  it('fires on the seeded Kanban team, which estimates nothing', () => {
    const verdict = insights.verdicts.find((entry) => entry.name === 'estimates_sparse');

    expect(verdict).toBeDefined();
    expect(verdict?.threshold.id).toBe('T18');
    expect(verdict?.threshold.value).toBe(6_000);
    expect(verdict!.value).toBeLessThan(THRESHOLDS.T18.value);
    expect(verdict?.subjects.length).toBeGreaterThan(0);
  });

  it('does not fire on a team that estimates most of its work', () => {
    expect(platform.statistics.estimateCoverage.coverageBasisPoints).toBeGreaterThanOrEqual(THRESHOLDS.T18.value);
    expect(platform.verdictNames).not.toContain('estimates_sparse');
    expect(wellRun.verdictNames).not.toContain('estimates_sparse');
  });

  it('fires on a constructed team that estimates one item in four', () => {
    const sparse = audit(wellRunTeamSnapshot({ sparseEstimates: true }));

    expect(sparse.verdictNames).toContain('estimates_sparse');
    expect(sparse.statistics.estimateCoverage.coverageBasisPoints).toBeLessThan(THRESHOLDS.T18.value);
  });
});

describe('scope_is_fiction fires on carryover or on churn', () => {
  it('fires on the seeded platform team through the carryover limb', () => {
    const verdict = platform.verdicts.find((entry) => entry.name === 'scope_is_fiction');

    expect(verdict).toBeDefined();
    expect(verdict?.threshold.id).toBe('T20');
    expect(platform.statistics.carryover.breachedSprintCount).toBeGreaterThanOrEqual(THRESHOLDS.T20.value);
    expect(verdict?.supportingThresholds.map((threshold) => threshold.id)).toEqual(['T19']);
    expect(verdict?.subjects.length).toBeGreaterThanOrEqual(THRESHOLDS.T20.value);
  });

  it('fires through the churn limb alone, against T21', () => {
    const churning = audit(wellRunTeamSnapshot({ churn: true }));
    const verdict = churning.verdicts.find((entry) => entry.name === 'scope_is_fiction');

    expect(churning.statistics.carryover.breachedSprintCount).toBeLessThan(THRESHOLDS.T20.value);
    expect(verdict, 'churn alone must be enough').toBeDefined();
    expect(verdict?.threshold.id).toBe('T21');
    expect(verdict!.value).toBeGreaterThanOrEqual(THRESHOLDS.T21.value);
  });

  it('fires through the carryover limb on a constructed team, against T20', () => {
    const carrying = audit(wellRunTeamSnapshot({ carryover: true }));

    expect(carrying.verdictNames).toContain('scope_is_fiction');
    expect(carrying.statistics.carryover.breachedSprintCount).toBeGreaterThanOrEqual(THRESHOLDS.T20.value);
  });

  it('does not fire on a team that finishes its commitment and leaves the scope alone', () => {
    expect(wellRun.verdictNames).not.toContain('scope_is_fiction');
  });
});

describe('workflow_inconsistent fires above the documented multiple of the median dwell', () => {
  it('fires on the seeded dataset, naming the status and the multiple', () => {
    const verdict = platform.verdicts.find((entry) => entry.name === 'workflow_inconsistent');

    expect(verdict).toBeDefined();
    expect(verdict?.threshold.id).toBe('T22');
    expect(verdict?.threshold.value).toBe(15_000);
    expect(verdict!.value).toBeGreaterThanOrEqual(THRESHOLDS.T22.value);
    expect(verdict?.sampleSize).toBeGreaterThanOrEqual(THRESHOLDS.T13.value);
    expect(verdict?.subjects.length).toBeGreaterThan(0);
    expect(verdict?.statement).toContain('median');
  });

  it('does not fire when every status holds its items for a consistent time', () => {
    expect(wellRun.verdictNames).not.toContain('workflow_inconsistent');
    for (const row of wellRun.statistics.statusDwell.perStatus) {
      expect(row.spreadOverMedianBasisPoints).toBeLessThan(THRESHOLDS.T22.value);
    }
  });

  it('fires on the same team once its dwell times are widened', () => {
    const wide = audit(wellRunTeamSnapshot({ wideDwell: true }));

    expect(wide.verdictNames).toContain('workflow_inconsistent');
  });

  it('withholds the verdict below the sample floor, however wide the spread', () => {
    // Two sprints of four items is eight dwell observations, under T13's ten. A
    // spread computed from eight intervals is not a property of the workflow.
    const thin = audit(wellRunTeamSnapshot({ completedSprints: 2, wideDwell: true }));
    const inProgress = thin.statistics.statusDwell.perStatus.find((row) => row.status === 'In Progress');

    expect(inProgress?.sampleSize).toBeLessThan(THRESHOLDS.T13.value);
    expect(inProgress?.spreadOverMedianBasisPoints).toBeGreaterThanOrEqual(THRESHOLDS.T22.value);
    expect(inProgress?.inconsistent).toBe(false);
    expect(thin.verdictNames).not.toContain('workflow_inconsistent');
  });
});

describe('statuses_stale fires at a fifth of the in-progress items', () => {
  it('fires on the seeded platform team', () => {
    const verdict = platform.verdicts.find((entry) => entry.name === 'statuses_stale');

    expect(verdict).toBeDefined();
    expect(verdict?.threshold.id).toBe('T24');
    expect(verdict?.supportingThresholds.map((threshold) => threshold.id)).toEqual(['T23']);
    expect(verdict!.value).toBeGreaterThanOrEqual(THRESHOLDS.T24.value);
    expect(verdict?.subjects).toContain('PLAT-905');
  });

  it('fires on a constructed team with two stalled items and nothing else wrong', () => {
    const stalling = audit(wellRunTeamSnapshot({ staleTickets: 2 }));

    expect(stalling.verdictNames).toContain('statuses_stale');
    expect(stalling.statistics.staleStatus.staleTickets).toBe(2);
  });

  it('does not fire on a team whose board is up to date', () => {
    expect(wellRun.verdictNames).not.toContain('statuses_stale');
  });
});

describe('insufficient_history suppresses the verdicts that need trailing sprints', () => {
  it('fires on the seeded Kanban team, which has no sprints at all', () => {
    const verdict = insights.verdicts.find((entry) => entry.name === 'insufficient_history');

    expect(insights.completedSprintCount).toBeLessThan(THRESHOLDS.T7.value);
    expect(verdict).toBeDefined();
    expect(verdict?.threshold.id).toBe('T7');
    expect(verdict?.value).toBe(insights.completedSprintCount);
  });

  it('withholds exactly the two verdicts that cannot be measured without them', () => {
    expect([...insights.suppressed].sort()).toEqual(['scope_is_fiction', 'workflow_inconsistent']);
    expect(insights.verdictNames).not.toContain('scope_is_fiction');
    expect(insights.verdictNames).not.toContain('workflow_inconsistent');
    // And it says which ones, rather than silently emitting fewer findings.
    expect(insights.statement).toContain('withholding');
  });

  it('still states the verdicts that do not need sprint history', () => {
    // Sparse estimates and a stale board are visible without any sprint at all, and
    // suppressing them would be Compass withholding a finding it had made.
    expect(insights.verdictNames).toContain('estimates_sparse');
    expect(insights.verdictNames).toContain('statuses_stale');
  });

  it('fires on a constructed team with one completed sprint, and suppresses the same two', () => {
    const young = audit(wellRunTeamSnapshot({ completedSprints: 1, churn: true, staleTickets: 1 }));

    expect(young.verdictNames).toContain('insufficient_history');
    expect(young.verdictNames).not.toContain('scope_is_fiction');
    expect([...young.suppressed].sort()).toEqual(['scope_is_fiction', 'workflow_inconsistent']);
  });

  it('does not fire once two sprints have completed', () => {
    expect(audit(wellRunTeamSnapshot({ completedSprints: 2 })).verdictNames).not.toContain('insufficient_history');
    expect(wellRun.suppressed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

describe('every statistic is computed from the snapshot alone and is deterministic', () => {
  it.each(['platform', 'checkout', 'insights'] as const)('produces byte-identical output twice over %s', (teamKey) => {
    const snapshot = seeded(teamKey);
    const scope = resolveScope(snapshot);

    expect(JSON.stringify(auditProcessCalibration(snapshot, SEED_NOW, scope))).toBe(
      JSON.stringify(auditProcessCalibration(snapshot, SEED_NOW, scope)),
    );
  });

  it('sorts every emitted key list, so no iteration order can leak into the output', () => {
    for (const entry of [platform, checkout, insights]) {
      const statistics = entry.statistics;
      const sorted = (keys: readonly string[]) => expect([...keys].sort()).toEqual([...keys]);

      sorted(statistics.estimateCoverage.unestimatedTicketKeys);
      sorted(statistics.staleStatus.staleTicketKeys);
      sorted(statistics.subTaskDoubleCount.doubleCountedParentKeys);
      sorted(statistics.pointToElapsed.ticketKeys);
      for (const row of statistics.carryover.perSprint) sorted(row.carriedTicketKeys);
      for (const row of statistics.scopeChurn.perSprint) {
        sorted(row.addedTicketKeys);
        sorted(row.removedTicketKeys);
      }
      for (const row of statistics.statusDwell.perStatus) sorted(row.ticketKeys);
    }
  });

  it('gives every verdict evidence a reader can open', () => {
    const named: ProcessVerdictName[] = ['points_uninformative', 'estimates_sparse', 'statuses_stale'];
    for (const verdict of platform.verdicts) {
      if (!named.includes(verdict.name)) continue;
      expect(verdict.evidence.length, `${verdict.name} carries no evidence`).toBeGreaterThan(0);
    }
  });
});
