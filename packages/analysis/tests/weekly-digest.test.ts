import { describe, expect, it } from 'vitest';

import {
  WEEKLY_DIGEST_TRAILING_DAYS,
  WEEKLY_TOPIC_KEYS,
  WEEKLY_TOPIC_PRODUCER,
  buildWeeklyDigest,
  createEmptyStructuredReport,
  digestSummary,
  generateStructuredReport,
  type StructuredReport,
} from '@compass/analysis';

import { SEED_NOW, SEED_TIMEZONE, SEED_WINDOW, buildSeedSnapshot } from './helpers/seed-snapshot.js';

/**
 * The weekly digest.
 *
 * Three claims: it always says six things, it never states a number it cannot compute, and it says the
 * same thing twice for the same `(organization, team, instant)`. The third is why it reads the daily
 * report's findings rather than the model — the daily is already deterministic for those three, so the
 * digest inherits it instead of having to establish it again.
 */

const TEAM_KEYS = ['platform', 'checkout', 'insights'] as const;

const digestFor = (teamKey: string) =>
  buildWeeklyDigest({
    teamKey,
    report: generateStructuredReport(buildSeedSnapshot({ scope: { kind: 'team', teamKey } }), SEED_NOW),
  });

/** A team Compass knows nothing about: every topic must refuse rather than print a zero. */
const emptyDigest = () =>
  buildWeeklyDigest({
    teamKey: 'brand-new',
    report: createEmptyStructuredReport({
      organizationId: '00000000-0000-4000-8000-000000000001',
      scope: { kind: 'team', teamKey: 'brand-new' },
      instant: SEED_NOW,
      timezone: SEED_TIMEZONE,
      window: SEED_WINDOW,
    }),
  });

describe('the digest always carries all six topics', () => {
  it('names exactly the six documented topics, in the documented order', () => {
    expect([...WEEKLY_TOPIC_KEYS]).toEqual([
      'velocityTrend',
      'workloadDistribution',
      'reviewBottlenecks',
      'technicalDebtGrowth',
      'upcomingRisks',
      'suggestedPriorities',
    ]);
  });

  it('emits all six for every seeded team, whatever their history', () => {
    for (const teamKey of TEAM_KEYS) {
      const digest = digestFor(teamKey);
      expect(digest.topics.map((topic) => topic.key), teamKey).toEqual([...WEEKLY_TOPIC_KEYS]);
    }
  });

  it('emits all six even for a team with no history at all', () => {
    // A digest that dropped its undefined topics would read as a complete picture of a week Compass
    // does not have the history for.
    expect(emptyDigest().topics.map((topic) => topic.key)).toEqual([...WEEKLY_TOPIC_KEYS]);
  });

  it('names the analysis function behind every topic', () => {
    // The criterion's "named producer": what lets a manager who disputes a sentence find the code.
    for (const topic of digestFor('platform').topics) {
      expect(topic.producer, topic.key).toBe(WEEKLY_TOPIC_PRODUCER[topic.key]);
      expect(topic.producer.length).toBeGreaterThan(0);
    }
  });

  it('covers the trailing week ending at the report instant', () => {
    const digest = digestFor('platform');
    expect(digest.instant).toBe(SEED_NOW);
    expect(digest.window.end).toBe(SEED_NOW);
    expect(digest.window.start).toBe(SEED_NOW - WEEKLY_DIGEST_TRAILING_DAYS * 86_400_000);
  });
});

