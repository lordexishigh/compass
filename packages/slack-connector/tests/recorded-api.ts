import { instantFromIso, timeWindow, type Instant, type TimeWindow } from '@compass/clock';
import { jsonResponse, ReplayHttpClient } from '@compass/connector-port/testkit';
import type { HttpResponse } from '@compass/connector-port';

/**
 * A recorded conversation with the chat provider, shaped exactly as the real API answers.
 *
 * ## Why the conformance suite is run against a recording
 *
 * `describeConnectorContract` requires that two identical requests be **deeply equal** and that a
 * *fresh* connector answer identically. Against a live API neither can hold: a channel gains a message
 * between two calls and the suite fails for a reason that says nothing about the connector. So the
 * contract is proven against a recording, which is precisely what lets the suite run *unchanged* against
 * a provider that has a network in production.
 *
 * The bodies below are the real response shapes — an `ok` envelope, `ts` as epoch seconds with a
 * six-digit fraction, `thread_ts` on a reply, `response_metadata.next_cursor` for pagination — because a
 * fixture in a shape the provider does not produce proves the mapping compiles and nothing more.
 *
 * ## What the recording deliberately includes
 *
 * Three messages that must be *dropped*, each for a different reason, because the connector's whole job
 * is the filtering and a fixture of only-valid rows would prove none of it:
 *
 *  - `OUT_OF_WINDOW` sits half a second **before** `window.start` and the provider returns it anyway —
 *    `oldest` is an inclusive bound and the prefilter carries a one-second margin. It is what proves
 *    `windowContains` is the authoritative filter rather than the query.
 *  - `AT_WINDOW_END` sits exactly **on** `window.end`. Half-open `[start, end)` means it belongs to the
 *    *next* window; a connector that kept it would have two abutting windows both claiming it, and the
 *    partition property would fail.
 *  - `HOUSEKEEPING` is a `channel_join`. Chat is the one family Compass stores verbatim, so a "Priya
 *    joined the channel" row would be retained text that is not conversation.
 */

export const ORGANIZATION_ID = '66666666-6666-4666-8666-666666666666';
export const SOURCE_KEY = 'primary-chat';

/** The two conversations a manager named. Nothing else may ever be requested. */
export const ENGINEERING_CHANNEL_KEY = 'C04AB12CD34';
export const ENGINEERING_CHANNEL_NAME = '#checkout-eng';
export const RELEASES_CHANNEL_KEY = 'C04ZZ99YY88';
export const RELEASES_CHANNEL_NAME = '#releases';

/** A conversation nobody named, used to prove an unselected channel is never queried. */
export const UNSELECTED_CHANNEL_KEY = 'C04NOTPICKED';

/** Two days wide, so the midpoint split lands between the messages below. */
export const CONTRACT_WINDOW: TimeWindow = timeWindow(
  instantFromIso('2026-07-29T00:00:00Z'),
  instantFromIso('2026-07-31T00:00:00Z'),
);

export const NOW: Instant = instantFromIso('2026-07-31T07:30:00Z');

export const API_BASE_URL = 'https://slack.test/api';

export const PRIYA_AUTHOR_ID = 'U04PRIYA001';
export const MARCUS_AUTHOR_ID = 'U04MARCUS02';

/**
 * The provider's timestamp format: epoch seconds with a six-digit fraction.
 *
 * Written out here rather than imported from the connector on purpose. The connector formats its query
 * string with its own copy, so if the two ever disagree the replay client raises
 * `UnrecordedRequestError` and names both URLs — a loud failure that points straight at the drift.
 * Sharing one helper would instead make a formatting change invisible, because the recording would move
 * with the connector.
 */
const providerTimestamp = (iso: string): string => {
  const millis = Date.parse(iso);
  const seconds = Math.floor(millis / 1000);
  const micros = (millis - seconds * 1000) * 1000;
  return `${seconds}.${String(micros).padStart(6, '0')}`;
};

/** A message as `conversations.history` returns it. */
const message = (input: {
  readonly at: string;
  /** The fractional part, which is what makes a provider timestamp unique within a channel. */
  readonly fraction: string;
  readonly authorId?: string;
  readonly text: string;
  readonly threadRootAt?: string;
  readonly threadRootFraction?: string;
  readonly subtype?: string;
}): Record<string, unknown> => {
  const stamp = `${providerTimestamp(input.at).split('.')[0]}.${input.fraction}`;
  return {
    type: 'message',
    ts: stamp,
    ...(input.subtype === undefined ? {} : { subtype: input.subtype }),
    ...(input.authorId === undefined ? { bot_id: 'B04DEPLOYBOT' } : { user: input.authorId }),
    text: input.text,
    ...(input.threadRootAt === undefined
      ? {}
      : {
          thread_ts: `${providerTimestamp(input.threadRootAt).split('.')[0]}.${input.threadRootFraction ?? '000000'}`,
        }),
  };
};

