import type { HttpClient, HttpRequest, HttpResponse } from '@compass/connector-port';
import { describe, expect, it } from 'vitest';

import {
  exchangeJiraAuthorizationCode,
  listJiraProjects,
  refreshJiraAccessToken,
} from '@compass/jira-connector';

/**
 * The OAuth 2.0 (3LO) round trip: the code exchange, the site lookup, and the refresh.
 *
 * `contract.test.ts` proves the connector once it *has* a credential. This file proves how it gets one and
 * how it keeps one — which is the half that decides whether a connection a manager made on Monday is still
 * reading on Tuesday.
 *
 * Every case is a value rather than a throw, because the caller is a browser callback or a worker boot: it
 * has to turn the outcome into a sentence somebody can act on, and an exception is not that.
 */

/** A client that answers from a table and records what it was asked. */
class RecordingClient implements HttpClient {
  readonly requests: HttpRequest[] = [];

  constructor(private readonly answers: readonly HttpResponse[]) {}

  send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const answer = this.answers[this.requests.length - 1];
    if (answer === undefined) {
      return Promise.reject(new Error(`No recorded answer for request ${this.requests.length}: ${request.url}`));
    }
    return Promise.resolve(answer);
  }
}

const json = (status: number, body: unknown): HttpResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const CREDENTIALS = { clientId: 'client-1234', clientSecret: 'shh' } as const;
const REDIRECT_URI = 'https://compass.example/api/connect/jira/callback';

// ---------------------------------------------------------------------------
// The code exchange, and the site lookup that has to follow it
// ---------------------------------------------------------------------------

