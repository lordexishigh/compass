import type { NextResponse } from 'next/server';

import { guard } from '../../../../lib/auth/guard';
import { failure, jsonError, jsonOk, readJsonObject, requiredString } from '../../../../lib/auth/http';
import { actorFor, mergeIdentity, undoMerge } from '../../../../lib/roster-source';

/**
 * `/api/roster/merges` — resolve an unmatched identity, and undo it.
 *
 * A wrong merge is the most expensive mistake this surface can make: it moves somebody else's
 * commits onto a person, and every report generated afterwards states that as fact. So
 * `DELETE` is not a convenience — it is the only recovery, and it restores the prior
 * attribution *exactly* rather than approximately.
 *
 * That exactness comes from the merge's own audit row. `POST` writes the pre-merge
 * attribution into the entry's `before` state before creating the link, and `DELETE` replays
 * it. The snapshot has to be taken then, because once the link exists the model no longer
 * holds the answer to "who was this attributed to before" — the identifier now resolves.
 * `audit_log_entries` is append-only in three independent places, so the record being
 * replayed cannot have been edited between the two acts.
 *
 * Neither verb rewrites a commit or a pull request. Attribution is resolved through
 * `identity_link` when a report is generated, from the identifier ingest records on every
 * artifact — which is how "restore the prior attribution exactly" and "never delete the
 * underlying artifacts" turn out to be the same statement, and why both take effect in the
 * next report with no re-ingest at all.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/roster/merges';

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const identityKey = requiredString(parsed.body, 'identityKey');
  if ('response' in identityKey) return identityKey.response;

  const developerKey = requiredString(parsed.body, 'developerKey');
  if ('response' in developerKey) return developerKey.response;

  // A new person is named rather than invented: the caller supplies the display name, so
  // Compass never derives a human's name from an email local-part. That derivation is
  // precisely what `UnmatchedIdentity` exists to refuse.
  const rawDisplayName = parsed.body['displayName'];
  const createNew = parsed.body['createDeveloper'] === true;

  if (createNew && (typeof rawDisplayName !== 'string' || rawDisplayName.trim().length === 0)) {
    return jsonError(
      'invalid_request',
      '`displayName` is required when creating a new person. Compass will not derive a name from an email address.',
      400,
    );
  }

  const rawTeamKey = parsed.body['teamKey'];
  const teamKey = typeof rawTeamKey === 'string' && rawTeamKey.trim().length > 0 ? rawTeamKey.trim() : null;

  try {
    const result = await mergeIdentity(
      admitted.scoped,
      {
        identityKey: identityKey.value,
        target: createNew
          ? {
              kind: 'new',
              developerKey: developerKey.value,
              displayName: (rawDisplayName as string).trim(),
              teamKey,
            }
          : { kind: 'existing', developerKey: developerKey.value },
      },
      actorFor(admitted.identity),
      admitted.now,
    );

    const { totalCount, commitCount, pullRequestCount } = result.impact;

    return jsonOk(
      {
        identityKey: result.identityKey,
        developerKey: result.developerKey,
        developerCreated: result.developerCreated,
        artifactsAffected: totalCount,
        commits: commitCount,
        pullRequests: pullRequestCount,
        // The handle an un-merge is asked for. Returned so the screen can offer "undo"
        // without a second read of the audit log.
        mergeAuditId: result.auditId,
        detail:
          `Merged. ${totalCount} artifact${totalCount === 1 ? '' : 's'} ` +
          `(${commitCount} commit${commitCount === 1 ? '' : 's'}, ${pullRequestCount} pull request${pullRequestCount === 1 ? '' : 's'}) ` +
          'attribute to this person from the next generated report onward. If it was wrong, undo restores the prior ' +
          'attribution exactly — the merge recorded what it changed.',
      },
      201,
    );
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'DELETE' });
  if (!admitted.allowed) return admitted.response;

  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const mergeAuditId = requiredString(parsed.body, 'mergeAuditId');
  if ('response' in mergeAuditId) return mergeAuditId.response;

  try {
    const result = await undoMerge(
      admitted.scoped,
      { mergeAuditId: mergeAuditId.value },
      actorFor(admitted.identity),
      admitted.now,
    );

    return jsonOk({
      identityKey: result.identityKey,
      restoredDeveloperKey: result.restoredDeveloperKey,
      artifactsRestored: result.restoredArtifactKeys.length,
      exact: result.exact,
      unmergeAuditId: result.auditId,
      detail: result.exact
        ? `Undone. The ${result.restoredArtifactKeys.length} artifact${result.restoredArtifactKeys.length === 1 ? '' : 's'} the merge moved are back exactly where they were, and both the merge and this undo are in the audit log.`
        : 'Undone, and the identifier is back to what it was — but an ingest since the merge observed artifacts the ' +
          'merge could not have known about. Those revert too; they were simply not part of the set it recorded.',
    });
  } catch (error) {
    return failure(error);
  }
}
