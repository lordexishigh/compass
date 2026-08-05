import { storeIntegrationToken } from '@compass/auth';
import { SystemClock, instantFromEpochMillis, toEpochMillis } from '@compass/clock';
import { fetchHttpClient } from '@compass/connector-port';
import { appendAuditLogEntry, saveSourceConfig } from '@compass/db';
import { exchangeJiraAuthorizationCode } from '@compass/jira-connector';
import { exchangeSlackAuthorizationCode } from '@compass/slack-connector';
import { NextResponse } from 'next/server';

import { guard, scopedFor } from '../../../../../lib/auth/guard';
import { NO_STORE } from '../../../../../lib/auth/http';
import { connectorIdFor } from '../../../../../lib/connect-scope';
import {
  JIRA_CLIENT_ID_ENV_VAR,
  JIRA_CLIENT_SECRET_ENV_VAR,
  SLACK_CLIENT_ID_ENV_VAR,
  SLACK_CLIENT_SECRET_ENV_VAR,
  connectRedirectUri,
  findProviderConfig,
  isConnectProviderId,
  providerById,
  verifyConnectState,
  type ConnectProviderId,
} from '../../../../../lib/connect-source';

/**
 * `GET /api/connect/[provider]/callback` — where a provider returns after a grant.
 *
 * ## Why this route is `public`, and what authorises it instead
 *
 * It arrives as a **top-level navigation from the provider with no cookie**, so there is no session to
 * authorise and requiring one would mean the feature cannot exist. It gets the same explicit `public`
 * treatment `/api/webhooks/[provider]` has, and for the same reason: what authorises it is *narrower* than
 * a session — an HMAC-signed `state` this deployment minted minutes earlier, naming the one organization
 * the credential may be stored against **and the one provider flow it belongs to**, compared in constant
 * time inside a ten-minute window.
 *
 * The organization therefore comes from the signed state and never from a query parameter. That is the
 * whole security argument: a caller who could choose the organization would store their own token against
 * somebody else's tenant. Binding the provider into the signature is the second half of it — without that,
 * a state minted for the chat flow could be replayed against the tracker's callback and store a chat token
 * under the tracker's source key, where the tracker connector would then try to use it.
 *
 * ## Failures answer a page, not JSON
 *
 * A person is looking at this in a browser, so every outcome is a redirect back to `/connect` carrying a
 * stated reason. A JSON error document would be the wrong thing to show somebody who just pressed a button
 * on a provider's consent screen — and the reasons are deliberately coarse in the URL because which check
 * failed is a tuning signal.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/connect/[provider]/callback';

/** Back to the connect screen, with an outcome it can state. Relative to this deployment's own origin. */
const backToConnect = (request: Request, providerId: string, outcome: string): NextResponse =>
  NextResponse.redirect(new URL(`/connect?${providerId}=${outcome}`, request.url).toString(), {
    status: 303,
    headers: NO_STORE,
  });

/** What a successful grant yields: a credential to seal, and any settings the connector needs to address it. */
interface GrantedCredential {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresInSeconds: number | null;
  /** Opaque, provider-specific addressing — a tracker's site id. Never a secret. */
  readonly settings: Readonly<Record<string, string>>;
}

/**
 * The code exchange, per provider.
 *
 * ## Why GitHub does not exchange anything here
 *
 * A GitHub App callback carries an `installation_id`, which is a durable identifier rather than a
 * single-use code: the short-lived installation *access* token is minted from it by a signed JWT exchange
 * against the App's private key, on demand, at ingest time. So the credential Compass stores is the
 * installation id, and there is nothing to exchange at connect time.
 *
 * Jira and Slack are the opposite case: their callbacks carry a `code` that is single-use and expires in
 * minutes, so an implementation that stored it would have stored something already dead. Those two must
 * exchange it here, which is why this function takes an `HttpClient` — the same seam the connectors use, so
 * the exchange is testable without a network.
 */
