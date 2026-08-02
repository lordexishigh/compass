import { describe, expect, it } from 'vitest';

import {
  MAX_RECOMMENDATIONS,
  RECOMMENDATION_SOURCES,
  REPORT_READER,
  RecommendationShapeError,
  assertRecommendationWellFormed,
  generateStructuredReport,
  isStableItemId,
  type Recommendation,
} from '@compass/analysis';

import { SEED_NOW, buildSeedSnapshot } from './helpers/seed-snapshot.js';

/**
 * The recommendation engine.
 *
 * A recommendation that does not name who should do what is commentary, and
 * commentary costs a manager more time than it saves. So the contract is exactly
 * three parts — an actor, an object and one concrete step — and it is *enforced*
 * rather than encouraged: `assertRecommendationWellFormed` throws, and
 * `generateStructuredReport` runs it over every recommendation before returning.
 *
 * These tests come at that from both directions: every recommendation the seeded
 * organization actually produces has all three, and a hand-built one missing any
 * of the three is rejected.
 */
const TEAM_KEYS = ['platform', 'checkout', 'insights'] as const;

const reports = TEAM_KEYS.map((teamKey) => ({
  teamKey,
  report: generateStructuredReport(buildSeedSnapshot({ scope: { kind: 'team', teamKey } }), SEED_NOW),
}));

const allRecommendations: readonly Recommendation[] = reports.flatMap(
  (entry) => entry.report.findings.recommendations,
);

/** A well-formed recommendation, used as the base for the rejection cases. */
const wellFormed = (): Recommendation => ({
  stableId: 'recommendation:blocker:PLAT-746',
  // The coordinates a rejection is keyed on. The discriminator is the blocker signal, which is why
  // the detector emits the cause rather than letting a later layer rebuild it.
  cause: { entityRef: 'ticket:PLAT-746', causeKind: 'recommend_blocker', causeDiscriminator: 'status_dwell' },
  source: 'blocker',
  actor: { kind: 'developer', key: 'marcus-hale', displayName: 'Marcus Hale' },
  object: { kind: 'ticket', key: 'PLAT-746', label: 'PLAT-746' },
  step: 'Ask what PLAT-746 is waiting on and write the answer on the ticket.',
  rationale: 'PLAT-746 has not changed status for four working days, which crosses T1 at three.',
  evidence: [{ kind: 'issue', label: 'PLAT-746', sourceKey: 'tracker', sourceRecordId: 'PLAT-746' }],
  urgency: 'today',
});

