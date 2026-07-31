import type { Instant } from '@compass/clock';
import type { EntityKind } from '@compass/db';

import { identityNaturalKey, normalizeIdentityValue, type IdentityKind } from './identity.js';
import type { KnowledgeStore, ObserveOutcome } from './store.js';

/**
 * The declared roster.
 *
 * Company, Objective, Team, Developer, IdentityLink and Absence are *configured*,
 * not ingested. The connector port has no roster artifact and that is deliberate:
 * the alternative is inferring that a git email is a person, which is exactly what
 * `UnmatchedIdentity` exists to refuse. A manager declares who is on the team and
 * which identifiers are theirs; Compass attributes work only through those
 * declarations.
 *
 * Provisioning is an observation like any other, so it gets the same treatment: the
 * same roster applied twice produces no new versions, a changed display name
 * produces exactly one, and every change is in `entity_versions` afterwards. The
 * CRUD surfaces for Objectives arrive with `mvp-goals-and-alignment`; this is the
 * write path they will call.
 */

export interface RosterCompany {
  /** Slug. Stable across renames — the name is a tracked field, the key is not. */
  readonly key: string;
  readonly name: string;
  readonly timezone: string;
}

export interface RosterObjective {
  readonly key: string;
  readonly kind: 'company' | 'quarter';
  readonly parentKey: string | null;
  readonly title: string;
  readonly effectiveFrom: Instant;
  readonly effectiveUntil: Instant;
  /** The one objective today's work is measured against. */
  readonly isCurrent: boolean;
}

export interface RosterTeam {
  readonly key: string;
  readonly name: string;
  readonly methodology: 'scrum' | 'kanban';
  readonly projectKey: string | null;
  readonly objectiveKey: string | null;
  readonly conversationKey: string | null;
  readonly timezone: string;
}

export interface RosterDeveloper {
  readonly key: string;
  readonly displayName: string;
  readonly teamKey: string | null;
  readonly active: boolean;
  /** Every git author address this person commits under. */
  readonly gitEmails: readonly string[];
  readonly trackerAccounts: readonly string[];
  readonly chatHandles: readonly string[];
}

export interface RosterAbsence {
  readonly developerKey: string;
  readonly kind: string;
  readonly startAt: Instant;
  readonly endAt: Instant;
  readonly note: string | null;
}

export interface OrgRoster {
  readonly company: RosterCompany;
  readonly objectives: readonly RosterObjective[];
  readonly teams: readonly RosterTeam[];
  readonly developers: readonly RosterDeveloper[];
  readonly absences: readonly RosterAbsence[];
  /**
   * When this roster was declared. Used as the observation instant, so the same
   * roster re-applied is byte-identical rather than merely equivalent.
   */
  readonly declaredAt: Instant;
}

export interface RosterProvisionResult {
  readonly created: number;
  readonly changed: number;
  readonly unchanged: number;
  readonly identityLinkCount: number;
  readonly perKind: readonly { readonly kind: EntityKind; readonly count: number }[];
}

/** The three identifier families a roster declares, in a fixed order. */
const IDENTITY_SOURCES: readonly {
  readonly kind: IdentityKind;
  readonly read: (developer: RosterDeveloper) => readonly string[];
}[] = [
  { kind: 'email', read: (developer) => developer.gitEmails },
  { kind: 'account', read: (developer) => developer.trackerAccounts },
  { kind: 'handle', read: (developer) => developer.chatHandles },
];

export class DuplicateIdentityLinkError extends Error {
  constructor(identityKey: string, first: string, second: string) {
    super(
      `\`${identityKey}\` is declared for both ${first} and ${second}. One identifier belongs to at most one person; resolve the roster before provisioning it.`,
    );
    this.name = 'DuplicateIdentityLinkError';
  }
}

/**
 * Writes a declared roster into the model.
 *
 * Identity links are expanded from each developer's identifiers, and a
 * duplicate — the same address claimed by two people — is refused rather than
 * silently resolved by declaration order. A silent winner would attribute a
 * person's commits to somebody else and the report would state that as fact.
 */
