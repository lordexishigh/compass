import { instantFromEpochMillis, toEpochMillis, windowContains, type Instant } from '@compass/clock';
import {
  ARTIFACT_SOURCE_KIND,
  completeCoverage,
  connectorResult,
  isAuthFailure,
  isRateLimited,
  sortRecords,
  unavailableCoverage,
  worstCoverageStatus,
  type ArtifactKind,
  type BranchRefRecord,
  type CommitRecord,
  type ConnectorCapabilities,
  type ConnectorPort,
  type ConnectorRequest,
  type ConnectorResult,
  type ConversationKind,
  type CoverageReason,
  type ExternalIdentity,
  type HttpClient,
  type HttpResponse,
  type IssueRecord,
  type IssueTransitionRecord,
  type MessageRecord,
  type PullRequestRecord,
  type ReleaseTagRecord,
  type ReviewRecord,
  type SourceCoverage,
  type SourceHealthEntry,
  type SourceHealthReport,
  type SprintRecord,
  type SprintScopeChangeRecord,
} from '@compass/connector-port';

/**
 * A live chat connector, behind the port every other provider implements.
 *
 * ## The whole point of this file
 *
 * It passes `describeConnectorContract` **unmodified** — the same function the seeded provider, the code
 * host and the tracker all run. That is the architectural claim the port was built to make good on: the
 * layers above cannot tell this from the seeded provider, so swapping one for the other is configuration
 * and nothing else.
 *
 * ## Chat is the family with the extra rule
 *
 * Every other artifact family is projected into a typed entity and the original text is discarded. A
 * message's value *is* its prose, so a message Compass has read is a message Compass is holding — and
 * that is exactly what a team reading over their manager's shoulder worries about. So this connector is
 * scoped in a way the other two are not:
 *
 *  - **It reads named conversations and nothing else.** The channel list is configuration, an empty list
 *    is refused outright (`EmptyChannelSelectionError`), and there is no code path that asks the
 *    provider which channels exist. `channels:read` is not requested, so there is not even a credential
 *    that could enumerate them — see `scopes.ts`.
 *  - **It vetoes what it can prove is not a public channel.** `conversationKind` is stamped from the
 *    conversation id's own prefix, which is a documented provider property: `D…` is a direct message and
 *    `G…` is a private or group conversation. A `C…` prefix is *ambiguous* — modern private channels get
 *    one too — so the field is left **absent** there rather than asserted as public. That is the honest
 *    shape and the port asks for exactly it: a connector that cannot tell leaves it off and lets the
 *    opt-in table, whose CHECK constraint refuses to enable anything but a public channel, be the gate.
 *    Defaulting to `public_channel` would mean a provider change silently started looking like consent.
 *
 * ## Three properties the contract demands that a naive live client would fail
 *
 * 1. **Idempotence, including across fresh instances.** No cursor, no cache and no mutable state on the
 *    instance: every call re-derives its answer, and pagination is followed to exhaustion *inside* one
 *    call rather than remembered between them.
 * 2. **Half-open `[start, end)` windowing, partitioning exactly.** `oldest` and `latest` are inclusive
 *    at the provider, so the API window is only ever a coarse prefilter and the authoritative filter is
 *    `windowContains` applied here. Without that a message landing exactly on `window.end` would be
 *    returned by two abutting windows and the partition property would fail.
 * 3. **Unavailability as coverage, never a throw.** A throttle becomes an `unavailable` coverage record
 *    naming the source and the reason, so the report states a gap rather than presenting the remainder
 *    as a complete picture.
 *
 * ## The failure mode unique to this provider
 *
 * Slack answers **HTTP 200 with `ok: false`** for most errors, including throttling. A connector that
 * only looked at the status code would read `{"ok":false,"error":"ratelimited"}` as a successful empty
 * day — the exact "reporting on partial data as complete" the criterion forbids, arrived at through the
 * back door. So `#failureFor` reads the status *and* the envelope, and `#outcomeFor` is the single place
 * both become a stated coverage reason.
 *
 * ## Provider vocabulary stops at this file
 *
 * The suite runs `findProviderVocabularyViolations` over every record, and the banned list includes
 * `slack`, `ts`, `threadts` and `channelid`. So a message's conversation is `conversationKey`, its
 * thread is `threadRef`, and the provider's own words appear only as *values*, as URL fragments and as
 * local variables — never as a field name that could reach the knowledge model.
 */

