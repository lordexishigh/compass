import { compareStable, type Instant } from './instant.js';

/**
 * Configuration as it was, not as it is.
 *
 * `snapshot.ts` used to say that scope was "deliberately *not* effective-dated here"
 * because resolving it as of a past instant "would need the roster's version history
 * rather than the snapshot's current belief". The history is right there in
 * `collections.entityVersions`, so this module is that deferred capability and
 * `resolveScope` now goes through it.
 *
 * ## Why it matters
 *
 * A report generated for last Tuesday states who was on the team and which repositories
 * were tracked *then*. Resolving today's configuration instead would mean archiving a
 * repository this morning silently rewrote three months of history: last Tuesday's report
 * would regenerate without the merges that were the whole of that day's work, and a
 * manager comparing it against the copy in their inbox would find Compass disagreeing with
 * itself. The same goes for somebody who has since left the team.
 *
 * ## How
 *
 * Every entity row carries its *current* tracked fields; `entity_versions` carries every
 * belief that preceded them, each stamped with the instant it was observed at. So the
 * belief in force at an instant is the newest version at or before it. Ties on `observedAt`
 * break by version number, so the resolution is total and deterministic.
 *
 * ## Why the input types are declared here
 *
 * This module takes structurally-typed input rather than importing `AnalysisSnapshot` from
 * `snapshot.ts`, because `snapshot.ts` imports *this* — and `.dependency-cruiser.cjs`
 * forbids a cycle at error severity. It is the same move the package already makes at its
 * outer boundary, where it re-declares the `Instant` brand structurally in order to depend
 * on nothing: a narrow structural contract is cheaper than a coupling.
 *
 * Pure, like everything else here: no clock, no I/O, the instant is a parameter.
 */

export type ConfigFieldValue = unknown;

/** The shape of `AnalysisEntity` this module reads. Structural, deliberately. */
export interface ConfigEntity {
  readonly kind: string;
  readonly naturalKey: string;
  readonly firstSeenAt: number;
  readonly version: number;
  readonly fields: Readonly<Record<string, ConfigFieldValue>>;
}

/** The shape of `AnalysisEntityVersion` this module reads. */
export interface ConfigEntityVersion {
  readonly entityKind: string;
  readonly entityNaturalKey: string;
  readonly version: number;
  readonly trackedFields: Readonly<Record<string, unknown>>;
  readonly observedAt: number;
}

/** The shape of `AnalysisSnapshot` this module reads. */
export interface ConfigSnapshot {
  readonly collections: {
    readonly entities: readonly ConfigEntity[];
    readonly entityVersions: readonly ConfigEntityVersion[];
  };
}

/** An entity's fields as they stood at an instant, with the version that stated them. */
export interface FieldsAtInstant {
  readonly kind: string;
  readonly naturalKey: string;
  readonly version: number;
  readonly fields: Readonly<Record<string, ConfigFieldValue>>;
  /**
   * True when the entity did not exist at the instant.
   *
   * Distinct from "existed with empty fields": a repository configured yesterday was not
   * merely untracked last Tuesday, it was unknown, and a past report must not mention it.
   */
  readonly absent: boolean;
}

const absentAt = (kind: string, naturalKey: string): FieldsAtInstant => ({
  kind,
  naturalKey,
  version: 0,
  fields: {},
  absent: true,
});

/**
 * Versions of one entity kind, grouped by natural key, oldest first.
 *
 * Built once per resolution rather than per lookup: a real organization's snapshot holds
 * tens of thousands of versions and `resolveScope` asks about every repository.
 */
function versionsByKey(
  snapshot: ConfigSnapshot,
  kind: string,
): ReadonlyMap<string, readonly ConfigEntityVersion[]> {
  const grouped = new Map<string, ConfigEntityVersion[]>();

  for (const version of snapshot.collections.entityVersions) {
    if (version.entityKind !== kind) continue;
    const bucket = grouped.get(version.entityNaturalKey);
    if (bucket === undefined) grouped.set(version.entityNaturalKey, [version]);
    else bucket.push(version);
  }

  for (const bucket of grouped.values()) {
    bucket.sort((left, right) =>
      left.observedAt === right.observedAt ? left.version - right.version : left.observedAt - right.observedAt,
    );
  }

  return grouped;
}

