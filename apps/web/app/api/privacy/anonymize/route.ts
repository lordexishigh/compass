import type { NextResponse } from 'next/server';

import { guard } from '../../../../lib/auth/guard';
import { failure, jsonError, jsonOk, readJsonObject, requiredString } from '../../../../lib/auth/http';
import { anonymizeDeveloper, restoreDeveloperName } from '../../../../lib/privacy-source';

/**
 * `/api/privacy/anonymize` — withdraw a person's name from future reports, or put it back.
 *
 * ## Why both verbs, and why the reversal is not a DELETE of the record
 *
 * A mistaken erasure request has to be fixable — somebody typed the wrong key, or a person
 * who left came back. So `DELETE` exists. What it deletes is the *effect*, not the record:
 * the `anonymizations` row is kept and stamped with the reversal, and a second audit entry
 * is written naming the actor. That is what "cannot be silently reversed" means in practice.
 * There is no request in Compass that removes the evidence that a name was withdrawn.
 *
 * ## Owner and manager, on the same reasoning as the roster
 *
 * A departure is noticed by the person who reads the team's report, and routing an erasure
 * through an owner would mean somebody's name stayed in tomorrow's report while a request
 * sat in a queue. Every act here is audited with its actor either way.
 *
 * ## What it does not do
 *
 * It does not delete the person's work. The tickets, pull requests and commits stay, because
 * they are the organization's record of work that happened — removing them would rewrite the
 * team's history and a manager would find a day's work missing from last Tuesday. Past
 * reports keep every ticket key, pull request number and count and render "a former team
 * member" where the name was.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/privacy/anonymize';

/** Why a name was withdrawn. Open text would make the roster unreadable; two values is enough. */
const REASONS = ['departed', 'erasure_request'] as const;

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const developerKey = requiredString(parsed.body, 'developerKey');
  if ('response' in developerKey) return developerKey.response;

  const rawReason = parsed.body['reason'];
  if (typeof rawReason !== 'string' || !(REASONS as readonly string[]).includes(rawReason)) {
    return jsonError(
      'invalid_request',
      '`reason` must be `departed` or `erasure_request`. The two are treated identically by the system and ' +
        'differently by a person reading the roster six months later, which is the whole reason to record it.',
      400,
    );
  }

  const rawNote = parsed.body['note'];

  try {
    const result = await anonymizeDeveloper(
      admitted.scoped,
      {
        developerKey: developerKey.value,
        reason: rawReason,
        note: typeof rawNote === 'string' && rawNote.trim().length > 0 ? rawNote.trim() : null,
      },
      admitted.identity,
      admitted.now,
    );

    return jsonOk(result, 201);
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'DELETE' });
  if (!admitted.allowed) return admitted.response;

  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const developerKey = requiredString(parsed.body, 'developerKey');
  if ('response' in developerKey) return developerKey.response;

  try {
    const detail = await restoreDeveloperName(
      admitted.scoped,
      developerKey.value,
      admitted.identity,
      admitted.now,
    );
    return jsonOk({ developerKey: developerKey.value, detail });
  } catch (error) {
    return failure(error);
  }
}