/** One configured conversation, as a manager named it on the connect screen. */
export interface SlackChannel {
  /**
   * The conversation's own opaque id, e.g. `C04AB12CD34`. The only thing ever sent to the provider.
   *
   * An id rather than a name because a channel can be renamed and Compass must keep reading the same
   * conversation across the rename — the alternative silently stops reading, which is the failure a
   * manager would not notice for a week.
   */
  readonly conversationKey: string;
  /**
   * The display name a manager knows the channel by, e.g. `#checkout-eng`.
   *
   * Configuration rather than a lookup, because looking it up would mean `channels:read`, and
   * `channels:read` is the scope that turns a channel-scoped connector into one that can enumerate the
   * workspace. A name a manager typed is also the name they will recognise in the report.
   */
  readonly name: string;
}

export interface SlackConnectorConfig {
  /** The configured source this connector answers as, e.g. `primary-chat`. */
  readonly sourceKey: string;
  /**
   * The conversations to read, and the only ones that will ever be requested.
   *
   * An empty list is a configuration error rather than "read everything the bot is in": the whole point
   * of per-channel scoping is that Compass reads what it was pointed at. See
   * `EmptyChannelSelectionError`.
   */
  readonly channels: readonly SlackChannel[];
  /** The bot access token. Resolved by the composition root; never read from env here. */
  readonly botToken: string;
  readonly http: HttpClient;
  /** Overridable so a test can point at a recorded host. */
  readonly apiBaseUrl?: string;
}

export class EmptyChannelSelectionError extends Error {
  constructor() {
    super(
      'The chat connector was configured with no channels. That is refused rather than treated as ' +
        '"every channel the bot can see": chat is the one family Compass keeps verbatim, so an unscoped ' +
        'read would mean holding the text of conversations nobody offered it, and a manager who named no ' +
        'channel has not consented to anything.',
    );
    this.name = 'EmptyChannelSelectionError';
  }
}

export const SLACK_CONNECTOR_ID = 'chat:slack-app-v1';
const DEFAULT_API_BASE_URL = 'https://slack.com/api';

/** The one artifact a chat source can answer. The nine it cannot are reported as absent capability. */
const SUPPORTED: Readonly<Record<ArtifactKind, boolean>> = Object.freeze({
  commits: false,
  pull_requests: false,
  reviews: false,
  branch_refs: false,
  release_tags: false,
  issues: false,
  issue_transitions: false,
  sprints: false,
  sprint_scope_changes: false,
  messages: true,
});

/** Tracker keys referenced in prose, e.g. `DEV-501`. Opaque to Compass; only ever compared. */
const WORK_ITEM_KEY_PATTERN = /\b[A-Z][A-Z0-9]+-\d+\b/g;

/**
 * Returns a mutable array on purpose: the port's record schemas infer `string[]`, so a
 * `readonly string[]` here would not assign to `referencedItemKeys`. Sorted and de-duplicated so two
 * runs over the same prose produce the same list, which the contract's idempotence assertion requires.
 */
const workItemKeysIn = (body: string): string[] =>
  [...new Set(body.match(WORK_ITEM_KEY_PATTERN) ?? [])].sort();

/**
 * Message subtypes that are housekeeping rather than conversation.
 *
 * Dropped because storing them would be storing the wrong thing twice over: a "Priya joined the
 * channel" line is not prose a manager needs, and chat is the family Compass retains verbatim, so every
 * stored row is a row retention has to carry and a team has to be comfortable with. Everything else —
 * including `bot_message`, because a deploy bot's notice is often the only place a release is stated —
 * is kept.
 */
const HOUSEKEEPING_SUBTYPES: ReadonlySet<string> = new Set([
  'channel_join',
  'channel_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'channel_archive',
  'channel_unarchive',
  'channel_convert_to_private',
  'channel_convert_to_public',
  'group_join',
  'group_leave',
  'pinned_item',
  'unpinned_item',
]);

