import { SystemClock } from '@compass/clock';
import { ScopedDb, findLatestReport, ingestRunRowId, orgScope, type CompassDatabase } from '@compass/db';
import { narratorFromEnvironment } from '@compass/narrator';
import { ensureDailyReport, loadFreshnessFor, type EnsuredReport } from '@compass/pipeline';
import { SeedConnector, resolveSeededRun, type SeededRun } from '@compass/seed-connector';

import {
  archiveHref,
  knownTeamKeys,
  simulatedClockAvailable,
  timeTravelBounds,
  type TimeTravelBounds,
} from './archive-source';
import { listDisconnectedSources } from './connect-source';
import {
  organizationHasSubject,
  readFirstRunReadiness,
  type FirstRunStep,
} from './first-run-source';
import { resolveProvider } from './foundation-report';
import { withdrawnNames } from './privacy-source';
import { buildReportView, type ReportView } from './view-model';

/**
 * The request edge.
 *
 * This is one of the two places in Compass allowed to construct a Clock (the
 * other is the worker). It resolves `now` once, picks the connector, opens the
 * pool, and hands all three down as parameters. Nothing below this file reads the
 * time or decides which provider answered — which is why the pipeline this page
 * calls is the same one the worker calls, running against the same code path a
 * live GitHub connector would.
 *
 * The read path is allowed to write, once, and only here: `ensureDailyReport`
 * generates today's report if the boot script has not. That is the whole of the
 * zero-config promise — a manager opens `/` on a cold container and reads a
 * report, with no login wall, no connector wizard and no empty state.
 */

/**
 * The pool moved to `lib/database.ts` and is re-exported here.
 *
 * Every existing caller imports `database` from this module, so the name stays; what
 * changed is that `lib/health.ts` can now reach the same pool without importing the report
 * path — `/api/health` has to be the lightest route in the app, not the one that loads the
 * analysis core and the narrator before it can say whether Postgres answered.
 */
import { database } from './database';

export { database };

/**
 * Which report this request is about.
 *
 * Resolved through the shared `resolveSeededRun`, never decided here: the boot
 * script calls the same function with its own instant, so the report it warmed
 * and the report this request looks for are the same row rather than two rows for
 * one day. The Clock is constructed here because this is a process edge; the
 * instant it produces is the only thing handed downward.
 */
export function requestedRun(): SeededRun {
  return resolveSeededRun({ hostNow: new SystemClock().now() });
}

/**
 * Today's report, generated on demand if nobody has generated it yet.
 *
 * The boot script normally gets there first, so this is usually a read. When it
 * is not — a container restarted past midnight, a day nobody scheduled — the
 * read path generates, which is what makes the page unable to show an empty
 * state. `ensureDailyReport` is keyed by `(organization, scope, report date)`, so
 * two requests racing on a cold start land on the same row rather than on two.
 */
export async function ensureTodaysReport(database_: CompassDatabase): Promise<{
  readonly ensured: EnsuredReport;
  readonly run: SeededRun;
}> {
  const run = requestedRun();
  const connector = new SeedConnector(run.dataset);

  const ensured = await ensureDailyReport({
    organizationId: run.organizationId,
    scope: { kind: 'team', teamKey: run.teamKey },
    now: run.now,
    timezone: run.timezone,
    window: run.window,
    ingestWindow: run.ingestWindow,
    runId: ingestRunRowId(
      run.organizationId,
      connector.connectorId,
      run.ingestWindow.start,
      run.ingestWindow.end,
      1,
    ),
    connector,
    database: database_,
    // Resolved at the edge, exactly like the connector and the clock. Null when
    // `ANTHROPIC_API_KEY` is absent, which is the zero-config default: the report
    // is then the deterministic render, complete and correct, with no fallback
    // flag — nothing was attempted, so nothing degraded.
    narrator: narratorFromEnvironment(process.env),
  });

  return { ensured, run };
}

/**
 * Everything the page needs, already formatted in the team's timezone, so the
 * component tree does no date arithmetic and needs no clock of its own.
 *
 * A degraded substrate is stated in the same place the day shift is: both are
 * reasons the page in front of the reader is not the page they would get on a
 * healthy deployment, and neither may be silent.
 */
export async function loadReportView(): Promise<ReportView> {
  const { ensured, run } = await ensureTodaysReport(database());

  const notes = [run.degradation, run.timeShiftNote].filter(
    (note): note is string => note !== null && note.length > 0,
  );

  return buildReportView({
    bundle: ensured.bundle,
    freshness: ensured.freshness,
    timeShiftNote: notes.length === 0 ? null : notes.join(' '),
    /**
     * Names withdrawn since a report was written.
     *
     * Read on every render rather than baked in at generation, because withdrawal happens
     * *after* the reports it has to affect. A report generated this morning and anonymised
     * this afternoon has to stop printing the name this afternoon, and the stored row is
     * deliberately never rewritten — so the only place this can happen is here, on the way
     * to the page.
     */
    withdrawnNames: await withdrawnNames(new ScopedDb(database(), orgScope(run.organizationId)), run.now),
    /**
     * Sources a manager disconnected.
     *
     * Read here rather than derived from the journal, because the journal cannot say it: a source nobody
     * is reading contributes no coverage row, so on the journal's evidence alone every remaining source
     * answered and the report looks finished. The configuration is the only place the fact exists.
     */
    disconnectedSources: await listDisconnectedSources(new ScopedDb(database(), orgScope(run.organizationId))),
  });
}

