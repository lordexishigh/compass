import {
  absenceCoversInstant,
  absenceIndex,
  calendarFor,
  configurationAt,
  describeArchival,
  describeCalendar,
  describeSuppression,
  detectBlockersWithSuppression,
  entitiesAt,
  resolveScope,
  teamDeveloperKeysAt,
  workingDaysBetween,
  workingDaysBetweenOn,
  type AnalysisEntity,
  type AnalysisEntityVersion,
  type AnalysisSnapshot,
  type AnalysisTicketTransition,
  type Instant,
} from '@compass/analysis';
import { describe, expect, it } from 'vitest';

/**
 * Configuration resolved as of an instant, the working calendar, and the suppression rule.
 *
 * The headline criterion is the first block: *"a report generated for a past instant resolves
 * team membership and tracked repos as they were effective at that instant"*. `snapshot.ts`
 * used to say scope was deliberately not effective-dated and that doing it properly needed
 * the roster's version history — so these tests build that history explicitly and assert the
 * answer moves with the instant rather than with today's configuration.
 *
 * Everything here is a pure function of (snapshot, instant). No database, no clock.
 */

const MAY = 1_777_000_000_000; // an arbitrary fixed base, so every instant below is literal
const DAY = 86_400_000;

/**
 * A day offset as an `Instant`, branded once here.
 *
 * The brand is applied at this single point rather than at each of the thirty-odd call
 * sites, which is the whole reason none of them needs a cast: an `Instant` is what every
 * function under test takes, so producing one here is producing the right type. Declaring
 * `number` instead forced an `as never` onto every argument, and `as never` at the boundary
 * a nominal type exists to guard is worse than having no brand at all — it silences the one
 * check that would catch a raw millisecond count reaching a function expecting an instant.
 */
const at = (dayOffset: number): Instant => (MAY + dayOffset * DAY) as Instant;

const entity = (
  kind: string,
  naturalKey: string,
  fields: Record<string, unknown>,
  firstSeenAt = at(0),
  version = 1,
): AnalysisEntity => ({
  kind,
  naturalKey,
  firstSeenAt,
  lastSeenAt: firstSeenAt,
  beliefAt: firstSeenAt,
  version,
  elapsed: { ageDays: 0, staleDays: 0, seenToday: true, trail: [] },
  fields: fields as AnalysisEntity['fields'],
});

const version = (
  kind: string,
  naturalKey: string,
  versionNumber: number,
  trackedFields: Record<string, unknown>,
  observedAt: Instant,
): AnalysisEntityVersion => ({
  entityKind: kind,
  entityNaturalKey: naturalKey,
  version: versionNumber,
  changedFields: Object.keys(trackedFields).sort(),
  trackedFields,
  observedAt,
  evidenceSourceKey: null,
  evidenceSourceRecordId: null,
});

/**
 * A status transition, so a ticket can be *seen to have stopped moving*.
 *
 * `detectStatusDwell` ignores any ticket with no transition history at all — an item Compass
 * has never seen move might simply predate ingest, and calling that stalled would be an
 * artefact of when Compass was switched on. So a suppressible finding cannot be built out of
 * entities alone; it needs one of these.
 */
const transition = (ticketKey: string, toStatus: string, transitionedAt: Instant): AnalysisTicketTransition => ({
  ticketKey,
  sourceKey: 'primary-tracker',
  sourceRecordId: `${ticketKey}-${transitionedAt}`,
  fromStatus: 'To Do',
  toStatus,
  fromStatusCategory: 'todo',
  toStatusCategory: 'in_progress',
  actorDeveloperKey: null,
  transitionedAt,
});

