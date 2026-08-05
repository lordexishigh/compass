import { appendAuditLogEntry, saveSourceConfig } from '@compass/db';
import type { NextResponse } from 'next/server';

import { guard } from '../../../../../lib/auth/guard';
import {
  failure,
  isFormSubmission,
  jsonError,
  jsonOk,
  readFormOrJsonObject,
  seeOther,
} from '../../../../../lib/auth/http';
import { connectorIdFor, describeSelections, parseScopeSelections } from '../../../../../lib/connect-scope';
import { findProviderConfig, isConnectProviderId, providerById } from '../../../../../lib/connect-source';

/**
 * `POST /api/connect/[provider]/scope` — say which repositories, projects or channels Compass may read.
 *
 * ## Why scoping is its own route, and not part of the install
 *
 * Because it is the part a manager comes back to. An install happens once; the selection changes whenever
 * a team picks up a new repository or a project is archived, and it has to be editable without revoking a
 * credential and starting again. Keeping it separate is also what lets a *reconnect* carry the previous
 * selection forward untouched — see the callback.
 *
 * ## Nothing partial is saved
 *
 * A field with four good lines and one typo is refused whole, with the offending line quoted back. Saving
 * the four would mean a manager believing they had selected five repositories while Compass read four, and
 * the difference would only ever surface as a report that was quietly thin. There is no upload and no
 * config file: the input is lines in a textarea, which is also the fastest thing to paste into.
 *
 * ## An empty selection is allowed, and is not "read everything"
 *
 * Clearing the field means Compass reads nothing from that source, and both the audit record and the
 * screen say so in those words. The connectors themselves refuse an empty selection at construction
 * (`EmptyRepositorySelectionError` and its two siblings), so the two halves agree: nothing unscoped is ever
 * read, whichever way the configuration got there.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/connect/[provider]/scope';

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly provider: string }> },
): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  const { provider: raw } = await context.params;
  if (!isConnectProviderId(raw)) {
    return jsonError('unknown_provider', `Compass has no connector called "${raw}".`, 404);
  }
  const provider = providerById(raw);

  try {
    const submitted = await readFormOrJsonObject(request);
    const field = submitted['selections'];
    const parsed = parseScopeSelections(raw, typeof field === 'string' ? field : '');

    if (parsed.rejected.length > 0) {
      const detail = parsed.rejected
        .map((entry) => `“${entry.line}” — ${entry.reason}`)
        .join(' ');

      // Refused whole. A browser gets the reason on the page it came from; a script gets it as JSON.
      return isFormSubmission(request)
        ? seeOther(
            new URL(
              `/connect?${raw}=scope-rejected&line=${encodeURIComponent(parsed.rejected[0]?.line ?? '')}`,
              request.url,
            ).toString(),
          )
        : jsonError('scope_rejected', `Nothing was saved. ${detail}`, 422);
    }

    const existing = await findProviderConfig(admitted.scoped, raw);

    await saveSourceConfig(
      admitted.scoped,
      {
        sourceKey: provider.sourceKey,
        sourceKind: provider.sourceKind,
        connectorId: connectorIdFor(raw),
        // A selection can be set before a credential exists — picking repositories and then granting
        // access is the order a lot of people work in — so this does not require one. `enabled` follows
        // whatever the source already was, defaulting to true for a first-time selection.
        enabled: existing?.enabled ?? true,
        selections: parsed.selections,
        settings: existing?.settings ?? {},
      },
      admitted.now,
    );

    /**
     * On the record, because it changes what Compass reads about the organization.
     *
     * `before` and `after` carry the selection *keys* rather than a count, so the log answers "which
     * repository stopped being read on the 4th" — which is the question somebody actually asks it, and one
     * a count cannot answer.
     */
    await appendAuditLogEntry(admitted.scoped, {
      actorUserId: admitted.identity?.user.id ?? null,
      action: 'connector.scope_changed',
      targetKind: 'connector',
      targetId: provider.sourceKey,
      before: { selectionKeys: (existing?.selections ?? []).map((entry) => entry.selectionKey) },
      after: {
        selectionKeys: parsed.selections.map((entry) => entry.selectionKey),
        stated: describeSelections(raw, parsed.selections),
      },
      occurredAt: admitted.now,
    });

    return isFormSubmission(request)
      ? seeOther(new URL(`/connect?${raw}=scoped`, request.url).toString())
      : jsonOk({
          sourceKey: provider.sourceKey,
          selections: parsed.selections,
          stated: describeSelections(raw, parsed.selections),
        });
  } catch (error) {
    return failure(error);
  }
}
