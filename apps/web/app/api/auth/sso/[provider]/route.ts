import { generateSsoNonce, isSsoProvider, issueSsoState, ssoAuthorizeUrl } from '@compass/auth';
import { NextResponse } from 'next/server';

import { setSsoNonceCookie } from '../../../../../lib/auth/cookies';
import { baseUrlFor, guard } from '../../../../../lib/auth/guard';
import { NO_STORE, failure, jsonError } from '../../../../../lib/auth/http';
import { ssoRedirectUri } from '../../../../../lib/sso-source';

/**
 * `GET /api/auth/sso/[provider]` — begins a Google or GitHub sign-in.
 *
 * ## Why a `GET` that redirects, rather than a `POST` returning a URL
 *
 * Because the sign-in panel is a document with no client JavaScript, like every other surface in this
 * product. A plain `<a href="/api/auth/sso/google">` has to work, and it does: this answers `303` to
 * the provider's consent screen. A `POST` returning JSON would need a script to follow it, which would
 * make signing in the one thing on the site that required JavaScript.
 *
 * It is safe as a `GET` because it *starts* a flow and grants nothing. No session is minted here, no
 * row is written, and the only side effect is a short-lived nonce cookie. The state-changing half is
 * the callback, and that is bound to this browser by the nonce.
 *
 * ## Sign in, or link — decided here and carried in the signed state
 *
 * If the caller already holds a session, this is a *link*: the identity will be attached to their
 * account, which is the ownership confirmation the unverified-email refusal points at. The user id
 * travels inside the HMAC'd state rather than being read from the cookie at the callback, because a
 * callback that read the session would link the identity to whoever happened to be signed in when the
 * redirect landed — not necessarily the person who started it.
 *
 * `ANYONE` in the matrix, for the same reason `/api/auth/login` is: this is how a session is obtained,
 * so requiring one would be circular.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/auth/sso/[provider]';

export async function GET(
  request: Request,
  context: { params: Promise<{ provider: string }> },
): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'GET' });
  if (!admitted.allowed) return admitted.response;

  try {
    const { provider } = await context.params;

    if (!isSsoProvider(provider)) {
      return jsonError(
        'unknown_provider',
        'Compass signs in with Google and GitHub. That is not one of them.',
        404,
      );
    }

    /**
     * The origin, from configuration rather than from a request header.
     *
     * `baseUrlFor` throws when it cannot say where this deployment lives, and `failure()` turns that
     * into a 503 naming the variable to set. Guessing would be worse than refusing: the redirect URI
     * has to match the one registered with the provider exactly, so a guessed origin produces a
     * provider-side error nobody can read from here.
     */
    const baseUrl = baseUrlFor(request);
    const nonce = generateSsoNonce();

    const state = issueSsoState({
      provider,
      organizationId: admitted.organizationId,
      nonce,
      // Present only when this is a link rather than a sign-in.
      linkUserId: admitted.identity?.user.id ?? null,
      now: admitted.now,
    });

    // Null means no state secret. Fails closed rather than sending somebody to a provider whose
    // callback would then be unverifiable — which would be worse than not offering the button.
    if (state === null) {
      return jsonError(
        'sso_unconfigured',
        'Single sign-on is not configured on this deployment. An administrator has to set ' +
          'COMPASS_SSO_STATE_SECRET before it can be used.',
        503,
      );
    }

    const authorizeUrl = ssoAuthorizeUrl({
      provider,
      redirectUri: ssoRedirectUri(baseUrl, provider),
      state,
    });

    if (authorizeUrl === null) {
      return jsonError(
        'sso_unconfigured',
        `${provider === 'google' ? 'Google' : 'GitHub'} sign-in is not configured on this deployment. ` +
          'Compass will not offer a button that cannot work.',
        503,
      );
    }

    const response = NextResponse.redirect(authorizeUrl, { status: 303, headers: NO_STORE });
    return setSsoNonceCookie(response, request, nonce);
  } catch (error) {
    return failure(error);
  }
}
