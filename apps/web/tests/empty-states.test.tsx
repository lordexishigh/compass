import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOKEN_TTL_LABEL } from '@compass/auth';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ArchiveIndex } from '../components/archive-index';
import { EmptyState } from '../components/empty-state';
import { GoalEditor } from '../components/goal-editor';
import { RosterScreen } from '../components/roster-screen';
import { SeatManager } from '../components/seat-manager';
import { EMPTY_STATES, EMPTY_STATE_LIST, type EmptyStateCopy } from '../lib/empty-states';

/**
 * Every list screen shows a designed empty state, asserted by rendering it empty.
 *
 * ## Why a source scan would not do
 *
 * The failure this file exists to catch is invisible in review: `{rows.map(...)}` over an
 * empty array renders *nothing at all*. There is no element to inspect, no "0 results" to
 * read, no error — the section header is followed by whitespace. A source scan for the word
 * "empty" would pass on that, and so would a screenshot nobody took of the empty case.
 *
 * So the components are rendered with genuinely empty data and the markup is searched for the
 * copy the registry says belongs to that list. That also catches the subtler version, which is
 * a screen wired to the *wrong* registry entry: it looks entirely reasonable in review and
 * tells the reader about a different list.
 *
 * ## The coverage claim
 *
 * `LIST_SCREENS` enumerates the lists Compass renders and which registry entries each screen
 * owns. Two diffs hold it honest in both directions: no entry may go unused, and no screen may
 * name an entry that does not exist. Adding a list means adding a row here, which is the point
 * — the enumeration is the checklist, and a new list with no empty state fails the build rather
 * than shipping blank.
 */

/**
 * The router these screens hold, stubbed.
 *
 * `useRouter` throws outside an app-router context, and two of the three list screens call it
 * because every write they make ends in `router.refresh()`. Stubbing it is the whole of the
 * concession this file makes to rendering client components outside Next: nothing under test
 * here navigates, and the markup a reader sees when the list is empty does not depend on the
 * router existing.
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {}, back: () => {} }),
}));

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readWebFile = (...parts: string[]): string => readFileSync(join(WEB_ROOT, ...parts), 'utf8');

/**
 * Every list or table surface, the file that renders it, and the entries it is responsible for.
 *
 * `rendered` is the markup of that screen with no rows in it. Where the screen is a client
 * component it is rendered here directly; where the list lives inside an async Server
 * Component that reaches the database, the component under test is the same `EmptyState` the
 * page hands the entry to, and the page's own wiring is asserted by the source check below.
 */
const LIST_SCREENS: readonly {
  readonly route: string;
  readonly file: readonly string[];
  readonly entries: readonly EmptyStateCopy[];
  /** Rendered markup of the real screen with nothing in it, when that is possible here. */
  readonly rendered?: string;
}[] = [
  {
    route: '/archive',
    // The index moved out of the page into a component so `accessibility.test.tsx` could render and
    // audit it — the archive was the one surface the axe criterion names that had nothing a test
    // could reach. The empty branch moved with it, so this now points at the component *and* can
    // supply `rendered`, which the page-level entry could never do: the page is a Server Component
    // that reaches the database.
    file: ['components', 'archive-index.tsx'],
    entries: [EMPTY_STATES.archive],
    rendered: renderToStaticMarkup(<ArchiveIndex days={[]} />),
  },
  {
    route: '/corrections',
    file: ['app', 'corrections', 'page.tsx'],
    entries: [EMPTY_STATES.correctedFlags, EMPTY_STATES.suppressions, EMPTY_STATES.snoozes],
  },
  {
    route: '/settings/members',
    file: ['components', 'seat-manager.tsx'],
    entries: [EMPTY_STATES.seats],
    rendered: renderToStaticMarkup(
      <SeatManager
        seats={[]}
        canManage
        knownTeamKeys={[]}
        roleCapabilities={{ owner: 'everything', manager: 'reads', member: 'reads', viewer: 'reads' }}
        inviteLifetimeLabel={TOKEN_TTL_LABEL.invite}
      />,
    ),
  },
  {
    route: '/roster',
    file: ['components', 'roster-screen.tsx'],
    entries: [
      EMPTY_STATES.rosterTeams,
      EMPTY_STATES.rosterPeople,
      EMPTY_STATES.rosterUnmatched,
      EMPTY_STATES.rosterAbsences,
    ],
    rendered: renderToStaticMarkup(
      <RosterScreen
        roster={{
          instant: 0,
          teams: [],
          repositories: [],
          projects: [],
          developers: [],
          unmatched: [],
          absences: [],
        }}
        // The editable render, because the empty states carry the calls to action.
        canEdit
      />,
    ),
  },
  {
    route: '/goals',
    file: ['components', 'goal-editor.tsx'],
    entries: [EMPTY_STATES.goals],
    rendered: renderToStaticMarkup(<GoalEditor nodes={[]} resolvedAt={new Date(0).toISOString()} />),
  },
];

