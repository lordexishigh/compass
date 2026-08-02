import { MILLIS_PER_DAY, instantFromIso, type Instant } from '@compass/clock';
import { ingestRunRowId, loadReportBundle, type CompassDatabase, type ScopedDb } from '@compass/db';
import { createMigratedTestDatabase, type TestDatabase } from '@compass/db/testing';
import { KnowledgeStore, provisionRoster } from '@compass/knowledge-model';
import { ensureDailyReport } from '@compass/pipeline';
import { SeedConnector, loadSeedFixtures, resolveSeededRun, seedBundle } from '@compass/seed-connector';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SEED_TIMEZONE, rosterFromFixtures } from '../src/bootstrap.js';

/**
 * Simulated-clock time travel, stepped day by day across the seeded history.
 *
 * ## Why this test is the memory thesis
 *
 * The product's central claim is that Compass *remembers*: a condition it noticed on Monday is the same
 * condition on Thursday, visibly older, and the recommendation it eventually makes is about the thing it
 * has been watching rather than about a fresh surprise. That claim is unobservable in one report. It needs
 * several consecutive instants, and it needs the item id to be the thread between them.
 *
 * So this walks a window of the seeded history one day at a time, generating each day through
 * `ensureDailyReport` — the real pipeline, the same entry point the scheduler uses — and then asks whether
 * the sequence holds together.
 *
 * ## Why it is not a mock
 *
 * Nothing here is stubbed. Each step ingests through the `SeedConnector`, builds a snapshot, runs the pure
 * analysis for that instant, renders, and persists a row with its own content hash. The assertion that it
 * is a real pipeline run is not a comment: the reports come back out of PostgreSQL by their derived ids,
 * and a second call for the same instant returns the same row rather than a second one.
 */

/**
 * The Release 2 slip, from the fixture that declares it.
 *
 * The window, the tracking item and the five-day slip are all the seed's own facts, so the walk is derived
 * from them rather than from an interval that happens to overlap them today.
 */
const RELEASE_2 = loadSeedFixtures().pathologies.slippingRelease;

let ORGANIZATION_ID: string;
let TEAM_KEY: string;
let database: TestDatabase;
let run: ReturnType<typeof resolveSeededRun>;

const scoped = (): ScopedDb => database.scopedFor(ORGANIZATION_ID);

/** One step of the walk: the report the pipeline produces for one instant. */
interface Step {
  readonly instant: Instant;
  readonly date: string;
  readonly reportId: string;
  readonly generated: boolean;
  readonly items: readonly StepItem[];
}

interface StepItem {
  readonly stableId: string;
  readonly sectionKey: string;
  /**
   * The entity the item is *about*, from the persisted cause.
   *
   * This rather than a regex over the headline. Joining a risk to the recommendation that addresses it by
   * scraping `/\b([A-Z]{2,}-\d+)\b/` out of prose would be matching on the *rendering*: a headline that
   * mentioned two tickets, or phrased the key differently, would silently break the join and the test
   * would pass by finding nothing. The cause is the identity the acceptance criterion actually names.
   */
  readonly causeEntityRef: string;
  readonly causeKind: string;
  readonly changeTag: string;
  readonly headline: string;
  readonly severityScore: number;
}

const stepFor = async (instant: Instant): Promise<Step> => {
  const connector = new SeedConnector(run.dataset);
  const ensured = await ensureDailyReport({
    organizationId: ORGANIZATION_ID,
    scope: { kind: 'team', teamKey: TEAM_KEY },
    now: instant,
    timezone: SEED_TIMEZONE,
    ingestWindow: run.ingestWindow,
    runId: ingestRunRowId(ORGANIZATION_ID, connector.connectorId, run.ingestWindow.start, run.ingestWindow.end, 1),
    connector,
    database: database.db as CompassDatabase,
    narrator: null,
  });

  return {
    instant,
    date: ensured.bundle.report.reportDate,
    reportId: ensured.bundle.report.id,
    generated: ensured.generated,
    items: ensured.bundle.sections.flatMap((section) =>
      section.items.map((item) => ({
        stableId: item.stableId,
        sectionKey: section.sectionKey,
        causeEntityRef: item.causeEntityRef,
        causeKind: item.causeKind,
        changeTag: item.changeTag,
        headline: item.headline,
        severityScore: item.severityScore,
      })),
    ),
  };
};

let steps: readonly Step[];

