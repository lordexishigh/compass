import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { RosterScreen } from '../components/roster-screen';
import type { RosterScreenView } from '../lib/roster-source';

/**
 * The router the screen holds, stubbed — the same concession `empty-states.test.tsx` makes.
 *
 * `useRouter` throws outside an app-router context, and this screen calls it because every write
 * ends in `router.refresh()`. Nothing under test here navigates: the markup a reader sees does not
 * depend on the router existing.
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {}, back: () => {} }),
}));

/**
 * The roster screen, rendered for the two readers the matrix now admits.
 *
 * `/roster` and `GET /api/roster` name `public` under `demoOnlyPublic`, so on the seeded
 * demonstration tenant the configuration behind every report claim is readable without a seat —
 * the same posture `/`, `/goals` and the archive have. The five `/api/roster/*` write rows did
 * **not** change, which is the whole reason this file exists: a screen that offered a control its
 * own endpoint answers 403 to would be the leak the matrix is supposed to prevent, and the
 * blueprint's own words for `/start` are that "a screen anyone could read while every button on it
 * answered 403 would be worse than being told to sign in".
 *
 * So the assertion is not about wording. It is that the read-only render contains **no control at
 * all** — no `<button>`, no `<form>` — while still stating every fact a reader needs to check why
 * the report said what it said.
 */

/** 2026-08-03T00:00:00Z. A literal, so the fixture cannot drift with the machine clock. */
const ABSENCE_START = 1_785_715_200_000;
/** 2026-08-08T00:00:00Z — exclusive, so the last day the absence covers is the 7th. */
const ABSENCE_END = 1_786_147_200_000;

const impact = (identityKey: string, commits: number, pullRequests: number) => ({
  identityKey,
  commitCount: commits,
  pullRequestCount: pullRequests,
  totalCount: commits + pullRequests,
  sampleArtifacts: [],
});

const ROSTER: RosterScreenView = {
  instant: ABSENCE_START,
  teams: [
    {
      key: 'platform',
      name: 'Platform',
      methodology: 'scrum',
      projectKey: 'PLAT',
      objectiveKey: 'obj-1',
      timezone: 'Europe/London',
      members: [
        {
          developerKey: 'priya-raman',
          displayName: 'Priya Raman',
          membershipRole: 'lead',
          active: true,
          impliedByDeveloperRow: false,
        },
      ],
      calendar: {
        teamKey: 'platform',
        workingWeekdays: [1, 2, 3, 4, 5],
        holidays: ['2026-08-31'],
        timezone: 'Europe/London',
      },
    },
  ],
  repositories: [
    { key: 'acme/api', name: 'api', tracked: true, archivedAt: null, note: null, parentKey: 'PLAT' },
  ],
  projects: [{ key: 'PLAT', name: 'Platform', tracked: true, archivedAt: null, note: null, parentKey: 'platform' }],
  developers: [
    {
      key: 'priya-raman',
      displayName: 'Priya Raman',
      teamKey: 'platform',
      active: true,
      identities: [
        {
          identityKey: 'email:priya@acme.example',
          kind: 'email',
          value: 'priya@acme.example',
          origin: 'declared',
          attributes: impact('email:priya@acme.example', 6, 2),
        },
      ],
      absences: [
        {
          naturalKey: 'absence-1',
          developerKey: 'priya-raman',
          kind: 'leave',
          startAt: ABSENCE_START,
          endAt: ABSENCE_END,
          note: 'annual leave',
          source: 'manual',
          sourceRef: null,
          activeNow: true,
        },
      ],
    },
  ],
  unmatched: [
    {
      identityKey: 'email:m.chen@contractor.example',
      kind: 'email',
      value: 'm.chen@contractor.example',
      displayName: 'M Chen',
      occurrenceCount: 4,
      artifactKinds: ['commit'],
      sourceKeys: ['primary-code'],
      sampleWitnessRefs: [],
      attributes: impact('email:m.chen@contractor.example', 4, 0),
      resolved: false,
      resolvedDeveloperKey: null,
      sampleLinks: [],
    },
  ],
  absences: [
    {
      naturalKey: 'absence-1',
      developerKey: 'priya-raman',
      kind: 'leave',
      startAt: ABSENCE_START,
      endAt: ABSENCE_END,
      note: 'annual leave',
      source: 'manual',
      sourceRef: null,
      activeNow: true,
    },
  ],
};

const editable = renderToStaticMarkup(<RosterScreen roster={ROSTER} canEdit />);
const readOnly = renderToStaticMarkup(<RosterScreen roster={ROSTER} canEdit={false} />);

