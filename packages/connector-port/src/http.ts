/**
 * The one way a live connector is allowed to reach the network.
 *
 * ## Why this lives in the port package
 *
 * `@compass/connector-port` is the contract layer, and a transport looks at first glance like
 * something that belongs above it. It is here for three reasons that outweigh that instinct:
 *
 *  - **It adds no dependency and does no I/O.** These are types plus one small replay client. The
 *    port still depends on `@compass/clock` and `zod` and nothing else, so nothing about the layer
 *    order changes.
 *  - **Every live connector needs the identical shape.** GitHub, Jira and Slack each need "issue one
 *    request, get a status and a body, never touch `fetch` directly". Three copies of that interface
 *    would drift, and a fourth package to hold one interface is more ceremony than substance.
 *  - **The conformance kit needs its counterpart.** `describeConnectorContract` demands that two
 *    calls be *deeply equal* and that a fresh instance answer identically. A connector talking to a
 *    real API cannot satisfy that, so the suite is run against a recorded transport — and the replay
 *    client belongs beside the suite that requires it, in the same testkit.
 *
 * ## Why an interface rather than `fetch`
 *
 * A connector that calls global `fetch` cannot be tested for the things that actually matter here.
 * The acceptance criteria include "no workspace-wide history call is ever made" and "unselected
 * projects are never queried" — both are assertions about *which requests left the process*, which
 * is only answerable if every request goes through one seam a test can watch. `RecordingHttpClient`
 * is that watcher; `ReplayHttpClient` is what makes a run deterministic.
 *
 * So the rule for a live connector is: take an `HttpClient` in the constructor, never reference
 * `fetch`, and let the composition root supply `fetchHttpClient()`.
 */

/** A single outbound request. `url` is absolute; the connector builds it, the client sends it. */
export interface HttpRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Already-serialised body, or null for a GET. Never an object: the caller owns the encoding. */
  readonly body?: string | null;
}

/**
 * What came back. Deliberately not `Response`.
 *
 * A `Response` body can only be read once, which makes it useless for a recording that has to be
 * replayed, and it drags the whole WHATWG surface into a type that needs three fields. `headers` is
 * a plain lower-cased map because rate-limit state arrives in headers and a connector has to be able
 * to read it without a case-sensitivity bug.
 */
export interface HttpResponse {
  readonly status: number;
  /** Header names lower-cased by the client, so a connector can index them directly. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface HttpClient {
  send(request: HttpRequest): Promise<HttpResponse>;
}

/**
 * The status codes that mean "you asked correctly, but not now".
 *
 * Kept here rather than in each connector because all three providers use the same three, and
 * because a connector that treated 429 as a hard failure would report an empty day instead of a
 * coverage gap — the exact dishonesty the port exists to prevent.
 */
export const RATE_LIMIT_STATUS = 429;
export const SERVER_ERROR_STATUSES: readonly number[] = [500, 502, 503, 504];

/** 403 with an exhausted quota is GitHub's rate limit; 403 without one is a real authorization failure. */
export const isRateLimited = (response: HttpResponse): boolean =>
  response.status === RATE_LIMIT_STATUS ||
  (response.status === 403 && (response.headers['x-ratelimit-remaining'] ?? '') === '0');

export const isAuthFailure = (response: HttpResponse): boolean =>
  response.status === 401 || (response.status === 403 && !isRateLimited(response));

/**
 * The platform `fetch`, declared structurally.
 *
 * This package keeps `types: []` — the same choice `@compass/clock` makes, and the thing that keeps
 * it dependency-free — so `fetch` and `Headers` are not in scope as ambient types. Rather than take
 * on `@types/node` for one call, the shape is declared here and resolved off `globalThis`, exactly as
 * `@compass/observability` declares `ConsoleLike` for its one `console.info`.
 *
 * The declaration is deliberately the *narrowest* thing this file uses: a callable returning
 * something with a status, an iterable header bag and a text body. Widening it to the real WHATWG
 * surface would invite a connector to reach for the rest of it.
 */
interface FetchedHeaders {
  forEach(callback: (value: string, key: string) => void): void;
}

interface FetchedResponse {
  readonly status: number;
  readonly headers: FetchedHeaders;
  text(): Promise<string>;
}

type FetchLike = (
  url: string,
  init: { method: string; headers?: Readonly<Record<string, string>>; body?: string },
) => Promise<FetchedResponse>;

/**
 * The real client, over the platform `fetch`.
 *
 * Node 22 has `fetch` globally, so there is no dependency to add. This is the only place in any
 * connector that names it, which is what makes the injection rule checkable rather than aspirational.
 */
export function fetchHttpClient(): HttpClient {
  const send = (globalThis as unknown as { fetch: FetchLike }).fetch;

  return {
    async send(request: HttpRequest): Promise<HttpResponse> {
      const response = await send(request.url, {
        method: request.method,
        ...(request.headers === undefined ? {} : { headers: request.headers }),
        ...(request.body === undefined || request.body === null ? {} : { body: request.body }),
      });

      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });

      return { status: response.status, headers, body: await response.text() };
    },
  };
}