async function exchange(
  providerId: ConnectProviderId,
  url: URL,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<GrantedCredential | { readonly failed: 'exchange-failed' | 'no-site' }> {
  if (providerId === 'github') {
    const installationId = (url.searchParams.get('installation_id') ?? '').trim();
    if (installationId.length === 0) return { failed: 'exchange-failed' };
    return { accessToken: installationId, refreshToken: null, expiresInSeconds: null, settings: {} };
  }

  const code = (url.searchParams.get('code') ?? '').trim();
  if (code.length === 0) return { failed: 'exchange-failed' };

  const http = fetchHttpClient();
  const redirectUri = connectRedirectUri(providerId, environment);

  if (providerId === 'jira') {
    const outcome = await exchangeJiraAuthorizationCode({
      http,
      clientId: (environment[JIRA_CLIENT_ID_ENV_VAR] ?? '').trim(),
      clientSecret: (environment[JIRA_CLIENT_SECRET_ENV_VAR] ?? '').trim(),
      code,
      redirectUri,
    });
    if (!outcome.ok) return { failed: outcome.reason === 'no_accessible_site' ? 'no-site' : 'exchange-failed' };

    return {
      accessToken: outcome.accessToken,
      refreshToken: outcome.refreshToken,
      expiresInSeconds: outcome.expiresInSeconds,
      // The site id is how `api.atlassian.com` routes, so the connector cannot address anything without
      // it. Not a secret — it says *which site*, not what may be done to it — so it lives in the
      // configuration blob rather than in the sealed table.
      settings: { cloudId: outcome.cloudId, siteName: outcome.siteName },
    };
  }

  const outcome = await exchangeSlackAuthorizationCode({
    http,
    clientId: (environment[SLACK_CLIENT_ID_ENV_VAR] ?? '').trim(),
    clientSecret: (environment[SLACK_CLIENT_SECRET_ENV_VAR] ?? '').trim(),
    code,
    redirectUri,
  });
  if (!outcome.ok) return { failed: 'exchange-failed' };

  return {
    accessToken: outcome.botToken,
    refreshToken: null,
    expiresInSeconds: null,
    settings: { workspaceName: outcome.workspaceName },
  };
}

export async function GET(
  request: Request,
  context: { readonly params: Promise<{ readonly provider: string }> },
): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'GET' });
  if (!admitted.allowed && !admitted.unavailable) return admitted.response;

  const { provider: raw } = await context.params;
  if (!isConnectProviderId(raw)) {
    return NextResponse.redirect(new URL('/connect', request.url).toString(), { status: 303, headers: NO_STORE });
  }
  const provider = providerById(raw);

  // The edge's own clock, resolved once. `guard` supplies one on the admitted path; this route also runs
  // when the guard could not reach the database, so it cannot depend on that.
  const now = admitted.allowed ? admitted.now : new SystemClock().now();

  const url = new URL(request.url);
  const verdict = verifyConnectState({ state: url.searchParams.get('state'), now, providerId: raw });

  if (!verdict.ok) {
    // One outcome for every failure, naming none of them. `unconfigured` is the operator's own
    // misconfiguration and is distinguished, because that one *is* actionable and is not a signal an
    // attacker can use.
    return backToConnect(request, raw, verdict.reason === 'unconfigured' ? 'not-configured' : 'state-rejected');
  }

  const granted = await exchange(raw, url, process.env);
  if ('failed' in granted) return backToConnect(request, raw, granted.failed);

  try {
    const scoped = scopedFor(verdict.organizationId);

    // Sealed before it reaches the database, under the organization's own data key. `storeIntegrationToken`
    // returns a *description* and never the value, so this route physically cannot echo what it stored.
    await storeIntegrationToken(
      scoped,
      {
        sourceKey: provider.sourceKey,
        tokenKind: 'access',
        token: granted.accessToken,
        ...(granted.expiresInSeconds === null
          ? {}
          : { expiresAt: instantFromEpochMillis(toEpochMillis(now) + granted.expiresInSeconds * 1000) }),
      },
      now,
    );

    if (granted.refreshToken !== null) {
      // Stored separately and sealed the same way. Its absence is a supported state — a grant without
      // `offline_access` simply expires — so this is a conditional write rather than a required one.
      await storeIntegrationToken(
        scoped,
        { sourceKey: provider.sourceKey, tokenKind: 'refresh', token: granted.refreshToken },
        now,
      );
    }

    /**
     * The source's configuration, written or updated but never emptied.
     *
     * A reconnect must not discard the repositories, projects or channels a manager already chose — that
     * is most of the ten minutes the connect flow is measured against, and asking for them twice is how a
     * reconnect becomes something people put off. So the existing selections are read and carried
     * forward, and only the provider settings are replaced.
     */
    const existing = await findProviderConfig(scoped, raw);
    await saveSourceConfig(
      scoped,
      {
        sourceKey: provider.sourceKey,
        sourceKind: provider.sourceKind,
        connectorId: connectorIdFor(raw),
        enabled: true,
        selections: existing?.selections ?? [],
        settings: granted.settings,
      },
      now,
    );

    /**
     * Connecting a source is a change to what Compass reads about an organization, so it is on the
     * record — the same treatment a seat change or an anonymization gets.
     *
     * `actorUserId` is null here and that is honest rather than lazy: a callback carries no cookie, so
     * there is no session to attribute it to. What *is* known is the organization, which came from the
     * signed state. `before`/`after` carry the connection state rather than any part of the credential.
     */
    await appendAuditLogEntry(scoped, {
      actorUserId: null,
      action: 'connector.connected',
      targetKind: 'connector',
      targetId: provider.sourceKey,
      before: { connected: false },
      after: {
        connected: true,
        access: 'read-only',
        sourceKind: provider.sourceKind,
        selectionCount: existing?.selections.length ?? 0,
      },
      occurredAt: now,
    });

    return backToConnect(request, raw, 'connected');
  } catch {
    // The credential could not be sealed or stored — most often no `COMPASS_KMS_MASTER_KEY`, which is
    // required before Compass will store any OAuth credential at all.
    return backToConnect(request, raw, 'storage-failed');
  }
}
