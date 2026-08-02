import { claimFeedbackLink } from '@compass/db';
import {
  FEEDBACK_LINK_SECRET_ENV_VAR,
  feedbackLinkIsStateChanging,
  verifyFeedbackToken,
} from '@compass/delivery';
import type { NextResponse } from 'next/server';

import { guard, type GuardAllowed } from '../../../../../lib/auth/guard';
import { failure, jsonError, jsonOk } from '../../../../../lib/auth/http';
import { applyManagerFeedback, parseFeedbackAction } from '../../../../../lib/feedback-source';

/**
 * `GET|POST /api/feedback/link/<token>` — the email channel's one click.
 *
 * ## Four properties, and each one is a deliberate refusal of something easier
 *
 * **Signed, and scoped to one item and one action.** The token is an HMAC over
 * `(version, organization, item, action, expiry, nonce)`, so it cannot be re-aimed at another item
 * or another verdict. There is no path from a valid token to reading a report or changing a setting.
 *
 * **Expires after 30 days.** The expiry is inside the signed payload, so it cannot be extended by
 * editing the URL — and the signature is checked *before* the expiry, because otherwise the handler
 * would be reasoning about a number an unauthenticated caller supplied.
 *
 * **Single-use for anything that changes state.** The digest is claimed in `feedback_link_uses` by a
 * plain insert, so the database refuses the second click; a read-then-write check would let a mail
 * client's prefetch and the manager's own click both through. A read-only action (`view`) is
 * deliberately *not* claimed: a link that shows something has nothing to spend, and burning it on a
 * scanner's prefetch would send the manager's real click to an error page.
 *
 * **It never authenticates a session.** No cookie is set, no session row is created, and the
 * response carries `no-store`. A capability to dismiss one risk must not become a way into the
 * organization's report — which is exactly what would happen if this route "helpfully" signed the
 * clicker in. `apps/web/tests/feedback-links.test.ts` asserts the absence of `set-cookie` directly,
 * because that is the kind of convenience somebody adds later in good faith.
 *
 * ## GET as well as POST
 *
 * A mail client follows a link with GET, and a daily whose buttons required a form post would have
 * no buttons at all. The single-use claim is what makes that safe: a GET that changes state is
 * normally a mistake because it is replayable, and here it provably is not. The claim happens
 * *before* the verdict is applied, so a prefetch that beats the manager to it spends the link and
 * the manager is told the link was used — an honest outcome, and the reason the report page's own
 * buttons are the primary affordance.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/feedback/link/[token]';

/**
 * The verdict, applied — everything after the guard.
 *
 * The guard itself is called by each verb rather than in here, and that is not a style choice:
 * `apps/web/tests/auth-http.test.ts` requires a `guard({ … })` call per verb the file serves, so
 * that a handler which forgot one is a build failure rather than an unguarded route nobody noticed.
 * Threading the admitted result in keeps one implementation of the effect while leaving the decision
 * visibly first in both entry points.
 */
async function consume(admitted: GuardAllowed, token: string): Promise<NextResponse> {
  // `token` verbatim: Next.js hands `params` already decoded, so decoding again would corrupt a token
  // that legitimately contained a percent sign and would throw `URIError` out of the handler — a 500
  // — for a stray `%` in a mangled URL, which is exactly the case the `malformed` verdict below
  // exists to answer with a sentence. A base64url signature has no character that needs escaping, so
  // there is nothing here that a second decode could have been for.
  const verification = verifyFeedbackToken(
    token,
    admitted.now,
    process.env[FEEDBACK_LINK_SECRET_ENV_VAR],
  );

  if (verification.verdict !== 'accepted') {
    // 410 for a link that was valid and is finished; 400 for one that never was; 503 for a
    // deployment that cannot verify at all. Three different facts, three different fixes.
    const status =
      verification.verdict === 'expired' ? 410 : verification.verdict === 'unconfigured' ? 503 : 400;
    return jsonError(verification.verdict, verification.detail, status);
  }

  const { claims, tokenDigest } = verification;

  // The token names its own tenant, and it must be the tenant this deployment is serving. A token
  // minted for another organization is refused rather than acted on in this one: the item id would
  // almost certainly match nothing, but "almost certainly" is not a security property.
  if (claims.organizationId !== admitted.organizationId) {
    return jsonError(
      'wrong_organization',
      'That link was issued for a different Compass organization, so it does not apply here.',
      403,
    );
  }

  const action = parseFeedbackAction(claims.action);
  if (action === null) {
    return jsonError(
      'unknown_action',
      `That link asks for \`${claims.action}\`, which is not a verdict Compass acts on. Open the report and use the ` +
        'buttons on the claim itself.',
      400,
    );
  }

  try {
    if (feedbackLinkIsStateChanging(claims.action)) {
      const claimed = await claimFeedbackLink(admitted.scoped, {
        tokenDigest,
        reportItemStableId: claims.itemStableId,
        action: claims.action,
        usedAt: admitted.now,
      });

      if (!claimed) {
        return jsonError(
          'already_used',
          'That link has already been used. Each feedback link works once — your verdict was recorded the first ' +
            'time, and nothing has changed now. Open the report to see it.',
          409,
        );
      }
    }

    const result = await applyManagerFeedback(admitted.scoped, {
      stableId: claims.itemStableId,
      action,
      // A mailed link carries no words. The reason is the click itself, stated plainly, so the
      // corrections screen shows something truthful rather than an empty cell.
      reason: 'Recorded from a link in the daily email.',
      channel: 'email',
      // Deliberately null. The token proves possession of an emailed capability, not identity — the
      // subscription's owner is the likely clicker but nothing here proves it, and attributing the
      // verdict to them would put a name against a judgement that may not be theirs.
      authorUserId: null,
      now: admitted.now,
    });

    if (!result.ok) {
      return jsonError(result.reason, result.detail, result.reason === 'unknown_item' ? 404 : 400);
    }

    return jsonOk({
      recorded: true,
      action: result.entry.action,
      stableId: result.entry.reportItemStableId,
      correctionWritten: result.correctionWritten,
      // No session, and the body says so: the reader should know that clicking a link in an email
      // did not sign them into anything.
      signedIn: false,
      detail: `${result.sentence} This link is now spent, and it did not sign you in.`,
    });
  } catch (error) {
    return failure(error);
  }
}

export async function GET(
  request: Request,
  context: { readonly params: Promise<{ readonly token: string }> },
): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'GET' });
  if (!admitted.allowed) return admitted.response;

  const { token } = await context.params;
  return consume(admitted, token);
}

/** The same effect for a client that prefers a POST. One implementation, so they cannot diverge. */
export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly token: string }> },
): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  const { token } = await context.params;
  return consume(admitted, token);
}
