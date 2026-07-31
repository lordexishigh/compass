import { instantFromIso, timeWindow } from '@compass/clock';
import { describe, expect, it } from 'vitest';

import {
  CALIBRATION_VERDICTS,
  THRESHOLDS,
  assessProgress,
  projectCompletion,
  resolveScope,
} from '@compass/analysis';

import { SEED_NOW, buildSeedSnapshot } from './helpers/seed-snapshot.js';

/**
 * The projected completion date and its collar.
 *
 * This is the single most authoritative-looking object on the page — square
 * brackets, mono, 22px — so the standard it is held to is that it can never be a
 * bare number. It carries a band rather than a point, a named method, a
 * machine-readable reasoning structure a renderer can print and a test can check,
 * and a calibration verdict that says in plain words how much conviction the date
 * deserves.
 */
const TEAM_KEYS = ['platform', 'checkout', 'insights'] as const;

const projections = TEAM_KEYS.map((teamKey) => {
  const snapshot = buildSeedSnapshot({ scope: { kind: 'team', teamKey } });
  const scope = resolveScope(snapshot);
  return {
    teamKey,
    projection: projectCompletion(snapshot, SEED_NOW, scope, assessProgress(snapshot, SEED_NOW, scope)),
  };
});

/**
 * Only the teams that actually got a date, narrowed to the `projected` arm.
 *
 * Built with `flatMap` rather than a filtered type predicate so the narrowing is
 * the compiler's own: the tests below reach for `band` and `reasoning`, which the
 * refusal arm genuinely does not have, and a hand-written predicate would assert
 * that rather than prove it.
 */
const projected = projections.flatMap((entry) =>
  entry.projection.kind === 'projected' ? [{ teamKey: entry.teamKey, projection: entry.projection }] : [],
);

describe('a date is never emitted as a bare number', () => {
  it('projects a date for at least one seeded team, so the shape below is exercised', () => {
    expect(projected.length).toBeGreaterThan(0);
  });

  it('brackets every date with a confidence band that actually contains it', () => {
    for (const { teamKey, projection } of projected) {
      const band = projection.band;

      expect(band.earliestInstant, `${teamKey} band starts after its own date`).toBeLessThanOrEqual(projection.instant);
      expect(band.latestInstant, `${teamKey} band ends before its own date`).toBeGreaterThanOrEqual(projection.instant);
      expect(band.spanDays).toBeGreaterThanOrEqual(0);
      expect(['low', 'medium', 'high']).toContain(band.confidence);
    }
  });

  it('states the date and both ends of the band as civil dates a human can read', () => {
    const civilDate = /^\d{4}-\d{2}-\d{2}$/;
    for (const { teamKey, projection } of projected) {
      expect(projection.utcDate, teamKey).toMatch(civilDate);
      expect(projection.band.earliestUtcDate).toMatch(civilDate);
      expect(projection.band.latestUtcDate).toMatch(civilDate);
      // The band reads in the order it is printed.
      expect(projection.band.earliestUtcDate <= projection.band.latestUtcDate).toBe(true);
    }
  });

  it('never projects a date in the past', () => {
    for (const { teamKey, projection } of projected) {
      expect(projection.instant, `${teamKey} projects backwards`).toBeGreaterThanOrEqual(SEED_NOW);
    }
  });

  it('says the band and the method in the first collar line', () => {
    for (const { projection } of projected) {
      expect(projection.statement).toContain(projection.band.earliestUtcDate);
      expect(projection.statement).toContain(projection.band.latestUtcDate);
      expect(projection.statement.length).toBeGreaterThan(30);
    }
  });
});

