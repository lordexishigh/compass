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

import { database } from '../report-source';

import { clearSessionCookie, readSessionCookie } from './cookies';

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

/** The absolute origin to put in a mailed link. */
export function baseUrlFor(request: Request): string {
  const configured = process.env['COMPASS_BASE_URL'];
  if (configured !== undefined && configured.length > 0) return configured.replace(/\/+$/, '');

  const forwardedHost = request.headers.get('x-forwarded-host');
  const url = new URL(request.url);
  const host = forwardedHost ?? url.host;
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ?? url.protocol.replace(':', '');
  return `${proto}://${host}`;
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
 */
export async function guard(input: GuardInput): Promise<GuardResult> {
  const now = nowAtEdge();
  const organizationId = requestOrganizationId();
  const scoped = scopedFor(organizationId);

  const resolution = await resolveIdentity({
    scoped,
    secret: readSessionCookie(input.request),
    now,
  });

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
    // A cookie that has stopped working is cleared on the way out, so the browser
    // stops sending it and `/account` shows the sign-in form rather than a stale name.
    return {
      allowed: false,
      response:
        identity === null && readSessionCookie(input.request) !== null
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
export interface PageAccess {
  readonly allowed: boolean;
  readonly principal: Principal;
  readonly identity: Identity | null;
  readonly organizationId: string;
  readonly scoped: ScopedDb;
  readonly now: Instant;
  readonly reason: string | null;
}

export async function pageAccess(input: {
  readonly route: string;
  readonly cookieHeader: string | null;
  readonly teamKey?: string | null;
}): Promise<PageAccess> {
  const now = nowAtEdge();
  const organizationId = requestOrganizationId();
  const scoped = scopedFor(organizationId);

  const secret = input.cookieHeader === null ? null : cookieValue(input.cookieHeader);
  const resolution = await resolveIdentity({ scoped, secret, now });
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
