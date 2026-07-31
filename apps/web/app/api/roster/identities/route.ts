import type { NextResponse } from 'next/server';

import { guard } from '../../../../lib/auth/guard';
import { failure, jsonError, jsonOk, readJsonObject, requiredString } from '../../../../lib/auth/http';
import { actorFor, linkIdentity, unlinkIdentity } from '../../../../lib/roster-source';

/**
 * `/api/roster/identities` — one person's git emails, tracker account and chat handle.
 *
 * Both verbs answer with the number of artifacts affected, and that is a requirement rather
 * than a courtesy: an attribution change that reported only success would leave a manager no
 * way to tell whether they had just moved six commits or six hundred. The number is what
 * makes the change reversible in practice — they see what it did before they have to decide
 * whether it was right.
 *
 * `DELETE` never deletes an artifact. The link stops naming a person, so the commits and
 * pull requests behind it revert to unattributed — "3 commits could not be tied to a
 * person", which is the honest state and the one the report already knows how to say.
 *
 * The identifier travels in the body rather than the path. An email address contains `@` and
 * a chat handle can contain almost anything; a path segment would need encoding at every
 * call site and one missed `encodeURIComponent` would be a 404 nobody could explain.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/roster/identities';
const KINDS = ['email', 'account', 'handle'] as const;

type IdentityKind = (typeof KINDS)[number];

function readKind(body: Record<string, unknown>): IdentityKind | NextResponse {
  const kind = body['kind'];
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) {
    return jsonError(
      'invalid_request',
      '`kind` must be `email` for a git author address, `account` for a tracker account id, or `handle` for a chat user id.',
      400,
    );
  }
  return kind as IdentityKind;
}

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const kind = readKind(parsed.body);
  if (typeof kind !== 'string') return kind;

  const value = requiredString(parsed.body, 'value');
  if ('response' in value) return value.response;
  const developerKey = requiredString(parsed.body, 'developerKey');
  if ('response' in developerKey) return developerKey.response;

  try {
    const result = await linkIdentity(
      admitted.scoped,
      { kind, value: value.value, developerKey: developerKey.value },
      actorFor(admitted.identity),
      admitted.now,
    );

    const { totalCount, commitCount, pullRequestCount } = result.impact;

    return jsonOk({
      identityKey: result.identityKey,
      developerKey: result.developerKey,
      outcome: result.outcome,
      artifactsAffected: totalCount,
      commits: commitCount,
      pullRequests: pullRequestCount,
      detail:
        totalCount === 0
          ? 'Linked. No artifact currently carries this identifier, so nothing was re-attributed — the next ingest ' +
            'will attribute anything new that does.'
          : `Linked. ${totalCount} artifact${totalCount === 1 ? '' : 's'} ` +
            `(${commitCount} commit${commitCount === 1 ? '' : 's'}, ${pullRequestCount} pull request${pullRequestCount === 1 ? '' : 's'}) ` +
            'now attribute to this person, from the next generated report onward. The next ingest applies it to ' +
            'anything new as well.',
    });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'DELETE' });
  if (!admitted.allowed) return admitted.response;

  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const kind = readKind(parsed.body);
  if (typeof kind !== 'string') return kind;

  const value = requiredString(parsed.body, 'value');
  if ('response' in value) return value.response;

  try {
    const result = await unlinkIdentity(
      admitted.scoped,
      { kind, value: value.value },
      actorFor(admitted.identity),
      admitted.now,
    );

    if (result === null) {
      return jsonError(
        'identity_not_linked',
        `No link exists for \`${kind}:${value.value}\`, so there is nothing to remove.`,
        404,
      );
    }

    const { totalCount } = result.impact;

    return jsonOk({
      identityKey: result.identityKey,
      previousDeveloperKey: result.developerKey,
      artifactsAffected: totalCount,
      detail:
        `Unlinked. ${totalCount} artifact${totalCount === 1 ? '' : 's'} revert to unattributed — none was deleted, ` +
        'and the report will ask about them rather than attributing them to anybody.',
    });
  } catch (error) {
    return failure(error);
  }
}
