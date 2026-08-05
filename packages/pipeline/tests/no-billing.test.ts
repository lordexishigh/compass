import { loadReportBundle } from '@compass/db';
import { groundedNarrator } from '@compass/narrator/testkit';
import { runReportPipeline } from '@compass/pipeline';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  INGEST_WINDOW,
  NOW,
  ORGANIZATION_ID,
  REPORT_WINDOW,
  TEAM_KEY,
  TIMEZONE,
  createPipelineHarness,
  type PipelineHarness,
} from './helpers/harness.js';

/**
 * The product works with no payment provider configured.
 *
 * ## Why this is a pipeline test and not an assertion about a sentence
 *
 * Criterion 004 asks for a test that "boots with no Stripe key and asserts report generation, delivery
 * and configuration all still function". The web suite proves the *billing screen* explains itself, and
 * it also asserted the copy — "every report, delivery and configuration screen works" — which is a claim
 * about a string rather than a demonstration. A sentence that says the pipeline works is exactly as
 * green when the pipeline does not.
 *
 * So this runs the real pipeline — real migrated PostgreSQL, real ingest through the connector port,
 * real analysis, real render, real persist — with `STRIPE_SECRET_KEY` **absent from the environment**,
 * and asserts a complete six-section report exists at the end of it. Delivery's half of the same
 * criterion is asserted in `apps/worker/tests/delivery.test.ts`, which owns the transport harness.
 *
 * ## What would actually break
 *
 * The failure this guards is not subtle and it is not hypothetical: a module-scope
 * `new Stripe(process.env.STRIPE_SECRET_KEY!)` anywhere in the graph throws at *import*, and every
 * module that transitively reaches it dies with it. `@compass/pipeline` does not depend on
 * `@compass/billing` at all — dependency-cruiser would refuse the edge — so this test is also a
 * standing check that the two stay unrelated: if somebody wires an entitlement check into the pipeline
 * without threading configuration through, this is where it surfaces.
 */

let harness: PipelineHarness;

/** Every Stripe variable, so the run is against a deployment that has never configured billing. */
const STRIPE_VARS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_STARTER',
  'STRIPE_PRICE_TEAM',
  'STRIPE_PRICE_BUSINESS',
] as const;

const saved = new Map<string, string | undefined>();

beforeAll(async () => {
  harness = await createPipelineHarness();
}, 120_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(() => {
  // Deleted rather than set to '': "absent" is the state the criterion names, and an empty string is a
  // different one that `resolveBillingConfig` happens to treat the same way. Testing the weaker of the
  // two would leave the real one unasserted.
  for (const name of STRIPE_VARS) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
});

const request = (runIdSuffix: string, overrides: Record<string, unknown> = {}) => ({
  organizationId: ORGANIZATION_ID,
  scope: { kind: 'team', teamKey: TEAM_KEY } as const,
  now: NOW,
  timezone: TIMEZONE,
  window: REPORT_WINDOW,
  ingestWindow: INGEST_WINDOW,
  runId: `88888888-8888-4888-8888-0000000000${runIdSuffix}`,
  connector: harness.connector,
  database: harness.database.db,
  ...overrides,
});

describe('with no STRIPE_SECRET_KEY in the environment', () => {
  it('confirms the fixture: every Stripe variable really is absent', () => {
    /**
     * Without this the assertions below could pass on a machine that happens to export a key, which
     * would make the whole file a test of nothing.
     *
     * Asserted against `process.env` rather than by calling `billingConfigured()`, deliberately: this
     * package must not be able to import `@compass/billing` at all. Adding the dependency to satisfy a
     * test would have created exactly the edge the test exists to prove is absent — and
     * dependency-cruiser refuses it, which is how the first attempt at this file failed.
     */
    for (const name of STRIPE_VARS) {
      expect(process.env[name], `${name} is set, so this suite would prove nothing`).toBeUndefined();
    }
  });

  it('generates a complete six-section report', async () => {
    const result = await runReportPipeline(request('01'));

    // The whole pipeline ran: ingest, snapshot, goals, analysis, render, persist.
    expect(result.stored.id).toBeTruthy();
    expect(result.report.sections).toHaveLength(6);

    const bundle = await loadReportBundle(
      harness.database.scopedFor(ORGANIZATION_ID),
      result.stored.id,
    );
    expect(bundle?.sections).toHaveLength(6);
    // Prose, not six empty headings — a report that generated but said nothing would satisfy a count
    // and fail the criterion.
    expect(bundle?.report.prose.length ?? 0).toBeGreaterThan(0);
  });

  it('narrates and grounds as usual, because narration has nothing to do with billing', async () => {
    const result = await runReportPipeline(request('02', { narrator: groundedNarrator() }));

    expect(result.narration?.rendererId).toBe('narrated');
    expect(result.narration?.fallback).toBeNull();
  });

  it('regenerates the same instant without a payment provider being involved', async () => {
    // Time travel and regeneration are the two paths an entitlement check would most plausibly be
    // bolted onto. Both are the same function, so running it twice is the assertion.
    const first = await runReportPipeline(request('03'));
    const second = await runReportPipeline(request('03'));

    // One report per (organization, scope, instant): the second run rewrites the same row.
    expect(second.stored.id).toBe(first.stored.id);
  });
});
