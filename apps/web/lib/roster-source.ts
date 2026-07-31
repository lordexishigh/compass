import { absenceCoversInstant } from '@compass/analysis';
import { recordAudit, type AuditAction } from '@compass/auth';
import { type Instant } from '@compass/clock';
import { findAuditLogEntry, type ScopedDb } from '@compass/db';
import { artifactHref } from '@compass/pipeline';
import {
  KnowledgeStore,
  addIdentityLink,
  endAbsence,
  isPreMergeAttribution,
  mergeUnmatchedIdentity,
  readRosterView,
  recordAbsence,
  removeIdentityLink,
  rosterIdentityKey,
  setProjectTracking,
  setRepositoryTracking,
  setTeamMembership,
  setWorkingCalendar,
  teamMembershipKey,
  unmergeIdentity,
  upsertDeveloper,
  upsertTeam,
  type AbsenceInput,
  type IdentityLinkResult,
  type MergeResult,
  type MergeTarget,
  type PreMergeAttribution,
  type RosterView,
  type TeamInput,
  type TeamMembershipInput,
  type TrackingInput,
  type UnmergeResult,
  type WorkingCalendarInput,
} from '@compass/knowledge-model';

import { MergeRecordNotFoundError } from './auth/http';

/**
 * The roster surface's server half: read the configuration, write it, audit every write.
 *
 * Thin on purpose. Validation lives in `@compass/knowledge-model`'s roster service, which
 * is the sole write path and is called by the boot script too; this module's whole job is to
 * pair each write with an `AuditLogEntry` and hand the result back in the shape the screen
 * renders. Putting the validation here instead would mean the boot script had a second,
 * weaker set of rules.
 *
 * Every function takes an already-resolved `ScopedDb` and an `Instant`. Nothing here reads a
 * clock or resolves a tenant — the route handler's `guard()` did both, and a second
 * resolution would be a second chance to disagree with it.
 */

export const storeFor = (scoped: ScopedDb): KnowledgeStore => new KnowledgeStore(scoped);

/** An absence with the one thing the screen needs and the read model refuses to guess. */
export type RosterAbsenceRow = RosterView['absences'][number] & { readonly activeNow: boolean };

/**
 * A sample artifact the unmatched queue links to.
 *
 * `label` is the artifact's own natural key — a SHA-bearing commit key or a pull request
 * key, which is what a manager searches for when they go and look. `href` is built by
 * `artifactHref` rather than written by hand here, so the queue's links and the report's
 * evidence markers cannot drift into two path shapes, only one of which the route serves.
 */
export interface RosterArtifactLink {
  readonly label: string;
  readonly href: string;
}

export type RosterUnmatchedRow = RosterView['unmatched'][number] & {
  readonly sampleLinks: readonly RosterArtifactLink[];
};

export type RosterScreenView = Omit<RosterView, 'absences' | 'developers' | 'unmatched'> & {
  readonly absences: readonly RosterAbsenceRow[];
  readonly unmatched: readonly RosterUnmatchedRow[];
  readonly developers: readonly (Omit<RosterView['developers'][number], 'absences'> & {
    readonly absences: readonly RosterAbsenceRow[];
  })[];
};

/**
 * The roster, with "is this absence in force" applied by the one predicate that decides it.
 *
 * `@compass/knowledge-model` cannot import `@compass/analysis` — the analysis core sits
 * above it and declares no dependencies at all — so the read model returns absences without
 * that mark and this edge, which may import both, adds it. That is the whole reason the
 * decoration happens here: one implementation of the predicate, used by the report and by
 * the screen, so the two can never say different things about the same person.
 */
export async function readRoster(scoped: ScopedDb, at: Instant): Promise<RosterScreenView> {
  const view = await readRosterView(storeFor(scoped), at);
  const mark = (absence: RosterView['absences'][number]): RosterAbsenceRow => ({
    ...absence,
    activeNow: absenceCoversInstant(absence, at),
  });

  return {
    ...view,
    absences: view.absences.map(mark),
    // The queue's "sample artifact link" resolved to a real path. The read model names the
    // artifact and its kind; turning that into `/artifact/<kind>/<id>` is this layer's job,
    // because `artifactHref` lives above the knowledge model.
    unmatched: view.unmatched.map((row) => ({
      ...row,
      sampleLinks: row.attributes.sampleArtifacts.map((sample) => ({
        label: sample.key,
        href: artifactHref(sample.kind, sample.key),
      })),
    })),
    developers: view.developers.map((developer) => ({
      ...developer,
      absences: developer.absences.map(mark),
    })),
  };
}