/**
 * The conversation kind an id prefix *proves*, or null when it proves nothing.
 *
 * `D` is a direct message and `G` a private or group conversation; both are documented provider
 * prefixes and both are a veto. `C` is deliberately not mapped to `public_channel`: modern private
 * channels are allocated `C` ids too, so reading it as proof of publicness would be exactly the
 * confident-but-wrong claim the port's comment warns against. Null there means "this connector cannot
 * tell", the opt-in row stays the gate, and nothing is asserted that is not known.
 */
export function conversationKindFromKey(conversationKey: string): ConversationKind | null {
  const prefix = conversationKey.charAt(0).toUpperCase();
  if (prefix === 'D') return 'direct_message';
  if (prefix === 'G') return 'group_message';
  return null;
}

/**
 * A person as the chat provider knows them, which is a handle — never an address.
 *
 * `users:read` does not carry email; that needs `users:read.email`, which is on the forbidden list. So
 * the identity is a handle, and identity *resolution* is the roster's job: a connector that guessed
 * would attribute one person's words to another.
 */
const identityFrom = (input: {
  readonly handle?: unknown;
  readonly displayName?: unknown;
}): ExternalIdentity => {
  const handle = typeof input.handle === 'string' && input.handle.length > 0 ? input.handle : null;
  const displayName =
    typeof input.displayName === 'string' && input.displayName.length > 0 ? input.displayName : null;

  // An anonymous author is a real state: a message posted by an app with no user behind it.
  return { kind: 'handle', value: handle ?? 'unknown', displayName };
};

/**
 * A provider timestamp, which is epoch **seconds** with a six-digit fraction.
 *
 * Formatted rather than interpolated so the URL sequence is byte-identical on every run — a replayed
 * fixture keys on the exact URL, and a client whose query string varied with formatting would make the
 * recording untestable.
 */
const providerTimestamp = (instant: Instant): string => {
  const millis = toEpochMillis(instant);
  const seconds = Math.floor(millis / 1000);
  const micros = (millis - seconds * 1000) * 1000;
  return `${seconds}.${String(micros).padStart(6, '0')}`;
};

/** The inverse, to whole milliseconds, which is what an `Instant` is. */
const instantFromProviderTimestamp = (value: unknown): Instant | null => {
  if (typeof value !== 'string' || value.length === 0) return null;
  const seconds = Number.parseFloat(value);
  if (!Number.isFinite(seconds)) return null;
  return instantFromEpochMillis(Math.round(seconds * 1000));
};

/** What one conversation read produced, plus whether it was complete. */
interface ChannelOutcome<TRecord> {
  readonly records: readonly TRecord[];
  readonly failure: { readonly reason: CoverageReason; readonly detail: string } | null;
}

const ok = <TRecord>(records: readonly TRecord[]): ChannelOutcome<TRecord> => ({ records, failure: null });

/**
 * How far *before* the window the coarse provider bound is set.
 *
 * One second, and the margin is not padding for its own sake: `oldest` and `latest` are *inclusive*
 * bounds at the provider, so a prefilter set exactly at `window.start` risks dropping a message that
 * belongs in the window on a boundary rounding. A prefilter that is too narrow silently loses data; one
 * that is too wide costs a marginally larger response and is then corrected exactly by `windowContains`.
 * Epoch seconds carry no timezone ambiguity, so a second is all this needs — unlike the tracker's day.
 */
const PREFILTER_MARGIN_MS = 1000;

/** The provider's maximum page for a history read; a smaller page only means more round trips. */
const PAGE_SIZE = 200;

/**
 * The pagination stop. 20 pages of 200 is 4,000 messages for one conversation in one window.
 *
 * A bound rather than an unbounded loop because a paginating client with an off-by-one in its
 * termination check does not fail, it hangs — and a connector that hangs takes the whole ingest tick
 * with it. Reaching this limit in a one-day window means something is wrong with the query.
 */
const MAX_PAGES = 20;

/** The envelope every method answers with, successful or not. */
interface ProviderEnvelope {
  readonly ok?: unknown;
  readonly error?: unknown;
  readonly response_metadata?: { readonly next_cursor?: unknown };
}

export class SlackConnector implements ConnectorPort {
  readonly connectorId = SLACK_CONNECTOR_ID;
  readonly #config: SlackConnectorConfig;
  readonly #baseUrl: string;

  constructor(config: SlackConnectorConfig) {
    if (config.channels.length === 0) throw new EmptyChannelSelectionError();
    this.#config = config;
    this.#baseUrl = (config.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, '');
  }

