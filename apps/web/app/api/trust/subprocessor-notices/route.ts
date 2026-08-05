import {
  composeSubprocessorConfirmationMail,
  digestSecret,
  issueSecret,
  looksLikeEmail,
} from '@compass/auth';
import { subscribeToSubprocessorNotices } from '@compass/db';
import type { NextResponse } from 'next/server';

import { guard, mailer, requestOrganizationId, scopedFor } from '../../../../lib/auth/guard';
import { failure, isFormSubmission, jsonError, jsonOk, readFormOrJsonObject, seeOther } from '../../../../lib/auth/http';
import { SUBPROCESSOR_NOTICE_DAYS, subprocessorDigest } from '@compass/trust';

/**
 * `POST /api/trust/subprocessor-notices` — subscribe to the 30-day change notice.
 *
 * ## Why this is public
 *
 * The commitment on `/trust/subprocessors` is that Compass gives 30 days' warning before changing who
 * processes your data. The person who most needs that warning is somebody *deciding* whether to trust
 * Compass — a data protection officer with no seat and no intention of getting one. An endpoint behind a
 * session would restrict the notice to existing customers, who are the people least in need of it.
 *
 * ## Why a confirmation email rather than a stored subscription
 *
 * Because it is public, anybody can type anybody's address into it. The row is therefore written
 * *unconfirmed* and the notice job never mails an unconfirmed address — so the worst a nuisance
 * submission achieves is one confirmation email, and the address is never signed up to anything. Storing
 * the subscription outright would let a stranger subscribe a colleague to mail from a vendor they have
 * never heard of.
 *
 * ## Why the reply is always the same sentence
 *
 * A subscribed address and an unsubscribed one get the identical response, for the reason
 * `/api/auth/password-reset` does: differing replies turn a public endpoint into an oracle for "is this
 * address on Compass's list", which is a small disclosure about somebody's vendor evaluation that is not
 * ours to make.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/trust/subprocessor-notices';

/** One sentence, whatever happened. See the note above on why it does not vary. */
const ACCEPTED =
  'If that address can receive mail, Compass has sent it a confirmation link. Follow it and you will be ' +
  `told at least ${SUBPROCESSOR_NOTICE_DAYS} days before the subprocessor list changes.`;

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  const body = await readFormOrJsonObject(request);
  if ('response' in body) return body.response;

  const raw = body.body['email'];
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';

  /**
   * The one case that *does* get a different answer.
   *
   * A malformed address is the submitter's own typo, not a fact about anybody else, so telling them is a
   * disclosure about nothing and withholding it would mean a mistyped address silently never receives the
   * notice it was created to receive.
   */
  if (!looksLikeEmail(email)) {
    return isFormSubmission(request)
      ? seeOther(new URL('/trust/subprocessors?notice=invalid', request.url).toString())
      : jsonError('invalid_request', 'That does not look like an email address.', 400);
  }

  try {
    // The deployment's own organization, exactly as `app_feedback` resolves it for an anonymous
    // submission: the notice obligation is the operator's, and scoping the row keeps it inside the same
    // isolation boundary as everything else. See `packages/db/src/schema/trust.ts`.
    const scoped = scopedFor(requestOrganizationId());

    // The token goes in the email; only its digest is stored. Same discipline as every other mailed link.
    const token = issueSecret();

    const outcome = await subscribeToSubprocessorNotices(
      scoped,
      {
        email,
        unsubscribeTokenHash: digestSecret(token.secret),
        // Recorded on a *new* row so somebody subscribing today is not immediately mailed about a change
        // that predates them. An existing row keeps whatever it was last told.
        currentDigest: subprocessorDigest(),
      },
      admitted.now,
    );

    /**
     * The confirmation is sent on a re-submission too, deliberately.
     *
     * Somebody who never received the first one — spam filter, typo they have since fixed elsewhere — has
     * no other way to get it, and refusing to re-send would leave them permanently unable to confirm.
     * `subscribeToSubprocessorNotices` is idempotent on the row, so this creates no duplicate.
     */
    const link = new URL(
      `/api/trust/subprocessor-notices/confirm?token=${encodeURIComponent(token.secret)}`,
      request.url,
    ).toString();

    await mailer().send(
      composeSubprocessorConfirmationMail({
        to: email,
        link,
        noticeDays: SUBPROCESSOR_NOTICE_DAYS,
      }),
    );

    return isFormSubmission(request)
      ? seeOther(new URL('/trust/subprocessors?notice=check-your-email', request.url).toString())
      : jsonOk({ accepted: true, created: outcome.created, detail: ACCEPTED });
  } catch (error) {
    return failure(error);
  }
}
