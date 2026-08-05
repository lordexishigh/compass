import {
  issueSecondFactorChallenge,
  resolveFederatedSignIn,
  startSession,
  verifySamlResponse,
  type SamlRefusal,
} from '@compass/auth';
import { SystemClock } from '@compass/clock';
import { claimAssertionId, findSamlConnection, findSecondFactor, samlConnectionIsEnabled } from '@compass/db';
import { NextResponse } from 'next/server';

import { setSessionCookie } from '../../../../../lib/auth/cookies';
import { baseUrlFor, guard, scopedFor } from '../../../../../lib/auth/guard';
import { NO_STORE } from '../../../../../lib/auth/http';
import { SIGNED_IN_LANDING_PATH } from '../../../../../lib/auth/login';
import { enterpriseIdentityAllowed, samlAcsUrl, samlEntityId } from '../../../../../lib/sso-source';

/**
 * `POST /api/auth/saml/acs` — the Assertion Consumer Service.
 *
 * ## Why this route is `public`, and what authorises it instead
 *
 * A SAML response arrives as a **form POST from the user's browser, redirected there by the identity
 * provider, with no Compass session** — that is the entire mechanism. Requiring a session would be
 * circular in exactly the way requiring one on `/api/auth/login` would be.
 *
 * What authorises it is strictly narrower than a session and is not a cookie at all: an RSA-SHA256
 * signature over the assertion, verified against the certificate this organization's owner configured,
 * plus an issuer match, an audience match, a recipient match, a validity window, and a one-shot claim
 * against the replay ledger. That is a bar an authenticated *manager* cannot clear.
 *
 * ## The order of the checks is the design
 *
 * 1. **Plan gate**, first, so a deployment that has not bought SAML never parses attacker-supplied XML
 *    at all. Cheap, and it reduces the attack surface to nothing on most tenants.
 * 2. **Signature and every semantic check**, in `verifySamlResponse` — pure, no database, no clock.
 * 3. **Replay claim**, last before a session exists. It is an INSERT against a unique index, so it is
 *    atomic under concurrency; and it comes *after* verification so that an unverifiable assertion
 *    cannot burn a legitimate id, which would be a denial-of-service primitive against a real user.
 *
 * ## `RelayState` is never followed
 *
 * IdPs echo it back and it is tempting to treat it as "where to go next". It is refused as a
 * destination: it is attacker-controllable, and following it would be an open redirect on the one
 * endpoint in the product that mints a session. Everybody lands on the report.
 *
 * ## Every refusal is a slug, never a sentence in the URL
 *
 * `lib/sso-source.ts` explains why at length: a `detail` parameter the page printed would let anybody
 * display arbitrary text in Compass's own typography on Compass's own domain.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/auth/saml/acs';

/** Back to the sign-in screen with a slug it looks the sentence up from. */
const refuse = (request: Request, slug: string): NextResponse => {
  const url = new URL('/account', request.url);
  url.searchParams.set('saml', slug);

  return NextResponse.redirect(url.toString(), { status: 303, headers: NO_STORE });
};

/**
 * Which slug a verification refusal maps to.
 *
 * Deliberately many-to-one. Every distinct signature failure — a bad digest, an unsupported algorithm,
 * a duplicated id — becomes `signature`, because the difference between them is a tuning signal for
 * somebody probing the endpoint and the operator who needs the detail has the logs.
 */
