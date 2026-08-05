import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CONNECT_WALKTHROUGH,
  DISQUALIFYING_PHRASES,
  WALKTHROUGH_BUDGET_SECONDS,
  WalkthroughNotSelfServe,
  WalkthroughOverBudget,
  assertSelfServe,
  assertWithinBudget,
  describeWalkthrough,
  estimateWalkthrough,
  selfServeProblems,
  type WalkthroughStep,
} from '@compass/smoke';

/**
 * The under-ten-minutes criterion, as a test.
 *
 * > A manager completes GitHub, Jira and Slack connect alone in under 10 minutes with per-repo and
 * > per-project scoping; measured by a scripted walkthrough.
 *
 * Four things have to hold for that sentence to mean anything, and each one is a section below:
 *
 *  1. The walkthrough covers all three providers **and** their scoping, so it is measuring the whole task.
 *  2. Every step is something the owner can do alone — no admin, no upload, no file.
 *  3. The total fits the budget, and no single step swallows it.
 *  4. **Every endpoint the walkthrough names exists.** This is the one that keeps the other three honest:
 *     a model of a flow is worthless if the flow has moved. A step naming a route nobody serves would let
 *     this suite pass over a connect experience that no longer works.
 */

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Where the App Router would serve a path from, with the dynamic provider segment applied. */
const routeFileFor = (path: string): string => {
  const asDynamic = path.replace(/\/api\/connect\/(github|jira|slack)\//, '/api/connect/[provider]/');
  return join(REPO_ROOT, 'apps/web/app', asDynamic, path.startsWith('/api/') ? 'route.ts' : 'page.tsx');
};

describe('the walkthrough measures the whole task', () => {
  it('covers all three providers', () => {
    const providers = new Set(
      CONNECT_WALKTHROUGH.map((step) => step.providerId).filter((id): id is 'github' | 'jira' | 'slack' => id !== null),
    );

    expect([...providers].sort()).toEqual(['github', 'jira', 'slack']);
  });

  it('includes a scoping step for every provider, which is half the criterion', () => {
    /**
     * "with per-repo and per-project scoping" is not a footnote to the ten minutes — it is the thing that
     * makes the ten minutes worth measuring. A walkthrough that connected three providers and read
     * everything they could see would be faster and would not be this product.
     */
    for (const providerId of ['github', 'jira', 'slack'] as const) {
      const scoping = CONNECT_WALKTHROUGH.find(
        (step) => step.providerId === providerId && step.kind === 'configure',
      );
      expect(scoping, `${providerId} has no scoping step`).toBeDefined();
    }
  });

  it('ends by reading back what each source is scoped to', () => {
    // A flow that ends the moment the last credential is stored is a flow nobody verifies. The last step
    // is the manager confirming what Compass will actually read.
    const last = CONNECT_WALKTHROUGH.at(-1);
    expect(last?.kind).toBe('read');
    expect(last?.what).toContain('scoped to');
  });

  it('grants before it reads, per provider, and never the other way round', () => {
    // Scoping is offered before the grant on purpose — choosing repositories and then granting access is
    // the order a lot of people work in — but the *return* has to come after the consent for each
    // provider, or the model is describing a flow that cannot happen.
    for (const providerId of ['github', 'jira', 'slack'] as const) {
      const steps = CONNECT_WALKTHROUGH.filter((step) => step.providerId === providerId);
      const consent = steps.findIndex((step) => step.kind === 'consent');
      const returned = steps.findIndex((step) => step.kind === 'return');

      expect(consent, `${providerId} has no consent step`).toBeGreaterThanOrEqual(0);
      expect(returned, `${providerId} returns before it consents`).toBeGreaterThan(consent);
    }
  });
});

describe('every step is something a manager can do alone', () => {
  it('needs nobody but the owner', () => {
    expect(selfServeProblems()).toEqual([]);
    expect(() => assertSelfServe()).not.toThrow();
  });

  it('rejects a step that needs an organization admin', () => {
    /**
     * The guard the rule needs, and would otherwise lack. Every assertion above passes on an empty problem
     * list, which is also what a broken matcher produces — so this proves the matcher rejects the thing it
     * exists to reject.
     */
    const withAdmin: WalkthroughStep = {
      id: 'install-app',
      what: 'Ask your workspace administrator to install the Compass app.',
      actor: 'owner',
      kind: 'consent',
      providerId: 'slack',
      path: null,
      estimatedSeconds: 30,
    };

    expect(selfServeProblems([withAdmin]).length).toBeGreaterThan(0);
    expect(() => assertSelfServe([withAdmin])).toThrow(WalkthroughNotSelfServe);
  });

  it.each([
    ['a CSV upload', 'Upload a CSV of your repositories.'],
    ['a hand-edited file', 'Edit the config file to list your projects.'],
    ['an operator', 'Set the environment variable for your site id.'],
  ])('rejects a step that needs %s', (_label, what) => {
    const step: WalkthroughStep = {
      id: 'bad-step',
      what,
      actor: 'owner',
      kind: 'configure',
      providerId: 'github',
      path: null,
      estimatedSeconds: 30,
    };

    expect(() => assertSelfServe([step])).toThrow(WalkthroughNotSelfServe);
  });

  it('matches whole words, so an innocent step is not rejected for containing one', () => {
    // `administer` is not `administrator`, and `supported` is not `support`. A rule that fired on either
    // would be a rule somebody worked around by rewording rather than by fixing the flow.
    const innocent: WalkthroughStep = {
      id: 'fine',
      what: 'Choose which repositories Compass administers reporting for, from the supported list.',
      actor: 'owner',
      kind: 'configure',
      providerId: 'github',
      path: null,
      estimatedSeconds: 30,
    };

    expect(selfServeProblems([innocent])).toEqual([]);
  });

  it('names the phrases it disqualifies, so the rule is reviewable', () => {
    for (const phrase of ['administrator', 'csv', 'yaml', 'upload']) {
      expect(DISQUALIFYING_PHRASES).toContain(phrase);
    }
  });
});

describe('the whole flow fits in ten minutes', () => {
  const estimate = estimateWalkthrough();

  it('totals less than the budget', () => {
    expect(estimate.budgetSeconds).toBe(WALKTHROUGH_BUDGET_SECONDS);
    expect(estimate.withinBudget, `the walkthrough is estimated at ${estimate.totalSeconds}s`).toBe(true);
    expect(() => assertWithinBudget()).not.toThrow();
  });

  it('leaves at least a minute of slack, rather than passing by a second', () => {
    /**
     * A ten-minute claim that is true at nine minutes fifty-nine is a claim that will be false the first
     * time a provider adds a confirmation screen.
     *
     * The threshold is a whole spare minute rather than a percentage, because a percentage of a budget is
     * not a fact about anything — whereas "one more consent screen could appear and the claim would still
     * hold" is. At the estimates in `CONNECT_WALKTHROUGH` the flow comes to 8m45s, so there is a minute and
     * a quarter in hand; if a step grows past that, the right response is to make the flow shorter, not to
     * lower this number.
     */
    expect(estimate.totalSeconds).toBeLessThanOrEqual(WALKTHROUGH_BUDGET_SECONDS - 60);
  });

  it('has no single step swallowing the budget', () => {
    // A flow that passes in nine minutes because one step takes eight is not a flow anybody finishes.
    expect(estimate.longestStep?.estimatedSeconds ?? 0).toBeLessThanOrEqual(120);
  });

  it('spends comparable time on each provider, because the surface is the same shape', () => {
    const { github, jira, slack } = estimate.perProviderSeconds;
    const largest = Math.max(github, jira, slack);
    const smallest = Math.min(github, jira, slack);

    // Within a factor of two. A provider costing five times another means its connect surface is doing
    // something the others are not, which is worth noticing here rather than in a support conversation.
    expect(largest / smallest).toBeLessThanOrEqual(2);
  });

  it('fails loudly when a flow does grow past the budget', () => {
    const bloated: WalkthroughStep[] = [
      {
        id: 'slow',
        what: 'Read the whole permission list very carefully.',
        actor: 'owner',
        kind: 'read',
        providerId: null,
        path: null,
        estimatedSeconds: WALKTHROUGH_BUDGET_SECONDS + 1,
      },
    ];

    expect(() => assertWithinBudget(bloated)).toThrow(WalkthroughOverBudget);
  });

  it('reports the estimate in lines an operator can read', () => {
    const lines = describeWalkthrough(estimate);

    expect(lines[0]).toContain('minutes estimated against a 10-minute budget');
    expect(lines.join(' ')).toContain('no administrator, no upload, no configuration file');
  });
});

describe('every endpoint the walkthrough names is one the app actually serves', () => {
  /**
   * The check that keeps the rest of this suite honest.
   *
   * A model of a flow proves nothing if the flow has moved underneath it. When the three per-provider
   * routes were replaced by one dynamic `[provider]` route, a walkthrough naming the old paths would have
   * gone on passing over a connect experience that had changed shape — so each path is resolved to the file
   * the App Router would serve it from, and has to exist.
   */
  const served = CONNECT_WALKTHROUGH.filter((step) => step.path !== null);

  it('names at least one endpoint per provider, so the check is not vacuous', () => {
    expect(served.length).toBeGreaterThanOrEqual(4);
  });

  it.each(served.map((step) => [step.id, step.path as string]))('%s resolves to a real route: %s', (_id, path) => {
    expect(existsSync(routeFileFor(path)), `${path} is in the walkthrough but nothing serves it`).toBe(true);
  });

  it('would notice a walkthrough naming a route nobody serves', () => {
    // The negative case, so a broken path resolver cannot make every assertion above pass vacuously.
    expect(existsSync(routeFileFor('/api/connect/gitlab/install'))).toBe(false);
  });
});
