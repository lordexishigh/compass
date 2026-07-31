import type { NextResponse } from 'next/server';

import { guard } from '../../../../lib/auth/guard';
import { failure, jsonError, jsonOk, readJsonObject, requiredString } from '../../../../lib/auth/http';
import { actorFor, saveProjectTracking, saveRepositoryTracking } from '../../../../lib/roster-source';

/**
 * `PATCH /api/roster/sources` — track or archive a repository or a project.
 *
 * Archiving is the interesting half, and what it does *not* do is the point. It excludes the
 * source from future ingest windows — `packages/ingest/src/tracking.ts` is the one boundary
 * where that can be true — and it touches nothing that already exists. Prior commits, prior
 * pull requests, and every report that cited them are unchanged, because the tracking
 * decision is its own effective-dated entity rather than a field on the repository.
 *
 * That separation is also why archiving survives the next ingest. Were `archived` a tracked
 * field on the observed Repository, every ingest would observe the repo without it and diff
 * it straight back to tracked — the connector silently overruling the manager once a day.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const KINDS = ['repository', 'project'] as const;

export async function PATCH(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: '/api/roster/sources', action: 'PATCH' });
  if (!admitted.allowed) return admitted.response;

  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const kind = parsed.body['kind'];
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) {
    return jsonError('invalid_request', '`kind` must be `repository` or `project`.', 400);
  }

  const key = requiredString(parsed.body, 'key');
  if ('response' in key) return key.response;

  const tracked = parsed.body['tracked'];
  if (typeof tracked !== 'boolean') {
    return jsonError(
      'invalid_request',
      '`tracked` must be false to archive or true to resume tracking. Archiving keeps every row it already has.',
      400,
    );
  }

  const rawNote = parsed.body['note'];
  const note = typeof rawNote === 'string' && rawNote.trim().length > 0 ? rawNote.trim() : null;

  try {
    const save = kind === 'repository' ? saveRepositoryTracking : saveProjectTracking;
    const result = await save(
      admitted.scoped,
      { key: key.value, tracked, note },
      actorFor(admitted.identity),
      admitted.now,
    );

    return jsonOk({
      kind,
      key: key.value,
      tracked,
      outcome: result.outcome,
      detail: tracked
        ? `Tracking ${key.value} again. The next ingest window will include it.`
        : `${key.value} is archived: no future ingest window will include it. Everything already ingested, and every ` +
          'report that cited it, is unchanged.',
    });
  } catch (error) {
    return failure(error);
  }
}
