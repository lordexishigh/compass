import { findLatestReport, loadReportBundle } from '@compass/db';
import type { NextResponse } from 'next/server';

import { guard } from '../../../../lib/auth/guard';
import { failure, jsonError, jsonOk } from '../../../../lib/auth/http';

/**
 * `GET /api/reports/<teamKey>` — one team's latest report.
 *
 * This is the route the team-scoping rule exists for. A manager scoped to team A asking
 * for team B is refused with **403** by `guard`, before this handler runs and before any
 * query is built — so the refusal cannot leak whether team B has a report at all. The
 * matrix marks the route `teamScoped: true`; `teamScopeAllows` is the one implementation
 * of "may this principal read this team".
 *
 * 403 rather than 404, deliberately. A 404 would be the more secretive answer, and it
 * would also be a lie: the report exists, and the honest thing to tell a colleague is
 * that it is not in their scope and which owner can change that. Compass does not
 * pretend data is absent in order to look careful.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Context = { readonly params: Promise<{ readonly teamKey: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const { teamKey } = await context.params;

  const admitted = await guard({
    request,
    route: '/api/reports/[teamKey]',
    action: 'GET',
    teamKey,
  });
  if (!admitted.allowed) return admitted.response;

  try {
    const scope = { scopeKind: 'team', scopeKey: teamKey } as const;
    const latest = await findLatestReport(admitted.scoped, scope);
    if (latest === null) {
      // A stated absence, in the product's own voice, and 200 — the request was
      // correct and the answer is "nothing yet", which is different from an error.
      return jsonOk({
        teamKey,
        report: null,
        detail:
          `No report has been generated for team \`${teamKey}\` yet. The worker generates one per working day; ` +
          'a cold deployment generates the first on the next read of the report page.',
      });
    }

    const bundle = await loadReportBundle(admitted.scoped, latest.id);
    if (bundle === null) {
      return jsonError(
        'report_incomplete',
        `Report ${latest.id} has a header but no sections, which should not be possible. Regenerate it.`,
        503,
      );
    }

    return jsonOk({
      teamKey,
      report: {
        id: bundle.report.id,
        reportDate: bundle.report.reportDate,
        timezone: bundle.report.timezone,
        coverageStatus: bundle.report.coverageStatus,
        rendererId: bundle.report.rendererId,
        // The six sections, in the order they are in every report forever.
        sections: bundle.sections.map((section) => ({
          key: section.sectionKey,
          ordinal: section.ordinal,
          title: section.title,
          prose: section.prose,
          itemCount: section.itemCount,
          emptyStatement: section.emptyStatement,
          items: section.items.map((item) => ({
            stableId: item.stableId,
            headline: item.headline,
            prose: item.prose,
            ageDays: item.ageDays,
            changeTag: item.changeTag,
          })),
        })),
      },
      readAs: admitted.principal,
    });
  } catch (error) {
    return failure(error);
  }
}
