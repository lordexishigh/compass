import { instantFromIso, type Instant } from '@compass/clock';
import type { NextResponse } from 'next/server';

import { guard } from '../../../../lib/auth/guard';
import { failure, jsonError, jsonOk, readJsonObject, requiredString } from '../../../../lib/auth/http';
import { actorFor, closeAbsence, saveAbsence } from '../../../../lib/roster-source';

/**
 * `/api/roster/absences` — mark somebody out, or end an absence early.
 *
 * **This route and the roster service behind it are the only way an Absence comes to
 * exist.** That single-writer rule is an acceptance criterion, and it exists because two
 * producers write absences: a manager here, and a Manager Memo that said "Priya is out until
 * Thursday". Two independent inserts would mean two shapes of row — one validated, one not;
 * one with a source, one without — and the suppression rule would work for whichever shape
 * its author had in mind. So the memo path calls `recordAbsence` too, and
 * `tools/quality-gates/tests/roster-single-writer.test.ts` asserts nothing else observes an
 * `absence`.
 *
 * What an absence *does* is suppress stalled-work findings that name the person, with the
 * reason and a link to this record attached. It does not shorten an elapsed count: "has not
 * moved for 4 working days" stays 4, because that is the number a manager can check on the
 * board. The number stays true; the accusation is withdrawn.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/roster/absences';

/**
 * An ISO instant field, or the sentence naming it.
 *
 * Returns `Instant`, not `number`. `instantFromIso` already produces the brand, so declaring
 * the looser type only forced every call site to write `as never` to hand it to
 * `AbsenceInput` — disabling the check at precisely the boundary the brand exists to guard.
 */
function readInstant(
  body: Record<string, unknown>,
  field: string,
): { readonly value: Instant } | { readonly response: NextResponse } {
  const raw = body[field];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { response: jsonError('invalid_request', `\`${field}\` is required.`, 400) };
  }
  try {
    return { value: instantFromIso(raw.trim()) };
  } catch {
    return {
      response: jsonError(
        'invalid_request',
        `\`${field}\` must be an ISO-8601 instant, e.g. 2026-08-03T00:00:00Z.`,
        400,
      ),
    };
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const developerKey = requiredString(parsed.body, 'developerKey');
  if ('response' in developerKey) return developerKey.response;
  const kind = requiredString(parsed.body, 'kind');
  if ('response' in kind) return kind.response;

  const startAt = readInstant(parsed.body, 'startAt');
  if ('response' in startAt) return startAt.response;
  const endAt = readInstant(parsed.body, 'endAt');
  if ('response' in endAt) return endAt.response;

  /**
   * Provenance is decided here, not sent.
   *
   * An absence recorded over this route *is* a manual one — a person typed it on the roster
   * screen. The memo-sourced kind is written in-process by the memo extractor calling
   * `recordAbsence` directly, so it has no reason to arrive as HTTP, and accepting it here
   * would let a caller forge the provenance the roster then displays as "from a manager
   * memo" together with a `sourceRef` of their choosing. `sourceRef` is therefore not read
   * from the body at all.
   *
   * An unrecognised value is refused rather than quietly coerced to `manual`: a caller who
   * sent `source: "slack"` has a belief about what they just recorded, and silently storing
   * something else is how that belief survives to mislead somebody reading the roster.
   */
  const rawSource = parsed.body['source'];
  if (rawSource !== undefined && rawSource !== 'manual') {
    return jsonError(
      'invalid_request',
      typeof rawSource === 'string' && rawSource === 'memo'
        ? '`source` cannot be `memo` here. A memo-sourced absence is written by the Manager Memo path itself, which ' +
            'carries the memo it came from; recording one through this route would state a provenance nothing backs.'
        : '`source` may only be `manual` on this route, or omitted — an absence recorded here is one somebody typed ' +
            'on the roster screen.',
      400,
    );
  }

  const rawNote = parsed.body['note'];

  try {
    const result = await saveAbsence(
      admitted.scoped,
      {
        developerKey: developerKey.value,
        kind: kind.value,
        startAt: startAt.value,
        endAt: endAt.value,
        note: typeof rawNote === 'string' && rawNote.trim().length > 0 ? rawNote.trim() : null,
        source: 'manual',
        sourceRef: null,
      },
      actorFor(admitted.identity),
      admitted.now,
    );

    return jsonOk(
      {
        absenceKey: result.naturalKey,
        outcome: result.outcome,
        detail:
          'Recorded. While it covers the report instant, stalled-work findings naming this person are withheld and ' +
          'the report states why, with a link back to this absence.',
      },
      201,
    );
  } catch (error) {
    return failure(error);
  }
}

export async function PATCH(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'PATCH' });
  if (!admitted.allowed) return admitted.response;

  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const absenceKey = requiredString(parsed.body, 'absenceKey');
  if ('response' in absenceKey) return absenceKey.response;

  /**
   * "End it now" means *the server's* now.
   *
   * `endAt` is optional, and its absence is what the roster screen's "end it now" button
   * sends. The alternative — the browser posting `new Date().toISOString()` — let a skewed
   * client clock decide the instant stored on a record that governs report suppression: a
   * device an hour fast would end an absence an hour before the manager clicked, and a
   * report generated in that window would name somebody who is still out. Every other
   * instant in Compass comes from the request edge, and this is not the one exception.
   *
   * An explicit `endAt` is still honoured, because ending an absence *on a chosen date* is a
   * different act from ending it now — a manager who learns somebody came back on Tuesday
   * needs to say Tuesday, not today.
   */
  const endAt =
    parsed.body['endAt'] === undefined ? { value: admitted.now } : readInstant(parsed.body, 'endAt');
  if ('response' in endAt) return endAt.response;

  try {
    const result = await closeAbsence(
      admitted.scoped,
      { naturalKey: absenceKey.value, endAt: endAt.value },
      actorFor(admitted.identity),
      admitted.now,
    );

    if (result === null) {
      return jsonError('absence_not_found', `No absence \`${absenceKey.value}\` exists in this organization.`, 404);
    }

    return jsonOk({
      absenceKey: absenceKey.value,
      outcome: result.outcome,
      detail:
        'Ended. The longer range is still on disk, so a report generated while it was in force still explains the ' +
        'findings it withheld.',
    });
  } catch (error) {
    return failure(error);
  }
}
