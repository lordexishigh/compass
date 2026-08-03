import { randomUUID } from 'node:crypto';

import { APP_FEEDBACK_MAX_LENGTH, recordAppFeedback } from '@compass/db';
import type { NextResponse } from 'next/server';

import { guard } from '../../../../lib/auth/guard';
import { failure, jsonError, jsonOk, readJsonObject, requiredString } from '../../../../lib/auth/http';

/**
 * `POST /api/feedback/app` — the in-app control's one field.
 *
 * ## Why this is not `POST /api/feedback`
 *
 * That path's POST is already a manager's verdict on a finding, and one verb on one path cannot mean
 * two things without the handler guessing from the body which was intended — a guess that would
 * eventually record a bug report as a dismissed risk, or worse, the reverse. The list of these
 * submissions is served by `GET /api/feedback`, which is the shape the acceptance criterion names;
 * the write lives here, one segment down.
 *
 * ## Anonymous submissions are accepted, and that is the point
 *
 * The matrix allows `public` on the demonstration tenant, exactly as it does for `/`. The reader who
 * most needs to say "this page is confusing" is the one who has not signed up, and a control that
 * demanded a session first would be a control that never hears from them. The row then carries a
 * null `user_id`, which states "no session" rather than pointing at an invented one.
 *
 * It is a narrow surface by construction: one field in, one row written to a table nothing in the
 * pipeline reads, and a response that contains no organization data at all — so the most a stranger
 * can accomplish here is telling us something.
 *
 * ## What the response is for
 *
 * The sentence, which the control shows verbatim. It names what happens next rather than
 * acknowledging the click, on the same principle as every other Compass confirmation: "Thanks —
 * that's stored" is checkable, "Submitted" is not.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/feedback/app';

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const message = requiredString(parsed.body, 'message');
  if ('response' in message) return message.response;

  /**
   * Refused rather than truncated.
   *
   * Storing the first four thousand characters of a longer message and answering "thanks" would lose
   * the part somebody cared about while telling them it arrived. The ceiling is the same constant the
   * database's own CHECK constraint enforces, so the two cannot drift, and the sentence says the
   * number so a person with a long report knows what to cut to.
   */
  if (message.value.length > APP_FEEDBACK_MAX_LENGTH) {
    return jsonError(
      'message_too_long',
      `That message is ${message.value.length} characters and Compass stores up to ${APP_FEEDBACK_MAX_LENGTH}. ` +
        'Nothing was saved, so your text is still in the box — shorten it and send again.',
      400,
    );
  }

  try {
    const stored = await recordAppFeedback(
      admitted.scoped,
      {
        id: randomUUID(),
        // Null when nobody is signed in. `identity` is null for the `public` principal by contract.
        userId: admitted.identity?.user.id ?? null,
        message: message.value,
      },
      // The request edge's instant, the same one `guard` resolved the session against. Nothing here
      // reads a clock of its own.
      admitted.now,
    );

    return jsonOk({
      recorded: true,
      id: stored.id,
      detail:
        'Thank you — that is stored, and an owner of this organization can read it. Compass will not use it to ' +
        'change what your reports say: it goes to the people who maintain the product, not into the pipeline.',
    });
  } catch (error) {
    return failure(error);
  }
}