describe('the reasoning is machine-readable and names its method and inputs', () => {
  it('names a method, and the same one the projection itself reports', () => {
    for (const { teamKey, projection } of projected) {
      expect(['trailing_velocity', 'cycle_time']).toContain(projection.method);
      expect(projection.reasoning.method, `${teamKey} disagrees with itself about its method`).toBe(projection.method);
    }
  });

  it('carries every input to the arithmetic with a name, a value and a unit', () => {
    for (const { teamKey, projection } of projected) {
      const inputs = projection.reasoning.inputs;
      expect(inputs.length, `${teamKey} shows its answer with no working`).toBeGreaterThan(0);

      for (const input of inputs) {
        expect(input.name.length).toBeGreaterThan(0);
        expect(Number.isFinite(input.value), `${teamKey} input \`${input.name}\` is not a number`).toBe(true);
        expect([
          'points',
          'items',
          'days',
          'points_per_sprint',
          'items_per_sprint',
          'sprints',
          'basis_points',
        ]).toContain(input.unit);
      }
      // Named once each, so a renderer can index them.
      const names = inputs.map((input) => input.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('names the inputs each method is actually defined in terms of', () => {
    for (const { teamKey, projection } of projected) {
      const names = projection.reasoning.inputs.map((input) => input.name);

      if (projection.method === 'trailing_velocity') {
        expect(names, teamKey).toContain('remaining');
        expect(names).toContain('meanPerSprint');
        expect(names).toContain('sprintLengthDays');
      } else {
        expect(names, teamKey).toContain('remainingItems');
        expect(names).toContain('medianCycleTimeDays');
        expect(names).toContain('sampleSize');
      }
    }
  });

  it('measures the remaining scope and the pace in the same unit', () => {
    // Regression. `progress.sprint.basis` (T15: points only when four fifths of
    // scope is estimated) and `velocity.basis` (points whenever the trailing
    // sprints totalled any) are decided independently and disagree on the seeded
    // platform team. The projection used to read `remaining` from the first and
    // `meanPerSprint` from the second, dividing items by points-per-sprint — a
    // quotient that is not a number of sprints — and then labelled the item count
    // `points` in the very structure a manager is invited to check.
    for (const { teamKey, projection } of projected) {
      if (projection.method !== 'trailing_velocity') continue;

      const unitOf = (name: string) =>
        projection.reasoning.inputs.find((input) => input.name === name)?.unit;

      const scopeUnit = unitOf('remaining');
      const paceUnit = unitOf('meanPerSprint');

      expect(scopeUnit, teamKey).toBeDefined();
      expect(paceUnit, teamKey).toBeDefined();
      expect(
        paceUnit,
        `${teamKey} divides ${scopeUnit} by ${paceUnit}, which is not a number of sprints`,
      ).toBe(scopeUnit === 'points' ? 'points_per_sprint' : 'items_per_sprint');

      // The band's endpoints are drawn from the same series, so they match too.
      expect(unitOf('slowestSprint')).toBe(scopeUnit);
      expect(unitOf('fastestSprint')).toBe(scopeUnit);
    }
  });

  it('never divides by a pace of zero, whatever the estimates look like', () => {
    for (const { teamKey, projection } of projected) {
      const pace = projection.reasoning.inputs.find(
        (input) => input.name === 'meanPerSprint' || input.name === 'medianCycleTimeDays',
      );
      const scope = projection.reasoning.inputs.find(
        (input) => input.name === 'remaining' || input.name === 'remainingItems',
      );

      expect(pace?.value, `${teamKey} projects from a zero pace`).toBeGreaterThan(0);
      expect(scope?.value, `${teamKey} projects a date for no remaining work`).toBeGreaterThan(0);
    }
  });

  it('writes the formula down and states the assumptions it can be argued with', () => {
    for (const { teamKey, projection } of projected) {
      expect(projection.reasoning.formula.length, `${teamKey} states no formula`).toBeGreaterThan(20);
      expect(projection.reasoning.assumptions.length).toBeGreaterThan(0);
      for (const assumption of projection.reasoning.assumptions) {
        expect(assumption.length).toBeGreaterThan(20);
      }
    }
  });
});

describe('the calibration collar qualifies the date in the product’s own voice', () => {
  it('carries a verdict from the closed vocabulary on every projection', () => {
    for (const { teamKey, projection } of projections) {
      const calibration = projection.calibration;
      expect(CALIBRATION_VERDICTS as readonly string[], teamKey).toContain(calibration.verdict);
      expect(calibration.statement.length).toBeGreaterThan(30);
      expect(calibration.correlationThreshold.id).toBe('T12');
      expect(calibration.sampleThreshold.id).toBe('T13');
    }
  });

  it('refuses a verdict below the sample size it needs, rather than reporting noise', () => {
    for (const { teamKey, projection } of projections) {
      const calibration = projection.calibration;
      if (calibration.sampleSize < THRESHOLDS.T13.value) {
        expect(calibration.verdict, teamKey).toBe('not_enough_data');
        expect(calibration.correlationBasisPoints).toBeNull();
      }
      expect(calibration.ticketKeys.length).toBe(calibration.sampleSize);
    }
  });

  it('never claims high confidence on a date its own estimates do not support', () => {
    // The typography loses conviction when calibration is poor; the data model has
    // to lose it first, or the renderer would be inventing the distinction.
    for (const { teamKey, projection } of projected) {
      if (projection.calibration.verdict !== 'points_track_elapsed') {
        expect(projection.band.confidence, `${teamKey} is confident on uncalibrated estimates`).not.toBe('high');
      }
    }
  });

  it('uses story points to forecast only where they have predicted duration before', () => {
    for (const { teamKey, projection } of projected) {
      if (projection.method === 'trailing_velocity') {
        const usesPoints = projection.reasoning.inputs.some((input) => input.unit === 'points_per_sprint');
        if (usesPoints) {
          expect(projection.calibration.verdict, `${teamKey} forecasts in points it has not validated`).toBe(
            'points_track_elapsed',
          );
        }
      }
    }
  });
});

describe('it refuses rather than guessing', () => {
  const early = () => {
    const instant = instantFromIso('2026-05-25T09:00:00.000Z');
    const snapshot = buildSeedSnapshot({
      scope: { kind: 'team', teamKey: 'platform' },
      instant,
      window: timeWindow(instantFromIso('2026-05-24T00:00:00.000Z'), instantFromIso('2026-05-25T00:00:00.000Z')),
    });
    const scope = resolveScope(snapshot);
    return projectCompletion(snapshot, instant, scope, assessProgress(snapshot, instant, scope));
  };

  it('emits no date, no band and no reasoning below two completed sprints', () => {
    const projection = early();

    expect(projection.kind).toBe('undefined');
    if (projection.kind !== 'undefined') throw new Error('expected a refusal');

    expect(projection.reason).toBe('insufficient_history');
    expect(projection.threshold.id).toBe('T7');
    // A date with a shrug next to it is still a date somebody puts in a plan.
    expect(Object.keys(projection)).not.toContain('utcDate');
    expect(Object.keys(projection)).not.toContain('band');
    expect(Object.keys(projection)).not.toContain('reasoning');
  });

  it('still carries a calibration verdict, because the refusal has a reason too', () => {
    const projection = early();
    if (projection.kind !== 'undefined') throw new Error('expected a refusal');

    expect(CALIBRATION_VERDICTS as readonly string[]).toContain(projection.calibration.verdict);
    expect(projection.statement.length).toBeGreaterThan(30);
  });

  it('names a reason from the closed set whenever it declines', () => {
    for (const { teamKey, projection } of projections) {
      if (projection.kind === 'undefined') {
        expect(['insufficient_history', 'no_remaining_scope', 'no_flow_history'], teamKey).toContain(projection.reason);
      }
    }
  });
});

describe('the projection is deterministic', () => {
  it('produces an identical projection on two runs over the same snapshot', () => {
    for (const teamKey of TEAM_KEYS) {
      const run = () => {
        const snapshot = buildSeedSnapshot({ scope: { kind: 'team', teamKey } });
        const scope = resolveScope(snapshot);
        return projectCompletion(snapshot, SEED_NOW, scope, assessProgress(snapshot, SEED_NOW, scope));
      };

      expect(run()).toEqual(run());
    }
  });
});