const snapshotOf = (
  entities: readonly AnalysisEntity[],
  versions: readonly AnalysisEntityVersion[],
  instant: Instant,
  scope: AnalysisSnapshot['scope'] = { kind: 'team', teamKey: 'platform' },
  transitions: readonly AnalysisTicketTransition[] = [],
): AnalysisSnapshot =>
  ({
    organizationId: '00000000-0000-4000-8000-000000000001',
    scope,
    instant,
    timezone: 'Europe/London',
    window: { start: (instant - DAY) as Instant, end: instant },
    collections: {
      entities,
      entityCounts: [],
      entityVersions: versions,
      ticketTransitions: transitions,
      sprintScopeChanges: [],
      corrections: [],
      ingestRuns: [],
    },
  }) as AnalysisSnapshot;

// ---------------------------------------------------------------------------
// The headline criterion
// ---------------------------------------------------------------------------

describe('a report for a past instant resolves the configuration in force then', () => {
  /**
   * The story these fixtures tell:
   *
   *  - day 0: `platform` has Priya and Marcus; `checkout-web` and `legacy-web` are tracked.
   *  - day 10: Marcus leaves the team, and `legacy-web` is archived.
   *
   * A report for day 5 must see both people and both repositories. A report for day 15 must
   * see one of each. Nothing about the day-5 answer may change when day 10 happens.
   */
  const entities: readonly AnalysisEntity[] = [
    entity('team', 'platform', { name: 'Platform', methodology: 'scrum', projectKey: 'PLAT', timezone: 'Europe/London' }),
    entity('project', 'PLAT', { name: 'Platform', teamKey: 'platform', methodology: 'scrum', defaultBranch: 'main' }),
    entity('repository', 'checkout-web', { name: 'checkout-web', projectKey: 'PLAT', defaultBranch: 'main' }),
    entity('repository', 'legacy-web', { name: 'legacy-web', projectKey: 'PLAT', defaultBranch: 'main' }),
    entity('developer', 'priya', { displayName: 'Priya Raman', teamKey: 'platform', active: true }),
    // Marcus's Developer row still names the team. The *membership* is what removed him,
    // which is the case that matters: the two disagree and the removal has to win.
    entity('developer', 'marcus', { displayName: 'Marcus Hale', teamKey: 'platform', active: true }),
    // Current belief: removed, and archived. Version history says when.
    entity('team_membership', 'platform:marcus', {
      teamKey: 'platform',
      developerKey: 'marcus',
      membershipRole: 'member',
      active: false,
    }, at(0), 2),
    entity('team_membership', 'platform:priya', {
      teamKey: 'platform',
      developerKey: 'priya',
      membershipRole: 'lead',
      active: true,
    }),
    entity('tracked_repository', 'legacy-web', {
      repositoryKey: 'legacy-web',
      tracked: false,
      archivedAt: at(10),
      note: 'Frozen; nobody works on it.',
    }, at(0), 2),
  ];

  const versions: readonly AnalysisEntityVersion[] = [
    version('team_membership', 'platform:marcus', 1, {
      teamKey: 'platform',
      developerKey: 'marcus',
      membershipRole: 'member',
      active: true,
    }, at(0)),
    version('team_membership', 'platform:marcus', 2, {
      teamKey: 'platform',
      developerKey: 'marcus',
      membershipRole: 'member',
      active: false,
    }, at(10)),
    version('team_membership', 'platform:priya', 1, {
      teamKey: 'platform',
      developerKey: 'priya',
      membershipRole: 'lead',
      active: true,
    }, at(0)),
    version('tracked_repository', 'legacy-web', 1, {
      repositoryKey: 'legacy-web',
      tracked: true,
      archivedAt: null,
      note: null,
    }, at(0)),
    version('tracked_repository', 'legacy-web', 2, {
      repositoryKey: 'legacy-web',
      tracked: false,
      archivedAt: at(10),
      note: 'Frozen; nobody works on it.',
    }, at(10)),
  ];

  it('resolves membership as it was, not as it is', () => {
    const before = resolveScope(snapshotOf(entities, versions, at(5)));
    const after = resolveScope(snapshotOf(entities, versions, at(15)));

    expect(before.developerKeys, 'Marcus was on the team on day 5').toEqual(['marcus', 'priya']);
    expect(after.developerKeys, 'and off it by day 15').toEqual(['priya']);
  });

  it('resolves tracked repositories as they were, not as they are', () => {
    const before = resolveScope(snapshotOf(entities, versions, at(5)));
    const after = resolveScope(snapshotOf(entities, versions, at(15)));

    expect(before.repositoryKeys, 'legacy-web was tracked on day 5').toEqual(['checkout-web', 'legacy-web']);
    expect(after.repositoryKeys, 'and archived by day 15').toEqual(['checkout-web']);
  });

  it('names what archival excluded rather than letting it silently vanish', () => {
    const after = resolveScope(snapshotOf(entities, versions, at(15)));

    expect(after.archivedRepositoryKeys).toEqual(['legacy-web']);

    const sentence = describeArchival(configurationAt(snapshotOf(entities, versions, at(15)), at(15)));
    expect(sentence).toContain('1 archived repository');
    // Honest degradation: the sentence says the past is intact, because that is the fact a
    // manager needs when a repository stops appearing.
    expect(sentence).toContain('Prior data and prior reports are unchanged');
  });

  it('says nothing about archival when nothing is archived', () => {
    expect(describeArchival(configurationAt(snapshotOf(entities, versions, at(5)), at(5)))).toBeNull();
  });

  it('lets an explicit removal override the Developer row that still names the team', () => {
    // Marcus's `developers.teamKey` is still `platform` at every instant. Only the
    // membership says he left, and it has to be the one that decides.
    expect(teamDeveloperKeysAt(snapshotOf(entities, versions, at(15)), 'platform', at(15))).toEqual(['priya']);
  });

  it('still lists somebody whose only claim is their Developer row', () => {
    // A deployment that has never opened the roster screen has no membership rows at all.
    // Ignoring `developers.teamKey` would empty every team the day this shipped.
    const withoutMemberships = entities.filter((row) => row.kind !== 'team_membership');

    expect(teamDeveloperKeysAt(snapshotOf(withoutMemberships, [], at(15)), 'platform', at(15))).toEqual([
      'marcus',
      'priya',
    ]);
  });

  it('treats an entity first seen after the instant as absent, not merely unconfigured', () => {
    // A repository configured tomorrow is not part of a report about yesterday.
    const late = [
      ...entities,
      entity('repository', 'new-service', { name: 'new-service', projectKey: 'PLAT', defaultBranch: 'main' }, at(20)),
    ];

    expect(resolveScope(snapshotOf(late, versions, at(15))).repositoryKeys).not.toContain('new-service');
    expect(resolveScope(snapshotOf(late, versions, at(25))).repositoryKeys).toContain('new-service');
  });

  it('resolves the belief in force at the instant when several versions precede it', () => {
    const resolved = entitiesAt(snapshotOf(entities, versions, at(12)), 'tracked_repository', at(12));

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.version).toBe(2);
    expect(resolved[0]?.fields['tracked']).toBe(false);
  });

  it('is deterministic: the same snapshot and instant resolve identically', () => {
    const once = resolveScope(snapshotOf(entities, versions, at(15)));
    const twice = resolveScope(snapshotOf(entities, versions, at(15)));

    expect(once).toEqual(twice);
  });

  it('keeps a merged report to the same effective-dated rules', () => {
    const merged = resolveScope(
      snapshotOf(entities, versions, at(15), { kind: 'merged' }),
    );

    expect(merged.repositoryKeys).toEqual(['checkout-web']);
    expect(merged.archivedRepositoryKeys).toEqual(['legacy-web']);
  });
});