/**
 * What `/` has to render: a report, or the reason there is not one.
 *
 * ## Why the check happens before `ensureDailyReport` and not after
 *
 * Generating first and inspecting the result afterwards would be the obvious order and it is
 * the wrong one. `ensureDailyReport` *persists* — an unprovisioned organization would end up
 * with a stored report asserting six empty sections about a team that does not exist, and
 * that row would then be served by the archive, the merged view and every subscription,
 * forever. So the question is asked first, and the write does not happen at all.
 *
 * ## Why this does not weaken the zero-config promise
 *
 * The seeded tenant has teams and people from boot, so it takes the report branch on the very
 * first request exactly as before — the extra cost is one roster read. The guide branch is
 * reachable only by an organization that has genuinely never been configured, which the
 * demonstration deployment never is. And a *quiet* day still renders six sections: this asks
 * whether there is a subject, not whether the subject did anything.
 */
/** One entry in the team switcher: this team, and where its report is. */
export interface TeamOption {
  readonly teamKey: string;
  /** Null for the team already on screen, and for a team with no report written yet. */
  readonly href: string | null;
  readonly isCurrent: boolean;
  /** Set when there is no report to link to, so the absence is stated rather than dead. */
  readonly absence: string | null;
}

/**
 * Every team this organization holds, and where to read each one's report.
 *
 * ## Why the link is a permalink and not a `/team/<key>` route
 *
 * A team's latest stored report is already a page — `/archive/<reportId>` renders the full
 * document, spine and all. Adding a route that generated today's report for an arbitrary team
 * would be a second generation path beside `ensureTodaysReport`, with its own matrix entry and
 * its own way of disagreeing with the scheduler about which instant a day is. Pointing at the row
 * that exists is both smaller and more honest: the switcher takes you to a report Compass has
 * actually written, and says so when it has not written one.
 *
 * The current team carries no href on purpose. A link to the page you are on is a control that
 * looks like it does something and does not.
 */
export async function loadTeamOptions(
  scoped: ScopedDb,
  currentTeamKey: string,
): Promise<readonly TeamOption[]> {
  const teamKeys = await knownTeamKeys(scoped);

  const options = await Promise.all(
    teamKeys.map(async (teamKey): Promise<TeamOption> => {
      if (teamKey === currentTeamKey) {
        return { teamKey, href: null, isCurrent: true, absence: null };
      }

      const latest = await findLatestReport(scoped, { scopeKind: 'team', scopeKey: teamKey });

      return {
        teamKey,
        href: latest === null ? null : archiveHref(latest.id),
        isCurrent: false,
        absence:
          latest === null
            ? 'no report written yet'
            : null,
      };
    }),
  );

  return options;
}

export type HomeView =
  | {
      readonly kind: 'report';
      readonly view: ReportView;
      /**
       * The other teams, and how to reach them.
       *
       * `/` reports on one team — the run's own — and until this existed there was no way to
       * discover that the organization had three. A manager of two or three teams is exactly who
       * this product is for, so a page that silently showed one of their teams and named none of
       * the others was answering a question they had not asked.
       */
      readonly teams: readonly TeamOption[];
      /**
       * The date control, or `null` where stepping `now` is not a meaningful act.
       *
       * Resolved here rather than in the page for the reason every instant in this app is: the
       * bounds are time arithmetic over the seeded history, and `apps/web` renders rather than
       * computes. `null` — not a disabled control — is what a live organization gets, because a
       * disabled affordance is an invitation to ask why, and the honest arrangement is that a
       * feature which cannot apply is not shown. The POST route refuses independently either way.
       */
      readonly timeTravel: {
        readonly bounds: TimeTravelBounds;
        readonly teamKey: string;
      } | null;
    }
  | {
      readonly kind: 'unprovisioned';
      readonly steps: readonly FirstRunStep[];
      readonly reportExists: boolean;
    };

export async function loadHomeView(): Promise<HomeView> {
  const run = requestedRun();
  const scoped = new ScopedDb(database(), orgScope(run.organizationId));

  // Two indexed reads, not the whole readiness model. On every deployment that has been
  // configured — which is every one that matters — this returns true and the report path is
  // reached having paid almost nothing for the question.
  if (await organizationHasSubject(scoped)) {
    const view = await loadReportView();

    return {
      kind: 'report',
      view,
      teams: await loadTeamOptions(scoped, run.teamKey),
      /**
       * `run.teamKey` is the scope `ensureTodaysReport` just generated for, so the key the
       * scrubber posts back is by construction the key this page is about — there is no second
       * source of it that could drift. `/` is always a team report, never the merged scope, so
       * the `scopeKind === 'team'` guard the permalink page needs has nothing to test here.
       */
      timeTravel: simulatedClockAvailable(run.organizationId)
        ? { bounds: timeTravelBounds(run.organizationId, view.reportDate), teamKey: run.teamKey }
        : null,
    };
  }

  // Only now, on the branch that is going to render the step list, is the full model built.
  const readiness = await readFirstRunReadiness({
    scoped,
    organizationId: run.organizationId,
    now: run.now,
  });

  return { kind: 'unprovisioned', steps: readiness.steps, reportExists: readiness.reportExists };
}

/** Freshness on its own, for a surface that must not generate anything. */
export async function loadFreshnessOnly(): Promise<Awaited<ReturnType<typeof loadFreshnessFor>>> {
  const provider = resolveProvider();
  return loadFreshnessFor(database(), provider.organizationId, provider.datasetWindow);
}
