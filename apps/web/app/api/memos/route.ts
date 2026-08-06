import {
  DeterministicExtractor,
  isMemoSourceChannel,
  isMemoSubjectKind,
  submitMemo,
  type SubjectCandidate,
} from '@compass/memos';
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
 * The candidates echoed back with a choice, validated field by field.
 *
 * They are stored on the memo so that "why is this about Marcus Hale rather than Marcus Webb" is
 * answerable later, which means they arrive from the client and are therefore untrusted. Anything
 * malformed is dropped rather than coerced: a candidate list with an invented `subjectKind` would
 * be a record of an offer that was never made.
 */
function readOfferedCandidates(raw: unknown): readonly SubjectCandidate[] | undefined {
  if (!Array.isArray(raw)) return undefined;

  const candidates = raw.flatMap((entry): readonly SubjectCandidate[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const { subjectKind, subjectKey, label, reason } = record;

    if (
      typeof subjectKey !== 'string' ||
      typeof label !== 'string' ||
      typeof reason !== 'string' ||
      typeof subjectKind !== 'string' ||
      !isMemoSubjectKind(subjectKind)
    ) {
      return [];
    }

    return [{ subjectKind, subjectKey, label, reason }];
  });

  return candidates.length === 0 ? undefined : candidates;
}

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
    const offeredCandidates = readOfferedCandidates(parsed.body['offeredCandidates']);

    const outcome = await submitMemo(
      { scoped: admitted.scoped, extractor: new DeterministicExtractor() },
      {
        rawText: rawText.value,
        channel,
        authorUserId: admitted.identity?.user.id ?? null,
        now: admitted.now,
        timezone: run.timezone,
        ...(typeof chosen === 'string' ? { chosenSubjectKey: chosen.trim() } : {}),
        ...(offeredCandidates === undefined ? {} : { offeredCandidates }),
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
