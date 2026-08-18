import { startSession } from '@compass/auth';
import { instantFromIso, type Instant } from '@compass/clock';
import {
  ScopedDb,
  memberships,
  orgScope,
  readFeedbackLedger,
  replaceTeamScopes,
  reportItems,
  reportSections,
  reports,
  upsertSubscription,
  users,
  type CompassDatabase,
} from '@compass/db';
import { createMigratedTestDatabase, type TestDatabase } from '@compass/db/testing';
import {
  FEEDBACK_LINK_SECRET_ENV_VAR,
  SLACK_SIGNATURE_HEADER,
  SLACK_SIGNING_SECRET_ENV_VAR,
  SLACK_TIMESTAMP_HEADER,
  feedbackLinkExpiry,
  mintFeedbackToken,
  slackActionId,
  slackSignatureFor,
} from '@compass/delivery';
import { SEEDED_ORGANIZATION_ID } from '@compass/seed-connector';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { SESSION_COOKIE_NAME } from '../lib/auth/cookies';
import { edgeNow } from './helpers/edge-now';
import {
  FIXTURE_FEEDBACK_LINK_SECRET,
  FIXTURE_OTHER_SIGNING_SECRET,
  FIXTURE_SLACK_SIGNING_SECRET,
} from './helpers/fixture-credentials';

/**
 * The two feedback routes, executed.
 *
 * `feedback-loop.test.ts` proves what a verdict *does*. This proves the two properties only the
 * handlers can have, and both are the kind that fail silently:
 *
 *  - **A signed email link never authenticates a session.** Asserted as the absence of `Set-Cookie`,
 *    because "helpfully sign the clicker in" is a convenience somebody adds later in good faith, and
 *    it would turn a capability to dismiss one risk into a way into the organization's reports.
 *  - **An unmapped or unauthorized Slack click mutates nothing.** Asserted by counting the ledger
 *    before and after, not by reading the response — a route that answered politely and wrote a row
 *    anyway would pass any assertion about its body.
 *
 * The handlers are imported unchanged and reach a real migrated PostgreSQL 17 through PGlite. Only
 * `lib/database`'s pool is stubbed, exactly as `login-route.test.ts` does it: that is the seam
 * between this process and a database, and everything above it — `guard`, `authorize`, the token
 * verification, the Slack signature — is the production path.
 */

const ORGANIZATION_ID = SEEDED_ORGANIZATION_ID;
const USER = '6b6b6b6b-6b6b-4b6b-8b6b-6b6b6b6b6b6b';
const MEMBERSHIP = '7c7c7c7c-7c7c-4c7c-8c7c-7c7c7c7c7c7c';
const VIEWER = '6b6b6b6b-6b6b-4b6b-8b6b-6b6b6b6b6b6c';
const VIEWER_MEMBERSHIP = '7c7c7c7c-7c7c-4c7c-8c7c-7c7c7c7c7c7d';
const REPORT = '8d8d8d8d-8d8d-4d8d-8d8d-8d8d8d8d8d8d';
const SECTION = '9e9e9e9e-9e9e-4e9e-8e9e-9e9e9e9e9e9e';

/** A second team's report, which nobody in this fixture is scoped to. */
const CHECKOUT_REPORT = '8d8d8d8d-8d8d-4d8d-8d8d-8d8d8d8d8dcc';
const CHECKOUT_SECTION = '9e9e9e9e-9e9e-4e9e-8e9e-9e9e9e9e9ecc';

const ITEM_ID = 'v1:8f2c1a0b3d4e5f60';
/** An item on the checkout team's report. Same organization, different team. */
const CHECKOUT_ITEM_ID = 'v1:00000000000000cc';
const LINK_SECRET = FIXTURE_FEEDBACK_LINK_SECRET;
const SLACK_SECRET = FIXTURE_SLACK_SIGNING_SECRET;

/** The manager's mapped Slack user, and a colleague who has no Compass seat at all. */
const MAPPED_SLACK_USER = 'U-PRIYA';
const UNMAPPED_SLACK_USER = 'U-STRANGER';
const VIEWER_SLACK_USER = 'U-VIEWER';

const T0: Instant = instantFromIso('2026-08-03T09:00:00Z');
const asDate = (iso: string) => new Date(Date.parse(iso));

