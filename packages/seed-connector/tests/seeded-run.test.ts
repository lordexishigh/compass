import { formatCivilDate, instantFromIso, toIso } from '@compass/clock';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TEAM_KEY,
  DEFAULT_TIMEZONE,
  SEEDED_ORGANIZATION_ID,
  TEAM_KEY_ENV_VAR,
  TIMEZONE_ENV_VAR,
  resolveSeededRun,
  resolveSubstrate,
  resolveTeamKey,
  resolveTimezone,
  seedBundle,
} from '@compass/seed-connector';

/**
 * The one authority both process edges consult.
 *
 * The web request path and the boot script each generate reports for the seeded
 * organization. If they disagreed about the organization, the team, the zone or the
 * day, they would write two reports for what a manager thinks is one day and race
 * to overwrite each other. Neither is allowed to decide any of it — both call
 * `resolveSeededRun` — so what has to be tested is that this function gives the
 * same answer to both, and that the answer depends on nothing but its argument and
 * the environment.
 */

/** Inside the dataset's span, so the host's own day is reported on. */
const INSIDE = instantFromIso('2026-07-30T09:00:00Z');
/** Long past the dataset's end, so the day-shift rule engages. */
const AFTER = instantFromIso('2027-03-04T09:00:00Z');

describe('the substrate', () => {
  it('resolves the generated seed, with no degradation to state', () => {
    const substrate = resolveSubstrate();

    expect(substrate.degradation).toBeNull();
    expect(substrate.organizationId).toBe(seedBundle().organizationId);
    expect(substrate.organizationId).toBe(SEEDED_ORGANIZATION_ID);
    expect(substrate.datasetWindow).not.toBeNull();
    expect(substrate.datasetNow).not.toBeNull();
  });
});

describe('the team and the zone', () => {
  it('falls back to documented defaults rather than to the host', () => {
    expect(resolveTeamKey({})).toBe(DEFAULT_TEAM_KEY);
    expect(resolveTimezone({})).toBe(DEFAULT_TIMEZONE);
    expect(DEFAULT_TIMEZONE).toBe('Europe/London');
  });

  it('reads a configured team and zone', () => {
    const env = { [TEAM_KEY_ENV_VAR]: 'payments', [TIMEZONE_ENV_VAR]: 'America/New_York' };

    expect(resolveTeamKey(env)).toBe('payments');
    expect(resolveTimezone(env)).toBe('America/New_York');
  });

  it('treats an empty variable as unset, not as an empty team key', () => {
    // A compose file that passes `COMPASS_DEFAULT_TEAM=` must not scope the report
    // to a team named '' and then report an honestly empty day.
    expect(resolveTeamKey({ [TEAM_KEY_ENV_VAR]: '' })).toBe(DEFAULT_TEAM_KEY);
    expect(resolveTimezone({ [TIMEZONE_ENV_VAR]: '' })).toBe(DEFAULT_TIMEZONE);
  });
});

describe('two edges asking the same question get the same answer', () => {
  it('is a pure function of the host instant and the environment', () => {
    const first = resolveSeededRun({ hostNow: INSIDE, env: {} });
    const second = resolveSeededRun({ hostNow: INSIDE, env: {} });

    expect(first.now).toBe(second.now);
    expect(first.window).toEqual(second.window);
    expect(first.ingestWindow).toEqual(second.ingestWindow);
    expect(first.organizationId).toBe(second.organizationId);
    expect(first.teamKey).toBe(second.teamKey);
  });

  it('agrees on the report date across a whole civil day, so a warm start is a read', () => {
    // The boot script and the first request run minutes or hours apart. They must
    // land on the same `reportDate`, which is the key `ensureDailyReport` looks up.
    const zone = 'Europe/London';
    const morning = resolveSeededRun({ hostNow: instantFromIso('2026-07-30T06:05:00Z'), env: {} });
    const evening = resolveSeededRun({ hostNow: instantFromIso('2026-07-30T21:55:00Z'), env: {} });

    expect(formatCivilDate(morning.now, zone)).toBe(formatCivilDate(evening.now, zone));
    expect(morning.window).toEqual(evening.window);
  });

  it('reports on the previous civil day in the team zone', () => {
    const run = resolveSeededRun({ hostNow: INSIDE, env: {} });

    expect(toIso(run.window.start)).toBe('2026-07-28T23:00:00.000Z');
    expect(toIso(run.window.end)).toBe('2026-07-29T23:00:00.000Z');
    expect(formatCivilDate(run.window.start, DEFAULT_TIMEZONE)).toBe('2026-07-29');
  });

  it('shifts the zone with the configured timezone rather than the host one', () => {
    const london = resolveSeededRun({ hostNow: INSIDE, env: {} });
    const newYork = resolveSeededRun({ hostNow: INSIDE, env: { [TIMEZONE_ENV_VAR]: 'America/New_York' } });

    expect(newYork.timezone).toBe('America/New_York');
    expect(newYork.window).not.toEqual(london.window);
  });
});

describe('the ingest window is the whole substrate, not the report window', () => {
  it('pulls the dataset span so a three-week-old sprint can be reported on', () => {
    const run = resolveSeededRun({ hostNow: INSIDE, env: {} });
    const substrate = resolveSubstrate();

    expect(run.ingestWindow).toEqual(substrate.datasetWindow);
    expect(run.ingestWindow.start).toBeLessThan(run.window.start);
    expect(toIso(run.ingestWindow.start)).toBe('2026-05-18T00:00:00.000Z');
  });
});

describe('a host clock past the end of the seeded history', () => {
  it('reports the last full day it has data for, and says which day it is not', () => {
    const run = resolveSeededRun({ hostNow: AFTER, env: {} });

    expect(run.timeShiftNote).not.toBeNull();
    expect(run.timeShiftNote).toContain('2026-07-31');
    expect(run.timeShiftNote).toContain('2027-03-04');
    // The instant is the dataset's own, so the report is about real records.
    expect(run.now).toBe(resolveSubstrate().datasetNow);
  });

  it('says nothing about a shift when the host day is inside the span', () => {
    expect(resolveSeededRun({ hostNow: INSIDE, env: {} }).timeShiftNote).toBeNull();
  });

  it('still resolves a window rather than refusing to report', () => {
    const run = resolveSeededRun({ hostNow: AFTER, env: {} });

    expect(run.window.end).toBeGreaterThan(run.window.start);
    expect(run.degradation).toBeNull();
  });
});
