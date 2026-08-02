import {
  WEEKLY_TOPIC_KEYS,
  WEEKLY_TOPIC_PRODUCER,
  WEEKLY_TOPIC_TITLE,
  type Instant,
  type WeeklyDigest,
  type WeeklyTopic,
  type WeeklyTopicKey,
} from '@compass/analysis';
import { instantFromIso } from '@compass/clock';
import { describe, expect, it } from 'vitest';

import { renderWeeklyDigest, renderWeeklyTopic } from '@compass/renderers';

/**
 * The weekly digest's prose.
 *
 * The claim worth asserting is the negative one: no chart, no canvas, no svg, no table of metrics. It is
 * structurally true — this renderer emits strings — but the cheapest way to break it later is a
 * component that "just adds a sparkline", and the criterion is explicit enough to deserve a test that
 * would catch that.
 */

const INSTANT: Instant = instantFromIso('2026-07-31T08:12:00Z');

const stated = (key: WeeklyTopicKey, statement: string, detail: readonly string[] = []): WeeklyTopic => ({
  key,
  title: WEEKLY_TOPIC_TITLE[key],
  producer: WEEKLY_TOPIC_PRODUCER[key],
  state: 'stated',
  statement,
  detail,
});

const refused = (key: WeeklyTopicKey, statement: string): WeeklyTopic => ({
  key,
  title: WEEKLY_TOPIC_TITLE[key],
  producer: WEEKLY_TOPIC_PRODUCER[key],
  state: 'undefined',
  statement,
});

const digest = (topics: readonly WeeklyTopic[]): WeeklyDigest => ({
  schemaVersion: 1,
  organizationId: '11111111-1111-4111-8111-111111111111',
  teamKey: 'platform',
  instant: INSTANT,
  timezone: 'Europe/London',
  window: { start: (INSTANT - 7 * 86_400_000) as Instant, end: INSTANT },
  topics,
  undefinedTopicKeys: topics.filter((topic) => topic.state === 'undefined').map((topic) => topic.key),
  summary: 'All 6 weekly topics have enough history behind them to state a figure.',
});

const fullDigest = (): WeeklyDigest =>
  digest([
    stated('velocityTrend', 'Velocity averages 31 points across the last 3 completed sprints.', [
      'Sprint 40: 28 points across 9 items',
      'Sprint 41: 33 points across 11 items',
    ]),
    stated('workloadDistribution', 'Six people carry 14 open items between them.'),
    stated('reviewBottlenecks', 'Eight pull requests are open for review; the oldest has waited 6 days.'),
    stated('technicalDebtGrowth', 'Open tech debt grew by 4 items over the trailing 28 days.'),
    stated('upcomingRisks', '2 risks crossed a threshold this week and 1 of them is moving the wrong way.'),
    stated('suggestedPriorities', '3 steps would move this team furthest next week.'),
  ]);

describe('the weekly digest renders as prose and nothing else', () => {
  const rendered = fullDigest();

  it('carries no chart, canvas, svg or image', () => {
    const output = renderWeeklyDigest(rendered);

    for (const token of ['<svg', '<canvas', '<img', 'chart', 'sparkline', 'data:image']) {
      expect(output.text.toLowerCase(), token).not.toContain(token);
      expect(output.prose.toLowerCase(), token).not.toContain(token);
    }
  });

  it('emits every topic, in the fixed documented order', () => {
    const output = renderWeeklyDigest(rendered);
    expect(output.topics.map((topic) => topic.key)).toEqual([...WEEKLY_TOPIC_KEYS]);
  });

  it('keeps the fixed order even when the payload lists topics out of sequence', () => {
    // Read from `WEEKLY_TOPIC_KEYS` rather than from the payload's own array: a weekly whose topics
    // reordered between two weeks would have to be re-learned every week.
    const shuffled = digest([...fullDigest().topics].reverse());
    expect(renderWeeklyDigest(shuffled).topics.map((topic) => topic.key)).toEqual([...WEEKLY_TOPIC_KEYS]);
  });

  it('carries the producer through to the rendered topic', () => {
    for (const topic of renderWeeklyDigest(rendered).topics) {
      expect(topic.producer, topic.key).toBe(WEEKLY_TOPIC_PRODUCER[topic.key]);
    }
  });

  it('names the team and the week in the masthead', () => {
    expect(renderWeeklyDigest(rendered).masthead).toBe('Compass weekly — platform — week ending 2026-07-31');
  });

  it('is deterministic for one digest', () => {
    expect(renderWeeklyDigest(rendered).text).toBe(renderWeeklyDigest(rendered).text);
  });
});

describe('a topic with no figure renders its refusal, not a blank', () => {
  it('renders the refusal sentence and nothing more', () => {
    const topic = refused(
      'velocityTrend',
      'Two completed sprints are needed to state a velocity and one has completed, so Compass will not give you a pace.',
    );

    expect(renderWeeklyTopic(topic)).toBe(topic.statement);
    // No trailing punctuation invented, no detail joined onto a sentence that has none.
    expect(renderWeeklyTopic(topic).endsWith('..')).toBe(false);
  });

  it('appears in the rendered output alongside the stated topics', () => {
    const mixed = digest([
      refused('velocityTrend', 'Two completed sprints are needed and one has completed.'),
      stated('workloadDistribution', 'Six people carry 14 open items between them.'),
    ]);
    const output = renderWeeklyDigest(mixed);

    expect(output.topics.map((topic) => topic.state)).toEqual(['undefined', 'stated']);
    expect(output.prose).toContain('Two completed sprints are needed');
    // The refusal is not marked up as an error or an empty state — it is a sentence like any other.
    expect(output.prose).not.toContain('—');
  });

  it('joins a stated topic’s detail without turning it into a bullet list', () => {
    const topic = stated('velocityTrend', 'Velocity averages 31 points.', ['Sprint 40: 28 points', 'Sprint 41: 33 points']);
    expect(renderWeeklyTopic(topic)).toBe(
      'Velocity averages 31 points. Sprint 40: 28 points; Sprint 41: 33 points.',
    );
  });
});
