import type { Instant } from '@compass/clock';
import type { ScopedDb } from '@compass/db';

import { loadArchiveIndex } from './archive-source';
import { isDemoOrganization } from './auth/guard';
import { listGoals } from './goal-source';
import { readRoster } from './roster-source';

/**
 * How far a new organization has got, and what is left.
 *
 * ## Why this is a read model and not four booleans in a page
 *
 * Two screens ask the same question and must not answer it differently. `/start` shows the
 * path and marks off what is done; `/` decides whether it has a report to render or an
 * explanation to give. If each computed "is this org configured" for itself, the day they
 * disagreed a manager would be told on one screen that setup was complete and on the other
 * that nothing was configured — and the second one is the report, so that is the one that
 * matters.
 *
 * ## Where the step list comes from
 *
 * Not invented here: the four steps are the four things a report is computed *from*, in
 * dependency order. A report needs a team to be about; a team needs a source for its
 * artifacts; alignment needs a goal chain; attribution needs people. Anything else somebody
 * might want to configure — subscriptions, share links, delivery schedules — is not on this
 * path, because a report can exist without it and the path exists to reach a first report.
 *
 * ## The time budget is on the page for a reason
 *
 * Each step carries the minutes it should take, and they sum to nine. That number is a claim
 * the product makes to somebody deciding whether to start now or after lunch, and a claim
 * with no number in it is not one. `tests/first-run.test.tsx` asserts the sum stays under
 * ten, so the budget cannot quietly inflate as steps are added.
 */

export type StepState = 'done' | 'todo';

export type FirstRunStepId = 'source' | 'team' | 'goals' | 'roster';

export interface FirstRunStep {
  readonly id: FirstRunStepId;
  /** `01`–`04`, mono, in fixed order — the same geography as the Six Spine. */
  readonly ordinal: string;
  readonly title: string;
  readonly state: StepState;
  /** What is true right now, stated as a fact rather than as a checkbox label. */
  readonly summary: string;
  /** The minutes this step should take. Printed, and held to a sum under ten by a test. */
  readonly minutes: number;
}

export interface FirstRunReadiness {
  readonly steps: readonly FirstRunStep[];
  /** True when every step is done, so the only thing left is to read the report. */
  readonly ready: boolean;
  /** True when Compass has already written a report for this organization. */
  readonly reportExists: boolean;
  /** True on the seeded demonstration tenant, where all of this is done already. */
  readonly demonstration: boolean;
  readonly teamKeys: readonly string[];
  readonly developerCount: number;
  readonly goalCount: number;
  readonly trackedSourceCount: number;
  readonly unmatchedCount: number;
}

/** The minutes the whole path should take, derived rather than asserted twice. */
export const firstRunMinutes = (readiness: FirstRunReadiness): number =>
  readiness.steps.reduce((total, step) => total + step.minutes, 0);

/** The steps still outstanding, in order. What `/` names when it has no report to give. */
export const outstandingSteps = (readiness: FirstRunReadiness): readonly FirstRunStep[] =>
  readiness.steps.filter((step) => step.state === 'todo');

/**
 * Reads the organization's configuration and turns it into the path.
 *
 * One instant, passed in rather than resolved here: this is called from a page that already
 * has the request's `now` from the guard, and a second clock reading would let the roster be
 * resolved at one instant and the goals at another.
 */
export async function readFirstRunReadiness(input: {
  readonly scoped: ScopedDb;
  readonly organizationId: string;
  readonly now: Instant;
}): Promise<FirstRunReadiness> {
  const [roster, goals, archive] = await Promise.all([
    readRoster(input.scoped, input.now),
    listGoals(input.now),
    // One row is enough to answer "has Compass ever written a report here".
    loadArchiveIndex(input.scoped, 1),
  ]);

  const trackedSourceCount =
    roster.repositories.filter((entry) => entry.tracked).length +
    roster.projects.filter((entry) => entry.tracked).length;

  // Archived goal revisions do not count: a hierarchy whose only node is archived resolves
  // to nothing, so alignment would still have nothing to judge against.
  const liveGoals = goals.nodes.filter((node) => !node.archived);
  const demonstration = isDemoOrganization(input.organizationId);

  const steps: readonly FirstRunStep[] = [
    {
      id: 'source',
      ordinal: '01',
      title: 'Choose where the facts come from',
      state: trackedSourceCount > 0 ? 'done' : 'todo',
      minutes: 1,
      summary:
        trackedSourceCount > 0
          ? `${trackedSourceCount} source${trackedSourceCount === 1 ? '' : 's'} tracked, so the connector has somewhere to read from.`
          : 'Nothing is tracked yet. Compass can read the seeded demonstration dataset, or the repositories and projects you name.',
    },
    {
      id: 'team',
      ordinal: '02',
      title: 'Declare the team the report is about',
      state: roster.teams.length > 0 ? 'done' : 'todo',
      minutes: 3,
      summary:
        roster.teams.length > 0
          ? `${roster.teams.length} team${roster.teams.length === 1 ? '' : 's'}: ${roster.teams.map((team) => team.key).join(', ')}.`
          : 'No team exists, so there is no scope for a report to cover. Compass will not infer one from who commits together.',
    },
    {
      id: 'goals',
      ordinal: '03',
      title: 'Enter the objective the work is measured against',
      state: liveGoals.length > 0 ? 'done' : 'todo',
      minutes: 3,
      summary:
        liveGoals.length > 0
          ? `${liveGoals.length} goal${liveGoals.length === 1 ? '' : 's'} recorded, so alignment has a chain to resolve against.`
          : 'No objective is recorded. Without one Compass reports the work and declines to judge whether it serves anything.',
    },
    {
      id: 'roster',
      ordinal: '04',
      title: 'Match the people to their identifiers',
      state: roster.developers.length > 0 ? 'done' : 'todo',
      minutes: 2,
      summary:
        roster.developers.length > 0
          ? `${roster.developers.length} ${roster.developers.length === 1 ? 'person' : 'people'} configured` +
            (roster.unmatched.length > 0
              ? `, and ${roster.unmatched.length} identifier${roster.unmatched.length === 1 ? '' : 's'} still waiting to be claimed.`
              : ', and every identifier Compass has seen belongs to somebody.')
          : 'Nobody is configured, so every commit and ticket will read as unattributed rather than being credited.',
    },
  ];

  return {
    steps,
    ready: steps.every((step) => step.state === 'done'),
    reportExists: archive.length > 0,
    demonstration,
    teamKeys: roster.teams.map((team) => team.key),
    developerCount: roster.developers.length,
    goalCount: liveGoals.length,
    trackedSourceCount,
    unmatchedCount: roster.unmatched.length,
  };
}

/**
 * Whether this organization has nothing at all yet.
 *
 * The narrow question `/` asks, and narrow on purpose. It is **not** "is there anything to
 * report today" — a team that shipped nothing yesterday still gets six sections with the
 * absences stated, which is the product working correctly and is asserted in
 * `tests/cold-start.test.tsx`. This is the different case: no team and nobody, so there is no
 * subject for a report to be about, and generating one would produce six headings over
 * nothing and imply the org was quiet when in fact it was never configured.
 *
 * Both conditions, not either. An org with people and no team is mid-setup and gets the
 * explanation; an org with a team and no people gets a report that says work is unattributed,
 * which is true and useful.
 */
export const organizationIsUnprovisioned = (readiness: {
  readonly teamKeys: readonly string[];
  readonly developerCount: number;
}): boolean => readiness.teamKeys.length === 0 && readiness.developerCount === 0;