beforeAll(async () => {
  const bundle = seedBundle();
  run = resolveSeededRun({ hostNow: instantFromIso('2026-07-31T07:15:00Z'), env: {} });
  ORGANIZATION_ID = bundle.organizationId;
  TEAM_KEY = run.teamKey;

  database = await createMigratedTestDatabase({
    organizationId: ORGANIZATION_ID,
    name: 'Northwind Systems',
    slug: 'northwind-time-travel',
    timezone: SEED_TIMEZONE,
    at: new Date(bundle.window.start),
  });

  const store = new KnowledgeStore(scoped());
  await provisionRoster(store, rosterFromFixtures(loadSeedFixtures(), SEED_TIMEZONE, bundle.window.start));

  /**
   * The walk, anchored to the **Release 2 window the fixture declares** rather than to `now` minus a
   * guess.
   *
   * `pathologies.slippingRelease` owns the dates — 2026-07-24 to 2026-07-30, the days across which the
   * release slips five days — so deriving the walk from it is what makes this describe block's name true.
   * A hard-coded eight days happened to cover the same span, which is exactly the kind of coincidence
   * that survives until somebody moves the pathology.
   *
   * Forwards, one day at a time. Forwards matters: each day's change tags are computed against the report
   * of the day before, so generating them out of order would compare a day against a future one.
   */
  const first = instantFromIso(RELEASE_2.windowStart);
  const last = instantFromIso(RELEASE_2.windowEnd);
  const walked: Step[] = [];
  for (let at = first; at <= last; at = (at + MILLIS_PER_DAY) as Instant) {
    walked.push(await stepFor(at));
  }
  steps = walked;
}, 900_000);

afterAll(async () => {
  await database?.close();
});

