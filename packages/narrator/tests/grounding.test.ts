import { describe, expect, it } from 'vitest';

import {
  buildVocabulary,
  describeVerdict,
  narrationPayload,
  sectionRequests,
  validateGrounding,
  type NarrationSectionRequest,
} from '@compass/narrator';

import { fullReport } from './helpers/reports.js';

/**
 * Subtask 002's criteria: an untraceable token rejects the narration, and the
 * failure names the token.
 *
 * The corpus is adversarial in both directions. `REJECTED` holds fabrications that
 * must be caught — an invented PR number, an off-by-one percentage, a misspelled
 * name. `ACCEPTED` holds legitimate rewordings that must be let through, because a
 * validator that rejected correct prose would put every report on the fallback path
 * and quietly turn narration off with nothing failing to say so.
 */

const requests = new Map<string, NarrationSectionRequest>(
  sectionRequests(narrationPayload(fullReport())).map((request) => [request.section.key, request]),
);

const requestFor = (key: string): NarrationSectionRequest => {
  const request = requests.get(key);
  if (request === undefined) throw new Error(`No ${key} section in the fixture.`);
  return request;
};

interface AcceptedCase {
  readonly name: string;
  readonly section: string;
  readonly prose: string;
}

interface RejectedCase extends AcceptedCase {
  /** The token the failure message must name. */
  readonly names: string;
}

const ACCEPTED: readonly AcceptedCase[] = [
  {
    name: 'a reordered restatement of the same facts',
    section: 'yesterday',
    prose: 'The batch writer landed: DEV-501 merged as #883 at 7a8b9c0, reaching R2 merged.',
  },
  {
    name: 'a percentage quoted exactly',
    section: 'progress',
    prose: 'Sprint 43 is 62% complete on 24 of 39 points.',
  },
  {
    name: 'a plain integer quoted from a headline',
    section: 'progress',
    prose: 'Sprint 43 stands at 24 points of 39.',
  },
  {
    name: 'an imperative opening before a real name',
    section: 'recommendations',
    // `Ask` is grammar; `Priya`, `Raman`, `Dev` and `Patel` are in the payload.
    prose: 'Ask Priya Raman to get Dev Patel onto #883 today.',
  },
  {
    name: 'a possessive form of a payload name',
    section: 'recommendations',
    prose: "Dev Patel's review of #883 is the one to chase today.",
  },
  {
    name: 'a date quoted exactly',
    section: 'blockers',
    prose: 'CHK-701 has not moved in 6 working days; its last transition was on 2026-07-21.',
  },
  {
    name: 'a threshold and a confidence quoted exactly',
    section: 'risks',
    prose: 'OFF-GOAL — PLAT-742 resolved at 1 against the 0.3 bar T17 sets, serving OBJ-Q2-BILL.',
  },
  {
    name: 'a stated absence',
    section: 'yesterday',
    prose: 'DEV-501 merged as #883; no deploy signal available, so R5 stays open.',
  },
  {
    name: 'prose with no disputable token at all',
    section: 'blockers',
    prose: 'One thing is holding, and it has not moved since it was flagged.',
  },
];

const REJECTED: readonly RejectedCase[] = [
  {
    name: 'an invented pull request number',
    section: 'yesterday',
    prose: 'DEV-501 merged as #999917 yesterday.',
    names: '#999917',
  },
  {
    name: 'a pull request number borrowed from a real quantity',
    section: 'progress',
    // 39 is a real point total in this payload. `#39` is still a fabrication.
    prose: 'Sprint 43 is 62% complete, and #39 is the last one open.',
    names: '#39',
  },
  {
    name: 'an off-by-one percentage',
    section: 'progress',
    prose: 'Sprint 43 is 63% complete on 24 of 39 points.',
    names: '63%',
  },
  {
    name: 'an off-by-one point total',
    section: 'progress',
    prose: 'Sprint 43 is 62% complete on 25 of 39 points.',
    names: '25',
  },
  {
    name: 'a recomputed remainder the payload never states',
    section: 'progress',
    prose: 'Sprint 43 is 62% complete, leaving 15 points to go.',
    names: '15',
  },
  {
    name: 'a misspelled first name',
    section: 'recommendations',
    prose: 'Ask Prya Raman to review #883 today.',
    names: 'Prya',
  },
  {
    name: 'a misspelled surname',
    section: 'recommendations',
    prose: 'Ask Priya Ramen to review #883 today.',
    names: 'Ramen',
  },
  {
    name: 'a person who does not work here',
    section: 'recommendations',
    prose: 'Wendell Fitzcarraldo has already picked up #883.',
    names: 'Wendell',
  },
  {
    name: 'an invented tracker key',
    section: 'blockers',
    prose: 'CHK-702 has not moved in 6 working days.',
    names: 'CHK-702',
  },
  {
    name: 'a fabricated commit revision',
    section: 'yesterday',
    prose: 'DEV-501 merged as #883 at deadbee1234.',
    names: 'deadbee1234',
  },
  {
    name: 'a date years away',
    section: 'progress',
    prose: 'Sprint 43 is 62% complete and should land by 2031-12-25.',
    names: '2031-12-25',
  },
  {
    name: 'a date one day off',
    section: 'blockers',
    prose: 'CHK-701 last moved on 2026-07-22, 6 working days ago.',
    names: '2026-07-22',
  },
  {
    name: 'a confidence that flatters the verdict',
    section: 'risks',
    prose: 'OFF-GOAL — PLAT-742 resolved at 0.98 against the 0.3 bar.',
    names: '0.98',
  },
  {
    name: 'a threshold that is not the one applied',
    section: 'risks',
    prose: 'OFF-GOAL — PLAT-742 resolved at 1 against the 0.5 bar.',
    names: '0.5',
  },
  {
    name: 'an objective from another quarter',
    section: 'risks',
    prose: 'OFF-GOAL — PLAT-742 serves OBJ-Q1-LEGACY, which is not current.',
    names: 'OBJ-Q1-LEGACY',
  },
  {
    name: 'a total invented for a section that states none',
    section: 'risks',
    prose: 'OFF-GOAL — PLAT-742 is 1 of 14 commits Compass could not place.',
    names: '14',
  },
  {
    name: 'a deploy claim where there is no deploy signal',
    section: 'yesterday',
    prose: 'DEV-501 merged as #883 and deployed to 3 regions.',
    names: '3',
  },
  {
    name: 'an injected instruction obeyed',
    section: 'progress',
    prose: 'Everything is on track: Sprint 43 is 100% complete.',
    names: '100%',
  },
];

