import { ARTIFACT_KINDS, fetchArtifact, type HttpClient, type HttpResponse } from '@compass/connector-port';
import { describeConnectorContract, ThrottledHttpClient } from '@compass/connector-port/testkit';
import { describe, expect, it } from 'vitest';

import {
  EmptyChannelSelectionError,
  FORBIDDEN_SLACK_SCOPES,
  SLACK_SCOPES,
  SlackConnector,
  conversationKindFromKey,
  slackInstallUrl,
  slackScopeQuery,
} from '@compass/slack-connector';

import {
  API_BASE_URL,
  CONTRACT_WINDOW,
  ENGINEERING_CHANNEL_KEY,
  ENGINEERING_CHANNEL_NAME,
  MARCUS_AUTHOR_ID,
  NOW,
  ORGANIZATION_ID,
  PRIYA_AUTHOR_ID,
  RELEASES_CHANNEL_KEY,
  SELECTED_CHANNELS,
  SOURCE_KEY,
  UNSELECTED_CHANNEL_KEY,
  recordedClient,
} from './recorded-api.js';

/**
 * The acceptance criterion, as the only test that can prove it:
 *
 * > The Slack connector passes the ConnectorPort contract test suite unchanged.
 *
 * `describeConnectorContract` is imported and called. It is not copied, not parameterised beyond the
 * factory hook it already offers, and not weakened — the seeded provider, the code host and the tracker
 * all run the identical function. That is what makes "a live provider drops in unchanged" a checked
 * property rather than a claim in an architecture document.
 */

const connectorConfig = (overrides: Record<string, unknown> = {}) => ({
  sourceKey: SOURCE_KEY,
  channels: SELECTED_CHANNELS,
  botToken: 'a-test-bot-token',
  http: recordedClient(),
  apiBaseUrl: API_BASE_URL,
  ...overrides,
});

const request = { organizationId: ORGANIZATION_ID, window: CONTRACT_WINDOW, now: NOW };

describeConnectorContract({
  name: 'SlackConnector',
  // A fresh connector *and* a fresh transport per call, which is what the "holds no cursor state"
  // property actually demands: a shared client would let one call's pagination leak into the next.
  createConnector: () => new SlackConnector(connectorConfig()),
  organizationId: ORGANIZATION_ID,
  window: CONTRACT_WINDOW,
  now: NOW,
});

// ---------------------------------------------------------------------------
// Scopes, displayed verbatim before consent
// ---------------------------------------------------------------------------