export async function provisionRoster(
  store: KnowledgeStore,
  roster: OrgRoster,
): Promise<RosterProvisionResult> {
  const at = roster.declaredAt;
  const counts = new Map<EntityKind, number>();
  let created = 0;
  let changed = 0;
  let unchanged = 0;

  const record = (kind: EntityKind, outcome: ObserveOutcome): void => {
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    if (outcome === 'created') created += 1;
    else if (outcome === 'changed') changed += 1;
    else unchanged += 1;
  };

  const company = await store.observe({
    kind: 'company',
    naturalKey: roster.company.key,
    fields: { name: roster.company.name, timezone: roster.company.timezone },
    observedAt: at,
    evidence: null,
  });
  record('company', company.outcome);

  for (const objective of [...roster.objectives].sort((left, right) => (left.key < right.key ? -1 : 1))) {
    const result = await store.observe({
      kind: 'objective',
      naturalKey: objective.key,
      fields: {
        objectiveKind: objective.kind,
        parentObjectiveKey: objective.parentKey,
        title: objective.title,
        effectiveFrom: objective.effectiveFrom,
        effectiveUntil: objective.effectiveUntil,
        isCurrent: objective.isCurrent,
      },
      observedAt: at,
      evidence: null,
    });
    record('objective', result.outcome);
  }

  for (const team of [...roster.teams].sort((left, right) => (left.key < right.key ? -1 : 1))) {
    const result = await store.observe({
      kind: 'team',
      naturalKey: team.key,
      fields: {
        name: team.name,
        methodology: team.methodology,
        projectKey: team.projectKey,
        objectiveKey: team.objectiveKey,
        conversationKey: team.conversationKey,
        timezone: team.timezone,
      },
      observedAt: at,
      evidence: null,
    });
    record('team', result.outcome);
  }

  // Every declared identifier, checked for collisions before anything is written.
  const claimedBy = new Map<string, string>();
  for (const developer of roster.developers) {
    for (const source of IDENTITY_SOURCES) {
      for (const value of source.read(developer)) {
        const key = identityNaturalKey(source.kind, value);
        const existing = claimedBy.get(key);
        if (existing !== undefined && existing !== developer.key) {
          throw new DuplicateIdentityLinkError(key, existing, developer.key);
        }
        claimedBy.set(key, developer.key);
      }
    }
  }

  let identityLinkCount = 0;
  for (const developer of [...roster.developers].sort((left, right) => (left.key < right.key ? -1 : 1))) {
    const result = await store.observe({
      kind: 'developer',
      naturalKey: developer.key,
      fields: {
        displayName: developer.displayName,
        teamKey: developer.teamKey,
        active: developer.active,
      },
      observedAt: at,
      evidence: null,
    });
    record('developer', result.outcome);

    for (const source of IDENTITY_SOURCES) {
      for (const value of [...source.read(developer)].sort()) {
        const link = await store.observe({
          kind: 'identity_link',
          naturalKey: identityNaturalKey(source.kind, value),
          fields: {
            identityKind: source.kind,
            identityValue: normalizeIdentityValue(source.kind, value),
            developerKey: developer.key,
            origin: 'declared',
          },
          observedAt: at,
          evidence: null,
        });
        record('identity_link', link.outcome);
        identityLinkCount += 1;
      }
    }
  }

  for (const absence of [...roster.absences].sort((left, right) =>
    left.developerKey === right.developerKey
      ? left.startAt - right.startAt
      : left.developerKey < right.developerKey
        ? -1
        : 1,
  )) {
    const result = await store.observe({
      kind: 'absence',
      naturalKey: `${absence.developerKey}:${absence.startAt}`,
      fields: {
        developerKey: absence.developerKey,
        absenceKind: absence.kind,
        startAt: absence.startAt,
        endAt: absence.endAt,
        note: absence.note,
      },
      observedAt: at,
      evidence: null,
    });
    record('absence', result.outcome);
  }

  return {
    created,
    changed,
    unchanged,
    identityLinkCount,
    perKind: [...counts.entries()].map(([kind, count]) => ({ kind, count })),
  };
}