let database: TestDatabase;
const scoped = () => new ScopedDb(database.db, orgScope(ORGANIZATION_ID));

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
    slug: 'northwind-feedback',
    timezone: 'Europe/London',
    at: new Date(T0),
  });
  pool.current = database.db;

  process.env[FEEDBACK_LINK_SECRET_ENV_VAR] = LINK_SECRET;
  process.env[SLACK_SIGNING_SECRET_ENV_VAR] = SLACK_SECRET;

  for (const [id, email, name] of [
    [USER, 'priya@example.com', 'Priya Raman'],
    [VIEWER, 'director@example.com', 'A Director'],
  ] as const) {
    await scoped()
      .insertInto(users, {
        id,
        email,
        displayName: name,
        passwordHash: null,
        createdAt: asDate('2026-08-01T00:00:00Z'),
        updatedAt: asDate('2026-08-01T00:00:00Z'),
      })
      .execute();
  }

  for (const [id, userId, role] of [
    [MEMBERSHIP, USER, 'manager'],
    [VIEWER_MEMBERSHIP, VIEWER, 'viewer'],
  ] as const) {
    await scoped()
      .insertInto(memberships, {
        id,
        userId,
        role,
        status: 'active',
        createdAt: asDate('2026-08-01T00:00:00Z'),
        updatedAt: asDate('2026-08-01T00:00:00Z'),
      })
      .execute();
  }

  // Both seats are scoped to the team whose report this is, so the viewer's refusal below is about
  // their *role* and not about scope. A manager with no scope at all has no team to act on, and
  // asserting against that fixture would be asserting the wrong rule.
  await replaceTeamScopes(scoped(), MEMBERSHIP, ['platform'], T0);
  await replaceTeamScopes(scoped(), VIEWER_MEMBERSHIP, ['platform'], T0);

  await scoped()
    .insertInto(reports, {
      id: REPORT,
      scopeKind: 'team',
      scopeKey: 'platform',
      schemaVersion: 2,
      reportInstant: asDate('2026-08-03T06:00:00Z'),
      reportDate: '2026-08-03',
      timezone: 'Europe/London',
      windowStart: asDate('2026-08-02T00:00:00Z'),
      windowEnd: asDate('2026-08-03T00:00:00Z'),
      contentHash: 'd'.repeat(64),
      payloadJson: '{}',
      payload: {},
      prose: 'The whole report.',
      changeLine: 'Nothing material changed since yesterday.',
      rendererId: 'template',
      fallbackRenderer: false,
      fallbackReason: null,
      coverageStatus: 'complete',
      ingestRunId: null,
      generatedAt: asDate('2026-08-03T06:00:00Z'),
    })
    .execute();

  await scoped()
    .insertInto(reportSections, {
      id: SECTION,
      reportId: REPORT,
      sectionKey: 'risks',
      ordinal: 4,
      title: 'Risks',
      prose: 'The risks prose.',
      payload: {},
      itemCount: 1,
      emptyStatement: 'No risk crossed a threshold.',
      summary: '1 risk crossed a threshold.',
    })
    .execute();

  await scoped()
    .insertInto(reportItems, {
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      reportId: REPORT,
      reportSectionId: SECTION,
      ordinal: 1,
      stableId: ITEM_ID,
      causeEntityRef: 'developer:priya',
      causeKind: 'review_bottleneck',
      causeDiscriminator: '',
      headline: 'Priya has reviewed 6 of the 8 open pull requests',
      detail: 'Review load is concentrated.',
      prose: 'A claim about review load.',
      changeTag: 'unchanged',
      ageDays: 5,
      firstSeenAt: asDate('2026-07-29T06:00:00Z'),
      severityScore: 210,
      signalOnsetAt: asDate('2026-07-29T06:00:00Z'),
      feedbackState: null,
      changeClause: null,
      ladder: null,
      hasLadder: false,
      payload: {},
    })
    .execute();

  // The Slack identity mapping an interactive action is authorized by. `target` is the channel the
  // daily is posted to; `slackUserId` is who the subscriber *is*, which is a different fact.
  await upsertSubscription(
    scoped(),
    {
      id: 'cccccccc-0000-4000-8000-000000000001',
      userId: USER,
      channel: 'slack',
      target: '#platform-daily',
      scope: 'team',
      sendTime: '07:30',
      timezone: 'Europe/London',
      unsubscribeTokenHash: 'e'.repeat(64),
      slackUserId: MAPPED_SLACK_USER,
    },
    T0,
  );

  await upsertSubscription(
    scoped(),
    {
      id: 'cccccccc-0000-4000-8000-000000000002',
      userId: VIEWER,
      channel: 'slack',
      target: '#platform-daily',
      scope: 'team',
      sendTime: '07:30',
      timezone: 'Europe/London',
      unsubscribeTokenHash: 'f'.repeat(64),
      slackUserId: VIEWER_SLACK_USER,
    },
    T0,
  );
  // ---- a second team, which nobody in this fixture is scoped to ---------------
  //
  // Both seats hold `['platform']` only. Everything below exists so the cross-team assertions have a
  // real item to aim at: the exposure being guarded is that an item id is not team-scoped, so a
  // manager handed one from another team's report could have their verdict applied to it.
  await scoped()
    .insertInto(reports, {
      id: CHECKOUT_REPORT,
      scopeKind: 'team',
      scopeKey: 'checkout',
      schemaVersion: 2,
      reportInstant: asDate('2026-08-03T06:00:00Z'),
      reportDate: '2026-08-03',
      timezone: 'Europe/London',
      windowStart: asDate('2026-08-02T00:00:00Z'),
      windowEnd: asDate('2026-08-03T00:00:00Z'),
      contentHash: '9'.repeat(64),
      payloadJson: '{}',
      payload: {},
      prose: 'The checkout team’s report.',
      changeLine: 'Nothing material changed since yesterday.',
      rendererId: 'template',
      fallbackRenderer: false,
      fallbackReason: null,
      coverageStatus: 'complete',
      ingestRunId: null,
      generatedAt: asDate('2026-08-03T06:00:00Z'),
    })
    .execute();

  await scoped()
    .insertInto(reportSections, {
      id: CHECKOUT_SECTION,
      reportId: CHECKOUT_REPORT,
      sectionKey: 'risks',
      ordinal: 4,
      title: 'Risks',
      prose: 'The checkout risks prose.',
      payload: {},
      itemCount: 1,
      emptyStatement: 'No risk crossed a threshold.',
      summary: '1 risk crossed a threshold.',
    })
    .execute();

  await scoped()
    .insertInto(reportItems, {
      id: 'bbbbbbbb-0000-4000-8000-000000000001',
      reportId: CHECKOUT_REPORT,
      reportSectionId: CHECKOUT_SECTION,
      ordinal: 1,
      stableId: CHECKOUT_ITEM_ID,
      causeEntityRef: 'developer:dev',
      causeKind: 'review_bottleneck',
      causeDiscriminator: '',
      headline: 'Dev has reviewed 7 of the 9 open pull requests',
      detail: 'Review load is concentrated.',
      prose: 'A claim about checkout review load.',
      changeTag: 'unchanged',
      ageDays: 5,
      firstSeenAt: asDate('2026-07-29T06:00:00Z'),
      severityScore: 210,
      signalOnsetAt: asDate('2026-07-29T06:00:00Z'),
      feedbackState: null,
      changeClause: null,
      ladder: null,
      hasLadder: false,
      payload: {},
    })
    .execute();
}, 120_000);

