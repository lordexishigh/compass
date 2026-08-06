import { formatCivilDate } from '@compass/clock';
import { DeterministicExtractor, submitMemo, type ResolvedWindow } from '@compass/memos';
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
 * This route's channel, pinned rather than read off the request.
 *
 * Compass has three memo intakes — web, email, Slack — and the design rests on them producing an
 * *identical row apart from the source field*. That guarantee is only as good as the field, and it
 * used to be a request parameter: a seated manager posting from this form could stamp their memo
 * `slack`, and the row would claim an origin it never had. Nothing legitimate does that. The Slack
 * and email adapters set their own channel because they *are* the other intakes; this one is the
 * web form and can only ever be `web`.
 *
 * It is also part of the memo's identity — `memoKey` hashes the channel — so a caller able to vary
 * it could store the same sentence from the same minute twice under two keys, which is the one
 * thing that key exists to prevent.
 */
const WEB_CHANNEL = 'web' as const;

/**
 * The memo window, in civil dates, in the run's zone.
 *
 * `ResolvedWindow` carries `Instant`s — epoch milliseconds — and `jsonOk` serialises them as the
 * numbers they are, so the confirmation read *"in force 1754179200000 → 1754438400000"*. The whole
 * point of that line is that a manager can check Compass's reading of "until Thursday" against the
 * Thursday they meant, and a millisecond count cannot be checked by anybody.
 *
 * Formatted here rather than in the component for the reason every date in this app is: the client
 * has no timezone, `apps/web` components do no date arithmetic, and `lib/view-model.ts` and
 * `TimeTravelBounds` already hand pre-formatted strings down. The zone is the run's — the calendar
 * the report is written in — so the date shown back is the date tomorrow's report will honour.
 */
export function civilWindow(
  window: ResolvedWindow,
  timezone: string,
): { readonly effectiveFrom: string; readonly effectiveUntil: string | null; readonly openEnded: boolean } {
  return {
    effectiveFrom: formatCivilDate(window.effectiveFrom, timezone),
    effectiveUntil: window.effectiveUntil === null ? null : formatCivilDate(window.effectiveUntil, timezone),
    openEnded: window.openEnded,
  };
}

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
        channel: WEB_CHANNEL,
        authorUserId: admitted.identity?.user.id ?? null,
        now: admitted.now,
        timezone: run.timezone,
        ...(typeof chosen === 'string' ? { chosenSubjectKey: chosen.trim() } : {}),
      },
    );

    switch (outcome.status) {
      case 'recorded':
        // The one field that is reshaped on the way out. Everything else is the outcome verbatim.
        return jsonOk({ ...outcome, window: civilWindow(outcome.window, run.timezone) }, 201);
      case 'needs_subject':
        return jsonOk(outcome, 409);
      default:
        // `refused` and `subject_unknown`: understood the request, will not represent it.
        //
        // A refusal carries *two* sentences and both travel: `message` is `REFUSAL_SENTENCE`, the
        // product's own "I can't represent that yet", and `detail` names what could not be
        // represented. Rendering only the second would drop the sentence the feature is known by.
        return jsonOk(outcome, 422);
    }
  } catch (error) {
    return failure(error);
  }
}
