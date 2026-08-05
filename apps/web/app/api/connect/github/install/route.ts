import type { NextResponse } from 'next/server';

import { guard } from '../../../../../lib/auth/guard';
import { failure, isFormSubmission, jsonError, jsonOk, seeOther } from '../../../../../lib/auth/http';
import {
  CONNECT_STATE_SECRET_ENV_VAR,
  GITHUB_APP_SLUG_ENV_VAR,
  githubInstallUrlFor,
} from '../../../../../lib/connect-source';

/**
 * `POST /api/connect/github/install` — start a GitHub App installation.
 *
 * Owner only, and a POST rather than a GET on purpose: it mints a CSRF `state` and sends the browser
 * to a third party, which is a state-changing act. A GET would be prefetchable by a browser and
 * followable from a link somebody was sent.
 *
 * ## What it does not do
 *
 * It does not request scopes. The install URL is built by `githubInstallUrl` from `GITHUB_SCOPES` in
 * `@compass/github-connector`, so this route names no permission at all — which is the whole point of
 * the single declaration. If a permission is ever added, it appears in the URL and on the connect
 * screen together or in neither.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/connect/github/install';

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  try {
    const url = githubInstallUrlFor({
      organizationId: admitted.organizationId,
      now: admitted.now,
    });

    if (url === null) {
      // Configuration, stated rather than a crash — the same posture every optional capability takes.
      return jsonError(
        'connect_not_configured',
        `Connecting GitHub needs ${GITHUB_APP_SLUG_ENV_VAR} and ${CONNECT_STATE_SECRET_ENV_VAR} set on this ` +
          'deployment. Compass will not send you to an install it cannot verify the return of: without a ' +
          'state secret the callback would accept a forged organization.',
        503,
      );
    }

    // A browser navigates; a script gets the URL. Same split, and the same reasoning, as checkout.
    return isFormSubmission(request) ? seeOther(url) : jsonOk({ url });
  } catch (error) {
    return failure(error);
  }
}
