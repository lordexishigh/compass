import { instantFromIso, timeWindow } from '@compass/clock';
import { describe, expect, it } from 'vitest';

import {
  THRESHOLDS,
  assessProgress,
  assessVelocity,
  generateStructuredReport,
  resolveScope,
  scopedSprints,
  scopedTickets,
} from '@compass/analysis';

import { SEED_NOW, buildSeedSnapshot } from './helpers/seed-snapshot.js';

/**
 * Sprint math, Kanban semantics and the refusal to guess.
 *
 * Every assertion here is one a manager could make with their board open, which
 * is the whole standard the Progress section is held to.
 */
const platform = buildSeedSnapshot({ scope: { kind: 'team', teamKey: 'platform' } });
const insights = buildSeedSnapshot({ scope: { kind: 'team', teamKey: 'insights' } });

/** Every key in an object graph, for the "this field is genuinely absent" checks. */
function allKeys(value: unknown, found: Set<string> = new Set()): ReadonlySet<string> {
  if (Array.isArray(value)) {
    for (const entry of value) allKeys(entry, found);
    return found;
  }
  if (value === null || typeof value !== 'object') return found;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    found.add(key);
    allKeys(nested, found);
  }
  return found;
}

describe('sprint completion reconciles line by line', () => {
  const progress = assessProgress(platform, SEED_NOW, resolveScope(platform));

  it('reports on the sprint that contains the report instant', () => {
    expect(progress.mode).toBe('sprint');
  });

  it('names the contributing ticket keys on every line', () => {
    if (progress.mode !== 'sprint') throw new Error('expected sprint semantics');
    const sprint = progress.sprint;

    for (const [label, line] of [
      ['committed', sprint.committed],
      ['currentScope', sprint.currentScope],
      ['completed', sprint.completed],
      ['remaining', sprint.remaining],
      ['addedMidSprint', sprint.addedMidSprint],
    ] as const) {
      expect(line.ticketKeys.length, `${label} must name its keys`).toBe(line.tickets);
      expect([...line.ticketKeys].sort()).toEqual([...line.ticketKeys]);
    }
  });

  it('adds up: committed plus added is the current scope, completed plus remaining is too', () => {
    if (progress.mode !== 'sprint') throw new Error('expected sprint semantics');
    const sprint = progress.sprint;

    expect(sprint.committed.tickets + sprint.addedMidSprint.tickets).toBe(sprint.currentScope.tickets);
    expect(sprint.committed.points + sprint.addedMidSprint.points).toBe(sprint.currentScope.points);
    expect(sprint.completed.tickets + sprint.remaining.tickets).toBe(sprint.currentScope.tickets);
    expect(sprint.completed.points + sprint.remaining.points).toBe(sprint.currentScope.points);
  });

  it('accounts for every in-scope item exactly once in the reconciliation table', () => {
    if (progress.mode !== 'sprint') throw new Error('expected sprint semantics');
    const sprint = progress.sprint;
    const rows = sprint.reconciliation;

    expect(rows).toHaveLength(sprint.currentScope.tickets);
    expect(new Set(rows.map((row) => row.ticketKey)).size).toBe(rows.length);
    expect(rows.filter((row) => row.countedIn === 'completed').map((row) => row.ticketKey).sort()).toEqual(
      [...sprint.completed.ticketKeys].sort(),
    );
    expect(rows.filter((row) => row.addedMidSprint).map((row) => row.ticketKey).sort()).toEqual(
      [...sprint.addedMidSprint.ticketKeys].sort(),
    );
  });

  it('derives the completion percentage from the lines it published', () => {
    if (progress.mode !== 'sprint') throw new Error('expected sprint semantics');
    const sprint = progress.sprint;
    const numerator = sprint.basis === 'story_points' ? sprint.completed.points : sprint.completed.tickets;
    const denominator = sprint.basis === 'story_points' ? sprint.currentScope.points : sprint.currentScope.tickets;

    expect(sprint.completionPercent).toBe(Math.round((numerator * 100) / denominator));
    expect(sprint.completionPercent).toBeGreaterThanOrEqual(0);
    expect(sprint.completionPercent).toBeLessThanOrEqual(100);
  });

  it('states the basis it measured in, and names the unestimated items', () => {
    if (progress.mode !== 'sprint') throw new Error('expected sprint semantics');
    const sprint = progress.sprint;

    expect(['story_points', 'ticket_count']).toContain(sprint.basis);
    expect(sprint.basisThreshold.id).toBe('T15');
    expect(sprint.unestimatedTicketKeys.every((key) => sprint.currentScope.ticketKeys.includes(key))).toBe(true);
  });

  it('shows scope creep as a larger denominator rather than a slower burn', () => {
    if (progress.mode !== 'sprint') throw new Error('expected sprint semantics');
    const sprint = progress.sprint;

    if (sprint.addedMidSprint.tickets > 0) {
      expect(sprint.completionPercentOfCommitment).toBeGreaterThan(sprint.completionPercent);
    } else {
      expect(sprint.completionPercentOfCommitment).toBe(sprint.completionPercent);
    }
  });
});