/** Half a second before `window.start`; the inclusive `oldest` bound returns it and the filter drops it. */
const OUT_OF_WINDOW = message({
  at: '2026-07-28T23:59:59Z',
  fraction: '500000',
  authorId: PRIYA_AUTHOR_ID,
  text: 'yesterday’s thread, before this window opened',
});

/** In the first half of the split. The blocker the report quotes. */
export const FIRST_HALF_ROOT_FRACTION = '000200';
const FIRST_HALF_ROOT = message({
  at: '2026-07-29T15:00:00Z',
  fraction: FIRST_HALF_ROOT_FRACTION,
  authorId: PRIYA_AUTHOR_ID,
  text: 'DEV-501 is still waiting on the staging key — blocked until infra rotates it.',
});

/** A reply in that thread, also in the first half, carrying the root's timestamp. */
const FIRST_HALF_REPLY = message({
  at: '2026-07-29T16:12:00Z',
  fraction: '000400',
  authorId: MARCUS_AUTHOR_ID,
  text: 'raised it with infra, tracking as OPS-88',
  threadRootAt: '2026-07-29T15:00:00Z',
  threadRootFraction: FIRST_HALF_ROOT_FRACTION,
});

/** Housekeeping, dropped: not conversation, and chat is the family Compass retains verbatim. */
const HOUSEKEEPING = message({
  at: '2026-07-29T15:01:40Z',
  fraction: '000000',
  authorId: MARCUS_AUTHOR_ID,
  text: 'has joined the channel',
  subtype: 'channel_join',
});

/** In the second half of the split. */
const SECOND_HALF = message({
  at: '2026-07-30T09:05:00Z',
  fraction: '000100',
  authorId: PRIYA_AUTHOR_ID,
  text: 'DEV-501 unblocked, the key landed overnight',
});

/** Exactly on `window.end`, so half-open windowing must exclude it. */
const AT_WINDOW_END = message({
  at: '2026-07-31T00:00:00Z',
  fraction: '000000',
  authorId: PRIYA_AUTHOR_ID,
  text: 'tomorrow’s message, on the boundary',
});

/**
 * A bot post in the second channel, with no `user` at all.
 *
 * Kept rather than dropped: a deploy bot's notice is often the only place a release is stated in prose,
 * and an author the provider will not name is an honest `unknown` handle rather than a reason to discard
 * the sentence.
 */
const RELEASE_NOTICE = message({
  at: '2026-07-30T13:40:00Z',
  fraction: '000500',
  text: 'Released v2.14 — includes DEV-501',
  subtype: 'bot_message',
});

const PRIYA_PROFILE = {
  ok: true,
  user: { id: PRIYA_AUTHOR_ID, name: 'priya', profile: { real_name: 'Priya Raman', display_name: 'priya' } },
};

const MARCUS_PROFILE = {
  ok: true,
  user: { id: MARCUS_AUTHOR_ID, name: 'marcus', profile: { real_name: 'Marcus Hale', display_name: 'marcus' } },
};

/** An `ok` envelope around a page of history, with the cursor field the provider always sends. */
const history = (messages: readonly unknown[], nextCursor = ''): HttpResponse =>
  jsonResponse({ ok: true, messages, has_more: nextCursor.length > 0, response_metadata: { next_cursor: nextCursor } });

/** The cursor the first page of the full-window read hands back, so pagination is actually exercised. */
export const NEXT_CURSOR = 'dXNlcjpVMDYxTkZUVDI=';

const historyUrl = (input: {
  readonly channelKey: string;
  readonly oldest: string;
  readonly latest: string;
  readonly cursor?: string;
}): string =>
  `${API_BASE_URL}/conversations.history?channel=${input.channelKey}&oldest=${input.oldest}` +
  `&latest=${input.latest}&inclusive=true&limit=200` +
  (input.cursor === undefined ? '' : `&cursor=${encodeURIComponent(input.cursor)}`);

/**
 * The bounds the connector computes for each window the suite asks about.
 *
 * `oldest` is `window.start` less the connector's one-second prefilter margin; `latest` is `window.end`
 * exactly. Spelled out rather than derived so that a change to either is a visible diff here.
 */