const entitiesOf = (snapshot: ConfigSnapshot, kind: string): readonly ConfigEntity[] =>
  snapshot.collections.entities.filter((entity) => entity.kind === kind);

/**
 * The fields one entity held at an instant.
 *
 * The rule, stated once:
 *
 *  - **First seen after the instant** — it did not exist. Absent.
 *  - **No versions at all** — the entity predates version tracking, so its current fields
 *    are the only belief there has ever been.
 *  - **A version at or before the instant** — the newest such version's `trackedFields`.
 *  - **Every version after the instant** — absent.
 */
export function fieldsAt(
  entity: ConfigEntity,
  versions: readonly ConfigEntityVersion[],
  instant: Instant,
): FieldsAtInstant {
  if (entity.firstSeenAt > instant) return absentAt(entity.kind, entity.naturalKey);

  if (versions.length === 0) {
    return {
      kind: entity.kind,
      naturalKey: entity.naturalKey,
      version: entity.version,
      fields: entity.fields,
      absent: false,
    };
  }

  let inForce: ConfigEntityVersion | null = null;
  for (const version of versions) {
    if (version.observedAt > instant) break;
    inForce = version;
  }

  if (inForce === null) return absentAt(entity.kind, entity.naturalKey);

  return {
    kind: entity.kind,
    naturalKey: entity.naturalKey,
    version: inForce.version,
    // `trackedFields` is the *complete* tracked state as of that version — the store
    // writes it whole rather than as a diff — so this is the belief itself and not a patch
    // to apply. See `packages/db/src/schema/history.ts`.
    fields: inForce.trackedFields as Readonly<Record<string, ConfigFieldValue>>,
    absent: false,
  };
}

/** Every entity of a kind, resolved as of an instant, absent ones dropped. */
export function entitiesAt(
  snapshot: ConfigSnapshot,
  kind: string,
  instant: Instant,
): readonly FieldsAtInstant[] {
  const versions = versionsByKey(snapshot, kind);

  return entitiesOf(snapshot, kind)
    .map((entity) => fieldsAt(entity, versions.get(entity.naturalKey) ?? [], instant))
    .filter((resolved) => !resolved.absent)
    .sort((left, right) => compareStable(left.naturalKey, right.naturalKey));
}

/** A text field off a resolved belief. Mirrors `textField` for the current row. */
export const resolvedText = (resolved: FieldsAtInstant, field: string): string | null => {
  const value = resolved.fields[field];
  return typeof value === 'string' ? value : null;
};

export const resolvedBoolean = (resolved: FieldsAtInstant, field: string): boolean =>
  resolved.fields[field] === true;

export const resolvedNumber = (resolved: FieldsAtInstant, field: string): number | null => {
  const value = resolved.fields[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

/** A list-valued field, non-strings dropped rather than coerced. */
export const resolvedTextList = (resolved: FieldsAtInstant, field: string): readonly string[] => {
  const value = resolved.fields[field];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
};

export const resolvedNumberList = (resolved: FieldsAtInstant, field: string): readonly number[] => {
  const value = resolved.fields[field];
  return Array.isArray(value)
    ? value.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry))
    : [];
};

// ---------------------------------------------------------------------------
// The configuration a report is generated against
// ---------------------------------------------------------------------------

export interface TeamMembershipAt {
  readonly teamKey: string;
  readonly developerKey: string;
  readonly membershipRole: string;
  readonly active: boolean;
}

export interface ConfigurationAtInstant {
  readonly instant: Instant;
  /** Active memberships only — somebody removed before the instant is not in this list. */
  readonly memberships: readonly TeamMembershipAt[];
  /** Repository keys explicitly archived *as of the instant*. */
  readonly archivedRepositoryKeys: readonly string[];
  readonly archivedProjectKeys: readonly string[];
}

/**
 * The whole configuration picture at one instant, in one pass.
 *
 * Assembled together rather than per-question so `resolveScope` walks the version history
 * once. A merged report and a team report both call this, and both get the same answer for
 * the same instant, which is what stops two sections of one report disagreeing about who
 * was on the team.
 */