afterAll(async () => {
  delete process.env[FEEDBACK_LINK_SECRET_ENV_VAR];
  delete process.env[SLACK_SIGNING_SECRET_ENV_VAR];
  await database?.close();
});

const ledgerSize = async (): Promise<number> => (await readFeedbackLedger(scoped())).length;

// ---------------------------------------------------------------------------
// The signed email link
// ---------------------------------------------------------------------------

const linkRequest = (token: string) =>
  new Request(`https://compass.example.com/api/feedback/link/${encodeURIComponent(token)}`, { method: 'GET' });

// Next.js hands `params` **already decoded**, so the fixture hands the token verbatim. Encoding it
// here would have been testing a decode step the handler deliberately does not perform.
const linkContext = (token: string) => ({ params: Promise.resolve({ token }) });

const token = (action: string, now: Instant = T0, secret = LINK_SECRET) =>
  mintFeedbackToken({ organizationId: ORGANIZATION_ID, itemStableId: ITEM_ID, action }, now, secret).token;

describe('GET /api/feedback/link/<token>', () => {
  it('records the verdict and never sets a session cookie', async () => {
    const { GET } = await import('../app/api/feedback/link/[token]/route');
    const minted = token('snooze');

    const response = await GET(linkRequest(minted), linkContext(minted));

    expect(response.status).toBe(200);
    // The property that matters most, and the one nobody would notice breaking: a capability to
    // snooze one item must not become a way into the organization's reports.
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');

    const body = (await response.json()) as Record<string, unknown>;
    expect(body['recorded']).toBe(true);
    expect(body['signedIn']).toBe(false);
    expect(String(body['detail'])).toContain('did not sign you in');
  });

  it('refuses the second click on the same link, and changes nothing', async () => {
    const { GET } = await import('../app/api/feedback/link/[token]/route');
    const minted = token('dismiss_risk');

    const first = await GET(linkRequest(minted), linkContext(minted));
    expect(first.status).toBe(200);

    const before = await ledgerSize();
    const second = await GET(linkRequest(minted), linkContext(minted));
    const after = await ledgerSize();

    expect(second.status).toBe(409);
    expect((await second.json())['error']).toBe('already_used');
    expect(after, 'a replayed link must not write a second verdict').toBe(before);
    expect(second.headers.getSetCookie()).toEqual([]);
  });

  it('refuses an expired link with 410 and writes nothing', async () => {
    const { GET } = await import('../app/api/feedback/link/[token]/route');
    // Minted 31 days before the request edge's own instant, so it is past its 30-day life. The edge
    // reads the system clock, so the token is dated relative to *now* rather than to T0.
    const longAgo = (Date.now() - 31 * 86_400_000) as Instant;
    const stale = token('snooze', longAgo);

    const before = await ledgerSize();
    const response = await GET(linkRequest(stale), linkContext(stale));

    expect(response.status).toBe(410);
    expect((await response.json())['error']).toBe('expired');
    expect(await ledgerSize()).toBe(before);
    // And the expiry it was refused against is the one the token itself claims.
    expect(feedbackLinkExpiry(longAgo)).toBeLessThan(Date.now());
  });

  it('refuses a forged signature with 400 and writes nothing', async () => {
    const { GET } = await import('../app/api/feedback/link/[token]/route');
    const forged = token('snooze', T0, FIXTURE_OTHER_SIGNING_SECRET);

    const before = await ledgerSize();
    const response = await GET(linkRequest(forged), linkContext(forged));

    expect(response.status).toBe(400);
    expect((await response.json())['error']).toBe('bad_signature');
    expect(await ledgerSize()).toBe(before);
  });

  it('refuses a link minted for another organization', async () => {
    const { GET } = await import('../app/api/feedback/link/[token]/route');
    const other = mintFeedbackToken(
      { organizationId: '11111111-1111-4111-8111-111111111111', itemStableId: ITEM_ID, action: 'snooze' },
      T0,
      LINK_SECRET,
    ).token;

    const before = await ledgerSize();
    const response = await GET(linkRequest(other), linkContext(other));

    expect(response.status).toBe(403);
    expect(await ledgerSize()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Slack interactions
// ---------------------------------------------------------------------------

const slackBody = (slackUserId: string, action = 'snooze', itemStableId = ITEM_ID): string =>
  new URLSearchParams({
    payload: JSON.stringify({
      user: { id: slackUserId },
      team: { id: 'T900' },
      channel: { id: 'C500' },
      response_url: 'https://hooks.slack.example/actions/1',
      actions: [{ action_id: slackActionId(action), value: itemStableId }],
    }),
  }).toString();

const slackRequest = (
  body: string,
  options: { readonly secret?: string; readonly at?: number } = {},
): Request => {
  const stamp = String(Math.floor((options.at ?? Date.now()) / 1000));
  return new Request('https://compass.example.com/api/slack/actions', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      [SLACK_TIMESTAMP_HEADER]: stamp,
      [SLACK_SIGNATURE_HEADER]: slackSignatureFor(body, stamp, options.secret ?? SLACK_SECRET),
    },
    body,
  });
};

describe('POST /api/slack/actions', () => {
  it('applies a verdict from a mapped, permitted Slack user', async () => {
    const { POST } = await import('../app/api/slack/actions/route');

    const before = await ledgerSize();
    const response = await POST(slackRequest(slackBody(MAPPED_SLACK_USER)));

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['response_type']).toBe('ephemeral');
    expect(String(body['text'])).toContain('Snoozed');
    expect(await ledgerSize()).toBeGreaterThanOrEqual(before);

    const recorded = (await readFeedbackLedger(scoped())).find((entry) => entry.sourceChannel === 'slack');
    expect(recorded, 'the verdict must be attributed to the mapped seat').toBeDefined();
    expect(recorded?.authorUserId).toBe(USER);
  });

  it('refuses a mapped manager acting on another team’s report item, and mutates nothing', async () => {
    /**
     * The exposure this closes. An item id is not team-scoped and the lookup behind it is scoped to
     * the organization, so a manager scoped to `platform` who is handed a `checkout` item's id — by
     * a colleague, from a shared channel, from a forwarded message — could have their verdict applied
     * to the checkout team's report.
     *
     * It used to pass because the matrix was asked about `teamScopes[0]`, the clicker's *own* first
     * team, so `teamScopeAllows` compared a scope against itself and could not fail. The team now
     * comes from the report containing the item.
     */
    const { POST } = await import('../app/api/slack/actions/route');

    const before = await ledgerSize();
    const response = await POST(slackRequest(slackBody(MAPPED_SLACK_USER, 'snooze', CHECKOUT_ITEM_ID)));
    const after = await ledgerSize();

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    // The same refusal an unmapped user gets, deliberately: a different message here would tell the
    // clicker that the id they were handed exists on a team they cannot see.
    expect(body['response_type']).toBe('ephemeral');
    expect(body['replace_original']).toBe(false);
    expect(String(body['text'])).toContain('don’t have access');
    expect(after, 'a cross-team click must write nothing').toBe(before);

    // And nothing was recorded against the checkout item under any channel.
    const ledger = await readFeedbackLedger(scoped());
    expect(ledger.some((entry) => entry.reportItemStableId === CHECKOUT_ITEM_ID)).toBe(false);
  });

  it('answers an unmapped Slack user with an ephemeral refusal and mutates nothing', async () => {
    const { POST } = await import('../app/api/slack/actions/route');

    const before = await ledgerSize();
    const response = await POST(slackRequest(slackBody(UNMAPPED_SLACK_USER)));
    const after = await ledgerSize();

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['response_type']).toBe('ephemeral');
    // Not `replace_original`: a manager's daily must not be rewritten because somebody else pressed a
    // button in a shared channel.
    expect(body['replace_original']).toBe(false);
    expect(String(body['text'])).toContain('don’t have access');
    expect(after, 'an unauthorized click must write nothing').toBe(before);
  });

  it('answers a mapped but unauthorized seat the same way, and mutates nothing', async () => {
    // A viewer reads the daily and does not get to change what tomorrow's says. The check is the same
    // `ROLE_MATRIX` the web POST consults, so a role that cannot act on the page cannot act here.
    const { POST } = await import('../app/api/slack/actions/route');

    const before = await ledgerSize();
    const response = await POST(slackRequest(slackBody(VIEWER_SLACK_USER)));

    expect(response.status).toBe(200);
    expect(String((await response.json())['text'])).toContain('don’t have access');
    expect(await ledgerSize()).toBe(before);
  });

  it('refuses an unsigned request with 401 and mutates nothing', async () => {
    const { POST } = await import('../app/api/slack/actions/route');
    const body = slackBody(MAPPED_SLACK_USER);

    const before = await ledgerSize();
    const response = await POST(
      new Request('https://compass.example.com/api/slack/actions', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      }),
    );

    expect(response.status).toBe(401);
    expect(await ledgerSize()).toBe(before);
  });

  it('refuses a request signed under the wrong secret', async () => {
    const { POST } = await import('../app/api/slack/actions/route');

    const before = await ledgerSize();
    const response = await POST(slackRequest(slackBody(MAPPED_SLACK_USER), { secret: FIXTURE_OTHER_SIGNING_SECRET }));

    expect(response.status).toBe(401);
    expect(await ledgerSize()).toBe(before);
  });

  it('refuses a replay from outside the five-minute window', async () => {
    const { POST } = await import('../app/api/slack/actions/route');

    const before = await ledgerSize();
    const response = await POST(slackRequest(slackBody(MAPPED_SLACK_USER), { at: Date.now() - 10 * 60 * 1000 }));

    expect(response.status).toBe(401);
    expect(await ledgerSize()).toBe(before);
  });

  it('still refuses the cross-team item when the seat is otherwise permitted', async () => {
    // The mirror of the accept case above, run last so it cannot be passing because an earlier test
    // left the ledger in a particular state: the same seat, the same action, the same signature — only
    // the item's team differs, and that is the one thing that decides it.
    const { POST } = await import('../app/api/slack/actions/route');

    const permitted = await POST(slackRequest(slackBody(MAPPED_SLACK_USER, 'snooze', ITEM_ID)));
    expect(String((await permitted.json())['text'])).not.toContain('don’t have access');

    const refused = await POST(slackRequest(slackBody(MAPPED_SLACK_USER, 'snooze', CHECKOUT_ITEM_ID)));
    expect(String((await refused.json())['text'])).toContain('don’t have access');
  });

  it('refuses every interaction when no signing secret is configured', async () => {
    const { POST } = await import('../app/api/slack/actions/route');
    const configured = process.env[SLACK_SIGNING_SECRET_ENV_VAR];
    delete process.env[SLACK_SIGNING_SECRET_ENV_VAR];

    try {
      const before = await ledgerSize();
      const response = await POST(slackRequest(slackBody(MAPPED_SLACK_USER)));

      // A deployment that cannot verify must not act, and says so as its own fault rather than the
      // caller's.
      expect(response.status).toBe(503);
      expect(await ledgerSize()).toBe(before);
    } finally {
      process.env[SLACK_SIGNING_SECRET_ENV_VAR] = configured;
    }
  });
});

