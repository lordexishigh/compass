import { DeterministicExtractor, isMemoSourceChannel, submitMemo } from '@compass/memos';
import { resolveSeededRun } from '@compass/seed-connector';
import type { NextResponse } from 'next/server';

import { guard } from '../../../lib/auth/guard';
import { failure, jsonError, jsonOk, readJsonObject, requiredString } from '../../../lib/auth/http';

/**
 * `POST /api/memos` — one Manager Memo, extracted into the closed five-kind schema and written.
 *
 * ## Why this route holds almost no logic
 *
 * Everything that decides anything lives in `@compass/memos`: `extractMemo` turns a sentence into
 * a typed assertion or refuses it, `resolveSubject` decides whether the subject is certain enough
 * to bind, and `submitMemo` composes the two and writes through the roster service. This handler
 * validates two fields off the wire and translates one outcome union into status codes.
 *
 * That split is the point. The refusal sentence, the confidence threshold and the candidate list
 * are product rules with tests in the package that owns them, and re-deciding any of them here
 * would mean the web form and the inbound email path — which calls the same service — could
 * disagree about what Compass is willing to represent.
 *
 * ## The four outcomes, and why three of them are not errors
 *
 * - `recorded` → **201**, with the typed assertion echoed back. The confirmation a manager reads
 *   is Compass's own reading of their sentence, which is the only way they can catch a
 *   misunderstanding before it shapes tomorrow's report.
 * - `needs_subject` → **409**, with the 2–3 candidates. Not a failure: Compass understood the
 *   assertion and cannot tell *who* it is about. Re-posting with `chosenSubjectKey` finishes it.
 * - `refused` → **422**, carrying `REFUSAL_SENTENCE`. The memo is outside the five kinds, and
 *   saying so plainly beats storing a shape nothing downstream can honour.
 * - `subject_unknown` → **422**. Understood, but names nobody this organization knows.
 *
 * A 4xx for the middle two is a deliberate reading of "the request cannot be completed as sent",
 * not a claim that the manager did something wrong — the body carries the sentence that says so.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/memos';

/**
 * ## The candidate list is not accepted from the client, deliberately
 *
 * A `chosenSubjectKey` arrives here and the alternatives it was chosen *between* do not. They
 * used to: the form echoed them back and they were stored on the memo as the record of the offer.
 * That made the row the caller's testimony rather than evidence — a caller could bind a memo to
 * any key and write its own account of the alternatives beside it, and "why Marcus Hale rather
 * than Marcus Webb" would be answered by the party with a reason to shade the answer.
 *
 * `submitMemo` now re-derives the offer from the store and refuses a choice that is not in it, so
 * the field is Compass's own and there is nothing here to validate. Deleting the parameter is the
 * fix; validating its shape only ever confirmed that a forgery was well-formed.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const rawText = requiredString(parsed.body, 'rawText');
  if ('response' in rawText) return rawText.response;

  /**
   * The channel is validated against the port's own vocabulary rather than defaulted.
   *
   * A memo's channel is part of its identity — `memoKey` hashes it — so silently substituting
   * `web` for a misspelled value would let the same sentence from the same minute be stored twice
   * under two keys, which is precisely what that key exists to prevent.
   */
  const rawChannel = parsed.body['channel'];
  const channel = rawChannel === undefined ? 'web' : rawChannel;
  if (typeof channel !== 'string' || !isMemoSourceChannel(channel)) {
    return jsonError('invalid_request', '`channel` must be one of the memo source channels.', 400);
  }

  const chosen = parsed.body['chosenSubjectKey'];
  if (chosen !== undefined && (typeof chosen !== 'string' || chosen.trim().length === 0)) {
    return jsonError('invalid_request', '`chosenSubjectKey` must be a non-empty string when present.', 400);
  }

  try {
    /**
     * The timezone comes from the run, not from the browser.
     *
     * "until Thursday" resolves against a civil calendar, and the calendar that matters is the
     * one the report is written in — a manager travelling must not record a different Thursday
     * from the one their team's report will honour.
     */
    const run = resolveSeededRun({ hostNow: admitted.now });

    const outcome = await submitMemo(
      { scoped: admitted.scoped, extractor: new DeterministicExtractor() },
      {
        rawText: rawText.value,
        channel,
        authorUserId: admitted.identity?.user.id ?? null,
        now: admitted.now,
        timezone: run.timezone,
        ...(typeof chosen === 'string' ? { chosenSubjectKey: chosen.trim() } : {}),
      },
    );

    switch (outcome.status) {
      case 'recorded':
        return jsonOk(outcome, 201);
      case 'needs_subject':
        return jsonOk(outcome, 409);
      default:
        // `refused` and `subject_unknown`: understood the request, will not represent it.
        return jsonOk(outcome, 422);
    }
  } catch (error) {
    return failure(error);
  }
}
