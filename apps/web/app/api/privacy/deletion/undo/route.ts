import type { NextResponse } from 'next/server';

import { guard } from '../../../../../lib/auth/guard';
import { failure, jsonError, jsonOk, readJsonObject, requiredString } from '../../../../../lib/auth/http';
import { undoDeletion } from '../../../../../lib/privacy-source';

/**
 * `/api/privacy/deletion/undo` — spend an undo link.
 *
 * ## Why this is `public` in the matrix, and why that is not a hole
 *
 * The link arrives from a mail client, which has no cookies to send. Worse: the whole point
 * of the message is that it works when the account holder cannot sign in — a deletion in its
 * grace period may be the reason they are locked out of the product, and requiring a session
 * would make the undo unusable in precisely the case it exists for.
 *
 * What authorises the request is therefore something *narrower* than a session: a
 * 32-byte token that was mailed once, whose digest is what the row stores, and which
 * authorises exactly one act on exactly one deletion request. It cannot read a report, it
 * cannot start a session, and it stops working the moment it is spent or the grace period
 * ends. `feedback/link/[token]` is authorised the same way and for the same reason.
 *
 * ## POST, not GET
 *
 * It changes state, and a link scanner or a mail client's preview fetcher must not cancel
 * somebody's deletion by looking at the message. Same reasoning RFC 8058 gives for one-click
 * unsubscribe being a POST. The page at `/account/deletion` reads the token out of the query
 * string and posts it, so a human still only has to click once.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/privacy/deletion/undo';

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const token = requiredString(parsed.body, 'token');
  if ('response' in token) return token.response;

  try {
    const outcome = await undoDeletion(admitted.scoped, token.value, admitted.now);

    switch (outcome.kind) {
      case 'restored':
        return jsonOk({ outcome: outcome.kind, detail: outcome.detail });

      case 'already_settled':
        // 200, not 409. Clicking a link twice is not an error, and the second click should
        // read as reassurance rather than as a failure.
        return jsonOk({ outcome: outcome.kind, detail: outcome.detail });

      case 'expired':
        // 410 Gone: the link was real and is no longer usable, which is a different fact
        // from "that link is invalid" and the one the reader most needs to be told plainly.
        return jsonError('grace_period_ended', outcome.detail, 410);

      case 'unknown_token':
        return jsonError('unknown_token', outcome.detail, 404);
    }
  } catch (error) {
    return failure(error);
  }
}
