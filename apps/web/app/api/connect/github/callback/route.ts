import { appendAuditLogEntry, storeIntegrationToken } from '@compass/auth';
import { SystemClock } from '@compass/clock';
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

import { guard, scopedFor } from '../../../../../lib/auth/guard';
import { NO_STORE } from '../../../../../lib/auth/http';
import { GITHUB_SOURCE_KEY, verifyConnectState } from '../../../../../lib/connect-source';

/**
 * `GET /api/connect/github/callback` — where GitHub returns after an install.
 *
 * ## Why this route is `public`, and what authorises it instead
 *
 * It arrives as a **top-level navigation from github.com with no cookie**, so there is no session to
 * authorise and requiring one would mean the feature cannot exist. It gets the same explicit `public`
 * treatment `/api/webhooks/[provider]` has, and for the same reason: what authorises it is *narrower*
 * than a session — an HMAC-signed `state` this deployment minted minutes earlier, naming the one
 * organization the credential may be stored against, compared in constant time inside a ten-minute
 * window.
 *
 * The organization therefore comes from the **signed state and never from a query parameter**. That is
 * the whole security argument: a caller who could choose the organization would store their own token
 * against somebody else's tenant, or read the install of a tenant they do not belong to.
 *
 * ## Failures answer a page, not JSON
 *
 * A person is looking at this in a browser, so every outcome is a redirect back to `/connect` carrying
 * a stated reason. A JSON error document would be the wrong thing to show somebody who just pressed a
 * button on GitHub — and the reasons are deliberately coarse in the URL (`state`, `exchange`) because
 * which check failed is a tuning signal.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/connect/github/callback';

/** Back to the connect screen, with an outcome it can state. Relative to this deployment's own origin. */
const backToConnect = (request: Request, outcome: string): NextResponse =>
  NextResponse.redirect(new URL(`/connect?github=${outcome}`, request.url).toString(), {
    status: 303,
    headers: NO_STORE,
  });

export async function GET(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'GET' });
  if (!admitted.allowed && !admitted.unavailable) return admitted.response;

  // The edge's own clock, resolved once. `guard` supplies one on the admitted path; this route also
  // runs when the guard could not reach the database, so it cannot depend on that.
  const now = admitted.allowed ? admitted.now : new SystemClock().now();

  const url = new URL(request.url);
  const verdict = verifyConnectState({ state: url.searchParams.get('state'), now });

  if (!verdict.ok) {
    // One outcome for every failure, naming none of them. `unconfigured` is the operator's own
    // misconfiguration and is distinguished, because that one *is* actionable and is not a signal an
    // attacker can use.
    return backToConnect(request, verdict.reason === 'unconfigured' ? 'not-configured' : 'state-rejected');
  }

  /**
   * The installation token GitHub hands back.
   *
   * `installation_id` is what a GitHub App callback carries; the short-lived installation *access*
   * token is minted from it by a signed JWT exchange against the App's private key. That exchange is
   * deliberately not done here: this pass stores the installation id as the credential Compass holds,
   * and the JWT-signing exchange lands with the token-refresh work in pass 2. Storing it through the
   * same sealed path means nothing about the storage changes when the exchange arrives.
   */
  const installationId = url.searchParams.get('installation_id');
  if (installationId === null || installationId.trim().length === 0) {
    return backToConnect(request, 'exchange-failed');
  }

  try {
    const scoped = scopedFor(verdict.organizationId);

    // Sealed before it reaches the database, under the organization's own data key. `storeIntegrationToken`
    // returns a *description* and never the value, so this route physically cannot echo what it stored.
    await storeIntegrationToken(
      scoped,
      { sourceKey: GITHUB_SOURCE_KEY, tokenKind: 'access', token: installationId.trim() },
      now,
    );

    // Connecting a source is a change to what Compass reads about an organization, so it is on the
    // record with the acting principal — the same treatment a seat change or an anonymization gets.
    await appendAuditLogEntry(
      scoped,
      {
        id: randomUUID(),
        actorUserId: admitted.allowed ? (admitted.identity?.user.id ?? null) : null,
        action: 'connector.connected',
        subjectKind: 'connector',
        subjectId: GITHUB_SOURCE_KEY,
        detail: 'GitHub was connected. Compass reads the selected repositories with read-only permissions.',
      },
      now,
    );

    return backToConnect(request, 'connected');
  } catch {
    // The credential could not be sealed or stored — most often no `COMPASS_KMS_MASTER_KEY`, which is
    // required before Compass will store any OAuth credential at all.
    return backToConnect(request, 'storage-failed');
  }
}