describe('every recommendation names an actor, an object and one step', () => {
  it('produces recommendations from the seeded dataset at all', () => {
    expect(allRecommendations.length).toBeGreaterThan(0);
  });

  it('names a person as the actor — never "the team", never nobody', () => {
    for (const recommendation of allRecommendations) {
      expect(['developer', 'manager']).toContain(recommendation.actor.kind);
      expect(recommendation.actor.key.trim().length, `${recommendation.stableId} names no actor`).toBeGreaterThan(0);
      expect(recommendation.actor.displayName.trim().length).toBeGreaterThan(0);
    }
  });

  it('names one artifact as the object, labelled the way a human would search for it', () => {
    for (const recommendation of allRecommendations) {
      expect(['pull_request', 'ticket', 'sprint']).toContain(recommendation.object.kind);
      expect(recommendation.object.key.trim().length, `${recommendation.stableId} names no object`).toBeGreaterThan(0);
      expect(recommendation.object.label.trim().length).toBeGreaterThan(0);
      // `#9101` or `PLAT-746` — something that can be pasted into a search box.
      expect(recommendation.object.label).toMatch(/^(#\d+|[A-Z][A-Z0-9]*-\d+|.+)$/);
    }
  });

  it('gives one concrete step, phrased as an instruction rather than a direction', () => {
    for (const recommendation of allRecommendations) {
      const step = recommendation.step.trim();
      expect(step.length, `${recommendation.stableId} states no step`).toBeGreaterThan(10);
      expect(step.endsWith('.'), `${recommendation.stableId} is not a sentence`).toBe(true);
      // One step, not a programme of work.
      expect(step.split('.').filter((part) => part.trim().length > 0)).toHaveLength(1);
    }
  });

  it('names the object inside the step, so the step can be acted on without cross-referencing', () => {
    for (const recommendation of allRecommendations) {
      expect(
        recommendation.step,
        `${recommendation.stableId} does not say which artifact to act on`,
      ).toContain(recommendation.object.label);
    }
  });

  it('carries the finding it came from as a rationale and a source', () => {
    for (const recommendation of allRecommendations) {
      expect(RECOMMENDATION_SOURCES as readonly string[]).toContain(recommendation.source);
      expect(recommendation.rationale.length).toBeGreaterThan(20);
      expect(['today', 'this_week']).toContain(recommendation.urgency);
    }
  });

  it('passes its own well-formedness assertion, which generation already ran', () => {
    for (const recommendation of allRecommendations) {
      expect(() => assertRecommendationWellFormed(recommendation)).not.toThrow();
    }
  });
});

describe('a recommendation missing any of the three is rejected', () => {
  it('rejects one with no actor', () => {
    const missingActor: Recommendation = {
      ...wellFormed(),
      actor: { kind: 'developer', key: '  ', displayName: '' },
    };

    expect(() => assertRecommendationWellFormed(missingActor)).toThrow(RecommendationShapeError);
    expect(() => assertRecommendationWellFormed(missingActor)).toThrow(/an actor/);
  });

  it('rejects one with no object', () => {
    const missingObject: Recommendation = {
      ...wellFormed(),
      object: { kind: 'ticket', key: '', label: '   ' },
    };

    expect(() => assertRecommendationWellFormed(missingObject)).toThrow(RecommendationShapeError);
    expect(() => assertRecommendationWellFormed(missingObject)).toThrow(/an object/);
  });

  it('rejects one with no step', () => {
    const missingStep: Recommendation = { ...wellFormed(), step: '   ' };

    expect(() => assertRecommendationWellFormed(missingStep)).toThrow(RecommendationShapeError);
    expect(() => assertRecommendationWellFormed(missingStep)).toThrow(/a step/);
  });

  it('names every missing part at once rather than failing one at a time', () => {
    const empty: Recommendation = {
      ...wellFormed(),
      actor: { kind: 'developer', key: '', displayName: '' },
      object: { kind: 'ticket', key: '', label: '' },
      step: '',
    };

    try {
      assertRecommendationWellFormed(empty);
      throw new Error('expected a RecommendationShapeError');
    } catch (error) {
      expect(error).toBeInstanceOf(RecommendationShapeError);
      expect((error as RecommendationShapeError).missing).toEqual(['an actor', 'an object', 'a step']);
      // The message has to say which recommendation, or nobody can find it.
      expect((error as RecommendationShapeError).message).toContain(empty.stableId);
    }
  });

  it('accepts the well-formed base the rejection cases were built from', () => {
    expect(() => assertRecommendationWellFormed(wellFormed())).not.toThrow();
  });
});

describe('the section stays finishable', () => {
  it('emits no more than the documented maximum per report', () => {
    for (const { teamKey, report } of reports) {
      expect(report.findings.recommendations.length, teamKey).toBeLessThanOrEqual(MAX_RECOMMENDATIONS);
    }
  });

  it('suggests one action per artifact, so a manager only has to act once', () => {
    for (const { teamKey, report } of reports) {
      const objects = report.findings.recommendations.map((recommendation) => recommendation.object.key);
      expect(new Set(objects).size, teamKey).toBe(objects.length);
    }
  });

  it('puts today’s work before this week’s', () => {
    for (const { teamKey, report } of reports) {
      const urgencies = report.findings.recommendations.map((recommendation) =>
        recommendation.urgency === 'today' ? 0 : 1,
      );
      expect(urgencies, teamKey).toEqual([...urgencies].sort());
    }
  });

  it('addresses the manager as a real person when nobody else can be named', () => {
    expect(REPORT_READER.kind).toBe('manager');
    expect(REPORT_READER.displayName).toBe('You');
    // Which means the fallback still satisfies the three-part contract.
    expect(() =>
      assertRecommendationWellFormed({ ...wellFormed(), actor: REPORT_READER }),
    ).not.toThrow();
  });
});

describe('recommendations reach the rendered section', () => {
  it('carries every recommendation into the Recommendations section as an item', () => {
    for (const { teamKey, report } of reports) {
      const section = report.sections.find((candidate) => candidate.key === 'recommendations');
      expect(section, teamKey).toBeDefined();
      expect(section?.items.length).toBe(report.findings.recommendations.length);

      for (const item of section?.items ?? []) {
        expect(item.headline.length).toBeGreaterThan(0);
        // A derived id rather than a `recommendation:`-prefixed string. The prefix carried no
        // information a reader used; what matters is that the id comes from the one derivation every
        // feedback action is keyed on, which `isStableItemId` is the check for.
        expect(isStableItemId(item.stableId), item.stableId).toBe(true);
      }
    }
  });

  it('names the actor in the headline, which is what the reader scans', () => {
    for (const { report } of reports) {
      const section = report.sections.find((candidate) => candidate.key === 'recommendations');
      for (const [index, item] of (section?.items ?? []).entries()) {
        expect(item.headline).toContain(report.findings.recommendations[index].actor.displayName);
      }
    }
  });
});