describe('the roster screen offers every write the roster service supports', () => {
  it('offers the controls behind each of the five write routes', () => {
    for (const control of [
      'remove', // team membership — PATCH /api/roster/teams
      'Save calendar', // PUT /api/roster/teams
      'archive this repository', // PATCH /api/roster/sources
      'unlink', // DELETE /api/roster/identities
      'Link', // POST /api/roster/identities
      'Merge', // POST /api/roster/merges
      'Record', // POST /api/roster/absences
      'end it now', // PATCH /api/roster/absences
    ]) {
      expect(editable, `no control for "${control}"`).toContain(control);
    }
  });
});

describe('a reader without a seat gets the document and none of the controls', () => {
  /**
   * The invariant, stated structurally rather than by wording.
   *
   * Every control on this screen calls `fetch` against a route that admits only owner and
   * manager, so for anybody else the honest surface is the prose without the buttons. Counting
   * elements rather than matching copy means a control added later cannot slip through by being
   * labelled something this test does not happen to look for.
   */
  it('renders no button and no form', () => {
    expect(readOnly).not.toContain('<button');
    expect(readOnly).not.toContain('<form');
    expect(readOnly).not.toContain('<select');
    expect(readOnly).not.toContain('<input');
  });

  it('still names the people, their identifiers and what those identifiers attribute', () => {
    expect(readOnly).toContain('Priya Raman');
    expect(readOnly).toContain('priya@acme.example');
    // The count is the point: it is how a reader checks an attribution they think is wrong.
    expect(readOnly).toContain('8');
  });

  it('still states the absence, and that it is in force', () => {
    // The last day covered, not the exclusive bound — the same reading the editable render gives.
    expect(readOnly).toContain('2026-08-03');
    expect(readOnly).toContain('2026-08-07');
    expect(readOnly).toContain('in force');
  });

  /**
   * The working calendar survives losing its fieldset.
   *
   * `CalendarForm` was the only place these three facts appeared, so hiding the form from a
   * seatless reader would have hidden what "three working days" means — and that phrase is load
   * bearing in every stalled-work finding the report makes.
   */
  it('states the working calendar as prose instead of a fieldset', () => {
    expect(readOnly).toContain('working calendar');
    expect(readOnly).toContain('Mon');
    expect(readOnly).toContain('Fri');
    expect(readOnly).toContain('Europe/London');
    expect(readOnly).toContain('2026-08-31');
  });

  it('still lists the unmatched identity, and says why the report asks rather than attributes', () => {
    expect(readOnly).toContain('m.chen@contractor.example');
    expect(readOnly).toContain('Not merged, so the report asks about this work rather than attributing it.');
  });

  it('still lists the tracked repository and project', () => {
    expect(readOnly).toContain('acme/api');
    expect(readOnly).toContain('PLAT');
  });
});

/**
 * The store-read failure says Compass's sentence, not the driver's.
 *
 * A source check rather than a render, for the reason `empty-states.test.tsx` states about the
 * archive: `/roster` is an async Server Component that reaches the database, and this suite
 * cannot execute the branch where that read throws.
 *
 * The rule is `lib/auth/http.ts`'s own — a driver or connection error's `message` carries host,
 * port, user and sometimes the database name, so it is logged and never returned. This page
 * rendered `error.message` until the matrix widening above, and that was survivable only while
 * the route was gated to owner and manager. Opening the read to `public` on the demonstration
 * tenant is exactly what turned it into a leak to a stranger, which is why the assertion lives
 * in this file next to the widening that caused it.
 */
describe('the /roster store-read failure is sanitised and logged', () => {
  const page = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'roster', 'page.tsx'),
    'utf8',
  );

  it('renders the shared unavailable sentence rather than the thrown message', () => {
    expect(page).toContain("import { UNAVAILABLE_SENTENCE } from '../../lib/auth/http'");
    // The exact rendered string, so a future edit cannot quietly put the driver's words back.
    expect(page).toContain('${UNAVAILABLE_SENTENCE} Nothing has been changed.');
  });

  it('logs the stack for the operator, so the failure is not silent', () => {
    expect(page).toContain('console.error');
    expect(page).toContain('/roster could not read the configuration');
  });

  it('keeps no variable carrying the thrown text into the render', () => {
    // `unreadable` was that variable. Its absence is the shape of the fix, not a rename.
    expect(page).not.toContain('unreadable');
  });
});