/** Who did it, for the audit row. Resolved from the session by the route handler. */
export interface Actor {
  readonly userId: string | null;
  readonly displayName: string;
}

/**
 * The actor for an audit row, from the guard's identity.
 *
 * `null` for the system — the boot script provisioning a roster has no signed-in person,
 * and the audit log's `actor_user_id` is nullable for exactly that case. Every route on this
 * surface is seated, so in practice the identity is always present; the fallback exists so
 * the type does not force a route to assert it.
 */
export const actorFor = (identity: { readonly user: { readonly id: string; readonly displayName: string } } | null): Actor =>
  identity === null
    ? { userId: null, displayName: 'Compass' }
    : { userId: identity.user.id, displayName: identity.user.displayName };

interface AuditedWrite {
  readonly action: AuditAction;
  readonly targetKind:
    | 'team'
    | 'team_membership'
    | 'working_calendar'
    | 'repository'
    | 'project'
    | 'developer'
    | 'identity'
    | 'absence';
  readonly targetId: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
}

const audit = (scoped: ScopedDb, actor: Actor, at: Instant, write: AuditedWrite) =>
  recordAudit(scoped, {
    action: write.action,
    actorUserId: actor.userId,
    targetKind: write.targetKind,
    targetId: write.targetId,
    before: write.before,
    after: write.after,
    occurredAt: at,
  });

// ---------------------------------------------------------------------------
// Teams, membership, calendars
// ---------------------------------------------------------------------------

export async function saveTeam(
  scoped: ScopedDb,
  input: TeamInput,
  actor: Actor,
  at: Instant,
): Promise<{ readonly outcome: string }> {
  const store = storeFor(scoped);
  const before = await store.read('team', input.key);
  const result = await upsertTeam(store, input, at);

  // An unchanged write appends nothing, so it audits nothing either. An audit log full of
  // "saved the form without editing it" is one nobody reads.
  if (result.outcome !== 'unchanged') {
    await audit(scoped, actor, at, {
      action: 'config.team_changed',
      targetKind: 'team',
      targetId: input.key,
      before: before === null ? null : { ...before.fields },
      after: { ...input },
    });
  }

  return { outcome: result.outcome };
}

export async function saveTeamMembership(
  scoped: ScopedDb,
  input: TeamMembershipInput,
  actor: Actor,
  at: Instant,
): Promise<{ readonly outcome: string }> {
  const store = storeFor(scoped);
  // Read before the write, because the prior value has to be *read* rather than inferred.
  // `active: !input.active` was wrong for the case that actually happens: changing somebody
  // from member to lead appends a version with `active` unchanged, and the audit row then
  // asserted the opposite of the truth — the one thing an audit row must never do.
  const before = await store.read('team_membership', teamMembershipKey(input.teamKey, input.developerKey));
  const result = await setTeamMembership(store, input, at);

  if (result.outcome !== 'unchanged') {
    await audit(scoped, actor, at, {
      action: 'config.team_membership_changed',
      targetKind: 'team_membership',
      targetId: result.naturalKey,
      before:
        before === null
          ? null
          : {
              active: before.fields['active'] === true,
              membershipRole: before.fields['membershipRole'] ?? 'member',
            },
      after: {
        teamKey: input.teamKey,
        developerKey: input.developerKey,
        membershipRole: input.membershipRole ?? 'member',
        active: input.active,
      },
    });
  }

  return { outcome: result.outcome };
}

export async function saveWorkingCalendar(
  scoped: ScopedDb,
  input: WorkingCalendarInput,
  actor: Actor,
  at: Instant,
): Promise<{ readonly outcome: string }> {
  const store = storeFor(scoped);
  const before = await store.read('working_calendar', input.teamKey);
  const result = await setWorkingCalendar(store, input, at);

  if (result.outcome !== 'unchanged') {
    await audit(scoped, actor, at, {
      action: 'config.working_calendar_changed',
      targetKind: 'working_calendar',
      targetId: input.teamKey,
      before: before === null ? null : { ...before.fields },
      after: { ...input },
    });
  }

  return { outcome: result.outcome };
}

// ---------------------------------------------------------------------------
// Tracked repositories and projects
// ---------------------------------------------------------------------------

export async function saveRepositoryTracking(
  scoped: ScopedDb,
  input: TrackingInput,
  actor: Actor,
  at: Instant,
): Promise<{ readonly outcome: string }> {
  const store = storeFor(scoped);
  const before = await store.read('tracked_repository', input.key);
  const result = await setRepositoryTracking(store, input, at);

  if (result.outcome !== 'unchanged') {
    await audit(scoped, actor, at, {
      action: 'config.repository_tracking_changed',
      targetKind: 'repository',
      targetId: input.key,
      before: { tracked: before === null ? true : before.fields['tracked'] !== false },
      after: { tracked: input.tracked, note: input.note ?? null },
    });
  }

  return { outcome: result.outcome };
}