describe('a team with no sprints gets Kanban semantics and no invented numbers', () => {
  const progress = assessProgress(insights, SEED_NOW, resolveScope(insights));

  it('has no sprint rows in the seeded dataset, as the manifest documents', () => {
    expect(scopedSprints(insights, resolveScope(insights))).toEqual([]);
    expect(scopedTickets(insights, resolveScope(insights)).length).toBeGreaterThan(0);
  });

  it('emits flow semantics', () => {
    expect(progress.mode).toBe('kanban');
    if (progress.mode !== 'kanban') throw new Error('expected Kanban semantics');

    expect(progress.reason).toBe('no_sprints_observed');
    expect(progress.flow.throughput.ticketKeys).toBeDefined();
    expect(progress.flow.workInProgress.items).toBeGreaterThanOrEqual(0);
  });

  it('emits no completion percentage, no story points and no sprint goal — the keys are absent', () => {
    if (progress.mode !== 'kanban') throw new Error('expected Kanban semantics');
    const keys = allKeys(progress);

    for (const forbidden of [
      'completionPercent',
      'completionPercentOfCommitment',
      'points',
      'goal',
      'sprintKey',
      'sprintName',
      'committed',
      'velocity',
    ]) {
      expect([...keys], `\`${forbidden}\` must be absent, not null`).not.toContain(forbidden);
    }
  });

  it('says so in the product’s own voice rather than leaving a blank', () => {
    if (progress.mode !== 'kanban') throw new Error('expected Kanban semantics');

    expect(progress.statement).toContain('no completion percentage');
    expect(progress.statement).toContain('will not invent');
  });

  it('carries the same absence through into the rendered report', () => {
    const report = generateStructuredReport(insights, SEED_NOW);
    const keys = allKeys(report.sections);

    expect([...keys]).not.toContain('completionPercent');
  });
});

describe('velocity refuses to guess below two completed sprints', () => {
  it('marks velocity, trend and projection undefined with reason insufficient_history', () => {
    // The dataset's very first day: one sprint has started and none has closed.
    const early = buildSeedSnapshot({
      scope: { kind: 'team', teamKey: 'platform' },
      instant: instantFromIso('2026-05-25T09:00:00.000Z'),
      window: timeWindow(instantFromIso('2026-05-24T00:00:00.000Z'), instantFromIso('2026-05-25T00:00:00.000Z')),
    });
    const velocity = assessVelocity(early, instantFromIso('2026-05-25T09:00:00.000Z'), resolveScope(early));

    expect(velocity.kind).toBe('undefined');
    if (velocity.kind !== 'undefined') throw new Error('expected an undefined velocity');

    expect(velocity.reason).toBe('insufficient_history');
    expect(velocity.completedSprintsFound).toBeLessThan(THRESHOLDS.T7.value);
    expect(velocity.threshold.id).toBe('T7');
    // No number for a renderer to reach for.
    expect([...allKeys(velocity)]).not.toContain('meanPoints');
    expect([...allKeys(velocity)]).not.toContain('trend');
  });

  it('propagates that refusal to the projection, which also emits no date', () => {
    const early = buildSeedSnapshot({
      scope: { kind: 'team', teamKey: 'platform' },
      instant: instantFromIso('2026-05-25T09:00:00.000Z'),
      window: timeWindow(instantFromIso('2026-05-24T00:00:00.000Z'), instantFromIso('2026-05-25T00:00:00.000Z')),
    });
    const report = generateStructuredReport(early, instantFromIso('2026-05-25T09:00:00.000Z'));

    expect(report.findings.projection.kind).toBe('undefined');
    if (report.findings.projection.kind !== 'undefined') throw new Error('expected no projection');
    expect(report.findings.projection.reason).toBe('insufficient_history');
    expect([...allKeys(report.findings.projection)]).not.toContain('utcDate');
  });

  it('measures a velocity once there is history, with the trend named', () => {
    const velocity = assessVelocity(platform, SEED_NOW, resolveScope(platform));

    expect(velocity.kind).toBe('measured');
    if (velocity.kind !== 'measured') throw new Error('expected a measured velocity');

    expect(velocity.samples.length).toBeGreaterThanOrEqual(THRESHOLDS.T7.value);
    expect(['rising', 'flat', 'falling']).toContain(velocity.trend);
    for (const sample of velocity.samples) {
      expect(sample.ticketKeys.length).toBe(sample.tickets);
    }
  });
});
