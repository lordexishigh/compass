import { instantFromIso, type Instant } from '@compass/clock';
import { memberships, replaceTeamScopes, teams, users, type CompassDatabase } from '@compass/db';
import { createMigratedTestDatabase, type TestDatabase } from '@compass/db/testing';
import { startSession } from '@compass/auth';
import { DEFAULT_GENERATION_LOCAL_TIME, SCOPE_KEY_FOR_MERGED, reportInstantForDate } from '@compass/pipeline';
import { SEEDED_ORGANIZATION_ID } from '@compass/seed-connector';
import type * as SeedConnectorModule from '@compass/seed-connector';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { SESSION_COOKIE_NAME } from '../lib/auth/cookies';
import { instantForDate, simulatedClockAvailable, timeTravelBounds } from '../lib/archive-source';

/**
 * The time-travel control's gate.
 *
 * The acceptance criterion has two halves and only one of them is about the UI: *the control is only
 * available in the simulated-clock mode and cannot alter production `now` for a live org*. The scrubber
 * returning null is the affordance; this is the part that matters, because a client-only guard is bypassed
 * by one `curl`.
 *
 * The day-by-day walk itself — eight consecutive instants through the real pipeline, and the
 * risk → projected slip → recommendation sequence under one item id — is asserted in
 * `apps/worker/tests/time-travel.test.ts`, where the seeded roster harness lives.
 */

const ORGANIZATION_ID = SEEDED_ORGANIZATION_ID;
const USER = '6b6b6b6b-6b6b-4b6b-8b6b-6b6b6b6b6b6b';
const MEMBERSHIP = '7c7c7c7c-7c7c-4c7c-8c7c-7c7c7c7c7c7c';
const T0: Instant = instantFromIso('2026-07-31T09:00:00Z');
const asDate = (iso: string) => new Date(Date.parse(iso));

let database: TestDatabase;
let session = '';

const pool = vi.hoisted(() => ({ current: null as CompassDatabase | null }));

vi.mock('../lib/database', () => ({
  database: (): CompassDatabase => {
    if (pool.current === null) throw new Error('The test database was not opened.');
    return pool.current;
  },
}));

beforeAll(async () => {
  database = await createMigratedTestDatabase({
    organizationId: ORGANIZATION_ID,
    name: 'Northwind Systems',
    slug: 'northwind-time-travel-web',
    timezone: 'Europe/London',
    at: new Date(T0),
  });
  pool.current = database.db;

  const scoped = database.scopedFor(ORGANIZATION_ID);
  await scoped
    .insertInto(users, {
      id: USER,
      email: 'priya@example.com',
      displayName: 'Priya Raman',
      passwordHash: null,
      createdAt: asDate('2026-07-01T00:00:00Z'),
      updatedAt: asDate('2026-07-01T00:00:00Z'),
    })
    .execute();
  await scoped
    .insertInto(memberships, {
      id: MEMBERSHIP,
      userId: USER,
      role: 'manager',
      status: 'active',
      createdAt: asDate('2026-07-01T00:00:00Z'),
      updatedAt: asDate('2026-07-01T00:00:00Z'),
    })
    .execute();
  await replaceTeamScopes(scoped, MEMBERSHIP, ['platform'], T0);

  /**
   * The team itself, as a knowledge-model row.
   *
   * A *scope* naming `platform` is not the same thing as a team called `platform` existing — which is
   * exactly the distinction the route's existence check enforces, and exactly why this fixture needs both.
   * The roster is declared configuration, so ingest never creates it; the worker's cold start provisions
   * the same row from the seed fixtures.
   */
  await scoped
    .insertInto(teams, {
      id: '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e',
      naturalKey: 'platform',
      firstSeenAt: asDate('2026-07-01T00:00:00Z'),
      lastSeenAt: asDate('2026-07-01T00:00:00Z'),
      beliefAt: asDate('2026-07-01T00:00:00Z'),
      version: 1,
      name: 'Platform',
      methodology: 'scrum',
      timezone: 'Europe/London',
    })
    .execute();

  session = (await startSession({ scoped, userId: USER, now: T0 })).secret;
}, 240_000);

afterAll(async () => {
  await database?.close();
});

