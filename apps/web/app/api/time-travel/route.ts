import type { NextResponse } from 'next/server';

import { guard } from '../../../lib/auth/guard';
import { failure, jsonError, jsonOk, readJsonObject, requiredString } from '../../../lib/auth/http';
import {
  TimeTravelUnavailableError,
  knownTeamKeys,
  regenerateForInstant,
  simulatedClockAvailable,
  stepableInstantFor,
  timeTravelBounds,
} from '../../../lib/archive-source';

/**
 * `POST /api/time-travel` — step `now` and regenerate through the real pipeline.
 *
 * ## What makes this the memory thesis rather than a demo toy
 *
 * The handler does not serve a precomputed anything. It resolves the civil date to an instant, hands
 * that instant to `ensureDailyReport` — the same entry point the worker's scheduled job and the cold
 * container's first page load both use — and lets the whole pipeline run for it: ingest window,
 * snapshot, goal hierarchy, analysis, render, persist. The report that comes back is a real row with a
 * real content hash, indistinguishable from one the scheduler would have written that morning.
 *
 * That is also why stepping to an already-generated day *reads* rather than regenerating. The report id
 * is derived from `(organization, scope, instant)`, so the row for that day already is the answer, and
 * the archived report is the record. Regenerating it would compute today's thresholds over that day's
 * data and quietly answer a different question.
 *
 * ## Two gates, and why the second one is here rather than in the browser
 *
 * The matrix admits owners and managers on a team-scoped route. Then this handler refuses any
 * organization that is not running on the simulated clock. A live organization's `now` is the actual
 * present: regenerating its daily for an arbitrary instant would write a report about a day that has not
 * happened, over the row a manager is about to read. A guard that lived only in the scrubber component
 * would be bypassed by `curl`, which is exactly what the acceptance criterion forbids — so the check is
 * on the server, in front of the write. `apps/web/tests/time-travel.test.ts` asserts it end to end: it
 * creates a second, non-seeded organization with an active owner seat, posts a valid seeded date as that
 * owner, and requires a 403 with no report row written.
 *
 * A third check follows the mode gate: the team named in the body has to be a team the knowledge model
 * actually holds. The archive contains merged-scope rows whose key is the merged sentinel, and an unscoped
 * owner satisfies the scope check, so without it a crafted POST could persist a daily for a team that does
 * not exist.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/time-travel';

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const date = requiredString(parsed.body, 'date');
  if ('response' in date) return date.response;

  const rawTeam = parsed.body['teamKey'];
  const teamKey = typeof rawTeam === 'string' && rawTeam.trim().length > 0 ? rawTeam.trim() : admitted.teamKey;

  // Before anything is read or written: is this deployment even on a clock that may be stepped? Stated
  // as a 403 rather than a 400, because the request is well formed and the *organization* is the reason.
  if (!simulatedClockAvailable(admitted.organizationId)) {
    return jsonError(
      'simulated_clock_unavailable',
      'Time travel is only available on the simulated clock. This organization runs on the real one, where `now` is ' +
        'the actual present — Compass will not regenerate its daily for a day that has not happened.',
      403,
    );
  }

  // The team must be one the caller may act on. `guard` has already checked `admitted.teamKey` against
  // their scopes; a request naming a *different* team has to be checked against them too, or a manager
  // scoped to one team could regenerate another team's report by naming it in the body.
  const scopes = admitted.identity?.teamScopes ?? [];
  const unscoped = admitted.principal === 'owner' || scopes.length === 0;
  if (!unscoped && !scopes.includes(teamKey)) {
    return jsonError(
      'team_out_of_scope',
      `\`${teamKey}\` is not one of your teams, so Compass will not regenerate its report. Your seat covers ` +
        `${scopes.join(', ')}.`,
      403,
    );
  }

  try {
    /**
     * The date first, before any database read.
     *
     * `2019-01-01` is a date outside the seeded history whatever team was named, and answering it as a
     * complaint about the team would send the reader to fix the wrong thing. Cheap request validation
     * before the expensive existence check is also the order that keeps a malformed request from touching
     * the database at all.
     */
    stepableInstantFor(date.value);

    /**
     * The team must actually exist, not merely be in scope.
     *
     * Belt and braces over the scope check above, and it closes a real hole: the archive contains
     * merged-scope rows whose `scopeKey` is the merged sentinel rather than a team, and an *unscoped* owner
     * passes every check above. Without this, a POST naming that sentinel would reach
     * `ensureDailyReport` with `scope: {kind:'team', teamKey:'*'}` and persist a daily for a team that does
     * not exist — a row nothing would ever read and nothing would clean up.
     *
     * Checked against the knowledge model rather than against a pattern, because "is this a team" is a
     * question only the model can answer.
     */
    const known = await knownTeamKeys(admitted.scoped);
    if (!known.includes(teamKey)) {
      return jsonError(
        'unknown_team',
        `\`${teamKey}\` is not a team in this organization, so there is no daily to regenerate for it. Compass ` +
          `knows: ${known.join(', ') || 'no teams yet'}. A merged report is derived from its date's team ` +
          'reports, so step one of those and open the merged view for the new date.',
        400,
      );
    }

    const regenerated = await regenerateForInstant({
      organizationId: admitted.organizationId,
      teamKey,
      date: date.value,
    });

    return jsonOk({
      ...regenerated,
      teamKey,
      bounds: timeTravelBounds(admitted.organizationId, regenerated.reportDate),
      detail: regenerated.generated
        ? `Compass ran the whole pipeline for ${regenerated.reportDate} and wrote the report it produced.`
        : `${regenerated.reportDate} was already generated, so this is the report Compass wrote that morning rather than a fresh one.`,
    });
  } catch (error) {
    // A date outside the seeded history, or one that is not a civil date at all. The caller's own
    // request is the problem and the sentence says which part, so it is a 400 rather than a 503.
    if (error instanceof TimeTravelUnavailableError) {
      return jsonError('time_travel_unavailable', error.detail, 400);
    }
    return failure(error);
  }
}