export function configurationAt(snapshot: ConfigSnapshot, instant: Instant): ConfigurationAtInstant {
  const memberships = entitiesAt(snapshot, 'team_membership', instant)
    .map((resolved) => ({
      teamKey: resolvedText(resolved, 'teamKey') ?? '',
      developerKey: resolvedText(resolved, 'developerKey') ?? '',
      membershipRole: resolvedText(resolved, 'membershipRole') ?? 'member',
      active: resolvedBoolean(resolved, 'active'),
    }))
    .filter((membership) => membership.teamKey.length > 0 && membership.developerKey.length > 0);

  const archivedRepositoryKeys = entitiesAt(snapshot, 'tracked_repository', instant)
    .filter((resolved) => resolved.fields['tracked'] === false)
    .map((resolved) => resolvedText(resolved, 'repositoryKey') ?? resolved.naturalKey)
    .sort(compareStable);

  const archivedProjectKeys = entitiesAt(snapshot, 'tracked_project', instant)
    .filter((resolved) => resolved.fields['tracked'] === false)
    .map((resolved) => resolvedText(resolved, 'projectKey') ?? resolved.naturalKey)
    .sort(compareStable);

  return {
    instant,
    memberships: memberships.filter((membership) => membership.active),
    archivedRepositoryKeys,
    archivedProjectKeys,
  };
}

/**
 * The developers on a team at an instant.
 *
 * Two sources, unioned, and both are needed. `team_membership` is the explicit record a
 * manager writes on the roster screen. `developers.teamKey` is the field the seeded roster
 * and every earlier task set, and a deployment that has never opened the roster screen has
 * only that — so ignoring it would empty every team the day this shipped.
 *
 * Where they disagree, an explicit *removal* wins: somebody taken off the team on the
 * roster screen is off it even if their Developer row still names it, because the removal
 * is the more recent and more deliberate statement.
 */
export function teamDeveloperKeysAt(
  snapshot: ConfigSnapshot,
  teamKey: string,
  instant: Instant,
): readonly string[] {
  const removed = new Set<string>();
  const present = new Set<string>();

  for (const resolved of entitiesAt(snapshot, 'team_membership', instant)) {
    if ((resolvedText(resolved, 'teamKey') ?? '') !== teamKey) continue;
    const developerKey = resolvedText(resolved, 'developerKey') ?? '';
    if (developerKey.length === 0) continue;
    if (resolvedBoolean(resolved, 'active')) present.add(developerKey);
    else removed.add(developerKey);
  }

  for (const resolved of entitiesAt(snapshot, 'developer', instant)) {
    if ((resolvedText(resolved, 'teamKey') ?? '') !== teamKey) continue;
    if (!resolvedBoolean(resolved, 'active')) continue;
    present.add(resolved.naturalKey);
  }

  return [...present].filter((key) => !removed.has(key)).sort(compareStable);
}

/** Whether a repository was tracked at an instant. An unknown repository is tracked. */
export const repositoryTrackedAt = (
  configuration: ConfigurationAtInstant,
  repositoryKey: string,
): boolean => !configuration.archivedRepositoryKeys.includes(repositoryKey);

export const projectTrackedAt = (configuration: ConfigurationAtInstant, projectKey: string): boolean =>
  !configuration.archivedProjectKeys.includes(projectKey);

/**
 * A stated sentence for what archival removed from this report's scope.
 *
 * Honest degradation: a repository that stopped appearing is a fact about the
 * configuration, not an absence to be quiet about. Returns null when nothing was archived,
 * so the masthead gains no empty clause.
 */
export function describeArchival(configuration: ConfigurationAtInstant): string | null {
  const repositories = configuration.archivedRepositoryKeys.length;
  const projects = configuration.archivedProjectKeys.length;
  if (repositories === 0 && projects === 0) return null;

  const parts: string[] = [];
  if (repositories > 0) {
    parts.push(`${repositories} archived ${repositories === 1 ? 'repository' : 'repositories'}`);
  }
  if (projects > 0) parts.push(`${projects} archived ${projects === 1 ? 'project' : 'projects'}`);

  return (
    `${parts.join(' and ')} ${repositories + projects === 1 ? 'is' : 'are'} outside this report. ` +
    'Prior data and prior reports are unchanged.'
  );
}
