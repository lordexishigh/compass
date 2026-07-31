import type { Instant } from '@compass/clock';

import { identityNaturalKey, type IdentityKind } from './identity.js';
import { attributionImpact, teamMembershipKey, type AttributionImpact } from './roster-service.js';
import type { KnowledgeStore, StoredEntity } from './store.js';

/**
 * Everything the roster screen shows, assembled in one read.
 *
 * A read model rather than a set of endpoints-per-table, for a reason that is visible on
 * the screen: the questions a manager actually asks span the tables. "What does this
 * identity currently attribute" needs identity links *and* commits *and* pull requests.
 * "Who is on this team" needs memberships *and* developers. Four endpoints would mean the
 * page assembled the joins in the browser and every one of them would be a chance to
 * disagree with what the report does.
 *
 * The counterpart is `roster-service.ts`, which is the only writer. Reads here, writes
 * there, and nothing in this file calls `observe`.
 */

const text = (entity: StoredEntity, field: string): string | null => {
  const value = entity.fields[field];
  return typeof value === 'string' ? value : null;
};

const bool = (entity: StoredEntity, field: string): boolean => entity.fields[field] === true;

const num = (entity: StoredEntity, field: string): number | null => {
  const value = entity.fields[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

const numbers = (entity: StoredEntity, field: string): readonly number[] => {
  const value = entity.fields[field];
  return Array.isArray(value)
    ? value.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry))
    : [];
};

const strings = (entity: StoredEntity, field: string): readonly string[] => {
  const value = entity.fields[field];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
};

const byKey = (left: { readonly key: string }, right: { readonly key: string }): number =>
  left.key < right.key ? -1 : left.key > right.key ? 1 : 0;

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export interface RosterTeamView {
  readonly key: string;
  readonly name: string;
  readonly methodology: string;
  readonly projectKey: string | null;
  readonly objectiveKey: string | null;
  readonly timezone: string;
  readonly members: readonly RosterMemberView[];
  readonly calendar: RosterCalendarView | null;
}

export interface RosterMemberView {
  readonly developerKey: string;
  readonly displayName: string;
  readonly membershipRole: string;
  /** False for somebody who was removed. The row stays; it is the evidence. */
  readonly active: boolean;
  /** True when the only thing placing them on the team is `developers.teamKey`. */
  readonly impliedByDeveloperRow: boolean;
}

export interface RosterCalendarView {
  readonly teamKey: string;
  readonly workingWeekdays: readonly number[];
  readonly holidays: readonly string[];
  readonly timezone: string;
}

// ---------------------------------------------------------------------------
// Repositories, projects and people
// ---------------------------------------------------------------------------

export interface RosterTrackedView {
  readonly key: string;
  readonly name: string;
  /** True unless a `tracked_*` row says otherwise. An unconfigured source is tracked. */
  readonly tracked: boolean;
  readonly archivedAt: number | null;
  readonly note: string | null;
  /** The project a repository belongs to, or the team a project belongs to. */
  readonly parentKey: string | null;
}

export interface RosterIdentityView {
  readonly identityKey: string;
  readonly kind: IdentityKind;
  readonly value: string;
  /** `declared` on the roster screen, `merged` from the unmatched queue. */
  readonly origin: string;
  /** How many artifacts this identifier currently accounts for. */
  readonly attributes: AttributionImpact;
}

export interface RosterDeveloperView {
  readonly key: string;
  readonly displayName: string;
  readonly teamKey: string | null;
  readonly active: boolean;
  readonly identities: readonly RosterIdentityView[];
  readonly absences: readonly RosterAbsenceView[];
}

export interface RosterAbsenceView {
  readonly naturalKey: string;
  readonly developerKey: string;
  readonly kind: string;
  readonly startAt: number;
  readonly endAt: number;
  readonly note: string | null;
  readonly source: string;
  readonly sourceRef: string | null;
}

export interface UnmatchedIdentityView {
  readonly identityKey: string;
  readonly kind: IdentityKind;
  readonly value: string;
  /** Recorded for display only — never used to match. */
  readonly displayName: string | null;
  readonly occurrenceCount: number;
  readonly artifactKinds: readonly string[];
  readonly sourceKeys: readonly string[];
  /** `sourceKey:sourceRecordId` strings — the sample the queue links to. */
  readonly sampleWitnessRefs: readonly string[];
  readonly attributes: AttributionImpact;
  /** True once a link covers it, so a merged row can be shown as resolved. */
  readonly resolved: boolean;
  readonly resolvedDeveloperKey: string | null;
}

export interface RosterView {
  readonly instant: number;
  readonly teams: readonly RosterTeamView[];
  readonly repositories: readonly RosterTrackedView[];
  readonly projects: readonly RosterTrackedView[];
  readonly developers: readonly RosterDeveloperView[];
  readonly unmatched: readonly UnmatchedIdentityView[];
  readonly absences: readonly RosterAbsenceView[];
}

const SAMPLE_WITNESSES = 3;

