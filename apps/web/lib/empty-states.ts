/**
 * The copy every empty list shows, in one place.
 *
 * ## Why a registry rather than the words where they are used
 *
 * Three reasons, and the third is the one that made this a module.
 *
 *  1. **An empty list is a screen, and it needs writing.** "No results" is not a design.
 *     Every entry below names what *would* be here, says why it is not, and offers the one
 *     action that would change it — which is a paragraph of product voice per list, not a
 *     string, and paragraphs buried in JSX do not get read or revised.
 *  2. **The tone has to be consistent across screens.** Compass states absences in its own
 *     voice and never colour-codes them; holding the sentences side by side is the only way
 *     that survives more than three authors.
 *  3. **It makes the claim testable.** `tests/empty-states.test.tsx` enumerates this
 *     registry, renders each one, and fails if a list screen has no entry or an entry has no
 *     screen. A bare `<ul>` over an empty array renders nothing at all and looks fine in
 *     review — the only thing that catches it is an enumeration that knows the list exists.
 *
 * ## The two kinds of empty, which are not the same screen
 *
 * A list can be empty because the org is new, or empty because there is genuinely nothing
 * to report — and telling a manager "nothing is held back" is *good news*, not a gap to be
 * filled. So `disposition` distinguishes them. Both still carry an action, because a reader
 * who has arrived at a screen with nothing on it still needs somewhere to go; for a settled
 * list that action is where the entries would come from, not an instruction to make some.
 */

export type EmptyDisposition =
  /** Nothing is configured yet, and the reader is the person who would configure it. */
  | 'unconfigured'
  /** The list is empty because there is nothing to say, which is the good outcome. */
  | 'settled';

export interface EmptyStateAction {
  readonly label: string;
  readonly href: string;
}

export interface EmptyStateCopy {
  /** Stable id. Rendered as `data-empty-state`, which is what the test looks for. */
  readonly id: string;
  /** The route this list lives on, so the enumeration can check coverage per screen. */
  readonly route: string;
  readonly disposition: EmptyDisposition;
  /**
   * What would be here, stated as a fact in the product's voice.
   *
   * Set in serif italic zinc — the same `stated-absence` treatment as a missing deploy
   * signal in a report — because it is the same kind of sentence.
   */
  readonly statement: string;
  /** Why it is empty and what filling it would mean. One or two sentences. */
  readonly explanation: string;
  /** The one action worth offering. Never absent: a dead end is not a designed state. */
  readonly action: EmptyStateAction;
  readonly secondary?: readonly EmptyStateAction[];
}

/**
 * Every list Compass renders, and what it says when it holds nothing.
 *
 * Keyed by a short name the screens import, so a typo is a type error rather than a list
 * that silently shows the wrong paragraph.
 */
