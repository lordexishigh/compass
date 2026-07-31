import type { NextResponse } from 'next/server';

import { guard } from '../../../../lib/auth/guard';
import {
  failure,
  jsonError,
  jsonOk,
  readJsonObject,
  requiredString,
} from '../../../../lib/auth/http';
import { actorFor, saveTeam, saveTeamMembership, saveWorkingCalendar } from '../../../../lib/roster-source';

/**
 * `/api/roster/teams` — a team, who is on it, and the week it works.
 *
 * Three verbs on one route because they are three edits to one object, and the screen makes
 * all three from the same panel:
 *
 *  - `POST` creates or edits the team itself.
 *  - `PATCH` adds or removes a member. Removal is `active: false`, never a delete — last
 *    Tuesday's report attributed work to that person as a member of this team, and deleting
 *    the row would make that report unexplainable.
 *  - `PUT` replaces the working calendar. A replacement rather than a merge, deliberately:
 *    sending three holidays means the calendar *has* three holidays, and a PATCH that
 *    unioned them would make removing one impossible.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = '/api/roster/teams';

const METHODOLOGIES = ['scrum', 'kanban'] as const;

export async function POST(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'POST' });
  if (!admitted.allowed) return admitted.response;

  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const key = requiredString(parsed.body, 'key');
  if ('response' in key) return key.response;
  const name = requiredString(parsed.body, 'name');
  if ('response' in name) return name.response;

  const methodology = parsed.body['methodology'];
  if (typeof methodology !== 'string' || !(METHODOLOGIES as readonly string[]).includes(methodology)) {
    return jsonError('invalid_request', '`methodology` must be `scrum` or `kanban`.', 400);
  }

  const timezone = requiredString(parsed.body, 'timezone');
  if ('response' in timezone) return timezone.response;

  const optional = (field: string): string | null => {
    const value = parsed.body[field];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  };

  try {
    const result = await saveTeam(
      admitted.scoped,
      {
        key: key.value,
        name: name.value,
        methodology: methodology as 'scrum' | 'kanban',
        projectKey: optional('projectKey'),
        objectiveKey: optional('objectiveKey'),
        conversationKey: optional('conversationKey'),
        timezone: timezone.value,
      },
      actorFor(admitted.identity),
      admitted.now,
    );

    return jsonOk({
      teamKey: key.value,
      outcome: result.outcome,
      detail:
        result.outcome === 'unchanged'
          ? 'Nothing changed, so no version was appended.'
          : 'Saved. The previous version is still on disk, so a report for a past instant resolves the team as it was then.',
    });
  } catch (error) {
    return failure(error);
  }
}

export async function PATCH(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'PATCH' });
  if (!admitted.allowed) return admitted.response;

  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const teamKey = requiredString(parsed.body, 'teamKey');
  if ('response' in teamKey) return teamKey.response;
  const developerKey = requiredString(parsed.body, 'developerKey');
  if ('response' in developerKey) return developerKey.response;

  const active = parsed.body['active'];
  if (typeof active !== 'boolean') {
    return jsonError(
      'invalid_request',
      '`active` must be true to add somebody to the team or false to remove them. Removal keeps the row — it is ' +
        'the evidence that they were on the team when the work happened.',
      400,
    );
  }

  const rawRole = parsed.body['membershipRole'];
  const membershipRole = rawRole === 'lead' ? 'lead' : 'member';

  try {
    const result = await saveTeamMembership(
      admitted.scoped,
      { teamKey: teamKey.value, developerKey: developerKey.value, membershipRole, active },
      actorFor(admitted.identity),
      admitted.now,
    );

    return jsonOk({
      teamKey: teamKey.value,
      developerKey: developerKey.value,
      active,
      outcome: result.outcome,
      detail: active
        ? 'Added. Reports from this instant forward resolve them as a member.'
        : 'Removed from this instant forward. Every earlier report still credits them with the work they did.',
    });
  } catch (error) {
    return failure(error);
  }
}

export async function PUT(request: Request): Promise<NextResponse> {
  const admitted = await guard({ request, route: ROUTE, action: 'PUT' });
  if (!admitted.allowed) return admitted.response;

  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;

  const teamKey = requiredString(parsed.body, 'teamKey');
  if ('response' in teamKey) return teamKey.response;
  const timezone = requiredString(parsed.body, 'timezone');
  if ('response' in timezone) return timezone.response;

  const rawWeekdays = parsed.body['workingWeekdays'];
  if (!Array.isArray(rawWeekdays) || rawWeekdays.some((day) => typeof day !== 'number')) {
    return jsonError(
      'invalid_request',
      '`workingWeekdays` must be an array of ISO weekday numbers — 1 for Monday through 7 for Sunday.',
      400,
    );
  }

  const rawHolidays = parsed.body['holidays'] ?? [];
  if (!Array.isArray(rawHolidays) || rawHolidays.some((date) => typeof date !== 'string')) {
    return jsonError('invalid_request', '`holidays` must be an array of `YYYY-MM-DD` dates.', 400);
  }

  try {
    const result = await saveWorkingCalendar(
      admitted.scoped,
      {
        teamKey: teamKey.value,
        workingWeekdays: rawWeekdays as readonly number[],
        holidays: rawHolidays as readonly string[],
        timezone: timezone.value,
      },
      actorFor(admitted.identity),
      admitted.now,
    );

    return jsonOk({
      teamKey: teamKey.value,
      outcome: result.outcome,
      detail:
        'Saved. Every threshold in the product is measured in working days, so this changes what "3 working days" ' +
        'means for this team from now on. Past reports keep the calendar that was in force when they were written.',
    });
  } catch (error) {
    return failure(error);
  }
}