export async function saveProjectTracking(
  scoped: ScopedDb,
  input: TrackingInput,
  actor: Actor,
  at: Instant,
): Promise<{ readonly outcome: string }> {
  const store = storeFor(scoped);
  const before = await store.read('tracked_project', input.key);
  const result = await setProjectTracking(store, input, at);

  if (result.outcome !== 'unchanged') {
    await audit(scoped, actor, at, {
      action: 'config.project_tracking_changed',
      targetKind: 'project',
      targetId: input.key,
      before: { tracked: before === null ? true : before.fields['tracked'] !== false },
      after: { tracked: input.tracked, note: input.note ?? null },
    });
  }

  return { outcome: result.outcome };
}

// ---------------------------------------------------------------------------
// Developers and identity links
// ---------------------------------------------------------------------------

export async function saveDeveloper(
  scoped: ScopedDb,
  input: { readonly key: string; readonly displayName: string; readonly teamKey: string | null; readonly active: boolean },
  actor: Actor,
  at: Instant,
): Promise<{ readonly outcome: string }> {
  const store = storeFor(scoped);
  const before = await store.read('developer', input.key);
  const result = await upsertDeveloper(store, input, at);

  if (result.outcome !== 'unchanged') {
    await audit(scoped, actor, at, {
      action: 'config.changed',
      targetKind: 'developer',
      targetId: input.key,
      before: before === null ? null : { ...before.fields },
      after: { ...input },
    });
  }

  return { outcome: result.outcome };
}

export async function linkIdentity(
  scoped: ScopedDb,
  input: { readonly kind: 'email' | 'account' | 'handle'; readonly value: string; readonly developerKey: string },
  actor: Actor,
  at: Instant,
): Promise<IdentityLinkResult> {
  const store = storeFor(scoped);
  // The prior owner is read, not assumed to be nobody. Re-pointing an identifier that was
  // already linked is exactly the case where the audit row matters most — recording `null`
  // there would erase the fact that this act took work off somebody else.
  const before = await store.read('identity_link', rosterIdentityKey(input.kind, input.value));
  const result = await addIdentityLink(store, input, at);

  await audit(scoped, actor, at, {
    action: 'identity.link_added',
    targetKind: 'identity',
    targetId: result.identityKey,
    before: { developerKey: before === null ? null : (before.fields['developerKey'] ?? null) || null },
    // The artifact count is in the audit row as well as the response, because "how many
    // artifacts did that move" is exactly the question somebody asks a week later when a
    // name looks wrong in a report.
    after: {
      developerKey: input.developerKey,
      artifactsAffected: result.impact.totalCount,
      commits: result.impact.commitCount,
      pullRequests: result.impact.pullRequestCount,
    },
  });

  return result;
}

export async function unlinkIdentity(
  scoped: ScopedDb,
  input: { readonly kind: 'email' | 'account' | 'handle'; readonly value: string },
  actor: Actor,
  at: Instant,
): Promise<IdentityLinkResult | null> {
  const result = await removeIdentityLink(storeFor(scoped), input, at);
  if (result === null) return null;

  await audit(scoped, actor, at, {
    action: 'identity.link_removed',
    targetKind: 'identity',
    targetId: result.identityKey,
    before: { developerKey: result.developerKey, artifactsAffected: result.impact.totalCount },
    // Unattributed, not deleted. The artifacts are all still there.
    after: { developerKey: null, artifactsRevertedToUnattributed: result.impact.totalCount },
  });

  return result;
}

// ---------------------------------------------------------------------------
// The unmatched queue: merge and un-merge
// ---------------------------------------------------------------------------

/** The audit row's key for the pre-merge snapshot, so the un-merge can find it. */
export const PRE_MERGE_STATE_KEY = 'preMergeAttribution';

/** The audit row's id is what an un-merge is asked for, so it travels with the result. */
export type MergeOutcome = MergeResult & { readonly auditId: string };

/**
 * Merges an unmatched identity, and writes the audit row an un-merge replays.
 *
 * The pre-merge attribution goes into the audit entry's `before` state, and that placement
 * is load-bearing rather than convenient: `audit_log_entries` is append-only in `ScopedDb`,
 * in a database trigger, and in the absence of any repository function that could rewrite
 * one. So the record an un-merge restores from cannot have been edited between the two acts.
 */