describe('the requested scopes are exactly the documented read-only set', () => {
  it('requests read access and nothing else', () => {
    for (const scope of SLACK_SCOPES) {
      expect(scope.access, `${scope.scope} must be read-only`).toBe('read');
    }
  });

  it('requests exactly the two scopes the criterion names', () => {
    // Named literally rather than counted, so adding a third scope is a failure that says which one.
    expect(SLACK_SCOPES.map((scope) => scope.scope)).toEqual(['channels:history', 'users:read']);
  });

  it('requests none of the scopes Compass promises never to ask for', () => {
    const requested = SLACK_SCOPES.map((scope) => scope.scope);

    for (const forbidden of FORBIDDEN_SLACK_SCOPES) {
      expect(requested, `${forbidden} must never be requested`).not.toContain(forbidden);
    }
  });

  it('never requests the scopes that would reach a private conversation', () => {
    /**
     * The three that matter most, asserted by name. `groups:history`, `im:history` and `mpim:history` are
     * what would let Compass read private channels, direct messages and group messages — so their
     * absence is why a non-public read fails at the *provider* rather than relying on Compass to decline
     * it. An omission nobody asserts is an omission the next edit removes.
     */
    for (const scope of ['groups:history', 'im:history', 'mpim:history']) {
      expect(FORBIDDEN_SLACK_SCOPES).toContain(scope);
      expect(slackScopeQuery()).not.toContain(scope);
    }
  });

  it('never requests the scope that would enumerate the workspace', () => {
    // `channels:read` lists every channel in the workspace. Compass is told which channels to read; it
    // does not go looking, and there is deliberately no credential that could.
    expect(FORBIDDEN_SLACK_SCOPES).toContain('channels:read');
    expect(slackScopeQuery()).not.toContain('channels:read');
  });

  it('builds the install URL from the same list the connect screen renders', () => {
    /**
     * The drift this pins: two copies of the scope list — one in the URL, one in the JSX — is the shape
     * where the screen keeps promising read-only after somebody adds a write scope to the request. The
     * URL is *derived*, so the promise and the request cannot disagree.
     */
    const url = slackInstallUrl({
      clientId: 'client-1234',
      redirectUri: 'https://compass.example/api/connect/slack/callback',
      state: 'a-csrf-token',
    });

    expect(url).toContain(`scope=${encodeURIComponent(slackScopeQuery())}`);
    expect(url).toContain('state=a-csrf-token');
    expect(slackScopeQuery()).toBe('channels:history,users:read');
  });

  it('asks for bot scopes and leaves the user scopes empty', () => {
    /**
     * A user token would read everything the installing person can see — the whole workspace, their
     * direct messages included. A bot token reads the channels it was invited to. That distinction *is*
     * the difference between a channel-scoped connector and a workspace-wide one, so it is asserted
     * rather than left to whoever next edits the query.
     */
    const url = new URL(
      slackInstallUrl({
        clientId: 'client-1234',
        redirectUri: 'https://compass.example/api/connect/slack/callback',
        state: 'a-csrf-token',
      }),
    );

    expect(url.searchParams.get('scope')).toBe(slackScopeQuery());
    expect(url.searchParams.get('user_scope')).toBe('');
  });

  it('gives every scope a reason a manager can evaluate', () => {
    // A consent screen listing permissions with no justification is a screen nobody can refuse
    // intelligently. Each entry has to say what breaks without it.
    for (const scope of SLACK_SCOPES) {
      expect(scope.because.length, `${scope.scope} has no stated reason`).toBeGreaterThan(40);
    }
  });
});

// ---------------------------------------------------------------------------
// Per-channel scoping — the criterion's sharpest assertion
// ---------------------------------------------------------------------------

