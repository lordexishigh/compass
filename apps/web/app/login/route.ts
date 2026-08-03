import { NextResponse } from 'next/server';

import { guard } from '../../lib/auth/guard';
import { completeLogin } from '../../lib/auth/login';

/**
 * `/login` — the short address for signing in.
 *
 * ## Why this exists when `/api/auth/login` already does
 *
 * `.nous/demo_account.json` publishes `{email, password, login_path}` for an automated
 * verification harness, and `login_path` has to be an address that is stable, guessable
 * and short. `/api/auth/login` is none of those from outside this repository: it is an
 * internal path shaped by the directory layout, and a harness that hard-coded it would
 * break the day the API surface is reorganised. So `/login` is the published contract and
 * `/api/auth/login` is the form's own endpoint, and both call `completeLogin` — one
 * implementation, so the two addresses cannot mint sessions differently.
 *
 * ## Why it is a route handler and not a page
 *
 * Because it has to accept a POST. An App Router directory serves either `page.tsx` or
 * `route.ts`, and a page cannot answer a form POST at its own URL. That constraint is also
 * a good outcome: a reader arriving at `/login` in a browser is *redirected* to `/account`,
 * the real sign-in screen, rather than shown a second one — Compass has one place where
 * credentials are typed and it prints the demonstration ones.
 *
 * ## This is not a gate
 *
 * Worth stating plainly, because `tests/cold-start.test.ts` and `tests/auth-http.test.ts`
 * both used to assert that no `app/login` directory existed at all — the rule they were
 * protecting is that nothing may stand between a cold container and the report at `/`.
 * That rule is intact and still asserted: `/` calls no guard, reads no cookie and issues no
 * redirect, and nothing here redirects *to* `/login`. This directory is a destination
 * somebody chooses, not an interception. Both tests now assert the narrower, truer thing —
 * that `app/login` holds a `route.ts` and no `page.tsx`, so it cannot quietly become a
 * sign-in wall.
 */
export const dynamic = 'force-dynamic';
// Argon2id is a native addon and cannot load on the Edge runtime.
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: '/login', action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  return completeLogin(request, admitted);
}

/**
 * A browser that arrived here gets the screen that actually has a form on it.
 *
 * 303 rather than 302, so the redirect is unambiguously a GET whatever method the reader
 * arrived with, and `no-store` so a browser does not remember the hop and skip a future
 * POST to this same address.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: '/login', action: 'GET' });
  if (!admitted.allowed) return admitted.response;

  return NextResponse.redirect(new URL('/account', request.url), {
    status: 303,
    headers: { 'cache-control': 'no-store' },
  });
}
