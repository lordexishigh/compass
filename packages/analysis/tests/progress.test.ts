import { instantFromIso, timeWindow } from '@compass/clock';
import { describe, expect, it } from 'vitest';

import {
  CYCLE_TIME_PERCENTILE,
  CYCLE_TIME_TREND_HALF_DAYS,
  PROGRESS_CAUSE_KINDS,
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

  it('emits flow semantics, and says the team’s own cadence is why', () => {
    expect(progress.mode).toBe('kanban');
    if (progress.mode !== 'kanban') throw new Error('expected Kanban semantics');

    // `team_runs_kanban` rather than `no_sprints_observed`: the seeded team declares
    // `methodology: kanban` on its roster row, and the declaration is the stronger reason.
    // "No sprint was ingested" is a different fact — on a Scrum team it means the board or
    // the connector is wrong, and a manager should be able to tell the two apart.
    expect(progress.reason).toBe('team_runs_kanban');
    expect(resolveScope(insights).methodology).toBe('kanban');
    expect(progress.flow.throughput.ticketKeys).toBeDefined();
    expect(progress.flow.workInProgress.items).toBeGreaterThanOrEqual(0);
  });

  it('breaks work in progress down by board column, and the columns partition the WIP', () => {
    if (progress.mode !== 'kanban') throw new Error('expected Kanban semantics');
    const wip = progress.flow.workInProgress;

    expect(wip.byColumn.length).toBeGreaterThan(0);
    expect(wip.byColumn.reduce((sum, load) => sum + load.items, 0)).toBe(wip.items);
    // Each column names its own keys, and together they are the WIP set exactly once.
    for (const load of wip.byColumn) {
      expect(load.ticketKeys.length).toBe(load.items);
      expect([...load.ticketKeys].sort()).toEqual([...load.ticketKeys]);
    }
    expect(wip.byColumn.flatMap((load) => load.ticketKeys).sort()).toEqual([...wip.ticketKeys].sort());
    // Heaviest column first, then by name — a total order, so two runs agree.
    const ordering = wip.byColumn.map((load) => [-load.items, load.column] as const);
    expect(ordering).toEqual(
      [...ordering].sort((left, right) => left[0] - right[0] || left[1].localeCompare(right[1])),
    );
    expect(wip.statement).toContain(`${wip.items} item`);
    expect(wip.statement).toContain(wip.byColumn[0]!.column);
  });

  it('states a cycle-time trend from two halves of the trailing span', () => {
    if (progress.mode !== 'kanban') throw new Error('expected Kanban semantics');
    const cycleTime = progress.flow.cycleTime;
    if (cycleTime.kind !== 'measured') throw new Error('the seeded Kanban board finishes work');

    expect(cycleTime.percentile).toBe(CYCLE_TIME_PERCENTILE);
    expect(cycleTime.p85Days).toBeGreaterThanOrEqual(cycleTime.medianDays);

    const trend = cycleTime.trend;
    if (trend.kind !== 'measured') throw new Error('the seeded board finishes work in both halves');

    expect(['lengthening', 'steady', 'shortening']).toContain(trend.direction);
    expect(trend.halfDays).toBe(CYCLE_TIME_TREND_HALF_DAYS);
    // Every sample falls in exactly one half, so the two sizes account for the whole sample.
    expect(trend.earlierSampleSize + trend.laterSampleSize).toBe(cycleTime.sampleSize);
    expect(trend.statement).toContain(trend.direction);
  });

  it('ages in-flight items against the board’s own P85, and names each one', () => {
    if (progress.mode !== 'kanban') throw new Error('expected Kanban semantics');
    const aging = progress.flow.aging;
    const cycleTime = progress.flow.cycleTime;
    if (aging.kind !== 'measured' || cycleTime.kind !== 'measured') {
      throw new Error('the seeded Kanban board has a cycle-time baseline');
    }

    // One baseline, not two: an aging list measured against a different P85 from the one
    // printed beside it is the kind of disagreement that ends trust in the whole page.
    expect(aging.p85Days).toBe(cycleTime.p85Days);
    expect(aging.items.length).toBeGreaterThan(0);

    const wipKeys = new Set(progress.flow.workInProgress.ticketKeys);
    for (const item of aging.items) {
      expect(item.ageDays, `${item.ticketKey} is not past the P85`).toBeGreaterThan(aging.p85Days);
      expect(wipKeys.has(item.ticketKey), `${item.ticketKey} is aging but not in flight`).toBe(true);
      expect(item.column.length).toBeGreaterThan(0);
    }
    // Oldest first, then by key.
    const ages = aging.items.map((item) => item.ageDays);
    expect(ages).toEqual([...ages].sort((left, right) => right - left));
    expect(aging.statement).toContain(`${aging.p85Days}-day P85`);
  });

  it('renders those flow metrics as the Progress section’s own claims', () => {
    const report = generateStructuredReport(insights, SEED_NOW);
    const section = report.sections.find((candidate) => candidate.key === 'progress');
    const causeKinds = (section?.items ?? []).map((item) => item.cause.causeKind);

    // Each flow figure is a claim in its own right, with its own id, so a manager can
    // dismiss the aging list without also dismissing the WIP distribution.
    expect(causeKinds).toContain(PROGRESS_CAUSE_KINDS.kanbanFlow);
    expect(causeKinds).toContain(PROGRESS_CAUSE_KINDS.kanbanWip);
    expect(causeKinds).toContain(PROGRESS_CAUSE_KINDS.kanbanCycleTime);
    expect(causeKinds).toContain(PROGRESS_CAUSE_KINDS.kanbanAging);
    expect(causeKinds).toContain(PROGRESS_CAUSE_KINDS.projection);
    expect(new Set(section?.items.map((item) => item.stableId)).size).toBe(section?.items.length);

    // And every one of them carries evidence, so no flow figure is unopenable.
    for (const item of section?.items ?? []) {
      if (item.cause.causeKind === PROGRESS_CAUSE_KINDS.kanbanAging) {
        expect(item.evidence.length, 'the aging claim cites the late items').toBeGreaterThan(0);
      }
      expect(item.headline.length).toBeGreaterThan(0);
    }

    // The renderable half of each metric is the *headline*: the deterministic renderer emits
    // a claim's headline, its change clause and its evidence, so a figure that lives only in
    // `detail` reaches the payload and never the page. That is the shape this feature was
    // half-built in, so it is asserted rather than assumed.
    const progress = report.findings.progress;
    if (progress.mode !== 'kanban') throw new Error('expected Kanban semantics');
    const byCause = new Map((section?.items ?? []).map((item) => [item.cause.causeKind, item] as const));

    expect(byCause.get(PROGRESS_CAUSE_KINDS.kanbanWip)?.headline).toContain(
      progress.flow.workInProgress.byColumn[0]!.column,
    );
    if (progress.flow.cycleTime.kind === 'measured') {
      expect(byCause.get(PROGRESS_CAUSE_KINDS.kanbanCycleTime)?.headline).toContain(
        progress.flow.cycleTime.trend.statement,
      );
    }
    if (progress.flow.aging.kind === 'measured') {
      expect(byCause.get(PROGRESS_CAUSE_KINDS.kanbanAging)?.headline).toContain(
        `${progress.flow.aging.p85Days}-day P85`,
      );
    }
  });

  it('resolves its work against the quarter objective, not a sprint goal it does not have', () => {
    const report = generateStructuredReport(insights, SEED_NOW);
    const tickets = report.findings.alignment.resolutions.filter(
      (resolution) => resolution.subjectKind === 'ticket',
    );

    expect(tickets.length).toBeGreaterThan(0);
    // Every open item reaches a goal chain, and it reaches it through the team's objective
    // rather than through a sprint goal — which is the only route a Kanban team has.
    expect(tickets.every((resolution) => resolution.alignmentClass === 'configured')).toBe(true);
    for (const resolution of tickets) {
      expect(resolution.evidence.tier).toBe('configured');
      if (resolution.evidence.tier !== 'configured') throw new Error('expected a configured chain');
      expect(resolution.evidence.via).toBe('team_objective');
      expect(resolution.objectiveNodeId).not.toBeNull();
      expect(resolution.servesCurrentObjective).toBe(true);
    }
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

/**
 * The configured cadence, tested where it actually decides something.
 *
 * A Kanban team whose tracker hands back sprint rows is not hypothetical: a Jira project
 * shared with a Scrum team, or a board somebody left a sprint switched on in, produces
 * exactly that. Before the team's own `methodology` was read, such a team was scored
 * against a sprint it never committed to — a completion percentage against a goal nobody
 * on the team had agreed. Platform is the seeded Scrum team *with* sprints, so flipping
 * only the methodology isolates the branch under test.
 */
describe('a team that declares Kanban gets flow semantics even when sprints exist', () => {
  const scope = resolveScope(platform);

  it('reports on the sprint while the team declares Scrum', () => {
    expect(scope.methodology).toBe('scrum');
    expect(scopedSprints(platform, scope).length).toBeGreaterThan(0);
    expect(assessProgress(platform, SEED_NOW, scope).mode).toBe('sprint');
  });

  it('switches to flow on the declaration alone, and says the declaration is why', () => {
    const progress = assessProgress(platform, SEED_NOW, { ...scope, methodology: 'kanban' });

    expect(progress.mode).toBe('kanban');
    if (progress.mode !== 'kanban') throw new Error('expected Kanban semantics');
    expect(progress.reason).toBe('team_runs_kanban');
    // The sprint is still in the snapshot; it is simply not what this team is measured by.
    expect([...allKeys(progress)]).not.toContain('completionPercent');
    expect([...allKeys(progress)]).not.toContain('sprintName');
  });

  it('reads the declaration as the tracker may have spelled it', () => {
    for (const methodology of ['Kanban', 'KANBAN', 'kanban (flow)']) {
      expect(assessProgress(platform, SEED_NOW, { ...scope, methodology }).mode, methodology).toBe('kanban');
    }
    // And nothing else is coerced into flow semantics.
    for (const methodology of ['scrum', 'scrumban-ish', null]) {
      expect(assessProgress(platform, SEED_NOW, { ...scope, methodology }).mode, String(methodology)).toBe('sprint');
    }
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