describe('an undefined topic states what is missing rather than emitting a number', () => {
  const digest = emptyDigest();

  it('refuses every topic for an organization with no history', () => {
    expect(digest.undefinedTopicKeys).toEqual([...WEEKLY_TOPIC_KEYS]);
    expect(digest.topics.every((topic) => topic.state === 'undefined')).toBe(true);
  });

  it('carries a sentence, and never a figure, on each refusal', () => {
    for (const topic of digest.topics) {
      expect(topic.state).toBe('undefined');
      if (topic.state !== 'undefined') continue;

      expect(topic.statement.length, topic.key).toBeGreaterThan(20);
      // The shape is what forbids a zero: an undefined topic has no `detail` to format and no numeric
      // field a renderer could reach for. Asserted structurally rather than by grepping the sentence.
      expect(Object.keys(topic).sort()).toEqual(['key', 'producer', 'state', 'statement', 'title']);
    }
  });

  it('names the undefined topics up front, so the reader is told rather than left counting', () => {
    // All six missing gets its own sentence rather than a list of all six titles.
    expect(digest.summary).toContain('too little history');

    // Some missing names which, so the reader does not have to read four topics to discover the gap.
    const partial = digestSummary(['velocityTrend', 'technicalDebtGrowth']);
    expect(partial).toContain('velocity trend');
    expect(partial).toContain('technical debt growth');
    expect(partial).toContain(`4 of the ${WEEKLY_TOPIC_KEYS.length}`);

    // None missing says so plainly rather than staying silent about it.
    expect(digestSummary([])).toContain('enough history');
  });

  it('states a figure where the seeded org does have the history', () => {
    // The other direction: a digest that refused everything would satisfy the honesty criterion while
    // being useless, so at least one seeded team must reach a stated topic.
    const stated = TEAM_KEYS.flatMap((teamKey) => digestFor(teamKey).topics).filter(
      (topic) => topic.state === 'stated',
    );

    expect(stated.length).toBeGreaterThan(0);
    for (const topic of stated) {
      expect(topic.state).toBe('stated');
      if (topic.state !== 'stated') continue;
      expect(topic.statement.length, topic.key).toBeGreaterThan(0);
    }
  });
});

describe('the digest is deterministic for one (org, team, instant)', () => {
  it('produces identical bytes across two builds', () => {
    for (const teamKey of TEAM_KEYS) {
      expect(JSON.stringify(digestFor(teamKey)), teamKey).toBe(JSON.stringify(digestFor(teamKey)));
    }
  });

  it('orders risks and priorities by a total order rather than by discovery', () => {
    // Both topics sort on `(rank, stableId)`. Without the id tiebreak two equal-severity risks would
    // resolve to detector order, which is stable today and would silently stop being so.
    const digest = digestFor('platform');
    const risks = digest.topics.find((topic) => topic.key === 'upcomingRisks');

    expect(risks).toBeDefined();
    if (risks?.state !== 'stated') return;

    const severities = risks.detail.map((line) => line.split(' ')[0] ?? '');
    const rank: Readonly<Record<string, number>> = { high: 0, medium: 1, low: 2 };
    const ranks = severities.map((severity) => rank[severity] ?? 3);
    expect([...ranks].sort((left, right) => left - right)).toEqual(ranks);
  });

  it('differs between two teams, so it is not accidentally team-independent', () => {
    const [first, second] = [digestFor('platform'), digestFor('checkout')];
    expect(first.teamKey).not.toBe(second.teamKey);
    expect(JSON.stringify(first.topics)).not.toBe(JSON.stringify(second.topics));
  });
});

describe('a kanban team has no velocity, and says so', () => {
  it('refuses the velocity topic rather than converting a flow figure into a pace', () => {
    const report = generateStructuredReport(
      buildSeedSnapshot({ scope: { kind: 'team', teamKey: 'platform' } }),
      SEED_NOW,
    );
    const kanban = {
      ...report,
      findings: {
        ...report.findings,
        progress: {
          mode: 'kanban',
          flow: { statement: 'Throughput is 4 items a week.', evidence: [] },
          reason: 'no_sprints_observed',
          statement: 'This team runs no sprints, so Compass reports flow rather than a sprint burn-down.',
        },
      },
    } as unknown as StructuredReport;

    const topic = buildWeeklyDigest({ teamKey: 'platform', report: kanban }).topics.find(
      (candidate) => candidate.key === 'velocityTrend',
    );

    expect(topic?.state).toBe('undefined');
    expect(topic?.statement).toContain('no sprints');
  });
});