  capabilities(): ConnectorCapabilities {
    return {
      connectorId: this.connectorId,
      artifacts: SUPPORTED,
      deploySignal: false,
      // The port's own word for it, and the only value this connector could honestly return: there is
      // no credential here that could read a conversation nobody named.
      chatScope: 'opted_in_conversations',
      sources: [{ sourceKey: this.#config.sourceKey, sourceKind: 'chat' }],
    };
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  async #get(pathWithQuery: string): Promise<HttpResponse> {
    return await this.#config.http.send({
      method: 'GET',
      url: `${this.#baseUrl}${pathWithQuery}`,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${this.#config.botToken}`,
      },
    });
  }

  /**
   * Turns a response into the coverage reason a manager will read, or null when it is fine.
   *
   * Reads the **status and the envelope**, because this provider signals almost everything as HTTP 200
   * with `ok: false` — including throttling. Every caller funnels through here so no endpoint can grow
   * its own idea of what a throttle means.
   */
  #failureFor(response: HttpResponse): ChannelOutcome<never>['failure'] {
    const { sourceKey } = this.#config;

    if (isRateLimited(response)) {
      const retryAfter = response.headers['retry-after'];
      return {
        reason: 'rate_limited',
        detail:
          `${sourceKey} was rate limited by the chat provider, so none of this window was read` +
          (retryAfter === undefined ? '.' : `; it asked Compass to wait ${retryAfter} seconds.`),
      };
    }

    if (isAuthFailure(response)) {
      return {
        reason: response.status === 401 ? 'authentication_failed' : 'permission_denied',
        detail:
          `${sourceKey} refused the stored credential (HTTP ${response.status}). Reconnect the chat ` +
          'provider; Compass will not report on a partial read as though it were complete.',
      };
    }

    if (response.status !== 200) {
      return {
        reason: 'provider_error',
        detail: `${sourceKey} answered HTTP ${response.status}, so this window was not read.`,
      };
    }

    let envelope: ProviderEnvelope;
    try {
      envelope = JSON.parse(response.body) as ProviderEnvelope;
    } catch {
      return {
        reason: 'provider_error',
        detail: `${sourceKey} answered with a body Compass could not read, so this window was not read.`,
      };
    }

    if (envelope.ok === true) return null;

