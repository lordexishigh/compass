import { STATUS_FOR_DENIAL, describeDenial } from '@compass/auth';
import type { NextResponse } from 'next/server';

import { guard, isDemoOrganization } from '../../../lib/auth/guard';
import { failure, jsonError, jsonOk, readJsonObject, requiredString } from '../../../lib/auth/http';
import {
  FEEDBACK_ACTION_LIST,
  applyManagerFeedback,
  parseFeedbackAction,
  resolveItemReportScope,
  seatMayActOnItem,
} from '../../../lib/feedback-source';

/**
 * `POST /api/feedback` — the web view's one click.
 *
 * The report page's buttons post here. Owners and managers only: a viewer reads the daily and does
 * not get to change what tomorrow's says, which is the matrix's decision and not this handler's.
 *
 * ## Why the effect is stated back
 *
 * The response carries the sentence the page shows, and every one of those sentences names the
 * effect on *future reports* rather than acknowledging the click. "Recorded" is not something a
 * manager can check. "Compass will keep this risk out of your report unless its severity rises by
 * 100 points" is — and it is a promise the pipeline keeps, which is the whole difference between
 * feedback and a thumbs-up button.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/feedback';

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const stableId = requiredString(parsed.body, 'stableId');
  if ('response' in stableId) return stableId.response;

  const action = parseFeedbackAction(parsed.body['action']);
  if (action === null) {
    return jsonError(
      'invalid_request',
      `\`action\` must be one of ${FEEDBACK_ACTION_LIST}. Those are the only verdicts Compass knows how to act on.`,
      400,
    );
  }

  const rawReason = parsed.body['reason'];
  const rawSnoozeDays = parsed.body['snoozeDays'];
  if (rawSnoozeDays !== undefined && typeof rawSnoozeDays !== 'number') {
    return jsonError('invalid_request', '`snoozeDays` must be a whole number of days.', 400);
  }

  try {
    /**
     * The team check, which `guard()` above could not have made.
     *
     * `/api/feedback` is `teamScoped` in the matrix, but the guard is handed no team — and it cannot
     * be, because the team is a property of *the item being acted on* and the item id is in the body
     * the guard never reads. With `teamKey: null`, `teamScopeAllows` only asks whether the caller has
     * any scope at all, so a manager scoped to `platform` passed; the item lookup underneath is
     * scoped to the organization and nothing narrower, so their verdict then landed on whichever
     * team's report held that id.
     *
     * So the item is resolved first and the *report's* team is checked against the caller's scopes,
     * before anything is written. `describeDenial` is the same sentence every other scope refusal in
     * the app uses, and it deliberately does not confirm whether the other team's report exists.
     */
    const itemScope = await resolveItemReportScope(admitted.scoped, stableId.value);
    if (
      itemScope !== null &&
      !seatMayActOnItem({
        principal: admitted.principal,
        teamScopes: admitted.identity?.teamScopes ?? [],
        itemTeamKey: itemScope.teamKey,
        demoOrganization: isDemoOrganization(admitted.organizationId),
      })
    ) {
      return jsonError(
        'team_out_of_scope',
        describeDenial('team_out_of_scope', { teamKey: itemScope.teamKey }),
        STATUS_FOR_DENIAL.team_out_of_scope,
      );
    }

    const result = await applyManagerFeedback(admitted.scoped, {
      stableId: stableId.value,
      action,
      reason: typeof rawReason === 'string' ? rawReason : null,
      ...(typeof rawSnoozeDays === 'number' ? { snoozeDays: rawSnoozeDays } : {}),
      channel: 'web',
      authorUserId: admitted.identity?.user.id ?? null,
      now: admitted.now,
    });

    if (!result.ok) {
      // 404 for an id that matches nothing, 400 for a request whose *shape* is the problem. The
      // distinction matters to whoever is reading: one means "that item is gone", the other means
      // "that is not a thing you can say about this item".
      return jsonError(result.reason, result.detail, result.reason === 'unknown_item' ? 404 : 400);
    }

    return jsonOk({
      recorded: true,
      action: result.entry.action,
      stableId: result.entry.reportItemStableId,
      correctionWritten: result.correctionWritten,
      detail: result.sentence,
    });
  } catch (error) {
    return failure(error);
  }
}