// ---------------------------------------------------------------------------
// The working calendar
// ---------------------------------------------------------------------------

describe('a team working calendar feeds working-day calculations', () => {
  /**
   * `MAY` is a Wednesday in UTC, which the first assertion pins — every count below is
   * stated in terms of which weekdays fall in the span, so a shifted base would make them
   * all wrong in the same invisible way.
   */
  const calendarEntities: readonly AnalysisEntity[] = [
    entity('team', 'platform', { name: 'Platform', methodology: 'scrum', projectKey: 'PLAT', timezone: 'UTC' }),
    entity('working_calendar', 'platform', {
      teamKey: 'platform',
      // Sunday to Thursday, which is the case Monday-to-Friday gets wrong.
      workingWeekdays: [7, 1, 2, 3, 4],
      holidays: [],
      timezone: 'UTC',
    }),
  ];

  it('is the default Monday-to-Friday week when nothing is configured', () => {
    const calendar = calendarFor(snapshotOf([], [], at(0)), 'platform', at(0));

    expect(calendar.configured).toBe(false);
    expect(calendar.workingWeekdays).toEqual([1, 2, 3, 4, 5]);
    expect(describeCalendar(calendar)).toContain('no working calendar is configured');
  });

  it('takes the team’s own week once one is configured', () => {
    const calendar = calendarFor(snapshotOf(calendarEntities, [], at(0)), 'platform', at(0));

    expect(calendar.configured).toBe(true);
    expect(calendar.workingWeekdays, 'sorted, so the value is stable').toEqual([1, 2, 3, 4, 7]);
    expect(describeCalendar(calendar)).toContain('Sun');
  });

  it('counts a different number of working days than the default week does', () => {
    const configured = calendarFor(snapshotOf(calendarEntities, [], at(0)), 'platform', at(0));
    const span = 7; // one whole week, so every weekday appears exactly once

    // Five working days either way over a full week — but not the *same* five, which is
    // what a Friday-only span proves below.
    expect(workingDaysBetweenOn(configured, at(0), at(span))).toBe(5);
    expect(workingDaysBetween(at(0), at(span))).toBe(5);
  });

  it('excludes a holiday however it falls', () => {
    const withHoliday: readonly AnalysisEntity[] = [
      entity('working_calendar', 'platform', {
        teamKey: 'platform',
        workingWeekdays: [1, 2, 3, 4, 5],
        // The base instant's own civil date, so exactly one working day is removed.
        holidays: [new Date(at(0)).toISOString().slice(0, 10)],
        timezone: 'UTC',
      }),
    ];

    const plain = calendarFor(snapshotOf([], [], at(0)), 'platform', at(0));
    const holidayed = calendarFor(snapshotOf(withHoliday, [], at(0)), 'platform', at(0));

    const plainCount = workingDaysBetweenOn(plain, at(0), at(7));
    const holidayedCount = workingDaysBetweenOn(holidayed, at(0), at(7));

    expect(holidayedCount).toBe(plainCount - 1);
  });

  it('falls back rather than silencing the product when a calendar has no working days', () => {
    // A hand-edited row could be empty. Counting every day as non-working would make every
    // elapsed measurement zero and no threshold could ever be crossed — the product would
    // go quiet without ever saying why.
    const empty: readonly AnalysisEntity[] = [
      entity('working_calendar', 'platform', {
        teamKey: 'platform',
        workingWeekdays: [],
        holidays: [],
        timezone: 'UTC',
      }),
    ];

    expect(calendarFor(snapshotOf(empty, [], at(0)), 'platform', at(0)).workingWeekdays).toEqual([1, 2, 3, 4, 5]);
  });

  it('takes no calendar for a merged report, because two teams may work different weeks', () => {
    expect(calendarFor(snapshotOf(calendarEntities, [], at(0)), null, at(0)).configured).toBe(false);
  });

  it('leaves the default count byte-identical to what it was before calendars existed', () => {
    // The whole point of keeping `workingDaysBetween`'s signature: a deployment with no
    // configured calendar must produce exactly the numbers it produced yesterday.
    for (const span of [1, 3, 7, 14, 30]) {
      expect(workingDaysBetweenOn(calendarFor(snapshotOf([], [], at(0)), 'platform', at(0)), at(0), at(span))).toBe(
        workingDaysBetween(at(0), at(span)),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The suppression rule
// ---------------------------------------------------------------------------

describe('an active absence suppresses stalled-work findings naming that person', () => {
  const REPORT_INSTANT = at(20);

  const withAbsence = (fields: Record<string, unknown>): AnalysisSnapshot =>
    snapshotOf([entity('absence', 'priya:1', fields)], [], REPORT_INSTANT);

  it('covers the instant on a half-open range', () => {
    expect(absenceCoversInstant({ startAt: at(19), endAt: at(21) }, REPORT_INSTANT)).toBe(true);
    // An absence that ends at the instant does not cover it — the same half-open rule every
    // other span in the product follows.
    expect(absenceCoversInstant({ startAt: at(18), endAt: REPORT_INSTANT }, REPORT_INSTANT)).toBe(false);
    expect(absenceCoversInstant({ startAt: REPORT_INSTANT, endAt: at(22) }, REPORT_INSTANT)).toBe(true);
  });

  it('indexes the person it is about', () => {
    const index = absenceIndex(
      withAbsence({
        developerKey: 'priya',
        absenceKind: 'leave',
        startAt: at(19),
        endAt: at(25),
        note: 'annual leave',
        source: 'manual',
        sourceRef: null,
      }),
      REPORT_INSTANT,
    );

    expect(index.any).toBe(true);
    expect(index.suppressing('priya')?.kind).toBe('leave');
    expect(index.suppressing('marcus'), 'somebody else is not covered').toBeNull();
  });

  it('never suppresses an unassigned item', () => {
    const index = absenceIndex(
      withAbsence({
        developerKey: 'priya',
        absenceKind: 'leave',
        startAt: at(19),
        endAt: at(25),
        note: null,
        source: 'manual',
        sourceRef: null,
      }),
      REPORT_INSTANT,
    );

    // "Nobody is named, so nobody is out" is the only defensible reading — suppressing an
    // unattributed item would hide a genuinely stalled ticket behind somebody's holiday.
    expect(index.suppressing(null)).toBeNull();
    expect(index.suppressing('')).toBeNull();
    expect(index.suppressing(undefined)).toBeNull();
  });

  it('ignores an absence that has ended before the instant', () => {
    const index = absenceIndex(
      withAbsence({
        developerKey: 'priya',
        absenceKind: 'leave',
        startAt: at(10),
        endAt: at(15),
        note: null,
        source: 'manual',
        sourceRef: null,
      }),
      REPORT_INSTANT,
    );

    expect(index.any).toBe(false);
    expect(index.suppressing('priya')).toBeNull();
  });

  it('states the reason and the source a report links to', () => {
    const manual = describeSuppression(
      {
        naturalKey: 'priya:1',
        developerKey: 'priya',
        kind: 'leave',
        startAt: at(19),
        endAt: at(25),
        note: 'annual leave',
        source: 'manual',
        sourceRef: null,
      },
      'Priya Raman',
    );

    expect(manual.reason).toContain('Priya Raman');
    expect(manual.reason).toContain('leave');
    expect(manual.reason).toContain('annual leave');
    expect(manual.reason).toContain('recorded in the roster');
    expect(manual.sourceLabel).toBe('roster');
  });

  it('links a memo-sourced absence back to the memo that stated it', () => {
    const fromMemo = describeSuppression(
      {
        naturalKey: 'priya:1',
        developerKey: 'priya',
        kind: 'leave',
        startAt: at(19),
        endAt: at(25),
        note: null,
        source: 'memo',
        sourceRef: 'memo:2026-08-01:priya-out',
      },
      'Priya Raman',
    );

    expect(fromMemo.reason).toContain('from a manager memo');
    // The link target, so the claim is checkable rather than merely asserted.
    expect(fromMemo.sourceLabel).toBe('memo:2026-08-01:priya-out');
  });

  it('does not suppress a tracker-stated blocker even when the assignee is absent', () => {
    /**
     * Two blockers about two people, one of whom is out:
     *
     *  - `PLAT-1` is flagged blocked *by the tracker* and assigned to Priya, who is on leave.
     *    A flagged ticket is blocked whether or not its assignee is at their desk — that is a
     *    stated fact about the work, and suppressing it would hide a real impediment behind
     *    somebody's holiday.
     *  - `PLAT-2` sits in a blocked status and is assigned to Marcus, who is present.
     *
     * So the expected `suppressed` list is empty, and the title says so. It used to claim to
     * withhold a silence-inferred finding while asserting the opposite, which left the
     * headline behaviour of this task — suppression actually firing — covered by nothing. The
     * tests below cover it.
     */
    const snapshot = snapshotOf(
      [
        entity('team', 'platform', { name: 'Platform', methodology: 'scrum', projectKey: 'PLAT', timezone: 'UTC' }),
        entity('project', 'PLAT', { name: 'Platform', teamKey: 'platform', methodology: 'scrum', defaultBranch: 'main' }),
        entity('developer', 'priya', { displayName: 'Priya Raman', teamKey: 'platform', active: true }),
        entity('developer', 'marcus', { displayName: 'Marcus Hale', teamKey: 'platform', active: true }),
        entity('absence', 'priya:1', {
          developerKey: 'priya',
          absenceKind: 'leave',
          startAt: at(19),
          endAt: at(25),
          note: null,
          source: 'manual',
          sourceRef: null,
        }),
        entity('ticket', 'PLAT-1', {
          projectKey: 'PLAT',
          itemKey: 'PLAT-1',
          title: 'Flagged by the tracker',
          status: 'Blocked',
          statusCategory: 'in_progress',
          assigneeDeveloperKey: 'priya',
          flaggedBlocked: true,
        }),
        entity('ticket', 'PLAT-2', {
          projectKey: 'PLAT',
          itemKey: 'PLAT-2',
          title: 'In a blocked status',
          status: 'Blocked',
          statusCategory: 'in_progress',
          assigneeDeveloperKey: 'marcus',
          flaggedBlocked: false,
        }),
      ],
      [],
      REPORT_INSTANT,
    );

    const detection = detectBlockersWithSuppression(snapshot, REPORT_INSTANT, resolveScope(snapshot));
    const reported = detection.blockers.map((blocker) => blocker.subject.key);

    // Both are tracker-stated, so neither is suppressed — the absence does not silence a
    // fact the tracker asserted.
    expect(reported).toContain('PLAT-1');
    expect(reported).toContain('PLAT-2');
    expect(detection.suppressed).toEqual([]);
  });

  /**
   * The suppression path, end to end — the behaviour this whole task exists for.
   *
   * `PLAT-3` is a `status_dwell` finding: in flight, in no blocked status, last moved on day
   * 10, and assigned to Priya. At `REPORT_INSTANT` (day 20) that is well past T1's three
   * working days, so the finding *is* generated — and it is inferred from silence, which is
   * exactly the class an absence withholds. Priya's leave covers day 20.
   *
   * `absence` takes the source so the same fixture proves both provenances, because the
   * `sourceLabel` is what the report turns into the link a reader checks the claim against.
   */
  const stalledUnderAbsence = (absence: { readonly source: string; readonly sourceRef: string | null }) =>
    snapshotOf(
      [
        entity('team', 'platform', { name: 'Platform', methodology: 'scrum', projectKey: 'PLAT', timezone: 'UTC' }),
        entity('project', 'PLAT', { name: 'Platform', teamKey: 'platform', methodology: 'scrum', defaultBranch: 'main' }),
        entity('developer', 'priya', { displayName: 'Priya Raman', teamKey: 'platform', active: true }),
        entity('absence', 'priya:1', {
          developerKey: 'priya',
          absenceKind: 'leave',
          startAt: at(19),
          endAt: at(25),
          note: 'annual leave',
          source: absence.source,
          sourceRef: absence.sourceRef,
        }),
        entity('ticket', 'PLAT-3', {
          projectKey: 'PLAT',
          itemKey: 'PLAT-3',
          title: 'Quietly not moving',
          status: 'In Progress',
          statusCategory: 'in_progress',
          assigneeDeveloperKey: 'priya',
          flaggedBlocked: false,
        }),
      ],
      [],
      REPORT_INSTANT,
      { kind: 'team', teamKey: 'platform' },
      [transition('PLAT-3', 'In Progress', at(10))],
    );

  it('withholds a silence-inferred stall naming somebody whose absence covers the instant', () => {
    const snapshot = stalledUnderAbsence({ source: 'manual', sourceRef: null });
    const detection = detectBlockersWithSuppression(snapshot, REPORT_INSTANT, resolveScope(snapshot));

    // Withheld, not merely absent: the finding exists and was taken out of the report.
    expect(detection.blockers.map((blocker) => blocker.subject.key)).not.toContain('PLAT-3');
    expect(detection.suppressed).toHaveLength(1);

    const [withheld] = detection.suppressed;
    expect(withheld?.blocker.subject.key).toBe('PLAT-3');
    expect(withheld?.blocker.signal).toBe('status_dwell');

    // The reason is stated in the product's voice, names the person rather than blaming them,
    // and carries the note the manager typed.
    expect(withheld?.note.reason).toContain('Priya Raman');
    expect(withheld?.note.reason).toContain('leave');
    expect(withheld?.note.reason).toContain('annual leave');
    expect(withheld?.note.developerKey).toBe('priya');
    expect(withheld?.note.absenceKey).toBe('priya:1');
    // A manually recorded absence links back to the roster, which is where it can be checked.
    expect(withheld?.note.sourceLabel).toBe('roster');
    expect(withheld?.note.source).toBe('manual');
  });

  it('links a withheld finding to the memo when that is where the absence came from', () => {
    const snapshot = stalledUnderAbsence({ source: 'memo', sourceRef: 'memo:2026-08-01:priya-out' });
    const detection = detectBlockersWithSuppression(snapshot, REPORT_INSTANT, resolveScope(snapshot));

    expect(detection.suppressed).toHaveLength(1);
    expect(detection.suppressed[0]?.note.reason).toContain('from a manager memo');
    expect(detection.suppressed[0]?.note.sourceLabel).toBe('memo:2026-08-01:priya-out');
  });

  it('states the same finding as normal once the absence no longer covers the instant', () => {
    // The control the assertion above needs. Without it, "PLAT-3 is not in the blockers" could
    // just as well mean the finding was never generated, and the suppression rule could be
    // doing nothing at all while every assertion still passed.
    const snapshot = stalledUnderAbsence({ source: 'manual', sourceRef: null });
    const afterwards = at(30);

    const detection = detectBlockersWithSuppression(snapshot, afterwards, resolveScope(snapshot));

    expect(detection.blockers.map((blocker) => blocker.subject.key)).toContain('PLAT-3');
    expect(detection.suppressed).toEqual([]);
  });

  it('leaves output byte-identical when nobody is absent', () => {
    const base = snapshotOf(
      [
        entity('team', 'platform', { name: 'Platform', methodology: 'scrum', projectKey: 'PLAT', timezone: 'UTC' }),
        entity('project', 'PLAT', { name: 'Platform', teamKey: 'platform', methodology: 'scrum', defaultBranch: 'main' }),
      ],
      [],
      REPORT_INSTANT,
    );

    const detection = detectBlockersWithSuppression(base, REPORT_INSTANT, resolveScope(base));

    expect(detection.suppressed).toEqual([]);
    expect(absenceIndex(base, REPORT_INSTANT).any).toBe(false);
  });
});