const WINDOW_BOUNDS = {
  whole: { oldest: '1785283199.000000', latest: '1785456000.000000' },
  firstHalf: { oldest: '1785283199.000000', latest: '1785369600.000000' },
  secondHalf: { oldest: '1785369599.000000', latest: '1785456000.000000' },
  empty: { oldest: '1785283199.000000', latest: '1785283200.000000' },
} as const;

/**
 * The full response table.
 *
 * Keyed `METHOD url` exactly as `ReplayHttpClient` keys it, so an endpoint the connector reaches for
 * without a recording is a loud `UnrecordedRequestError` rather than a silent empty answer. That is what
 * makes "no workspace-wide call was made" an assertion with teeth: a leaked `conversations.list` cannot
 * pass as an empty result.
 */
export function recordedResponses(): Record<string, HttpResponse> {
  const table: Record<string, HttpResponse> = {
    // The two author lookups, which is the whole of what `users:read` is asked for.
    [`GET ${API_BASE_URL}/users.info?user=${PRIYA_AUTHOR_ID}`]: jsonResponse(PRIYA_PROFILE),
    [`GET ${API_BASE_URL}/users.info?user=${MARCUS_AUTHOR_ID}`]: jsonResponse(MARCUS_PROFILE),

    // The health probe: one message per named channel, asking only whether it is reachable.
    [`GET ${API_BASE_URL}/conversations.history?channel=${ENGINEERING_CHANNEL_KEY}&limit=1`]: history([SECOND_HALF]),
    [`GET ${API_BASE_URL}/conversations.history?channel=${RELEASES_CHANNEL_KEY}&limit=1`]: history([RELEASE_NOTICE]),
  };

  // The whole window, in two pages, so the cursor walk is exercised rather than assumed.
  table[`GET ${historyUrl({ channelKey: ENGINEERING_CHANNEL_KEY, ...WINDOW_BOUNDS.whole })}`] = history(
    [OUT_OF_WINDOW, FIRST_HALF_ROOT, HOUSEKEEPING, FIRST_HALF_REPLY],
    NEXT_CURSOR,
  );
  table[
    `GET ${historyUrl({ channelKey: ENGINEERING_CHANNEL_KEY, ...WINDOW_BOUNDS.whole, cursor: NEXT_CURSOR })}`
  ] = history([SECOND_HALF, AT_WINDOW_END]);
  table[`GET ${historyUrl({ channelKey: RELEASES_CHANNEL_KEY, ...WINDOW_BOUNDS.whole })}`] = history([RELEASE_NOTICE]);

  // The first half of the split: [start, midpoint).
  table[`GET ${historyUrl({ channelKey: ENGINEERING_CHANNEL_KEY, ...WINDOW_BOUNDS.firstHalf })}`] = history([
    OUT_OF_WINDOW,
    FIRST_HALF_ROOT,
    HOUSEKEEPING,
    FIRST_HALF_REPLY,
  ]);
  table[`GET ${historyUrl({ channelKey: RELEASES_CHANNEL_KEY, ...WINDOW_BOUNDS.firstHalf })}`] = history([]);

  // The second half: [midpoint, end).
  table[`GET ${historyUrl({ channelKey: ENGINEERING_CHANNEL_KEY, ...WINDOW_BOUNDS.secondHalf })}`] = history([
    SECOND_HALF,
    AT_WINDOW_END,
  ]);
  table[`GET ${historyUrl({ channelKey: RELEASES_CHANNEL_KEY, ...WINDOW_BOUNDS.secondHalf })}`] = history([
    RELEASE_NOTICE,
  ]);

  // The empty window the suite probes with. The provider still answers, and still returns the message
  // sitting inside the one-second prefilter margin — which the window filter then drops.
  table[`GET ${historyUrl({ channelKey: ENGINEERING_CHANNEL_KEY, ...WINDOW_BOUNDS.empty })}`] = history([
    OUT_OF_WINDOW,
  ]);
  table[`GET ${historyUrl({ channelKey: RELEASES_CHANNEL_KEY, ...WINDOW_BOUNDS.empty })}`] = history([]);

  return table;
}

export const recordedClient = (): ReplayHttpClient => new ReplayHttpClient(recordedResponses());

/** The channel list the contract runs against: exactly the two a manager named. */
export const SELECTED_CHANNELS = Object.freeze([
  Object.freeze({ conversationKey: ENGINEERING_CHANNEL_KEY, name: ENGINEERING_CHANNEL_NAME }),
  Object.freeze({ conversationKey: RELEASES_CHANNEL_KEY, name: RELEASES_CHANNEL_NAME }),
]);