const slugForRefusal = (refusal: SamlRefusal): string => {
  switch (refusal.kind) {
    case 'signature':
      return 'signature';
    case 'audience_mismatch':
      return 'audience';
    case 'issuer_mismatch':
    case 'recipient_mismatch':
      // Both mean "this assertion was not addressed to this Compass", which is what `audience` says.
      return 'audience';
    case 'expired':
    case 'not_yet_valid':
      return 'expired';
    case 'responder_error':
      return 'provider_refused';
    case 'encrypted':
      return 'encrypted';
    case 'no_email':
      return 'no_email';
    case 'no_subject':
    case 'malformed':
      return 'malformed';
  }
};

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'POST' });
  if (!admitted.allowed && !admitted.unavailable) return admitted.response;

  const now = admitted.allowed ? admitted.now : new SystemClock().now();

  if (!admitted.allowed) return refuse(request, 'unavailable');

  try {
    const scoped = scopedFor(admitted.organizationId);

    // 1. The plan gate, before a byte of the assertion is parsed.
    if (!(await enterpriseIdentityAllowed(scoped))) return refuse(request, 'not_allowed');

    const connection = await findSamlConnection(scoped);
    if (connection === null || !samlConnectionIsEnabled(connection)) {
      return refuse(request, 'not_configured');
    }

    /**
     * The form body. `SAMLResponse` is base64 of the XML, per the HTTP-POST binding.
     *
     * Read as form data directly rather than through `readFormOrJsonObject`: an IdP posts
     * `application/x-www-form-urlencoded` and never JSON, so the helper's JSON branch would be dead
     * code that obscured what this endpoint actually accepts.
     */
    const form = await request.formData();
    const encoded = form.get('SAMLResponse');

    if (typeof encoded !== 'string' || encoded.trim().length === 0) {
      return refuse(request, 'no_response');
    }

    const xml = Buffer.from(encoded.trim(), 'base64').toString('utf8');
    // `Buffer.from` never throws on bad base64 — it silently drops invalid characters — so an empty
    // result is the only signal that the input was not base64 at all.
    if (xml.trim().length === 0) return refuse(request, 'malformed');

    const baseUrl = baseUrlFor(request);

    // 2. Signature, issuer, audience, recipient and the validity window. Pure.
    const verdict = verifySamlResponse({
      xml,
      idpEntityId: connection.idpEntityId,
      idpCertificate: connection.idpCertificate,
      serviceProviderEntityId: samlEntityId(baseUrl),
      assertionConsumerServiceUrl: samlAcsUrl(baseUrl),
      now,
    });

    if (!verdict.ok) {
      /**
       * Logged in full, and answered coarsely.
       *
       * The operator debugging an IdP integration needs to know it was the digest and not the audience;
       * the browser must not be told. This is the seam where those two requirements are both met.
       */
      console.warn(
        `[compass] SAML assertion refused for organization ${admitted.organizationId}: ` +
          `${JSON.stringify(verdict.refusal)}`,
      );
      return refuse(request, slugForRefusal(verdict.refusal));
    }

    const accepted = verdict.accepted;

    /**
     * 3. The replay claim. An INSERT, and its result *is* the verdict.
     *
     * `false` means this assertion id has already been spent — the same captured assertion posted
     * twice. Refused with a sentence that does not say "already used", because confirming that a
     * captured assertion was genuine is a fact only somebody replaying one needs.
     */
    const claimed = await claimAssertionId(
      scoped,
      { assertionId: accepted.assertionId, issuer: accepted.issuer, notOnOrAfter: accepted.notOnOrAfter },
      now,
    );

    if (!claimed) return refuse(request, 'replayed');

    /**
     * Provisioning is allowed here, and only here.
     *
     * The assertion comes from the organization's *own* identity provider — the system that issues its
     * mailboxes — so it is the authority for that namespace in a way a consumer Google account is not.
     * The role is the connection's configured default, which the database forbids from being `owner`,
     * so an IdP administrator cannot mint themselves control of the Compass organization.
     */
    const resolution = await resolveFederatedSignIn({
      scoped,
      assertion: accepted.assertion,
      now,
      allowProvisioning: true,
      provisionRole: connection.defaultRole,
    });

    if (resolution.kind === 'refused') {
      return refuse(request, resolution.reason === 'seat_revoked' ? 'seat_revoked' : 'no_seat');
    }

    /**
     * The second factor, still enforced — before any session exists.
     *
     * Deliberate, and the same choice the OAuth callback makes: Compass cannot see whether the IdP
     * applied a second factor to *this* sign-in, so treating a SAML assertion as self-evidently
     * two-factor would silently downgrade every account that had turned Compass's own 2FA on.
     */
    const secondFactor = await findSecondFactor(scoped, resolution.user.id);

    if (secondFactor !== null && secondFactor.activatedAt !== null) {
      const challenge = issueSecondFactorChallenge({ userId: resolution.user.id, now });
      // Fails closed: a missing challenge secret must not downgrade a 2FA account to one factor.
      if (challenge === null) return refuse(request, 'failed');

      const url = new URL('/account', request.url);
      url.searchParams.set('sso', 'second-factor');
      url.searchParams.set('challenge', challenge);

      return NextResponse.redirect(url.toString(), { status: 303, headers: NO_STORE });
    }

    // The same helper the password and OAuth paths call, so rotation and both TTLs are inherited by
    // construction rather than by three call sites agreeing.
    const started = await startSession({ scoped, userId: resolution.user.id, now });

    const response = NextResponse.redirect(new URL(SIGNED_IN_LANDING_PATH, request.url).toString(), {
      status: 303,
      headers: NO_STORE,
    });

    return setSessionCookie(response, request, started.secret);
  } catch (error) {
    console.error(
      `[compass] SAML sign-in failed for organization ${admitted.organizationId}: ` +
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    return refuse(request, 'failed');
  }
}
