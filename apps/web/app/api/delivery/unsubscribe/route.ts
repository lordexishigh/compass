import { deactivateSubscription, findSubscriptionByUnsubscribeHash } from '@compass/db';
import type { NextResponse } from 'next/server';

import { guard } from '../../../../lib/auth/guard';
import { failure, jsonError, jsonOk } from '../../../../lib/auth/http';

/**
 * `POST /api/delivery/unsubscribe` — RFC 8058 one-click unsubscribe.
 *
 * This is the endpoint the `List-Unsubscribe` header points at, and the pair of headers
 * `renderEmail` emits is what makes a mail client show its own unsubscribe button and POST here
 * without the reader ever leaving their inbox. An unsubscribe a reader cannot find becomes a spam
 * report, which costs the sending domain far more than the unsubscribe would have.
 *
 * ## Public by necessity, and why that is safe
 *
 * A one-click POST arrives from a mail client with no cookies, so this route cannot require a
 * session. What authorises it is the token: 128 bits of CSPRNG entropy, unique per subscription.
 * The worst a holder can do is switch off one person's daily — and because the row is kept rather
 * than deleted, that is reversible from the roster screen.
 *
 * ## Idempotent, because clients really do POST twice
 *
 * A second click, a retried request, or a mail client that pre-fetches all answer 200 with the
 * same body. A 404-on-second-click would look like a broken link to the one person trying to
 * make the mail stop, which is the worst moment to look broken.
 *
 * ## GET is deliberately absent
 *
 * RFC 8058 requires a POST precisely so that a link-scanner or an email-preview fetch cannot
 * unsubscribe somebody by looking at the message. Serving the same effect on GET would undo that.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/delivery/unsubscribe';

/**
 * The token, from the query string or the form body.
 *
 * Both, because mail clients differ: some POST the `List-Unsubscribe` URL untouched with its query
 * string, others send `List-Unsubscribe=One-Click` as a form body. Reading both is what makes the
 * button work in more than one client.
 */
async function presentedToken(request: Request): Promise<string | null> {
  const fromQuery = new URL(request.url).searchParams.get('token');
  if (fromQuery !== null && fromQuery.trim().length > 0) return fromQuery.trim();

  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const body = new URLSearchParams(await request.text());
    const fromForm = body.get('token');
    if (fromForm !== null && fromForm.trim().length > 0) return fromForm.trim();
  }

  return null;
}

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  const token = await presentedToken(request);
  if (token === null) {
    return jsonError(
      'invalid_request',
      'This unsubscribe link carries no token. Use the link from the email, or turn the daily off on the report page.',
      400,
    );
  }

  try {
    const subscription = await findSubscriptionByUnsubscribeHash(admitted.scoped, token);

    // A token matching nothing answers 200, not 404: this route must not become an oracle for
    // which unsubscribe tokens exist, and the reader's intent — "stop sending me this" — is
    // satisfied either way for any subscription they could actually have.
    if (subscription === null) {
      return jsonOk({
        unsubscribed: true,
        detail: 'You will not receive this daily report. Nothing further is needed.',
      });
    }

    if (subscription.active) {
      await deactivateSubscription(admitted.scoped, subscription.id, admitted.now);
    }

    return jsonOk({
      unsubscribed: true,
      channel: subscription.channel,
      detail:
        `The ${subscription.channel === 'email' ? 'email' : 'Slack'} daily is switched off. The report is still ` +
        'readable in Compass, and you can turn delivery back on from the report page whenever you want it again.',
    });
  } catch (error) {
    return failure(error);
  }
}