/**
 * Reads the whole roster.
 *
 * `at` decides only which absences read as active — everything else is the current
 * configuration, because this screen is for *changing* it and showing a manager a past
 * state they cannot edit would be a trap. Past states are what reports resolve, through
 * `packages/analysis/src/configuration.ts`.
 */
export async function readRosterView(store: KnowledgeStore, at: Instant): Promise<RosterView> {
  const [
    teams,
    developers,
    memberships,
    calendars,
    repositories,
    projects,
    trackedRepositories,
    trackedProjects,
    identityLinks,
    unmatched,
    absences,
  ] = await Promise.all([
    store.list('team'),
    store.list('developer'),
    store.list('team_membership'),
    store.list('working_calendar'),
    store.list('repository'),
    store.list('project'),
    store.list('tracked_repository'),
    store.list('tracked_project'),
    store.list('identity_link'),
    store.list('unmatched_identity'),
    store.list('absence'),
  ]);

  const developerName = new Map(developers.map((developer) => [developer.naturalKey, text(developer, 'displayName')]));

  // ---- absences -------------------------------------------------------------
  //
  // Deliberately *not* marked as in force here. "Does this absence cover the instant" is
  // the suppression predicate, and it lives in exactly one module —
  // `packages/analysis/src/absence-suppression.ts` — which this layer may not import
  // (analysis sits above the knowledge model and depends on nothing). Recomputing it here
  // would be a second copy that could disagree with the report, and a screen saying
  // somebody is out while the report names them is worse than either answer alone. The web
  // edge, which may import both, applies the one predicate. `tools/quality-gates` asserts
  // that no second copy exists.
  const absenceViews: RosterAbsenceView[] = absences
    .map((absence) => ({
      naturalKey: absence.naturalKey,
      developerKey: text(absence, 'developerKey') ?? '',
      kind: text(absence, 'absenceKind') ?? 'leave',
      startAt: num(absence, 'startAt') ?? 0,
      endAt: num(absence, 'endAt') ?? 0,
      note: text(absence, 'note'),
      source: text(absence, 'source') ?? 'manual',
      sourceRef: text(absence, 'sourceRef'),
    }))
    .sort((left, right) =>
      left.startAt === right.startAt
        ? left.naturalKey < right.naturalKey
          ? -1
          : 1
        : right.startAt - left.startAt,
    );

  // ---- identity links, with what each one attributes ------------------------
  const identityViews: RosterIdentityView[] = [];
  for (const link of identityLinks) {
    const developerKey = text(link, 'developerKey') ?? '';
    // A link whose developer is the empty string was *unlinked*; it is history, not a
    // current mapping, so it does not appear as one of the person's identifiers.
    if (developerKey.length === 0) continue;

    identityViews.push({
      identityKey: link.naturalKey,
      kind: (text(link, 'identityKind') ?? 'email') as IdentityKind,
      value: text(link, 'identityValue') ?? '',
      origin: text(link, 'origin') ?? 'declared',
      attributes: await attributionImpact(store, link.naturalKey),
    });
  }

  const identitiesByDeveloper = new Map<string, RosterIdentityView[]>();
  for (const link of identityLinks) {
    const developerKey = text(link, 'developerKey') ?? '';
    if (developerKey.length === 0) continue;
    const view = identityViews.find((candidate) => candidate.identityKey === link.naturalKey);
    if (view === undefined) continue;
    const bucket = identitiesByDeveloper.get(developerKey);
    if (bucket === undefined) identitiesByDeveloper.set(developerKey, [view]);
    else bucket.push(view);
  }

  const linkedDeveloperByIdentity = new Map(
    identityLinks
      .map((link) => [link.naturalKey, text(link, 'developerKey') ?? ''] as const)
      .filter(([, developerKey]) => developerKey.length > 0),
  );

  // ---- developers -----------------------------------------------------------
  const developerViews: RosterDeveloperView[] = developers
    .map((developer) => ({
      key: developer.naturalKey,
      displayName: text(developer, 'displayName') ?? developer.naturalKey,
      teamKey: text(developer, 'teamKey'),
      active: bool(developer, 'active'),
      identities: [...(identitiesByDeveloper.get(developer.naturalKey) ?? [])].sort((left, right) =>
        left.identityKey < right.identityKey ? -1 : 1,
      ),
      absences: absenceViews.filter((absence) => absence.developerKey === developer.naturalKey),
    }))
    .sort(byKey);

  // ---- teams, with membership -----------------------------------------------
  const membershipByTeam = new Map<string, StoredEntity[]>();
  for (const membership of memberships) {
    const teamKey = text(membership, 'teamKey') ?? '';
    if (teamKey.length === 0) continue;
    const bucket = membershipByTeam.get(teamKey);
    if (bucket === undefined) membershipByTeam.set(teamKey, [membership]);
    else bucket.push(membership);
  }

  const calendarByTeam = new Map(
    calendars.map((calendar) => [
      text(calendar, 'teamKey') ?? calendar.naturalKey,
      {
        teamKey: text(calendar, 'teamKey') ?? calendar.naturalKey,
        workingWeekdays: numbers(calendar, 'workingWeekdays'),
        holidays: strings(calendar, 'holidays'),
        timezone: text(calendar, 'timezone') ?? 'UTC',
      } satisfies RosterCalendarView,
    ]),
  );

  const teamViews: RosterTeamView[] = teams
    .map((team) => {
      const explicit = membershipByTeam.get(team.naturalKey) ?? [];
      const explicitKeys = new Set(explicit.map((row) => text(row, 'developerKey') ?? ''));

      const members: RosterMemberView[] = [
        ...explicit.map((row) => {
          const developerKey = text(row, 'developerKey') ?? '';
          return {
            developerKey,
            displayName: developerName.get(developerKey) ?? developerKey,
            membershipRole: text(row, 'membershipRole') ?? 'member',
            active: bool(row, 'active'),
            impliedByDeveloperRow: false,
          };
        }),
        // Somebody whose Developer row names this team but who has no membership row.
        // Shown as implied rather than hidden: a deployment that has never opened this
        // screen has only that field, and an empty team list would be a lie.
        ...developers
          .filter(
            (developer) =>
              text(developer, 'teamKey') === team.naturalKey && !explicitKeys.has(developer.naturalKey),
          )
          .map((developer) => ({
            developerKey: developer.naturalKey,
            displayName: text(developer, 'displayName') ?? developer.naturalKey,
            membershipRole: 'member',
            active: bool(developer, 'active'),
            impliedByDeveloperRow: true,
          })),
      ].sort((left, right) => (left.developerKey < right.developerKey ? -1 : 1));

      return {
        key: team.naturalKey,
        name: text(team, 'name') ?? team.naturalKey,
        methodology: text(team, 'methodology') ?? 'scrum',
        projectKey: text(team, 'projectKey'),
        objectiveKey: text(team, 'objectiveKey'),
        timezone: text(team, 'timezone') ?? 'UTC',
        members,
        calendar: calendarByTeam.get(team.naturalKey) ?? null,
      };
    })
    .sort(byKey);

  // ---- tracked sources -------------------------------------------------------
  const trackingOf = (
    rows: readonly StoredEntity[],
    key: string,
  ): { readonly tracked: boolean; readonly archivedAt: number | null; readonly note: string | null } => {
    const row = rows.find((candidate) => candidate.naturalKey === key);
    if (row === undefined) return { tracked: true, archivedAt: null, note: null };
    return {
      tracked: row.fields['tracked'] !== false,
      archivedAt: num(row, 'archivedAt'),
      note: text(row, 'note'),
    };
  };

  const repositoryViews: RosterTrackedView[] = repositories
    .map((repository) => ({
      key: repository.naturalKey,
      name: text(repository, 'name') ?? repository.naturalKey,
      parentKey: text(repository, 'projectKey'),
      ...trackingOf(trackedRepositories, repository.naturalKey),
    }))
    .sort(byKey);

  const projectViews: RosterTrackedView[] = projects
    .map((project) => ({
      key: project.naturalKey,
      name: text(project, 'name') ?? project.naturalKey,
      parentKey: text(project, 'teamKey'),
      ...trackingOf(trackedProjects, project.naturalKey),
    }))
    .sort(byKey);

  // ---- the unmatched queue ---------------------------------------------------
  const unmatchedViews: UnmatchedIdentityView[] = [];
  for (const row of unmatched) {
    const resolvedDeveloperKey = linkedDeveloperByIdentity.get(row.naturalKey) ?? null;
    unmatchedViews.push({
      identityKey: row.naturalKey,
      kind: (text(row, 'identityKind') ?? 'email') as IdentityKind,
      value: text(row, 'identityValue') ?? '',
      displayName: text(row, 'displayName'),
      occurrenceCount: num(row, 'occurrenceCount') ?? 0,
      artifactKinds: strings(row, 'artifactKinds'),
      sourceKeys: strings(row, 'sourceKeys'),
      sampleWitnessRefs: strings(row, 'witnessRefs').slice(0, SAMPLE_WITNESSES),
      attributes: await attributionImpact(store, row.naturalKey),
      resolved: resolvedDeveloperKey !== null,
      resolvedDeveloperKey,
    });
  }

  // Unresolved first, then by how much work is at stake: the queue is a work list, and
  // the address accounting for forty commits matters more than the one accounting for one.
  unmatchedViews.sort((left, right) => {
    if (left.resolved !== right.resolved) return left.resolved ? 1 : -1;
    if (left.occurrenceCount !== right.occurrenceCount) return right.occurrenceCount - left.occurrenceCount;
    return left.identityKey < right.identityKey ? -1 : 1;
  });

  return {
    instant: at,
    teams: teamViews,
    repositories: repositoryViews,
    projects: projectViews,
    developers: developerViews,
    unmatched: unmatchedViews,
    absences: absenceViews,
  };
}

/** The membership natural key for a (team, developer) pair, for a caller holding both. */
export { teamMembershipKey };

/** The identity key for a kind and a value, for a caller holding both. */
export const rosterIdentityKey = (kind: IdentityKind, value: string): string =>
  identityNaturalKey(kind, value);
