import type { NextResponse } from 'next/server';

import { guard } from '../../../../../lib/auth/guard';
import { failure, isFormSubmission, jsonError, jsonOk, seeOther } from '../../../../../lib/auth/http';
import {
  CONNECT_STATE_SECRET_ENV_VAR,
  connectStartUrlFor,
  isConnectProviderId,
  providerById,
} from '../../../../../lib/connect-source';

/**
 * `POST /api/connect/[provider]/install` — start an install or an OAuth grant.
 *
 * Owner only, and a POST rather than a GET on purpose: it mints a CSRF `state` and sends the browser to a
 * third party, which is a state-changing act. A GET would be prefetchable by a browser and followable from
 * a link somebody was sent.
 *
 * ## Why one route for three providers
 *
 * Because the route's own logic is identical for all three — check the role, mint a state, redirect — and
 * every difference between them is *configuration*: which scopes, which authorize URL, which environment
 * variables. That configuration lives in `PROVIDERS` and in the three connector packages, and this handler
 * reads it. Three copies of this file is how the fourth provider ends up with a subtly different `state`
 * lifetime, and how one of them quietly stops checking the role.
 *
 * ## What it does not do
 *
 * It names no permission at all. Each install URL is built by the provider's own package from that
 * provider's own scope constant, so if a scope is ever added it appears in the URL and on the connect
 * screen together or in neither.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/connect/[provider]/install';

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly provider: string }> },
): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  const { provider: raw } = await context.params;
  if (!isConnectProviderId(raw)) {
    return jsonError(
      'unknown_provider',
      `Compass has no connector called "${raw}". The connectable sources are a code host, a tracker and ` +
        'named chat channels.',
      404,
    );
  }

  try {
    const url = connectStartUrlFor({
      providerId: raw,
      organizationId: admitted.organizationId,
      now: admitted.now,
    });

    if (url === null) {
      const provider = providerById(raw);
      // Configuration, stated rather than a crash — the same posture every optional capability takes.
      return jsonError(
        'connect_not_configured',
        `Connecting ${provider.name} needs ${provider.requiredEnvVars.join(' and ')} set on this deployment. ` +
          'Compass will not send you to an install it cannot verify the return of: without a state secret ' +
          `the callback would accept a forged organization. ${CONNECT_STATE_SECRET_ENV_VAR} is the one that ` +
          'matters most.',
        503,
      );
    }

    // A browser navigates; a script gets the URL. Same split, and the same reasoning, as checkout.
    return isFormSubmission(request) ? seeOther(url) : jsonOk({ url });
  } catch (error) {
    return failure(error);
  }
}
