import { consumeMagicLink, describeTokenRejection } from '@compass/auth';
import { NextResponse } from 'next/server';

import { setSessionCookie } from '../../../../../lib/auth/cookies';
import { guard } from '../../../../../lib/auth/guard';
import { failure } from '../../../../../lib/auth/http';

/**
 * `GET /api/auth/magic-link/consume?token=…` — spends a mailed sign-in link.
 *
 * A route handler rather than a page, for one reason: a Server Component cannot set a
 * cookie, and this has to. So the mailed URL points here, this sets the session and
 * redirects to the report — which is what makes clicking a link in an inbox land on
 * today's report rather than on a form.
 *
 * A `GET` that changes state is normally a mistake. It is right here because the state
 * change *is* following a link from an email, and the only alternative is a page with a
 * button, which is a second step for no security gain: the secret in the URL is the
 * credential either way, and `SameSite=Lax` means the cookie it sets is not usable in a
 * cross-site POST regardless.
 *
 * A rejected link redirects to `/account` carrying the reason, so the person reads
 * "this has already been used" beside the form that can send them a new one, rather
 * than a bare error page.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: '/api/auth/magic-link/consume', action: 'GET' });
  if (!admitted.allowed) return admitted.response;

  const token = new URL(request.url).searchParams.get('token');
  const origin = new URL(request.url).origin;

  if (token === null || token.length === 0) {
    return NextResponse.redirect(
      `${origin}/account?problem=${encodeURIComponent('That link carried no token. Request a new one.')}`,
      { status: 303 },
    );
  }

  try {
    const result = await consumeMagicLink({ scoped: admitted.scoped, secret: token, now: admitted.now });

    if (!result.ok) {
      return NextResponse.redirect(
        `${origin}/account?problem=${encodeURIComponent(describeTokenRejection(result.rejection, 'magic_link'))}`,
        { status: 303 },
      );
    }

    // 303 rather than 302: the browser must follow with a GET, and 302 leaves that to
    // the client's discretion.
    const response = NextResponse.redirect(`${origin}/`, { status: 303 });
    response.headers.set('cache-control', 'no-store');
    return setSessionCookie(response, request, result.payload.started.secret);
  } catch (error) {
    return failure(error);
  }
}
