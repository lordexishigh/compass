import type { HttpClient, HttpRequest, HttpResponse } from '../http.js';

/**
 * The two fake transports every live-connector test uses.
 *
 * Same convention as the narrator's and delivery's testkits: the fake is indistinguishable from the
 * real client to the connector above it, so the code under test is the production path with the
 * network removed.
 *
 * ## Why the contract suite needs these at all
 *
 * `describeConnectorContract` asserts that the same request twice is **deeply equal** and that a
 * *fresh* connector instance answers identically. Against a live API neither holds — a repository
 * gains a commit between two calls and the suite fails for a reason that says nothing about the
 * connector. So a live connector is conformance-tested against `ReplayHttpClient` over recorded
 * responses, which is exactly how the suite can run *unchanged* against a provider that has a
 * network in production.
 */

/** Requests are keyed by method and URL: the same call must always get the same answer. */
const keyOf = (request: HttpRequest): string => `${request.method} ${request.url}`;

export class UnrecordedRequestError extends Error {
  readonly attempted: string;
  readonly known: readonly string[];

  constructor(attempted: string, known: readonly string[]) {
    super(
      `The connector issued a request with no recorded response: ${attempted}\n` +
        `Recorded requests (${known.length}):\n${known.map((entry) => `  - ${entry}`).join('\n')}\n` +
        'This is a failure rather than an empty answer on purpose. A replay client that invented a ' +
        '200 for an unrecorded call would let a connector silently change which endpoints it hits, ' +
        'which is the one thing the scoping assertions exist to catch.',
    );
    this.name = 'UnrecordedRequestError';
    this.attempted = attempted;
    this.known = known;
  }
}

/**
 * Answers from a fixed table and records what it was asked.
 *
 * It **throws on an unrecorded request** rather than returning a 404. A test asserting "unselected
 * projects are never queried" is only meaningful if an unexpected call is loud: a client that
 * answered everything with an empty list would turn a leaked whole-site query into a green test with
 * zero records, which reads identically to a correctly-scoped query on a quiet day.
 */
export class ReplayHttpClient implements HttpClient {
  /** Every request issued, in order, so a test can assert on the call list itself. */
  readonly requests: HttpRequest[] = [];
  readonly #responses: Map<string, HttpResponse>;

  constructor(responses: Readonly<Record<string, HttpResponse>>) {
    this.#responses = new Map(Object.entries(responses));
  }

  send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const found = this.#responses.get(keyOf(request));
    if (found === undefined) {
      return Promise.reject(new UnrecordedRequestError(keyOf(request), [...this.#responses.keys()]));
    }
    return Promise.resolve(found);
  }

  /** Every URL requested, for the "which endpoints did we touch" assertions. */
  get urls(): readonly string[] {
    return this.requests.map((request) => request.url);
  }

  /** Whether any request's URL contains a fragment — the workspace-wide-call assertion's primitive. */
  calledAnyMatching(pattern: RegExp): boolean {
    return this.requests.some((request) => pattern.test(request.url));
  }
}

/**
 * Wraps another client and answers one nominated request with a rate-limit response.
 *
 * Its own class rather than a flag on `ReplayHttpClient` because the rate-limit criterion is about a
 * *partial* outcome: one source throttled while the others answer, so the report has to state a
 * coverage gap instead of presenting the remainder as complete. That needs a client that is healthy
 * for most calls and throttled for one.
 */
export class ThrottledHttpClient implements HttpClient {
  readonly requests: HttpRequest[] = [];

  constructor(
    private readonly inner: HttpClient,
    /** Requests whose URL matches are answered 429; everything else passes through. */
    private readonly throttle: RegExp,
    private readonly retryAfterSeconds = 60,
  ) {}

  send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    if (this.throttle.test(request.url)) {
      return Promise.resolve({
        status: 429,
        headers: {
          'retry-after': String(this.retryAfterSeconds),
          'x-ratelimit-remaining': '0',
        },
        body: JSON.stringify({ message: 'API rate limit exceeded' }),
      });
    }
    return this.inner.send(request);
  }
}

/** Builds a recorded 200 with a JSON body, which is what almost every fixture entry is. */
export const jsonResponse = (
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): HttpResponse => ({
  status: 200,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