export const EMPTY_STATES = {
  // -------------------------------------------------------------------------
  // /archive
  // -------------------------------------------------------------------------
  archive: {
    id: 'archive',
    route: '/archive',
    disposition: 'unconfigured',
    statement: 'Compass has not written a report yet, so there is nothing to permalink.',
    explanation:
      'Every report Compass generates is kept exactly as it was sent, and listed here by date and team. The first one ' +
      'appears the moment the scheduler runs — or as soon as somebody opens today’s report, which generates it.',
    action: { label: 'Open today’s report', href: '/' },
    secondary: [{ label: 'system readiness', href: '/api/health' }],
  },

  // -------------------------------------------------------------------------
  // /settings/members
  // -------------------------------------------------------------------------
  seats: {
    id: 'seats',
    route: '/settings/members',
    disposition: 'unconfigured',
    statement: 'This organization has no seats to list.',
    // The "14 days" here cannot interpolate `TOKEN_TTL_LABEL`: this table is imported by
    // `seat-manager.tsx`, which is a client component, and `@compass/auth` reaches
    // `node:crypto`. `tests/empty-states.test.tsx` asserts this sentence against the
    // constant instead, so the number is checked at build time rather than by eye.
    explanation:
      'Seats are how colleagues read the report: each one carries a role and the teams it may read. Inviting somebody ' +
      'sends a single-use link that expires in 14 days.',
    action: { label: 'Invite the first seat', href: '#invite-seat' },
    secondary: [{ label: '← today’s report', href: '/' }],
  },

  // -------------------------------------------------------------------------
  // /roster — four lists, four different absences
  // -------------------------------------------------------------------------
  rosterTeams: {
    id: 'roster-teams',
    route: '/roster',
    disposition: 'unconfigured',
    statement: 'No team is configured, so there is no report to generate.',
    explanation:
      'A team is what a daily report is *about*: it names the board, the repositories and the people whose work the ' +
      'report covers. Compass will not infer one from who commits together — that would put somebody else’s merge in ' +
      'this team’s Yesterday.',
    /**
     * The action is `/start`, not a form on this screen, and that is deliberate rather than a
     * shortcut. Creating a team is not one field: it needs a key, a project, a board and the
     * people on it, which is step two of the guided path. Offering a lone "add team" input here
     * would produce a team with no scope, which is a team no report can be about.
     */
    action: { label: 'Set up the first team', href: '/start#team' },
    secondary: [{ label: '← today’s report', href: '/' }],
  },
  rosterPeople: {
    id: 'roster-people',
    route: '/roster',
    disposition: 'unconfigured',
    statement: 'Nobody is configured, so every commit and ticket will read as unattributed.',
    explanation:
      'A person here is one human with all their identifiers behind them — several git addresses, a tracker account, a ' +
      'chat handle. Until they exist, Compass can see the work and cannot say whose it is, and it says so rather than ' +
      'guessing.',
    action: { label: 'Import the roster', href: '/start#roster' },
    secondary: [{ label: '← today’s report', href: '/' }],
  },
  rosterUnmatched: {
    id: 'roster-unmatched',
    route: '/roster',
    disposition: 'settled',
    statement: 'Every identifier Compass has seen belongs to somebody.',
    explanation:
      'This queue fills when an address or account appears in the data that no configured person claims. An empty ' +
      'queue means attribution is complete — nothing is being quietly dropped into an unattributed bucket.',
    action: { label: 'Review the identity roster', href: '#roster-identities' },
  },
  rosterAbsences: {
    id: 'roster-absences',
    route: '/roster',
    disposition: 'settled',
    statement: 'Nobody is marked out.',
    explanation:
      'Marking somebody out is what stops them reading as stalled: their open ticket does not become a blocker while ' +
      'they are on leave, and the report says they are away rather than silent.',
    // The absence form lives against a person, up in section 04 — so that is where this points.
    action: { label: 'Mark somebody out', href: '#roster-identities' },
  },

  // -------------------------------------------------------------------------
  // /corrections — three lists, all of them good news when empty
  // -------------------------------------------------------------------------
  correctedFlags: {
    id: 'corrections-flags',
    route: '/corrections',
    disposition: 'settled',
    statement: 'You have not marked an off-goal flag wrong.',
    explanation:
      'When you do, Compass records what it claimed beside what you said, stops making that claim, and counts the ' +
      'correction against its own objective matching. Nothing here means you have not had to argue with it yet.',
    action: { label: 'Read today’s report', href: '/' },
  },
  suppressions: {
    id: 'corrections-suppressions',
    route: '/corrections',
    disposition: 'settled',
    statement: 'Nothing is being held back. Every finding Compass has is in your report.',
    explanation:
      'Dismissing a risk or rejecting a recommendation from the report lists it here with the reason and the date — so ' +
      'a finding that has stopped appearing is never indistinguishable from a detector that broke.',
    action: { label: 'Read today’s report', href: '/' },
  },
  snoozes: {
    id: 'corrections-snoozes',
    route: '/corrections',
    disposition: 'settled',
    statement: 'Nothing is snoozed.',
    explanation:
      'A snooze is the one verdict that expires on its own: the finding returns on the day you chose, and the report ' +
      'says that it is back rather than presenting it as new.',
    action: { label: 'Read today’s report', href: '/' },
  },

  // -------------------------------------------------------------------------
  // /goals
  // -------------------------------------------------------------------------
  goals: {
    id: 'goals',
    route: '/goals',
    disposition: 'unconfigured',
    statement: 'No objective is recorded, so every alignment verdict is unattributed.',
    explanation:
      'The chain runs company objective → quarter → sprint goal → epic → ticket, and it is what "this work does not ' +
      'serve the current objective" is measured against. With none of it, Compass reports the work and declines to ' +
      'judge it — which is the honest answer, and a quiet one.',
    /**
     * Two actions, because there are genuinely two ways in and they suit different people. The
     * quick entry on the guided path takes a company objective and a sprint goal together with
     * defaults filled in — which is the shape a new org needs, since one objective on its own
     * is not a chain. The form below this list is the full one, for anybody adding a fifth
     * level to a hierarchy that already exists.
     */
    action: { label: 'Enter the first two objectives', href: '/start#goals' },
    secondary: [{ label: 'or use the full form', href: '#add-a-goal' }],
  },
} as const satisfies Readonly<Record<string, EmptyStateCopy>>;

export type EmptyStateName = keyof typeof EMPTY_STATES;

/** Every entry, for the enumeration that holds the screens to this registry. */
export const EMPTY_STATE_LIST: readonly EmptyStateCopy[] = Object.values(EMPTY_STATES);