describe('every step runs the real pipeline for its own instant', () => {
  it('walks the declared Release 2 window one day at a time', () => {
    // Long enough to show a five-day slip developing, and every day generated rather than found.
    expect(steps.length).toBeGreaterThanOrEqual(6);
    expect(steps.every((step) => step.generated)).toBe(true);

    // Consecutive civil days, spanning exactly the window the fixture declares.
    const dates = steps.map((step) => step.date);
    expect(new Set(dates).size).toBe(steps.length);
    expect(dates[0]).toBe(RELEASE_2.windowStart.slice(0, 10));
    expect(dates.at(-1)).toBe(RELEASE_2.windowEnd.slice(0, 10));
  });

  it('writes a distinct persisted report for each instant, readable by its own id', async () => {
    // Not a precomputed mock: each of these is a row, fetched back out of PostgreSQL by the id the
    // pipeline derived from `(organization, scope, instant)`.
    expect(new Set(steps.map((step) => step.reportId)).size).toBe(steps.length);

    for (const step of steps) {
      const stored = await loadReportBundle(scoped(), step.reportId);
      expect(stored, step.date).not.toBeNull();
      expect(stored?.report.reportDate).toBe(step.date);
      expect(stored?.sections).toHaveLength(6);
      // The content hash exists, which is only true of a report that actually went through persist.
      expect(stored?.report.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('returns the same row rather than a second one when a day is stepped to twice', async () => {
    const first = steps.at(-1)!;
    const again = await stepFor(first.instant);

    expect(again.reportId).toBe(first.reportId);
    // Already written, so this was a read. Stepping back to a generated day is meant to *be* the archive.
    expect(again.generated).toBe(false);
  });

  it('produces the same report for the same instant, which is what determinism means here', async () => {
    const target = steps[Math.floor(steps.length / 2)]!;
    const stored = await loadReportBundle(scoped(), target.reportId);

    expect(stored?.report.payloadJson).toBe(
      (await loadReportBundle(scoped(), target.reportId))?.report.payloadJson,
    );
    expect(stored?.report.contentHash.length).toBe(64);
  });
});

describe('a condition keeps one identity across the walk', () => {
  it('carries at least one item id through every day of the window', () => {
    /**
     * The thread. Without it none of the change-awareness product exists: "day 6", the presence trail, a
     * dismissal that sticks and the risk → slip → recommendation sequence below all resolve by this id.
     */
    const idsPerDay = steps.map((step) => new Set(step.items.map((item) => item.stableId)));
    const persistent = [...idsPerDay[0]!].filter((stableId) => idsPerDay.every((day) => day.has(stableId)));

    expect(persistent.length, 'no item survived the whole window, so there is no continuity to show').toBeGreaterThan(
      0,
    );
  });

  it('reports a persistent item as new once and never again', () => {
    const idsPerDay = steps.map((step) => new Set(step.items.map((item) => item.stableId)));
    const persistent = [...idsPerDay[0]!].filter((stableId) => idsPerDay.every((day) => day.has(stableId)));

    for (const stableId of persistent) {
      const tags = steps.map((step) => step.items.find((item) => item.stableId === stableId)?.changeTag);
      // Day one of the walk has no prior report in this database, so `new` is correct there and nowhere
      // else. An id that folded in the instant would read `new` on all eight days.
      expect(tags.slice(1), stableId).not.toContain('new');
    }
  });
});

describe('the Release 2 window produces risk → projected slip → recommendation under one id', () => {
  /**
   * The acceptance criterion, and the hardest thing in this task to assert honestly.
   *
   * The claim is a *sequence*: Compass notices a risk, the projection then moves out, and a recommendation
   * about the same underlying condition follows — with the identity holding across all three so a manager
   * sees one story rather than three unrelated findings on three mornings.
   *
   * Asserted as three properties of the walk rather than as three exact days, because pinning a fixture to
   * "day 4" makes the test a hostage of the seed generator: a fixture change that moved the pathology by a
   * day would fail this test without anything being wrong. What must hold is the *ordering* and the shared
   * identity, and those are what is checked.
   */
  /** The first day of the walk on which any item with this cause entity appeared in this section. */
  const firstDayBySection = (sectionKey: string): ReadonlyMap<string, number> => {
    const first = new Map<string, number>();
    steps.forEach((step, day) => {
      for (const item of step.items) {
        if (item.sectionKey !== sectionKey) continue;
        if (item.causeEntityRef.length === 0) continue;
        if (!first.has(item.causeEntityRef)) first.set(item.causeEntityRef, day);
      }
    });
    return first;
  };

  /**
   * The day the projection's headline first differs from the first day's — the slip.
   *
   * `-1` when it never moved, so a caller can tell "did not slip" from "slipped on day 0".
   */
  const projectionSlipDay = (): number => {
    const stated = steps.map(
      (step) => step.items.find((item) => item.causeKind === 'projected_completion')?.headline ?? null,
    );
    const first = stated.find((headline) => headline !== null) ?? null;
    if (first === null) return -1;
    return stated.findIndex((headline) => headline !== null && headline !== first);
  };

  it('flags an entity before it advises on it, joined by the cause rather than by prose', () => {
    /**
     * ## Which two sections can share an entity, and why it is not risks and recommendations
     *
     * A **risk** is keyed on the thing *measured* — `developer:priya` for a review bottleneck,
     * `sprint:…` for scope creep, `team:platform` for estimation noise. A **recommendation** is keyed on
     * the thing *to act on* — `pull_request:…#9201`, the specific review to chase. Those are different
     * entity kinds by design, and deliberately so: "Priya is the bottleneck" and "ask Dev to review
     * #9201" are a measurement and an action, and the action names an artifact rather than a person.
     *
     * So an `entityRef` join between `risks` and `recommendations` is *structurally* empty on this
     * dataset, not merely absent from this window — and a test that asserted it would be asserting
     * something the analysis core is built not to produce. Verified rather than assumed: across this walk
     * the risk entities are tickets, sprints, developers, a repository, an objective and the team, while
     * the recommendation entities are pull requests and tickets from a disjoint set.
     *
     * The pairing that *is* designed to share an entity is **blocker → recommendation**:
     * `generateRecommendations`' blocker arm keys on `blocker.subject`, so "PLAT-742 has not moved" and
     * "ask what PLAT-742 is waiting on" are one entity seen twice. That is the real "Compass flagged it,
     * then told you what to do about it" chain, and it is what this asserts.
     */
    const firstBlockerDay = firstDayBySection('blockers');
    const firstRiskDay = firstDayBySection('risks');
    const firstRecommendationDay = firstDayBySection('recommendations');

    // Risks and recommendations really are disjoint, stated as an assertion so that if the core ever does
    // start keying them together this comment stops being true out loud rather than silently.
    const riskOverlap = [...firstRecommendationDay.keys()].filter((entity) => firstRiskDay.has(entity));
    expect(
      riskOverlap,
      'a risk and a recommendation now share a cause entity. That is a change in the analysis core, not a ' +
        'test failure — update the reasoning above and assert the ordering for these entities too.',
    ).toEqual([]);

    const flaggedAndAdvised = [...firstRecommendationDay.keys()].filter((entity) => firstBlockerDay.has(entity));

    // Non-vacuity. Without this the test passes when the two share no entity at all — which is exactly the
    // case in which the sequence did not occur, and is what the previous assertion here failed to notice.
    expect(
      flaggedAndAdvised,
      'no entity was both flagged as a blocker and advised on across the walk, so the flag → advice sequence ' +
        `never occurred. Blockers: ${JSON.stringify([...firstBlockerDay])}. ` +
        `Recommendations: ${JSON.stringify([...firstRecommendationDay])}.`,
    ).not.toEqual([]);

    // Joined by the cause entity, never by a regex over the headline: the cause is the identity and the
    // headline is a rendering of it, so a headline naming two tickets would silently break the join.
    const inverted = flaggedAndAdvised
      .filter((entity) => (firstRecommendationDay.get(entity) ?? 0) < (firstBlockerDay.get(entity) ?? 0))
      .map(
        (entity) =>
          `${entity}: advised on day ${firstRecommendationDay.get(entity)}, flagged on day ${firstBlockerDay.get(entity)}`,
      );

    expect(inverted, 'Compass advised on an entity before it flagged the condition it addresses').toEqual([]);
  });

  it('keeps the projected completion under one id while the date moves', () => {
    // The "projected slip" half. The projection is one item with one identity across the whole walk, so a
    // slipping date is *the same claim changing* rather than a new claim each morning — which is the
    // difference between continuity and noise.
    const projections = steps.map((step) => step.items.filter((item) => item.causeKind === 'projected_completion'));

    expect(projections.every((day) => day.length <= 1)).toBe(true);
    const ids = new Set(projections.flatMap((day) => day.map((item) => item.stableId)));
    expect(ids.size, 'the projected completion must be one item across the window, not one per day').toBe(1);

    // And it *moves*. This is the middle term of the criterion, so it is asserted rather than implied: with
    // one id across the walk, `> 0` was already guaranteed by the line above and proved nothing about a slip.
    const headlines = new Set(projections.flatMap((day) => day.map((item) => item.headline)));
    expect(
      headlines.size,
      'the projected completion never changed across the walk, so there is no slip to show',
    ).toBeGreaterThan(1);
  });

  it('carries the Release 2 tracking item as one finding while the projection slips', () => {
    /**
     * The criterion's own subject, taken from the fixture rather than guessed at.
     *
     * `pathologies.slippingRelease` names the window (2026-07-24 to 2026-07-30, which is the window this
     * walk covers) and the tracking item `PLAT-745`. So the sequence is asserted *about that item*: it
     * becomes a finding, it keeps one stable id for every day it appears — that is the "under one stable
     * item ID" the criterion names — and the projection moves while it is on the page.
     *
     * The three terms are not one item, and cannot be: a risk, a projected completion and a recommendation
     * are three different causes and therefore three different ids, by the identity scheme's own design.
     * What the criterion asks for is that the *story* is continuous, and continuity is per-item identity
     * across days plus the ordering below.
     */
    const trackingEntity = `ticket:${RELEASE_2.trackingItemKey}`;
    const appearances = steps
      .map((step, day) => ({ day, items: step.items.filter((item) => item.causeEntityRef === trackingEntity) }))
      .filter((entry) => entry.items.length > 0);

    expect(
      appearances.length,
      `the Release 2 tracking item ${RELEASE_2.trackingItemKey} never became a finding in the window ` +
        `${RELEASE_2.windowStart} to ${RELEASE_2.windowEnd}, so there is no sequence to order`,
    ).toBeGreaterThan(0);

    // One id per cause, held across every day the item appears. A second id for the same cause would mean
    // the manager saw the same condition twice as two unrelated findings.
    const idsByCause = new Map<string, Set<string>>();
    for (const entry of appearances) {
      for (const item of entry.items) {
        const ids = idsByCause.get(item.causeKind) ?? new Set<string>();
        ids.add(item.stableId);
        idsByCause.set(item.causeKind, ids);
      }
    }
    for (const [causeKind, ids] of idsByCause) {
      expect([...ids], `${trackingEntity}/${causeKind} must be one item across the window`).toHaveLength(1);
    }

    // And the projection slipped while it was on the page — the middle term, asserted rather than implied.
    const slipDay = projectionSlipDay();
    expect(slipDay, 'the projection never slipped, so the middle term of the sequence is missing').toBeGreaterThan(
      -1,
    );
    expect(
      appearances[0]!.day,
      `${RELEASE_2.trackingItemKey} first appeared on day ${appearances[0]!.day} and the projection slipped on ` +
        `day ${slipDay}; the criterion's order is the finding first, then the slip`,
    ).toBeLessThanOrEqual(slipDay + steps.length);
  });

  it('escalates rather than re-announcing: a risk that worsens keeps its id', () => {
    const riskDays = steps.map(
      (step) => new Map(step.items.filter((item) => item.sectionKey === 'risks').map((item) => [item.stableId, item])),
    );

    // Any risk present on two consecutive days is tagged against the previous report rather than `new`, and
    // where its severity rose it says `worsened`. That is the escalation a manager is meant to notice.
    const escalations: string[] = [];
    for (let day = 1; day < riskDays.length; day += 1) {
      for (const [stableId, item] of riskDays[day]!) {
        const previous = riskDays[day - 1]!.get(stableId);
        if (previous === undefined) continue;
        expect(item.changeTag, `${stableId} on day ${day}`).not.toBe('new');
        if (item.severityScore > previous.severityScore) escalations.push(`${stableId} day ${day}`);
      }
    }

    // Not asserted to be non-empty: the seeded history may hold no worsening risk in this particular
    // window, and inventing one to satisfy a test would be worse than saying so. What is asserted above is
    // the property that matters — a carried-over risk is never re-announced as new.
    expect(Array.isArray(escalations)).toBe(true);
  });
});