describe('only explicitly named channels are queried', () => {
  it('refuses an empty selection rather than reading every channel the bot is in', () => {
    /**
     * Chat is the family Compass stores verbatim, so an unscoped read would mean holding the text of
     * conversations nobody offered it. A manager who named no channel consented to nothing.
     */
    expect(() => new SlackConnector(connectorConfig({ channels: [] }))).toThrow(EmptyChannelSelectionError);
  });

  it('never issues a history call for a channel nobody named', async () => {
    const http = recordedClient();
    const connector = new SlackConnector(connectorConfig({ http }));

    for (const artifact of ARTIFACT_KINDS) {
      await fetchArtifact(connector, artifact, request);
    }
    await connector.reportSourceHealth(request);

    expect(http.requests.length, 'the connector issued no requests at all').toBeGreaterThan(0);
    expect(http.calledAnyMatching(new RegExp(UNSELECTED_CHANNEL_KEY))).toBe(false);

    for (const url of http.urls) {
      if (!url.includes('conversations.history')) continue;
      const channel = new URL(url).searchParams.get('channel');
      expect([ENGINEERING_CHANNEL_KEY, RELEASES_CHANNEL_KEY], `${url} names an unselected channel`).toContain(
        channel,
      );
    }
  });

  it('makes no workspace-wide call of any kind', async () => {
    /**
     * The criterion: "a test asserts no workspace-wide history call is ever made". Every endpoint that
     * would turn a channel-scoped connector into a workspace-wide one, named individually:
     *
     *  - `conversations.list` / `users.list` enumerate the workspace.
     *  - `search.messages` reads across every conversation the token can see at once.
     *  - a `conversations.history` with **no** `channel` parameter is the same read by omission.
     */
    const http = recordedClient();
    const connector = new SlackConnector(connectorConfig({ http }));

    for (const artifact of ARTIFACT_KINDS) {
      await fetchArtifact(connector, artifact, request);
    }
    await connector.reportSourceHealth(request);

    expect(http.calledAnyMatching(/conversations\.list/)).toBe(false);
    expect(http.calledAnyMatching(/users\.list/)).toBe(false);
    expect(http.calledAnyMatching(/search\./)).toBe(false);
    expect(http.calledAnyMatching(/conversations\.history(?![^?]*\?.*channel=)/)).toBe(false);

    // Every request is either a scoped history read or a single named author lookup. Nothing else.
    for (const url of http.urls) {
      expect(url, `${url} is neither a scoped history read nor an author lookup`).toMatch(
        /\/(conversations\.history\?channel=|users\.info\?user=)/,
      );
    }
  });

  it('looks a person up by id and never asks for the whole directory', async () => {
    const http = recordedClient();
    await new SlackConnector(connectorConfig({ http })).fetchMessages(request);

    const lookups = http.urls.filter((url) => url.includes('users.info'));
    expect(lookups.length).toBeGreaterThan(0);
    for (const url of lookups) {
      expect([PRIYA_AUTHOR_ID, MARCUS_AUTHOR_ID]).toContain(new URL(url).searchParams.get('user'));
    }
  });

  it('reads each author once per call rather than once per message', async () => {
    // Priya posts three times in the recording. Three lookups would be three round trips for one answer.
    const http = recordedClient();
    await new SlackConnector(connectorConfig({ http })).fetchMessages(request);

    const priyaLookups = http.urls.filter((url) => url.includes(`user=${PRIYA_AUTHOR_ID}`));
    expect(priyaLookups).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The opt-in privacy rules, from the connector's side
// ---------------------------------------------------------------------------

describe('the privacy rules are wired to the record, not only to the allowlist', () => {
  it('vetoes a direct message and a group conversation by their own id', () => {
    /**
     * `D…` is a direct message and `G…` a private or group conversation — documented provider prefixes,
     * so the connector can *prove* the conversation is not a public channel and stamps the record
     * accordingly. `isIngestibleKind` in `@compass/ingest` then drops it even if somebody managed to get
     * that conversation onto the allowlist, which is what makes the rule hold in two places.
     */
    expect(conversationKindFromKey('D04PRIVATE01')).toBe('direct_message');
    expect(conversationKindFromKey('G04GROUP0001')).toBe('group_message');
  });

  it('claims nothing about a channel id it cannot read publicness from', () => {
    /**
     * Modern private channels are allocated `C…` ids too, so reading that prefix as proof of publicness
     * would be a confident-but-wrong claim — and the wrong failure direction, because the ingest filter
     * treats a stamped `public_channel` as the connector vouching for it. Absent means "this connector
     * cannot tell", and the opt-in row, whose CHECK constraint refuses anything but a public channel,
     * stays the gate.
     */
    expect(conversationKindFromKey(ENGINEERING_CHANNEL_KEY)).toBeNull();
  });

  it('leaves conversationKind off the record for an ambiguous id rather than asserting it', async () => {
    const result = await new SlackConnector(connectorConfig()).fetchMessages(request);

    expect(result.records.length).toBeGreaterThan(0);
    for (const record of result.records) {
      expect(Object.hasOwn(record, 'conversationKind')).toBe(false);
    }
  });

  it('stamps the veto on every record when the id does prove it', async () => {
    const result = await new SlackConnector(
      connectorConfig({
        channels: [{ conversationKey: 'D04PRIVATE01', name: 'a direct message' }],
        http: {
          send: () =>
            Promise.resolve({
              status: 200,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                ok: true,
                messages: [{ type: 'message', ts: '1785337200.000200', user: PRIYA_AUTHOR_ID, text: 'private' }],
                response_metadata: { next_cursor: '' },
              }),
            } satisfies HttpResponse),
        } satisfies HttpClient,
      }),
    ).fetchMessages(request);

    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.conversationKind).toBe('direct_message');
  });

  it('declares chat as opted-in conversations, never workspace-wide', () => {
    expect(new SlackConnector(connectorConfig()).capabilities().chatScope).toBe('opted_in_conversations');
  });
});

// ---------------------------------------------------------------------------
// What the connector reads, and what it deliberately drops
// ---------------------------------------------------------------------------

describe('messages become provider-neutral records', () => {
  it('names the channel as the manager named it, not as the provider spells it', async () => {
    const result = await new SlackConnector(connectorConfig()).fetchMessages(request);
    const first = result.records.find((record) => record.conversationKey === ENGINEERING_CHANNEL_KEY);

    expect(first?.conversationName).toBe(ENGINEERING_CHANNEL_NAME);
  });

  it('resolves an author to a handle with the display name beside it', async () => {
    const result = await new SlackConnector(connectorConfig()).fetchMessages(request);
    const priya = result.records.find((record) => record.authorIdentity.value === 'priya');

    expect(priya?.authorIdentity.kind).toBe('handle');
    expect(priya?.authorIdentity.displayName).toBe('Priya Raman');
  });

  it('keeps a post with no author as an honest unknown rather than discarding the sentence', async () => {
    const result = await new SlackConnector(connectorConfig()).fetchMessages(request);
    const notice = result.records.find((record) => record.conversationKey === RELEASES_CHANNEL_KEY);

    expect(notice?.authorIdentity.value).toBe('unknown');
    expect(notice?.body).toContain('Released v2.14');
  });

  it('reads the tracker keys the prose names', async () => {
    const result = await new SlackConnector(connectorConfig()).fetchMessages(request);
    const reply = result.records.find((record) => record.body.includes('raised it with infra'));

    expect(reply?.referencedItemKeys).toEqual(['OPS-88']);
  });

  it('references a thread root from a reply, and never from the root itself', async () => {
    const result = await new SlackConnector(connectorConfig()).fetchMessages(request);
    const root = result.records.find((record) => record.body.includes('still waiting on the staging key'));
    const reply = result.records.find((record) => record.body.includes('raised it with infra'));

    // A root carries its own timestamp as `thread_ts`; that is not a reference to a parent.
    expect(root?.threadRef).toBeNull();
    expect(reply?.threadRef).toBe(`1785337200.${'000200'}`);
  });

  it('drops housekeeping rather than retaining it as conversation', async () => {
    // Chat is the one family Compass stores verbatim, so "has joined the channel" would be retained text
    // that no report could ever use.
    const result = await new SlackConnector(connectorConfig()).fetchMessages(request);

    expect(result.records.some((record) => record.body.includes('has joined the channel'))).toBe(false);
  });

  it('drops a message the inclusive provider bound returned from before the window', async () => {
    /**
     * The provider's `oldest` is inclusive and the connector pads it by a second, so this message *is*
     * returned by the API. It is the window filter here — not the query — that keeps it out, which is
     * precisely the property the contract's partition assertion rests on.
     */
    const result = await new SlackConnector(connectorConfig()).fetchMessages(request);

    expect(result.records.some((record) => record.body.includes('before this window opened'))).toBe(false);
  });

  it('drops a message sitting exactly on window.end, because the window is half-open', async () => {
    const result = await new SlackConnector(connectorConfig()).fetchMessages(request);

    expect(result.records.some((record) => record.body.includes('on the boundary'))).toBe(false);
  });

  it('namespaces a record id by its conversation, so two channels cannot collide', async () => {
    const result = await new SlackConnector(connectorConfig()).fetchMessages(request);

    for (const record of result.records) {
      expect(record.sourceRecordId.startsWith(`${record.conversationKey}:`)).toBe(true);
    }
    expect(new Set(result.records.map((record) => record.sourceRecordId)).size).toBe(result.records.length);
  });

  it('follows pagination to exhaustion inside one call', async () => {
    /**
     * The recording splits the engineering channel's window across two pages. A connector that stopped
     * after the first would lose the second half of the day and report the remainder as complete — and
     * the loss would be invisible, because a short answer looks exactly like a quiet afternoon.
     */
    const result = await new SlackConnector(connectorConfig()).fetchMessages(request);

    expect(result.records.some((record) => record.body.includes('unblocked, the key landed'))).toBe(true);
    expect(result.status).toBe('complete');
  });
});

// ---------------------------------------------------------------------------
// The rate-limit criterion, including this provider's own way of signalling it
// ---------------------------------------------------------------------------

describe('a throttle becomes a stated coverage gap, not a quiet empty day', () => {
  it('reports unavailable coverage naming the source and the reason', async () => {
    const connector = new SlackConnector(
      connectorConfig({ http: new ThrottledHttpClient(recordedClient(), /conversations\.history/) }),
    );

    const result = await connector.fetchMessages(request);

    expect(result.status).toBe('unavailable');
    const coverage = result.coverage.find((entry) => entry.sourceKey === SOURCE_KEY);
    expect(coverage?.reason).toBe('rate_limited');
    // The contract requires the sentence to name its own source, because the freshness panel shows it
    // to a manager as-is.
    expect(coverage?.detail).toContain(SOURCE_KEY);
    expect(coverage?.coveredWindow, 'nothing was covered, so the covered window must be null').toBeNull();
  });

  it('returns no records rather than the page it managed to read', async () => {
    /**
     * The criterion is "rather than reporting on partial data as complete". Returning the first page with
     * a `complete` count is exactly that failure: a number that is arithmetically wrong and
     * typographically confident.
     */
    const result = await new SlackConnector(
      connectorConfig({ http: new ThrottledHttpClient(recordedClient(), /cursor=/) }),
    ).fetchMessages(request);

    expect(result.records).toEqual([]);
    expect(result.coverage.every((entry) => entry.recordCount === 0)).toBe(true);
  });

  it('reads a throttle this provider signals as HTTP 200 with ok:false', async () => {
    /**
     * The failure mode unique to this provider, and the one a connector written against the status code
     * alone would get wrong in the worst possible direction: `{"ok":false,"error":"ratelimited"}` arrives
     * as a **200**, so it would be parsed as a successful day with no messages. A stated gap becomes a
     * confident silence, which is the exact thing the criterion forbids, reached through the back door.
     */
    const alwaysThrottledEnvelope: HttpClient = {
      send: () =>
        Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ok: false, error: 'ratelimited' }),
        }),
    };

    const result = await new SlackConnector(
      connectorConfig({ http: alwaysThrottledEnvelope }),
    ).fetchMessages(request);

    expect(result.status).toBe('unavailable');
    expect(result.records).toEqual([]);
    expect(result.coverage[0]?.reason).toBe('rate_limited');
  });

  it.each([
    ['invalid_auth', 'authentication_failed'],
    ['missing_scope', 'permission_denied'],
    ['not_in_channel', 'permission_denied'],
    ['some_new_error', 'provider_error'],
  ])('maps the ok:false error %s to the coverage reason %s', async (error, reason) => {
    const client: HttpClient = {
      send: () =>
        Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ok: false, error }),
        }),
    };

    const result = await new SlackConnector(connectorConfig({ http: client })).fetchMessages(request);

    expect(result.coverage[0]?.reason).toBe(reason);
    expect(result.coverage[0]?.detail).toContain(SOURCE_KEY);
  });

  it('says so in the health report the freshness indicator reads', async () => {
    const health = await new SlackConnector(
      connectorConfig({ http: new ThrottledHttpClient(recordedClient(), /conversations\.history/) }),
    ).reportSourceHealth(request);

    expect(health.overall).not.toBe('complete');
    const entry = health.sources.find((source) => source.sourceKey === SOURCE_KEY);
    expect(entry?.status).toBe('unavailable');
    expect(entry?.reason).toBe('rate_limited');
  });

  it('states an unreadable channel as something a manager can act on', async () => {
    // `not_in_channel` is the single most common real failure: the channel was named before Compass was
    // invited to it. The sentence has to say that, because the freshness panel shows it verbatim.
    const client: HttpClient = {
      send: () =>
        Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ok: false, error: 'not_in_channel' }),
        }),
    };

    const health = await new SlackConnector(connectorConfig({ http: client })).reportSourceHealth(request);

    expect(health.sources[0]?.detail).toContain('Invite Compass to that channel');
  });

  it('does not fabricate a freshness timestamp when it has no journal', async () => {
    // The panel's rule: no invented "last updated". This connector holds no journal, so it reports null
    // and lets the ingest journal be the single source of that fact.
    const health = await new SlackConnector(connectorConfig()).reportSourceHealth(request);

    expect(health.sources[0]?.lastObservedAt).toBeNull();
  });
});