    return this.#envelopeFailure(typeof envelope.error === 'string' ? envelope.error : 'unknown');
  }

  /**
   * A 200-with-`ok:false` mapped to a stated reason.
   *
   * Split out from `#failureFor` because this is the mapping most worth reading on its own: it is where
   * the provider's quirk stops being a quirk. Each sentence is what the freshness panel shows verbatim,
   * so each one says what a manager can *do* — reconnect, invite the bot, wait.
   */
  #envelopeFailure(error: string): NonNullable<ChannelOutcome<never>['failure']> {
    const { sourceKey } = this.#config;

    if (error === 'ratelimited' || error === 'rate_limited') {
      return {
        reason: 'rate_limited',
        detail: `${sourceKey} was rate limited by the chat provider, so none of this window was read.`,
      };
    }

    if (error === 'invalid_auth' || error === 'not_authed' || error === 'token_revoked' || error === 'account_inactive') {
      return {
        reason: 'authentication_failed',
        detail:
          `${sourceKey} refused the stored credential (${error}). Reconnect the chat provider; Compass ` +
          'will not report on a partial read as though it were complete.',
      };
    }

    if (error === 'missing_scope' || error === 'not_allowed_token_type') {
      return {
        reason: 'permission_denied',
        detail:
          `${sourceKey} declined the read (${error}), which means the install is missing a permission it ` +
          'was granted at consent. Reconnect the chat provider to grant it again.',
      };
    }

    if (error === 'not_in_channel' || error === 'channel_not_found' || error === 'is_archived') {
      return {
        reason: 'permission_denied',
        detail:
          `${sourceKey} could not read a named channel (${error}). Invite Compass to that channel, or ` +
          'remove it from the selection — an unread channel is stated here rather than reported as quiet.',
      };
    }

    return {
      reason: 'provider_error',
      detail: `${sourceKey} answered "${error}", so this window was not read.`,
    };
  }

  /**
   * A paginated collection, followed to exhaustion inside one call.
   *
   * The cursor comes from the response rather than from instance state, so a fresh connector walks the
   * identical URL sequence — which is what the contract's "holds no cursor state" property demands, and
   * what lets a recorded fixture key on the sequence at all.
   */
  async #collect(
    method: string,
    query: string,
    key: string,
  ): Promise<{ readonly rows: readonly unknown[]; readonly failure: ChannelOutcome<never>['failure'] }> {
    const rows: unknown[] = [];
    let cursor: string | null = null;

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const withCursor = cursor === null ? query : `${query}&cursor=${encodeURIComponent(cursor)}`;
      const response = await this.#get(`/${method}?${withCursor}`);

      const failure = this.#failureFor(response);
      if (failure !== null) return { rows, failure };

      const envelope = JSON.parse(response.body) as ProviderEnvelope & Record<string, unknown>;
      const pageRows = envelope[key];
      if (Array.isArray(pageRows)) rows.push(...pageRows);

      const next = envelope.response_metadata?.next_cursor;
      // An empty string is how this provider says "no more pages" — it is present but blank, so a
      // truthiness check on presence alone would loop until MAX_PAGES on every read.
      cursor = typeof next === 'string' && next.length > 0 ? next : null;
      if (cursor === null) break;
    }

    return { rows, failure: null };
  }

  // -------------------------------------------------------------------------
  // The shared shape of every fetch method
  // -------------------------------------------------------------------------

  /**
   * Runs a per-conversation read and assembles the one coverage record the contract requires.
   *
   * Coverage is per *source*, not per conversation: a manager configures "chat" and wants to know
   * whether to trust it today, not which of four channels answered. So the worst outcome across the
   * named conversations decides the source's status, and the failing conversation's own sentence is what
   * gets shown.
   */
  async #answer<TRecord>(
    artifact: ArtifactKind,
    request: ConnectorRequest,
    read: (channel: SlackChannel) => Promise<ChannelOutcome<TRecord>>,
  ): Promise<ConnectorResult<TRecord>> {
    const { sourceKey } = this.#config;
    const sourceKind = ARTIFACT_SOURCE_KIND[artifact];

    // `sourceKeys` restricts the query to named sources. This connector is one source, so a request
    // naming others has nothing to do with it — and must still answer with coverage, not silence.
    if (request.sourceKeys !== undefined && !request.sourceKeys.includes(sourceKey)) {
      return connectorResult(artifact, request.window, [], []);
    }

    if (!SUPPORTED[artifact]) {
      return connectorResult(artifact, request.window, [], [
        unavailableCoverage({
          sourceKey,
          sourceKind,
          artifact,
          requestedWindow: request.window,
          observedAt: request.now,
          reason: 'capability_absent',
          detail:
            `${sourceKey} is a chat source and cannot answer for ${artifact.replace(/_/g, ' ')}. This is ` +
            'an absent capability, not an empty day — the report says so rather than implying nothing ' +
            'happened.',
        }),
      ]);
    }

    const collected: TRecord[] = [];
    let failure: ChannelOutcome<never>['failure'] = null;

    for (const channel of this.#config.channels) {
      const outcome = await read(channel);
      collected.push(...outcome.records);
      // First failure wins the sentence: a manager needs one actionable reason, not four.
      if (outcome.failure !== null && failure === null) failure = outcome.failure;
    }

    if (failure !== null) {
      // Records already read are deliberately discarded. A partial read presented with a `complete`
      // count is exactly the "reporting on partial data as complete" the criterion forbids.
      return connectorResult(artifact, request.window, [], [
        unavailableCoverage({
          sourceKey,
          sourceKind,
          artifact,
          requestedWindow: request.window,
          observedAt: request.now,
          reason: failure.reason,
          detail: failure.detail,
        }),
      ]);
    }

    // The authoritative window filter, applied here rather than trusted from the API. See the class
    // comment: the provider's bounds are inclusive and only ever a prefilter.
    const inWindow = collected.filter((record) =>
      windowContains(request.window, (record as { readonly occurredAt: Instant }).occurredAt),
    );
    const ordered = sortRecords(inWindow as never) as readonly TRecord[];

    return connectorResult(artifact, request.window, ordered, [
      completeCoverage({
        sourceKey,
        sourceKind,
        artifact,
        requestedWindow: request.window,
        observedAt: request.now,
        recordCount: ordered.length,
      }),
    ]);
  }

  // -------------------------------------------------------------------------
  // The ten port methods
  // -------------------------------------------------------------------------

  /**
   * Messages from the named conversations, with their authors resolved to handles.
   *
   * The author lookup is memoised **per call** in a local map. Per call and not on the instance,
   * deliberately: a cache held across calls would make a fresh connector issue a different sequence of
   * requests from a warm one, which the contract's "holds no cursor state" property forbids and which
   * would make the replay fixture depend on call order.
   */
  async fetchMessages(request: ConnectorRequest): Promise<ConnectorResult<MessageRecord>> {
    const oldest = providerTimestamp(
      instantFromEpochMillis(toEpochMillis(request.window.start) - PREFILTER_MARGIN_MS),
    );
    const latest = providerTimestamp(request.window.end);
    const handles = new Map<string, ExternalIdentity>();

    return await this.#answer('messages', request, async (channel) => {
      const listed = await this.#collect(
        'conversations.history',
        `channel=${encodeURIComponent(channel.conversationKey)}&oldest=${oldest}&latest=${latest}` +
          `&inclusive=true&limit=${PAGE_SIZE}`,
        'messages',
      );
      if (listed.failure !== null) return { records: [], failure: listed.failure };

      const conversationKind = conversationKindFromKey(channel.conversationKey);
      const records: MessageRecord[] = [];

      for (const row of listed.rows) {
        const message = row as {
          ts?: unknown;
          user?: unknown;
          text?: unknown;
          subtype?: unknown;
          thread_ts?: unknown;
        };

        const postedAt = instantFromProviderTimestamp(message.ts);
        const recordId = typeof message.ts === 'string' ? message.ts : null;
        if (postedAt === null || recordId === null) continue;
        if (typeof message.subtype === 'string' && HOUSEKEEPING_SUBTYPES.has(message.subtype)) continue;

        const authorId = typeof message.user === 'string' && message.user.length > 0 ? message.user : null;
        let authorIdentity = identityFrom({});
        if (authorId !== null) {
          const cached = handles.get(authorId);
          if (cached !== undefined) authorIdentity = cached;
          else {
            const looked = await this.#lookUpAuthor(authorId);
            if (looked.failure !== null) return { records: [], failure: looked.failure };
            handles.set(authorId, looked.identity);
            authorIdentity = looked.identity;
          }
        }

        const body = typeof message.text === 'string' ? message.text : '';
        const threadRoot = typeof message.thread_ts === 'string' ? message.thread_ts : null;

        records.push({
          sourceKey: this.#config.sourceKey,
          sourceKind: 'chat',
          // Namespaced by conversation: the provider's timestamp is unique within a conversation but
          // not across them, and `recordIdentity` has to be unique across the whole result.
          sourceRecordId: `${channel.conversationKey}:${recordId}`,
          occurredAt: postedAt,
          conversationKey: channel.conversationKey,
          // The name a manager typed, not one read back from the provider. See `SlackChannel.name`.
          conversationName: channel.name,
          // Only when the id proves it. Absent means "this connector cannot tell", which is what the
          // port asks for — see the class comment.
          ...(conversationKind === null ? {} : { conversationKind }),
          authorIdentity,
          body,
          // A thread root carries its own ts as `thread_ts`; that is not a reference to a parent, so it
          // is normalised to null. A reply carries the root's, which is the reference.
          threadRef: threadRoot === null || threadRoot === recordId ? null : threadRoot,
          referencedItemKeys: workItemKeysIn(body),
          postedAt,
        });
      }

      return ok(records);
    });
  }

  /**
   * One author, resolved to a handle.
   *
   * A failure here fails the whole conversation read rather than falling back to `unknown`: an identity
   * silently degraded to "unknown" is how one person's words end up attributed to nobody, and the
   * honest answer when the provider will not say who somebody is is a stated coverage gap.
   */
  async #lookUpAuthor(
    authorId: string,
  ): Promise<{ readonly identity: ExternalIdentity; readonly failure: ChannelOutcome<never>['failure'] }> {
    const response = await this.#get(`/users.info?user=${encodeURIComponent(authorId)}`);
    const failure = this.#failureFor(response);
    if (failure !== null) return { identity: identityFrom({}), failure };

    const envelope = JSON.parse(response.body) as {
      user?: { name?: unknown; profile?: { real_name?: unknown; display_name?: unknown } };
    };

    return {
      identity: identityFrom({
        handle: envelope.user?.name,
        displayName: envelope.user?.profile?.real_name ?? envelope.user?.profile?.display_name,
      }),
      failure: null,
    };
  }

  // The nine a chat source cannot answer. Each reports absent capability rather than an empty day; the
  // shared `#answer` does that from the `SUPPORTED` table, so there is one statement of it, not nine.
  async fetchCommits(request: ConnectorRequest): Promise<ConnectorResult<CommitRecord>> {
    return await this.#answer('commits', request, async () => ok<CommitRecord>([]));
  }

  async fetchPullRequests(request: ConnectorRequest): Promise<ConnectorResult<PullRequestRecord>> {
    return await this.#answer('pull_requests', request, async () => ok<PullRequestRecord>([]));
  }

  async fetchReviews(request: ConnectorRequest): Promise<ConnectorResult<ReviewRecord>> {
    return await this.#answer('reviews', request, async () => ok<ReviewRecord>([]));
  }

  async fetchBranchRefs(request: ConnectorRequest): Promise<ConnectorResult<BranchRefRecord>> {
    return await this.#answer('branch_refs', request, async () => ok<BranchRefRecord>([]));
  }

  async fetchReleaseTags(request: ConnectorRequest): Promise<ConnectorResult<ReleaseTagRecord>> {
    return await this.#answer('release_tags', request, async () => ok<ReleaseTagRecord>([]));
  }

  async fetchIssues(request: ConnectorRequest): Promise<ConnectorResult<IssueRecord>> {
    return await this.#answer('issues', request, async () => ok<IssueRecord>([]));
  }

  async fetchIssueTransitions(request: ConnectorRequest): Promise<ConnectorResult<IssueTransitionRecord>> {
    return await this.#answer('issue_transitions', request, async () => ok<IssueTransitionRecord>([]));
  }

  async fetchSprints(request: ConnectorRequest): Promise<ConnectorResult<SprintRecord>> {
    return await this.#answer('sprints', request, async () => ok<SprintRecord>([]));
  }

  async fetchSprintScopeChanges(request: ConnectorRequest): Promise<ConnectorResult<SprintScopeChangeRecord>> {
    return await this.#answer('sprint_scope_changes', request, async () => ok<SprintScopeChangeRecord>([]));
  }

  /**
   * Per-source health for the freshness indicator.
   *
   * Derived from the same read the report is built from — a one-message probe per named conversation —
   * so the panel cannot claim chat is healthy while the report beside it was generated from a throttled
   * window. The probe is `limit=1` rather than the window query because health is a question about
   * *reachability*, and re-reading a day of messages to answer it would double the cost of every page
   * that shows the panel.
   */
  async reportSourceHealth(request: ConnectorRequest): Promise<SourceHealthReport> {
    const result = await this.#answer('messages', request, async (channel) => {
      const probe = await this.#get(
        `/conversations.history?channel=${encodeURIComponent(channel.conversationKey)}&limit=1`,
      );
      const failure = this.#failureFor(probe);
      return failure === null ? ok<never>([]) : { records: [], failure };
    });

    const coverage: readonly SourceCoverage[] = result.coverage;
    const status = worstCoverageStatus(coverage.map((entry) => entry.status));
    const degraded = coverage.find((entry) => entry.status !== 'complete');

    const entry: SourceHealthEntry = {
      sourceKey: this.#config.sourceKey,
      sourceKind: 'chat',
      status,
      reason: degraded?.reason ?? 'ok',
      detail:
        degraded?.detail ??
        `${this.#config.sourceKey} answered for ${this.#config.channels.length} named ` +
          `${this.#config.channels.length === 1 ? 'channel' : 'channels'}.`,
      // Null rather than `now`: this connector holds no journal, and stamping the request instant here
      // would tell a manager the data is fresh when what is fresh is the page.
      lastObservedAt: null,
    };

    return {
      connectorId: this.connectorId,
      window: request.window,
      observedAt: request.now,
      overall: status,
      sources: [entry],
    };
  }
}
