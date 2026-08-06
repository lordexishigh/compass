import {
  ConsoleMailer,
  STATUS_FOR_DENIAL,
  authorize,
  describeDenial,
  resolveIdentity,
  type Action,
  type AuthMailer,
  type AuthorizeDecision,
  type Identity,
  type Principal,
  type RouteRule,
} from '@compass/auth';
import { SystemClock, type Instant } from '@compass/clock';
import { ScopedDb, findOrganization, orgScope } from '@compass/db';
import { SEEDED_ORGANIZATION_ID, resolveSeededRun } from '@compass/seed-connector';
import { NextResponse } from 'next/server';

import { database } from '../database';

import { clearSessionCookie, hasSessionCookie, readSessionCookie } from './cookies';
import { LinkOriginUnavailableError, UNAVAILABLE_SENTENCE, jsonError } from './http';

/**
 * The one place a request is admitted or refused.
 *
 * Every route handler in `app/api` begins with `guard(...)` and does nothing before
 * it. That is deliberate and it is the whole reason the matrix is worth having: a
 * per-route check would mean the parametrized (role × route × action) test was
 * asserting against a table that the handlers might or might not consult, and the
 * first handler to forget would be invisible.
 *
 * There is **no Next.js middleware**. Middleware is the obvious place for this and it
 * is the wrong one here for two reasons. It runs before `/` and would have to be
 * taught an exception for the zero-config report — an exception in the one layer no
 * test can see the inside of. And Argon2id is a native addon that cannot load on the
 * Edge runtime, so a middleware that touched sign-in would fail at build time.
 * `apps/web/tests/cold-start.test.tsx` asserts no middleware file exists, so this
 * cannot quietly change.
 */

/** The process edge's own instant. Route handlers are one of the two places allowed a Clock. */
export const nowAtEdge = (): Instant => new SystemClock().now();

/**
 * The organization a request is for.
 *
 * Compass is multi-tenant in the schema and single-tenant in this deployment: the
 * seeded organization is the only one, resolved through the same `resolveSeededRun`
 * the report edge and the boot script call. When host-based or subdomain-based tenant
 * resolution arrives it replaces the body of this function and nothing else, because
 * every caller already goes through it.
 */
export function requestOrganizationId(): string {
  return resolveSeededRun({ hostNow: nowAtEdge() }).organizationId;
}

/** The team this deployment serves when a request names none. */
export function defaultTeamKey(): string {
  return resolveSeededRun({ hostNow: nowAtEdge() }).teamKey;
}

/**
 * Whether the organization being read is the demonstration tenant.
 *
 * This is what confines public readability to the demo. A real customer's
 * organization id is not the seeded one, so `demoOnlyPublic` routes stop being public
 * the moment Compass is holding somebody's actual blockers.
 */
export const isDemoOrganization = (organizationId: string): boolean =>
  organizationId === SEEDED_ORGANIZATION_ID;

export function scopedFor(organizationId: string): ScopedDb {
  return new ScopedDb(database(), orgScope(organizationId));
}

/**
 * The mailer this process sends with.
 *
 * One per process, cached across hot reloads for the same reason the pool is: the
 * console transport keeps what it sent, and a new instance per reload would lose the
 * link an operator was about to copy. A real transport arrives with
 * `alpha-delivery-email-and-slack`; until then the link goes to the log, and
 * `/api/health` says so rather than implying mail works.
 */
const MAILER_KEY = Symbol.for('compass.web.mailer');
type MailerGlobal = typeof globalThis & { [MAILER_KEY]?: AuthMailer };

export function mailer(): AuthMailer {
  const cache = globalThis as MailerGlobal;
  cache[MAILER_KEY] ??= new ConsoleMailer();
  return cache[MAILER_KEY];
}

/**
 * The organization's name, for the mail Compass sends.
 *
 * Falls back to "Compass" rather than throwing: a mailer that refused to send because
 * the tenant row could not be read would turn a cosmetic problem into a person unable
 * to sign in.
 */
export async function organizationName(scoped: ScopedDb): Promise<string> {
  const organization = await findOrganization(scoped);
  return organization?.name ?? 'Compass';
}

/**
 * Hosts a mailed link may point at without `COMPASS_BASE_URL` being set.
 *
 * Loopback only. A link to the reader's own machine is harmless whoever asked for it,
 * which is what makes the zero-config path — `docker compose up`, then a browser on
 * `localhost:3000` — work with nothing configured.
 */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * The absolute origin to put in a mailed link.
 *
 * ## Why this does not read `x-forwarded-host`
 *
 * `POST /api/auth/password-reset` is public and answers identically for an address that
 * has a seat and one that does not — deliberately, so the form is not a membership
 * oracle. That means an unauthenticated caller can make Compass mail a *valid single-use
 * token* to somebody else. If the origin of that link came from a request header, the
 * caller would also choose where the victim's token pointed: send
 * `x-forwarded-host: evil.example`, and the reset link in the victim's inbox is an
 * attacker's page that receives the token when clicked.
 *
 * It is not exploitable while `mailer()` is `ConsoleMailer` — the link goes to the
 * process log. It becomes exploitable the day a real transport lands, which is why it is
 * fixed now rather than then.
 *
 * So the origin comes from configuration, or from a loopback Host, or not at all. There
 * is no third source. Refusing is the right failure: a deployment that cannot say where
 * its own links point must not guess, and `failure()` turns this into a 503 naming the
 * variable to set.
 */