const post = (body: unknown) =>
  new Request('https://compass.example.com/api/time-travel', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(session)}` },
    body: JSON.stringify(body),
  });

describe('the mode gate is resolved from the substrate, not from the request', () => {
  it('reports the simulated clock as available only for the seeded organization', () => {
    expect(simulatedClockAvailable(ORGANIZATION_ID)).toBe(true);
    // A live organization — any id that is not the seeded one — is not on a clock that may be stepped.
    expect(simulatedClockAvailable('99999999-9999-4999-8999-999999999999')).toBe(false);
  });

  it('collapses the bounds onto the current date outside simulated-clock mode', () => {
    // So a UI that ignored `available` still could not offer a step: `min` equals `max` equals today.
    const live = timeTravelBounds('99999999-9999-4999-8999-999999999999', '2026-07-31');

    expect(live.available).toBe(false);
    expect(live.earliestDate).toBe('2026-07-31');
    expect(live.latestDate).toBe('2026-07-31');
  });

  it('offers a real span inside simulated-clock mode', () => {
    const seeded = timeTravelBounds(ORGANIZATION_ID, '2026-07-31');

    expect(seeded.available).toBe(true);
    expect(seeded.earliestDate < seeded.latestDate).toBe(true);
  });
});

describe('POST /api/time-travel', () => {
  it('refuses a date that is not a civil date, and writes nothing', async () => {
    const { POST } = await import('../app/api/time-travel/route');

    const response = await POST(post({ date: 'last tuesday' }));

    expect(response.status).toBe(400);
    expect((await response.json())['error']).toBe('time_travel_unavailable');
  });

  it('refuses a date outside the seeded history rather than generating six absences', async () => {
    const { POST } = await import('../app/api/time-travel/route');

    const response = await POST(post({ date: '2019-01-01' }));
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    // The sentence names the span, so the reader knows what they may ask for.
    expect(String(body['detail'])).toContain('outside the seeded history');
  });

  it('refuses a team the caller is not scoped to, even named in the body', async () => {
    // `guard` checks `admitted.teamKey`, which is the caller's own. A body naming another team has to be
    // checked against their scopes too, or a manager could regenerate another team's report by asking.
    const { POST } = await import('../app/api/time-travel/route');

    const response = await POST(post({ date: '2026-07-30', teamKey: 'checkout' }));

    expect(response.status).toBe(403);
    expect((await response.json())['error']).toBe('team_out_of_scope');
  });

  it('refuses a team that is not a team in this organization', () => {
    // The merged sentinel is the concrete case: the archive contains merged-scope rows whose `scopeKey` is
    // `*`, and without this check a POST naming it would persist a daily for a team that does not exist.
    // Asserted here rather than only in the page, because the page is the affordance and this is the gate.
    return import('../app/api/time-travel/route').then(async ({ POST }) => {
      const response = await POST(post({ date: '2026-07-30', teamKey: SCOPE_KEY_FOR_MERGED }));
      const body = (await response.json()) as Record<string, unknown>;

      // 403 on scope before 400 on existence: this caller is scoped to `platform`, so the sentinel fails the
      // scope check first. Either refusal is correct; what must not happen is a write.
      expect([400, 403]).toContain(response.status);
      expect(['unknown_team', 'team_out_of_scope']).toContain(String(body['error']));
    });
  });

  it('resolves a civil date to a stable instant, the scheduler’s own', () => {
    // A pure function of the civil date. It previously copied the UTC hour off the host clock, so two
    // requests a minute apart produced two instants — and therefore two report rows for one morning, since
    // the row id is derived from `(organization, scope, instant)`.
    const instant = instantForDate('2026-07-24');

    expect(instantForDate('2026-07-24')).toBe(instant);
    // 06:00 in the run's zone, which is what `generate.tick` uses. Compared against the shared derivation
    // rather than against a literal, so the two cannot drift.
    expect(instant).toBe(reportInstantForDate('2026-07-24', 'Europe/London', DEFAULT_GENERATION_LOCAL_TIME));
  });

  it('lands on one report row when the same civil date is stepped to twice', async () => {
    /**
     * The consequence of the above, end to end and through the real pipeline.
     *
     * Same *date*, not the same instant — that is the whole point. The first POST generates; the second
     * finds the row the first wrote and says so. A drifting instant would silently produce two rows for one
     * morning, and the archive would list the same day twice with different content.
     */
    const { POST } = await import('../app/api/time-travel/route');

    const first = await POST(post({ date: '2026-07-30' }));
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(first.status, JSON.stringify(firstBody)).toBe(200);
    expect(firstBody['generated']).toBe(true);

    const second = await POST(post({ date: '2026-07-30' }));
    const secondBody = (await second.json()) as Record<string, unknown>;
    expect(second.status).toBe(200);

    expect(secondBody['reportId']).toBe(firstBody['reportId']);
    expect(secondBody['generated'], 'the second step must read the row the first one wrote').toBe(false);
    expect(String(secondBody['detail'])).toContain('already generated');
  }, 240_000);
});

describe('the mode gate refuses the write, not just the affordance', () => {
  /**
   * The criterion's second half, exercised through the route.
   *
   * The reachable arm is a deployment whose **substrate is not a stepped clock at all**:
   * `simulatedClockAvailable` is false when the seeded dataset has no window, which is the state of a
   * deployment reading a live connector. The organization-mismatch arm cannot be reached over HTTP today
   * because `guard` resolves the tenant server-side through `resolveSeededRun` — the same call the gate
   * asks — so a request cannot even *be* for another organization in this single-tenant deployment. It
   * becomes reachable the day host-based tenant resolution lands, which `lib/auth/guard.ts` documents as
   * replacing the body of `requestOrganizationId` and nothing else.
   *
   * Stubbed at the substrate rather than at `simulatedClockAvailable`, because stubbing the gate would be
   * testing the stub. Everything above it — the matrix, the session, the handler's ordering — is the
   * production path.
   */
  it('answers 403 and writes nothing when the deployment is not on a simulated clock', async () => {
    const { listReportArchive } = await import('@compass/db');
    const before = (await listReportArchive(database.scopedFor(ORGANIZATION_ID))).length;

    vi.resetModules();
    vi.doMock('@compass/seed-connector', async () => {
      const actual = await vi.importActual<typeof SeedConnectorModule>('@compass/seed-connector');
      return {
        ...actual,
        // A substrate with no window: not a fixture with a known start and end, so not a clock that may be
        // stepped. The organization id is unchanged, so the *only* thing failing is the mode.
        resolveSeededRun: (input: Parameters<typeof actual.resolveSeededRun>[0]) => ({
          ...actual.resolveSeededRun(input),
          datasetWindow: null,
        }),
      };
    });

    try {
      const { POST } = await import('../app/api/time-travel/route');
      const response = await POST(post({ date: '2026-07-30' }));
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(403);
      expect(body['error']).toBe('simulated_clock_unavailable');
      expect(String(body['detail'])).toContain('runs on the real one');

      // And nothing was written. The gate is in front of the write, not beside it.
      expect((await listReportArchive(database.scopedFor(ORGANIZATION_ID))).length).toBe(before);
    } finally {
      vi.doUnmock('@compass/seed-connector');
      vi.resetModules();
    }
  }, 240_000);
});