// ---------------------------------------------------------------------------
// The web channel
// ---------------------------------------------------------------------------

/**
 * A signed-in POST to `/api/feedback`, as the report page's buttons make it.
 *
 * A real session rather than a stubbed guard: the whole question is whether the *handler* checks the
 * item's team against this seat's scopes, and a mocked `guard` would answer a question nobody asked.
 */
const feedbackRequest = (cookie: string, body: unknown) =>
  new Request('https://compass.example.com/api/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(cookie)}` },
    body: JSON.stringify(body),
  });

describe('POST /api/feedback', () => {
  let managerSession = '';

  beforeAll(async () => {
    const started = await startSession({ scoped: scoped(), userId: USER, now: edgeNow() });
    managerSession = started.secret;
  });

  it('records a verdict on an item in the caller’s own team', async () => {
    const { POST } = await import('../app/api/feedback/route');

    const response = await POST(feedbackRequest(managerSession, { stableId: ITEM_ID, action: 'snooze' }));

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['recorded']).toBe(true);
    expect(body['stableId']).toBe(ITEM_ID);
  });

  it('refuses an item on a team the caller is not scoped to, and mutates nothing', async () => {
    /**
     * The same exposure as the Slack case, on the channel that looks safest.
     *
     * `guard()` cannot make this check: `/api/feedback` is `teamScoped` in the matrix, but the team is
     * a property of the item and the item id is in the body the guard never reads. With no team,
     * `teamScopeAllows` only asks whether the caller has *any* scope — which a manager does — so the
     * request was admitted and the organization-scoped item lookup then did the rest.
     */
    const { POST } = await import('../app/api/feedback/route');

    const before = await ledgerSize();
    const response = await POST(feedbackRequest(managerSession, { stableId: CHECKOUT_ITEM_ID, action: 'snooze' }));
    const after = await ledgerSize();

    expect(response.status).toBe(403);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['error']).toBe('team_out_of_scope');
    // The sentence names the scope problem without confirming that the other team has a report.
    expect(String(body['detail']).toLowerCase()).not.toContain('does not exist');
    expect(after, 'a cross-team POST must write nothing').toBe(before);

    const ledger = await readFeedbackLedger(scoped());
    expect(ledger.some((entry) => entry.reportItemStableId === CHECKOUT_ITEM_ID)).toBe(false);
  });
});
