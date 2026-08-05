import {
  fetchSsoProfile,
  isSsoProvider,
  issueSecondFactorChallenge,
  linkIdentityToAccount,
  resolveFederatedSignIn,
  startSession,
  verifySsoState,
  type SsoProvider,
} from '@compass/auth';
import { SystemClock } from '@compass/clock';
import { fetchHttpClient } from '@compass/connector-port';
import { findSecondFactor } from '@compass/db';
import { NextResponse } from 'next/server';

import { clearSsoNonceCookie, readSsoNonceCookie, setSessionCookie } from '../../../../../../lib/auth/cookies';
import { baseUrlFor, guard, scopedFor } from '../../../../../../lib/auth/guard';
import { NO_STORE } from '../../../../../../lib/auth/http';
import { SIGNED_IN_LANDING_PATH } from '../../../../../../lib/auth/login';
import { ssoRedirectUri } from '../../../../../../lib/sso-source';

/**
 * `GET /api/auth/sso/[provider]/callback` — where Google and GitHub return.
 *
 * ## Why this route is `public`, and what authorises it instead
 *
 * It arrives as a **top-level navigation from the provider with no session** — that is the whole point
 * of a sign-in — so requiring one would be circular. It gets the same explicit `public` treatment
 * `/api/connect/github/callback` and `/api/auth/2fa/challenge` have, and what authorises it is
 * narrower than a session: an HMAC-signed `state` this deployment minted minutes earlier, naming the
 * one organization the identity may be attached to, plus a nonce cookie that ties the callback to the
 * browser that began the flow.
 *
 * **The organization comes from the signed state and never from a query parameter.** That is the
 * security argument: a caller who could choose the organization would attach their own Google identity
 * to a seat in somebody else's tenant.
 *
 * ## Every outcome is a redirect, because a person is looking at this
 *
 * A JSON error document is the wrong thing to show somebody who just pressed a button on Google. So
 * failures land back on `/account` with a coarse, stated reason — coarse deliberately: *which* check
 * failed is a tuning signal for anybody probing.
 *
 * ## The second factor is still enforced
 *
 * A person with 2FA active who signs in with Google is asked for their code, exactly as a password
 * sign-in is. Stated because the other choice is defensible and this one is deliberate: Compass cannot
 * see whether Google actually applied a second factor to *this* sign-in, and treating a federated
 * sign-in as self-evidently two-factor would silently downgrade every account that had turned it on.
 * The code step is the same signed challenge the password path issues, so there is one implementation.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/auth/sso/[provider]/callback';

/** Back to the account screen with an outcome it can state. Relative to this deployment's own origin. */
const back = (request: Request, outcome: string, provider?: SsoProvider): NextResponse => {
  const url = new URL('/account', request.url);
  url.searchParams.set('sso', outcome);
  if (provider !== undefined) url.searchParams.set('provider', provider);

  return NextResponse.redirect(url.toString(), { status: 303, headers: NO_STORE });
};