// ---------------------------------------------------------------------------
// 1. Coverage, in both directions
// ---------------------------------------------------------------------------

describe('every list Compass renders has an empty state', () => {
  it('names every registry entry exactly once across the screens', () => {
    const claimed = LIST_SCREENS.flatMap((screen) => screen.entries.map((entry) => entry.id)).sort();
    const registered = EMPTY_STATE_LIST.map((entry) => entry.id).sort();

    // An entry with no screen is copy nobody reads; a screen claiming an entry twice is a
    // paragraph rendered in two places, which is how two lists end up saying the same thing.
    expect(claimed, 'an empty-state entry is unused, or claimed by more than one screen').toEqual(registered);
  });

  it('agrees with the registry about which route each list is on', () => {
    for (const screen of LIST_SCREENS) {
      for (const entry of screen.entries) {
        expect(entry.route, `${entry.id} is declared on ${entry.route} but rendered by ${screen.route}`).toBe(
          screen.route,
        );
      }
    }
  });

  it('wires each screen to its own entries by name', () => {
    // The source check. It catches the case rendering cannot: a Server Component that reaches
    // the database, whose empty branch this file cannot execute.
    for (const screen of LIST_SCREENS) {
      const source = readWebFile(...screen.file);
      expect(source, `${screen.route} does not import the shared empty state`).toContain('EmptyState');

      for (const entry of screen.entries) {
        const name = Object.entries(EMPTY_STATES).find(([, value]) => value.id === entry.id)?.[0];
        expect(
          source.includes(`EMPTY_STATES.${name}`),
          `${screen.route} never renders EMPTY_STATES.${name}, so that list is blank when it holds nothing`,
        ).toBe(true);
      }
    }
  });

  /**
   * The one copy string in this table that restates a number the code enforces.
   *
   * `EMPTY_STATES.seats` promises how long an invitation lasts. It cannot interpolate
   * `TOKEN_TTL_LABEL` — this module is imported by the client component `seat-manager.tsx`,
   * and `@compass/auth` reaches `node:crypto` — so the tie is asserted here instead, where
   * importing it costs nothing. The screen's *other* statement of the window is a prop
   * (`inviteLifetimeLabel`) and needs no test.
   *
   * This drifted once, in exactly this direction: the token expired after seven days while
   * the copy promised what the blueprint committed to. A sentence that overstates how long
   * somebody has to accept an invitation is a support ticket, not a typo.
   */
  it('states the real invitation lifetime, not a number that has drifted from the token', () => {
    expect(EMPTY_STATES.seats.explanation).toContain(`expires in ${TOKEN_TTL_LABEL.invite}`);
  });
});

// ---------------------------------------------------------------------------
// 2. Each entry is a designed state, not a shrug
// ---------------------------------------------------------------------------