describe('exchanging an authorization code', () => {
  const tokenGrant = {
    access_token: 'an-access-token',
    refresh_token: 'a-refresh-token',
    expires_in: 3600,
    scope: 'read:jira-work read:jira-user offline_access',
  };

  const sites = [{ id: 'cloud-abc', name: 'Northwind', url: 'https://northwind.atlassian.net' }];

  it('returns the tokens and the site the connector will address', async () => {
    /**
     * The site lookup is part of the exchange rather than a later step, because `api.atlassian.com` routes
     * by cloud id: a connector configured from the token alone would have no address to query, and the
     * failure would arrive a day later as an empty report instead of at connect time as a refusal.
     */
    const http = new RecordingClient([json(200, tokenGrant), json(200, sites)]);

    const outcome = await exchangeJiraAuthorizationCode({
      http,
      ...CREDENTIALS,
      code: 'a-code',
      redirectUri: REDIRECT_URI,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.accessToken).toBe('an-access-token');
    expect(outcome.refreshToken).toBe('a-refresh-token');
    expect(outcome.expiresInSeconds).toBe(3600);
    expect(outcome.cloudId).toBe('cloud-abc');
    expect(outcome.siteName).toBe('Northwind');
    expect(outcome.grantedScopes).toContain('read:jira-work');
  });

  it('sends the redirect URI back, because the provider compares it byte for byte', async () => {
    // A mismatch here is the single most common way an OAuth integration fails in a way that says nothing
    // useful, so the value is asserted on the wire rather than trusted.
    const http = new RecordingClient([json(200, tokenGrant), json(200, sites)]);

    await exchangeJiraAuthorizationCode({ http, ...CREDENTIALS, code: 'a-code', redirectUri: REDIRECT_URI });

    const body = JSON.parse(http.requests[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body['redirect_uri']).toBe(REDIRECT_URI);
    expect(body['grant_type']).toBe('authorization_code');
  });

  it('refuses a grant that names no site Compass could read', async () => {
    const http = new RecordingClient([json(200, tokenGrant), json(200, [])]);

    const outcome = await exchangeJiraAuthorizationCode({
      http,
      ...CREDENTIALS,
      code: 'a-code',
      redirectUri: REDIRECT_URI,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('no_accessible_site');
  });

  it.each([
    ['a refused code', json(400, { error: 'invalid_grant' })],
    ['a body it cannot read', { status: 200, headers: {}, body: 'not json' } satisfies HttpResponse],
    ['a grant with no access token', json(200, { refresh_token: 'r' })],
  ])('reports %s as a failed exchange rather than throwing', async (_label, response) => {
    const http = new RecordingClient([response, json(200, sites)]);

    const outcome = await exchangeJiraAuthorizationCode({
      http,
      ...CREDENTIALS,
      code: 'a-code',
      redirectUri: REDIRECT_URI,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('exchange_failed');
  });

  it('never asks for a site before it has a token to ask with', async () => {
    // Ordering matters: the resources endpoint is authorised by the access token, so a client that issued
    // both requests concurrently would get a 401 on one of them for no discoverable reason.
    const http = new RecordingClient([json(200, tokenGrant), json(200, sites)]);

    await exchangeJiraAuthorizationCode({ http, ...CREDENTIALS, code: 'a-code', redirectUri: REDIRECT_URI });

    expect(http.requests[0]?.method).toBe('POST');
    expect(http.requests[1]?.headers?.['authorization']).toBe('Bearer an-access-token');
  });
});

// ---------------------------------------------------------------------------
// The refresh, which is what makes a connection outlive its first hour
// ---------------------------------------------------------------------------

describe('refreshing an access token', () => {
  it('returns a new access token and the replacement refresh token', async () => {
    /**
     * The rotation is the point. This provider invalidates the refresh token that was sent and issues a
     * new one, so a caller that kept the old one would hold a credential that fails on its next use — and
     * the failure would arrive an hour later looking like a revoked grant.
     */
    const http = new RecordingClient([
      json(200, { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 }),
    ]);

    const outcome = await refreshJiraAccessToken({ http, ...CREDENTIALS, refreshToken: 'refresh-1' });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.accessToken).toBe('access-2');
    expect(outcome.refreshToken).toBe('refresh-2');
    expect(outcome.refreshToken).not.toBe('refresh-1');
    expect(outcome.expiresInSeconds).toBe(3600);
  });

  it('sends the refresh grant, and the token it is spending', async () => {
    const http = new RecordingClient([
      json(200, { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 }),
    ]);

    await refreshJiraAccessToken({ http, ...CREDENTIALS, refreshToken: 'refresh-1' });

    const body = JSON.parse(http.requests[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body['grant_type']).toBe('refresh_token');
    expect(body['refresh_token']).toBe('refresh-1');
  });

  it('refuses a response with a new access token and no replacement', async () => {
    /**
     * Failing here is better than succeeding. A connection that works now and is unrecoverable in an hour
     * is the worst of the available outcomes: nothing is stated, nothing is logged, and the source goes
     * quiet at a time nobody is watching.
     */
    const http = new RecordingClient([json(200, { access_token: 'access-2', expires_in: 3600 })]);

    const outcome = await refreshJiraAccessToken({ http, ...CREDENTIALS, refreshToken: 'refresh-1' });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('refresh_failed');
  });

  it('tells a revoked grant apart from a provider outage', async () => {
    /**
     * The distinction a manager acts on. A 4xx means the grant is gone — revoked in the provider's own
     * settings, or the refresh token already spent — and reconnecting is the only fix. A 5xx is transient,
     * and telling somebody to reconnect over it would send them to redo work that was never lost.
     */
    const revoked = await refreshJiraAccessToken({
      http: new RecordingClient([json(400, { error: 'invalid_grant' })]),
      ...CREDENTIALS,
      refreshToken: 'refresh-1',
    });
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.reason).toBe('refresh_rejected');

    const outage = await refreshJiraAccessToken({
      http: new RecordingClient([json(503, { error: 'unavailable' })]),
      ...CREDENTIALS,
      refreshToken: 'refresh-1',
    });
    expect(outage.ok).toBe(false);
    if (!outage.ok) expect(outage.reason).toBe('refresh_failed');
  });

  it('reports an unreadable body as a failure rather than throwing', async () => {
    const outcome = await refreshJiraAccessToken({
      http: new RecordingClient([{ status: 200, headers: {}, body: '<html>' }]),
      ...CREDENTIALS,
      refreshToken: 'refresh-1',
    });

    expect(outcome.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The project list, which is what makes per-project scoping self-serve
// ---------------------------------------------------------------------------

describe('listing the projects a grant can see', () => {
  it('returns the keys a manager picks from', async () => {
    /**
     * Without this, per-project scoping would mean a manager knowing that their project key is `DEV` — a
     * configuration file with extra steps. It reads the *search* endpoint, so it needs only
     * `read:jira-work`, which is already requested.
     */
    const http = new RecordingClient([
      json(200, {
        values: [
          { key: 'DEV', name: 'Checkout' },
          { key: 'OPS', name: 'Platform Ops' },
        ],
      }),
    ]);

    const projects = await listJiraProjects({ http, accessToken: 'a-token', cloudId: 'cloud-abc' });

    expect(projects).toEqual([
      { projectKey: 'DEV', name: 'Checkout' },
      { projectKey: 'OPS', name: 'Platform Ops' },
    ]);
  });

  it('addresses the site by its cloud id', async () => {
    const http = new RecordingClient([json(200, { values: [] })]);

    await listJiraProjects({ http, accessToken: 'a-token', cloudId: 'cloud-abc' });

    expect(http.requests[0]?.url).toContain('/ex/jira/cloud-abc/');
    // The search endpoint, not an issue enumeration: this is called once at connect time and must not be
    // a route into reading anybody's work.
    expect(http.requests[0]?.url).toContain('/project/search');
  });

  it('answers with an empty list rather than throwing when the grant cannot list them', async () => {
    // The connect screen then falls back to a typed key, which still works. A throw here would take the
    // whole callback down over a list that is a convenience.
    const projects = await listJiraProjects({
      http: new RecordingClient([json(403, { error: 'forbidden' })]),
      accessToken: 'a-token',
      cloudId: 'cloud-abc',
    });

    expect(projects).toEqual([]);
  });
});