export async function mergeIdentity(
  scoped: ScopedDb,
  input: { readonly identityKey: string; readonly target: MergeTarget },
  actor: Actor,
  at: Instant,
): Promise<MergeOutcome> {
  const result = await mergeUnmatchedIdentity(storeFor(scoped), input, at);

  const entry = await audit(scoped, actor, at, {
    action: 'identity.merged',
    targetKind: 'identity',
    targetId: result.identityKey,
    before: { [PRE_MERGE_STATE_KEY]: { ...result.preMerge } },
    after: {
      developerKey: result.developerKey,
      developerCreated: result.developerCreated,
      artifactsAffected: result.impact.totalCount,
      commits: result.impact.commitCount,
      pullRequests: result.impact.pullRequestCount,
    },
  });

  return { ...result, auditId: entry.id };
}

/**
 * Re-exported from `lib/auth/http.ts`, which is where it has to be defined.
 *
 * `failure()` maps it onto a 404, and `http.ts` cannot import this module — that would be a
 * cycle, since `http.ts` is imported by `guard.ts` and this module imports `@compass/auth`.
 * Callers still import it from here, next to the function that throws it.
 */
export { MergeRecordNotFoundError };

export type UnmergeOutcome = UnmergeResult & {
  readonly auditId: string;
  readonly mergeAuditId: string;
};

/**
 * Undoes a merge from its own audit record.
 *
 * The snapshot is read back out of the append-only log rather than recomputed, because it
 * cannot be recomputed: once the link exists, "who was this attributed to before" is a
 * question about a state the model no longer holds.
 */
export async function undoMerge(
  scoped: ScopedDb,
  input: { readonly mergeAuditId: string },
  actor: Actor,
  at: Instant,
): Promise<UnmergeOutcome> {
  // Read by id rather than by scanning a page of the log: an organization that merges
  // often would push the record it needs off the end of any window this could pick.
  const merge = await findAuditLogEntry(scoped, input.mergeAuditId);
  if (merge === null || merge.action !== 'identity.merged') {
    throw new MergeRecordNotFoundError(input.mergeAuditId);
  }

  const snapshot = (merge.before ?? {})[PRE_MERGE_STATE_KEY];
  if (!isPreMergeAttribution(snapshot)) throw new MergeRecordNotFoundError(input.mergeAuditId);

  const result = await unmergeIdentity(storeFor(scoped), snapshot as PreMergeAttribution, at);

  const entry = await audit(scoped, actor, at, {
    action: 'identity.unmerged',
    targetKind: 'identity',
    targetId: result.identityKey,
    before: { developerKey: merge.after?.['developerKey'] ?? null, mergeAuditId: input.mergeAuditId },
    after: {
      developerKey: result.restoredDeveloperKey,
      artifactsRestored: result.restoredArtifactKeys.length,
      // Stated rather than assumed: an ingest between the two acts can have added
      // artifacts the merge's snapshot could not have known about.
      exact: result.exact,
    },
  });

  return { ...result, auditId: entry.id, mergeAuditId: input.mergeAuditId };
}

// ---------------------------------------------------------------------------
// Absences
// ---------------------------------------------------------------------------

export async function saveAbsence(
  scoped: ScopedDb,
  input: AbsenceInput,
  actor: Actor,
  at: Instant,
): Promise<{ readonly outcome: string; readonly naturalKey: string }> {
  const result = await recordAbsence(storeFor(scoped), input, at);

  if (result.outcome !== 'unchanged') {
    await audit(scoped, actor, at, {
      action: 'absence.recorded',
      targetKind: 'absence',
      targetId: result.naturalKey,
      before: null,
      after: {
        developerKey: input.developerKey,
        kind: input.kind,
        startAt: input.startAt,
        endAt: input.endAt,
        source: input.source,
        sourceRef: input.sourceRef ?? null,
      },
    });
  }

  return { outcome: result.outcome, naturalKey: result.naturalKey };
}

export async function closeAbsence(
  scoped: ScopedDb,
  input: { readonly naturalKey: string; readonly endAt: Instant },
  actor: Actor,
  at: Instant,
): Promise<{ readonly outcome: string } | null> {
  const store = storeFor(scoped);
  const before = await store.read('absence', input.naturalKey);
  const result = await endAbsence(store, input, at);
  if (result === null) return null;

  if (result.outcome !== 'unchanged') {
    await audit(scoped, actor, at, {
      action: 'absence.ended',
      targetKind: 'absence',
      targetId: input.naturalKey,
      before: before === null ? null : { endAt: before.fields['endAt'] ?? null },
      after: { endAt: input.endAt },
    });
  }

  return { outcome: result.outcome };
}