describe.each(EMPTY_STATE_LIST.map((entry) => [entry.id, entry] as const))('the %s empty state', (_id, entry) => {
  const markup = renderToStaticMarkup(<EmptyState copy={entry} />);

  it('states what would be here, in the product’s own voice', () => {
    expect(markup).toContain('stated-absence');
    // A sentence rather than a label. "Nothing is snoozed." is a short one and is right to be;
    // the explanation beneath it is where the length has to be, because that is the half that
    // says what the list is for and what would fill it.
    expect(entry.statement.length).toBeGreaterThan(15);
    expect(entry.statement.endsWith('.')).toBe(true);
    expect(entry.explanation.length).toBeGreaterThan(60);
  });

  it('renders both the statement and the explanation, not just one', () => {
    // Rendered, not merely present in the object: a component that dropped `explanation`
    // would still pass a check on the registry alone.
    for (const sentence of [entry.statement, entry.explanation]) {
      const [head] = sentence.split('.');
      expect(markup).toContain(escapeForHtml(head ?? sentence));
    }
  });

  it('offers a primary action that goes somewhere', () => {
    expect(entry.action.label.length).toBeGreaterThan(3);
    expect(entry.action.href.length).toBeGreaterThan(0);
    expect(markup).toContain(`href="${entry.action.href}"`);
    expect(markup).toContain('primary-action');
  });

  it('says nothing that reads as an error or a placeholder', () => {
    // The empty case is not a failure and is never dressed as one — nor as a spinner, nor as
    // a skeleton, nor as the two words that mean nobody wrote this screen.
    const forbidden = ['No results', 'no results', 'Nothing to show', 'N/A', 'TODO', 'Loading', 'skeleton', 'animate-pulse'];
    for (const phrase of forbidden) {
      expect(markup, `the ${entry.id} empty state contains \`${phrase}\``).not.toContain(phrase);
    }
  });

  it('carries no red, amber or danger colour, because an empty list is not bad news', () => {
    for (const forbidden of ['text-red', 'bg-red', 'border-red', 'text-amber', 'bg-amber', 'rule-severe']) {
      expect(markup, `the ${entry.id} empty state uses ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The real screens, rendered with nothing in them
// ---------------------------------------------------------------------------

describe('the screens that can be rendered here show their copy when empty', () => {
  const renderable = LIST_SCREENS.filter(
    (screen): screen is (typeof LIST_SCREENS)[number] & { readonly rendered: string } =>
      screen.rendered !== undefined,
  );

  it('covers every list screen that can be rendered here, so this suite is not vacuous', () => {
    // `/archive` joined the moment its index became a component rather than inline JSX in a Server
    // Component. Enumerated rather than counted, so a screen that stops being renderable is a
    // visible edit here instead of a silently smaller suite.
    expect(renderable.map((screen) => screen.route).sort()).toEqual(['/archive', '/goals', '/roster', '/settings/members']);
  });

  it.each(renderable.map((screen) => [screen.route, screen] as const))(
    '%s renders every one of its empty states',
    (route, screen) => {
      for (const entry of screen.entries) {
        expect(
          screen.rendered.includes(`data-empty-state="${entry.id}"`),
          `${route} rendered no empty state for ${entry.id} — an empty list here is blank markup`,
        ).toBe(true);

        const [head] = entry.statement.split('.');
        expect(screen.rendered).toContain(escapeForHtml(head ?? entry.statement));
      }
    },
  );

  it.each(renderable.map((screen) => [screen.route, screen] as const))(
    '%s renders a reachable action rather than a dead end',
    (_route, screen) => {
      for (const entry of screen.entries) {
        expect(screen.rendered).toContain(`href="${entry.action.href}"`);
      }
    },
  );

  it('renders no bare list markup with nothing inside it', () => {
    // The specific shape of the failure: a `<ul>` that closes immediately.
    for (const screen of renderable) {
      expect(screen.rendered, `${screen.route} renders an empty list element`).not.toMatch(/<ul[^>]*>\s*<\/ul>/);
      expect(screen.rendered, `${screen.route} renders an empty table body`).not.toMatch(/<tbody[^>]*>\s*<\/tbody>/);
    }
  });
});

/**
 * React escapes text into HTML entities, so the assertions compare against the escaped form.
 *
 * The curly apostrophe and the em dash survive unescaped — they are ordinary characters, not
 * markup — but the straight double quote does not, and one entry quotes the product's own
 * phrase, which is what made this necessary.
 */
function escapeForHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}
