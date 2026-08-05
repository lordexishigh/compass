import { digestSecret } from '@compass/auth';
import { SystemClock } from '@compass/clock';
import { confirmNoticeSubscriber, unsubscribeFromSubprocessorNotices } from '@compass/db';
import { NextResponse } from 'next/server';

import { guard, requestOrganizationId, scopedFor } from '../../../../../lib/auth/guard';
import { NO_STORE } from '../../../../../lib/auth/http';

/**
 * `GET /api/trust/subprocessor-notices/confirm` — spend a confirmation or unsubscribe link.
 *
 * ## One route for both directions, and why that is not laziness
 *
 * Both links are the *same token* doing the same job: proving the holder controls the address. Confirming
 * and unsubscribing are then two values of one parameter. Splitting them would mean two routes, two
 * matrix rows and two places to get the constant-time comparison right, for no difference a reader could
 * observe.
 *
 * ## `public`, and authorised by the token alone
 *
 * A GET from an email client carries no cookie and the subscriber has no account, so a session is not
 * available even in principle. The token is narrower than a session: it authorises exactly one address's
 * subscription and nothing else, and it is compared by digest so the database never holds the value that
 * would let somebody unsubscribe a third party.
 *
 * ## Why unsubscribing is idempotent and silent about misses
 *
 * A token that matches nothing gets the same page as one that matched. An unsubscribe link that reported
 * "no such subscription" would confirm to anybody holding a stale link whether an address is still on the
 * list — and the honest reading of a second click is that the person wanted to be off the list, which
 * they are.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/trust/subprocessor-notices/confirm';

const backToPage = (request: Request, outcome: string): NextResponse =>
  NextResponse.redirect(new URL(`/trust/subprocessors?notice=${outcome}`, request.url).toString(), {
    status: 303,
    headers: NO_STORE,
  });

export async function GET(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'GET' });
  if (!admitted.allowed && !admitted.unavailable) return admitted.response;

  // The edge's own clock. `guard` supplies one when it could reach the database; this route also has to
  // work when it could not, so it cannot depend on that.
  const now = admitted.allowed ? admitted.now : new SystemClock().now();

  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const wantsUnsubscribe = url.searchParams.get('action') === 'unsubscribe';

  if (token === null || token.length === 0) return backToPage(request, 'link-rejected');

  try {
    const scoped = scopedFor(requestOrganizationId());
    const hash = digestSecret(token);

    if (wantsUnsubscribe) {
      await unsubscribeFromSubprocessorNotices(scoped, hash);
      // Silent about whether a row was there. See the note above.
      return backToPage(request, 'unsubscribed');
    }

    const confirmed = await confirmNoticeSubscriber(scoped, hash, now);
    return backToPage(request, confirmed === null ? 'link-rejected' : 'confirmed');
  } catch (error) {
    /**
     * An infrastructure failure is not a bad link, and must not be reported as one.
     *
     * The previous `catch {}` collapsed the two: a database outage told the subscriber their confirmation
     * link had been rejected — which is a lie that they cannot act on, since the link is fine and clicking
     * it again would work — and left no trace for whoever could have fixed it. Somebody would then be
     * silently absent from the notice list they had deliberately joined.
     *
     * So the error is logged in the same shape as `failure()` in `lib/auth/http.ts`, and the outcome is
     * distinct: `unavailable` says the request could not be completed and to try the link again, rather
     * than accusing the link.
     */
    console.error(
      `[compass] subprocessor notice confirmation failed: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }`,
    );

    return backToPage(request, 'unavailable');
  }
}