export function baseUrlFor(request: Request): string {
  const configured = process.env['COMPASS_BASE_URL'];

  if (configured !== undefined && configured.length > 0) {
    let parsed: URL;
    try {
      parsed = new URL(configured);
    } catch {
      throw new LinkOriginUnavailableError(
        `COMPASS_BASE_URL is set to \`${configured}\`, which is not an absolute URL. It must look like ` +
          '`https://compass.your-company.com` — Compass will not mail a link it cannot construct.',
      );
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new LinkOriginUnavailableError(
        `COMPASS_BASE_URL must be an http or https URL; \`${parsed.protocol}\` is neither.`,
      );
    }
    return `${parsed.protocol}//${parsed.host}`;
  }

  // No configuration. The Host header is only trusted when it names this machine.
  const url = new URL(request.url);
  if (LOOPBACK_HOSTNAMES.has(url.hostname)) {
    return `${url.protocol}//${url.host}`;
  }

  throw new LinkOriginUnavailableError(
    'COMPASS_BASE_URL is not set, so Compass does not know which address to put in the link it would send. It is ' +
      'deliberately not taken from the request: this endpoint can be called by anyone, so a caller who chose the ' +
      'host would choose where somebody else’s sign-in token pointed. Set COMPASS_BASE_URL to this deployment’s ' +
      'own origin and try again.',
  );
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

export interface GuardInput {
  readonly request: Request;
  /** Spelled exactly as `app/api/**\/route.ts` spells it — `/api/goals/[nodeId]`. */
  readonly route: string;
  readonly action: Action;
  /** The team a team-scoped route is answering about. */
  readonly teamKey?: string | null;
}

export interface GuardAllowed {
  readonly allowed: true;
  readonly rule: RouteRule;
  readonly principal: Principal;
  readonly organizationId: string;
  readonly scoped: ScopedDb;
  readonly now: Instant;
  /** Null for the `public` principal. */
  readonly identity: Identity | null;
  /** The team the request resolved to, after scoping. */
  readonly teamKey: string;
}

export interface GuardRefused {
  readonly allowed: false;
  readonly response: NextResponse;
  /**
   * True when the refusal is Compass's own fault rather than the caller's — the database
   * could not be reached, so who is asking could not be established at all.
   *
   * Every handler returns `response` either way. It exists for `/api/health`, whose whole
   * job is to *report* that condition: that route lets an unavailable guard fall through
   * to `readiness()` instead of answering with the guard's own 503, because a health
   * endpoint that goes down with the thing it monitors is not one.
   */
  readonly unavailable: boolean;
}

export type GuardResult = GuardAllowed | GuardRefused;

const NO_STORE = { 'cache-control': 'no-store' } as const;

/**
 * Turns a denial into a response.
 *
 * The body always names the route and the reason, because the alternative — a bare
 * 403 — makes an access problem indistinguishable from a bug, and the person hitting
 * it is usually a colleague who needs to know which owner to ask.
 */
export function denialResponse(
  decision: Extract<AuthorizeDecision, { allowed: false }>,
  detail: { readonly teamKey?: string | null } = {},
): NextResponse {
  return NextResponse.json(
    {
      error: decision.reason,
      detail: describeDenial(decision.reason, detail),
      route: decision.rule?.route ?? null,
    },
    { status: STATUS_FOR_DENIAL[decision.reason], headers: NO_STORE },
  );
}

/**
 * Resolves who is asking, then asks the matrix.
 *
 * The order matters: the identity is resolved first so that an expired session is
 * *sealed* (revoked, cookie cleared) even on a route the caller would have been
 * allowed anonymously. A dead cookie that is merely ignored keeps being presented on
 * every request for a month.
 *
 * ## This function never throws
 *
 * That is a contract, not a happy accident, and it exists because of where the call
 * sits: `auth-http.test.ts` requires `guard()` to be the **first** statement in every
 * handler, which puts it outside the try/catch that owns `failure()`. So anything it
 * threw — a missing `DATABASE_URL`, an unreachable Postgres, a malformed cookie — came
 * out of the handler as a framework 500 rather than as the stated 503 the product means
 * to give. Wrapping the body here fixes every route at once and keeps the call in the
 * position the coverage test insists on.
 */
export async function guard(input: GuardInput): Promise<GuardResult> {
  const now = nowAtEdge();

  let organizationId: string;
  let scoped: ScopedDb;
  let resolution: Awaited<ReturnType<typeof resolveIdentity>>;

  try {
    organizationId = requestOrganizationId();
    scoped = scopedFor(organizationId);
    resolution = await resolveIdentity({
      scoped,
      secret: readSessionCookie(input.request),
      now,
    });
  } catch (error) {
    // Not the caller's fault and not something they can act on, so it is stated as ours.
    // `failure()` logs the detail and returns a fixed sentence; the same is done here so
    // a driver error cannot describe the infrastructure to an unauthenticated caller.
    console.error(
      `[compass] guard could not establish identity for ${input.action} ${input.route}: ` +
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );

    return {
      allowed: false,
      unavailable: true,
      response: jsonError('unavailable', UNAVAILABLE_SENTENCE, 503),
    };
  }

  const identity = resolution.kind === 'identified' ? resolution.identity : null;
  const principal: Principal = identity === null ? 'public' : identity.principal;

  const decision = authorize({
    route: input.route,
    action: input.action,
    principal,
    seatActive: identity === null ? undefined : identity.membership.status === 'active',
    teamKey: input.teamKey ?? null,
    teamScopes: identity?.teamScopes ?? [],
    demoOrganization: isDemoOrganization(organizationId),
  });

  if (!decision.allowed) {
    const response = denialResponse(decision, { teamKey: input.teamKey ?? null });
    // A cookie that has stopped working is cleared on the way out, so the browser stops
    // sending it and `/account` shows the sign-in form rather than a stale name.
    // `hasSessionCookie` rather than `readSessionCookie !== null`, because a cookie whose
    // value cannot even be decoded is exactly the one that most needs clearing — and it
    // reads as absent.
    return {
      allowed: false,
      unavailable: false,
      response:
        identity === null && hasSessionCookie(input.request)
          ? clearSessionCookie(response, input.request)
          : response,
    };
  }

  return {
    allowed: true,
    rule: decision.rule,
    principal,
    organizationId,
    scoped,
    now,
    identity,
    // A team-scoped route reached without a team answers about the caller's own: their
    // first scope, or the deployment's default for an unscoped owner or public reader.
    teamKey:
      input.teamKey !== null && input.teamKey !== undefined && input.teamKey.length > 0
        ? input.teamKey
        : (identity?.teamScopes[0] ?? defaultTeamKey()),
  };
}

/**
 * The same decision, for a Server Component.
 *
 * A page cannot answer 403 with a JSON body, so this returns the facts and lets the
 * page render a refusal in the product's own voice. Pages and endpoints therefore read
 * one matrix, which is the point: a screen that rendered data its API refuses would be
 * the leak the matrix exists to prevent.
 */
/** A decision was reached: the matrix either allowed the read or refused it. */
export interface PageAccessResolved {
  readonly kind: 'resolved';
  readonly allowed: boolean;
  readonly principal: Principal;
  readonly identity: Identity | null;
  readonly organizationId: string;
  readonly scoped: ScopedDb;
  readonly now: Instant;
  readonly reason: string | null;
}

/** No decision could be reached, because the substrate could not be read. */
export interface PageAccessUnavailable {
  readonly kind: 'unavailable';
  /** Stated to the reader. Compass's own words, never a driver's. */
  readonly detail: string;
}

export type PageAccess = PageAccessResolved | PageAccessUnavailable;

/**
 * Like `guard()`, this never throws — and the return type says so.
 *
 * A discriminated union rather than a nullable field, so a page physically cannot read
 * `scoped` off an outcome where there is no connection to read it from. Both callers
 * (`/account`, `/settings/members`) render `StatedFailure` on the `unavailable` arm:
 * `/account` in particular is where somebody goes *because* something is wrong, so it is
 * the last screen that may itself become an error page.
 */
export async function pageAccess(input: {
  readonly route: string;
  readonly cookieHeader: string | null;
  readonly teamKey?: string | null;
}): Promise<PageAccess> {
  const now = nowAtEdge();

  let organizationId: string;
  let scoped: ScopedDb;
  let resolution: Awaited<ReturnType<typeof resolveIdentity>>;

  try {
    organizationId = requestOrganizationId();
    scoped = scopedFor(organizationId);
    const secret = input.cookieHeader === null ? null : cookieValue(input.cookieHeader);
    resolution = await resolveIdentity({ scoped, secret, now });
  } catch (error) {
    console.error(
      `[compass] pageAccess could not establish identity for ${input.route}: ` +
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    return { kind: 'unavailable', detail: UNAVAILABLE_SENTENCE };
  }

  const identity = resolution.kind === 'identified' ? resolution.identity : null;
  const principal: Principal = identity === null ? 'public' : identity.principal;

  const decision = authorize({
    route: input.route,
    action: 'GET',
    principal,
    seatActive: identity === null ? undefined : identity.membership.status === 'active',
    teamKey: input.teamKey ?? null,
    teamScopes: identity?.teamScopes ?? [],
    demoOrganization: isDemoOrganization(organizationId),
  });

  return {
    kind: 'resolved',
    allowed: decision.allowed,
    principal,
    identity,
    organizationId,
    scoped,
    now,
    reason: decision.allowed ? null : describeDenial(decision.reason, { teamKey: input.teamKey ?? null }),
  };
}

/** Pulls the session secret out of a raw `Cookie` header. */
export function cookieValue(cookieHeader: string): string | null {
  return readSessionCookie(new Request('http://compass.invalid/', { headers: { cookie: cookieHeader } }));
}