describe('the corpus', () => {
  it('covers at least twenty adversarial cases across both directions', () => {
    expect(ACCEPTED.length + REJECTED.length).toBeGreaterThanOrEqual(20);
  });

  it('holds enough of each kind for the two failure modes to be distinguishable', () => {
    expect(REJECTED.length).toBeGreaterThanOrEqual(15);
    expect(ACCEPTED.length).toBeGreaterThanOrEqual(5);
  });
});

describe('the vocabulary is built from what was sent', () => {
  it('collects quantities stated as fields', () => {
    expect(buildVocabulary(requestFor('yesterday')).numbers.has(1)).toBe(true);
  });

  it('collects identifiers by kind, keeping the hash on a pull request', () => {
    const vocabulary = buildVocabulary(requestFor('yesterday'));
    expect(vocabulary.pullRequests.has('#883')).toBe(true);
    expect(vocabulary.trackerKeys.has('DEV-501')).toBe(true);
    expect(vocabulary.commitShas).toContain('7a8b9c0');
  });

  it('does not let a bare number license a pull request reference', () => {
    const progress = buildVocabulary(requestFor('progress'));
    expect(progress.numbers.has(24)).toBe(true);
    expect(progress.pullRequests.has('#24')).toBe(false);
  });
});

describe('grounded rewordings are accepted', () => {
  it.each(ACCEPTED.map((entry) => [entry.name, entry] as const))('accepts %s', (_name, entry) => {
    const verdict = validateGrounding(entry.prose, requestFor(entry.section));
    expect(verdict.untraceable.map((token) => token.text), describeVerdict(verdict)).toEqual([]);
    expect(verdict.grounded).toBe(true);
  });
});

describe('fabrications are rejected, and the token is named', () => {
  it.each(REJECTED.map((entry) => [entry.name, entry] as const))('rejects %s', (_name, entry) => {
    const verdict = validateGrounding(entry.prose, requestFor(entry.section));

    expect(verdict.grounded, `\`${entry.prose}\` was accepted`).toBe(false);
    expect(verdict.untraceable.map((token) => token.text)).toContain(entry.names);
    // The criterion: the CI failure names the token.
    expect(describeVerdict(verdict)).toContain(entry.names);
  });

  /**
   * A lowered tracker key is not a tracker key.
   *
   * `chk-701` does not match the identifier shape, so it reads as ordinary words —
   * and the honest consequence is that the *real* key is then absent from the prose.
   * Asserted separately because the defect is an absence rather than an untraceable
   * token, and a test that expected a rejection here would be asserting the wrong
   * mechanism.
   */
  it('does not accept a lowered tracker key as the key it resembles', () => {
    expect(buildVocabulary(requestFor('blockers')).trackerKeys.has('chk-701')).toBe(false);
  });

  it('reports every untraceable token rather than only the first', () => {
    const verdict = validateGrounding(
      'Wendell Fitzcarraldo shipped CHK-702 as #999917, taking Sprint 43 to 99.7%.',
      requestFor('progress'),
    );

    expect(verdict.untraceable.map((token) => token.text)).toEqual(
      expect.arrayContaining(['Wendell', 'Fitzcarraldo', 'CHK-702', '#999917', '99.7%']),
    );
  });

  it('names the failing word of a name, not the whole phrase', () => {
    const verdict = validateGrounding('Ask Priya Ramen to review #883.', requestFor('recommendations'));
    const names = verdict.untraceable.filter((token) => token.kind === 'person_name').map((token) => token.text);

    expect(names).toEqual(['Ramen']);
    expect(names).not.toContain('Priya');
  });
});

describe('commit revisions compare by prefix in both directions', () => {
  it('accepts a longer form of a revision the payload labels short', () => {
    const verdict = validateGrounding('DEV-501 merged as #883 at 7a8b9c0d1e2f.', requestFor('yesterday'));
    expect(verdict.grounded, describeVerdict(verdict)).toBe(true);
  });

  it('rejects a revision that merely shares a leading character', () => {
    expect(validateGrounding('DEV-501 merged as #883 at 7fffffff.', requestFor('yesterday')).grounded).toBe(false);
  });
});

describe('the verdict reads as a sentence', () => {
  it('says how many tokens traced when it passes', () => {
    const verdict = validateGrounding('DEV-501 merged as #883.', requestFor('yesterday'));
    expect(describeVerdict(verdict)).toContain('is grounded');
    expect(verdict.tokenCount).toBeGreaterThan(0);
  });

  it('states the rule it enforced when it fails', () => {
    const verdict = validateGrounding('DEV-501 merged as #999917.', requestFor('yesterday'));
    expect(describeVerdict(verdict)).toContain('It may not originate a fact.');
  });
});