export async function GET(
  request: Request,
  context: { params: Promise<{ provider: string }> },
): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'GET' });
  // A callback must still answer when the guard could not reach the database, for the same reason the
  // GitHub install callback does: the person is mid-flow in a browser and needs a page, not a 503 body.
  if (!admitted.allowed && !admitted.unavailable) return admitted.response;

  const now = admitted.allowed ? admitted.now : new SystemClock().now();
  const { provider: rawProvider } = await context.params;

  if (!isSsoProvider(rawProvider)) return back(request, 'unknown-provider');
  const provider = rawProvider;

  const url = new URL(request.url);

  /**
   * A provider-side refusal, handled before the state.
   *
   * `error=access_denied` is somebody pressing "Cancel" on the consent screen, which is not a failure
   * and must not be reported as one — they get the account screen back with nothing said beyond that
   * the sign-in was cancelled.
   */
  const providerError = url.searchParams.get('error');
  if (providerError !== null && providerError.length > 0) {
    return clearSsoNonceCookie(
      back(request, providerError === 'access_denied' ? 'cancelled' : 'provider-error', provider),
      request,
    );
  }

  const verdict = verifySsoState({
    state: url.searchParams.get('state'),
    nonce: readSsoNonceCookie(request),
    now,
  });

  if (!verdict.ok) {
    return clearSsoNonceCookie(
      back(request, verdict.reason === 'unconfigured' ? 'not-configured' : 'state-rejected', provider),
      request,
    );
  }

  // The state named the provider too, so a callback delivered to the wrong provider's path — which
  // would mean a mismatched redirect URI at the token exchange — is refused here with a clear reason.
  if (verdict.state.provider !== provider) {
    return clearSsoNonceCookie(back(request, 'state-rejected', provider), request);
  }

  const code = url.searchParams.get('code');
  if (code === null || code.trim().length === 0) {
    return clearSsoNonceCookie(back(request, 'no-code', provider), request);
  }

  try {
    const baseUrl = baseUrlFor(request);

    const profile = await fetchSsoProfile({
      provider,
      code: code.trim(),
      // The same redirect URI the authorization request carried. Providers compare them, and a
      // mismatch is the commonest cause of a failed exchange — which is why both come from one helper.
      redirectUri: ssoRedirectUri(baseUrl, provider),
      // Injected rather than reached for, so a test can watch which requests left the process.
      http: fetchHttpClient(),
    });

    if (!profile.ok) {
      return clearSsoNonceCookie(
        back(request, profile.reason === 'no_email' ? 'no-email' : 'exchange-failed', provider),
        request,
      );
    }

    // From the signed state, never from a query parameter or the current cookie.
    const scoped = scopedFor(verdict.state.organizationId);

    const assertion = {
      provider,
      subject: profile.profile.subject,
      email: profile.profile.email,
      emailVerified: profile.profile.emailVerified,
      displayName: profile.profile.displayName,
    } as const;

    /**
     * The linking branch: this flow was started by somebody already signed in.
     *
     * No session is minted and no session is replaced — they already have one. The provider's
     * verification state is recorded but is not load-bearing here, because the person has already
     * proved who they are with a credential Compass issued.
     */
    if (verdict.state.linkUserId !== null) {
      const linked = await linkIdentityToAccount({
        scoped,
        userId: verdict.state.linkUserId,
        assertion,
        now,
      });

      return clearSsoNonceCookie(
        back(request, linked.ok ? 'linked' : 'already-linked-elsewhere', provider),
        request,
      );
    }

    const resolution = await resolveFederatedSignIn({ scoped, assertion, now });

    if (resolution.kind === 'refused') {
      return clearSsoNonceCookie(back(request, refusalOutcome(resolution.reason), provider), request);
    }

    /**
     * The second factor, before any session exists — the same order the password path uses.
     *
     * A session that exists is a session that works, so an account with 2FA active gets no cookie
     * here: it gets the signed challenge, and the code step mints the session. See the header for why
     * a federated sign-in is not treated as self-evidently two-factor.
     */
    const secondFactor = await findSecondFactor(scoped, resolution.user.id);

    if (secondFactor !== null && secondFactor.activatedAt !== null) {
      const challenge = issueSecondFactorChallenge({ userId: resolution.user.id, now });

      // Fails closed. A missing challenge secret must not downgrade a 2FA account to one factor.
      if (challenge === null) {
        return clearSsoNonceCookie(back(request, 'second-factor-unconfigured', provider), request);
      }

      /**
       * Back to `/account`, carrying the challenge, where the sign-in panel renders the code step.
       *
       * Not a redirect to `/api/auth/2fa/challenge`: that endpoint takes a JSON body and answers JSON,
       * and this caller is a browser mid-navigation. The panel is where the code form already lives, so
       * routing through it means the SSO and password paths present the *same* prompt rather than two.
       *
       * The challenge travels in the query string, and that is acceptable rather than merely
       * convenient: it is a five-minute signed ticket that authorises exactly one act — presenting a
       * code for one user — and it is worthless without the code, whose own replay rejection is durable
       * in the database. `second-factor-challenge.ts` records the same reasoning for why it is signed
       * rather than stored.
       */
      const url2fa = new URL('/account', request.url);
      url2fa.searchParams.set('sso', 'second-factor');
      url2fa.searchParams.set('challenge', challenge);

      return clearSsoNonceCookie(
        NextResponse.redirect(url2fa.toString(), { status: 303, headers: NO_STORE }),
        request,
      );
    }

    /**
     * One session, minted by the same helper the password path calls.
     *
     * `startSession` is what freezes the absolute deadline and records the lineage, so an SSO session
     * obeys the identical rotation and expiry rules — which is the acceptance criterion, and it holds
     * because there is one implementation rather than because two were written to match.
     */
    const started = await startSession({ scoped, userId: resolution.user.id, now });

    const response = NextResponse.redirect(new URL(SIGNED_IN_LANDING_PATH, request.url).toString(), {
      status: 303,
      headers: NO_STORE,
    });

    return clearSsoNonceCookie(setSessionCookie(response, request, started.secret), request);
  } catch {
    /**
     * One coarse outcome, and nothing about the cause.
     *
     * `failure()` is not used here on purpose: it answers with a JSON body, and this route's caller is
     * a browser mid-navigation. The detail is still logged by the layers underneath.
     */
    return clearSsoNonceCookie(back(request, 'failed', provider), request);
  }
}

const refusalOutcome = (reason: 'email_unverified' | 'no_seat' | 'seat_revoked'): string =>
  reason === 'email_unverified' ? 'email-unverified' : reason === 'seat_revoked' ? 'seat-revoked' : 'no-seat';
