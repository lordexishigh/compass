import type { Instant } from '@compass/clock';
import { appendAuditLogEntry, type AuditLogRow, type ScopedDb } from '@compass/db';

/**
 * The audit vocabulary.
 *
 * Every privileged or destructive act writes one row, and the action is drawn from
 * this closed list rather than composed at the call site. Two reasons: a free-text
 * action makes "show me every role change" a text search, and a typo would make the
 * act invisible to the very query the log exists to answer.
 *
 * The list is exactly the acts the task names — role change, seat revoke, config
 * change, share-link revoke, export, delete — plus the ones that are the same kind
 * of thing and would be conspicuous by their absence: inviting a seat, resending an
 * invitation, changing team scopes, and ending every session a person holds.
 *
 * `audit_log_entries` is append-only in `ScopedDb`, in a database trigger, and in
 * the repository's surface area — there is no function anywhere that updates or
 * deletes one. `packages/db/tests/auth-repository.test.ts` asserts all three.
 */
export const AUDIT_ACTIONS = [
  'seat.invited',
  'seat.invite_resent',
  'seat.invite_revoked',
  'seat.accepted',
  'seat.role_changed',
  'seat.team_scopes_changed',
  'seat.removed',
  'account.password_changed',
  'account.sessions_revoked',
  'config.changed',
  // Configuration and roster acts. `identity.merged` and `identity.unmerged` are the
  // pair the un-merge criterion names: a wrong merge corrupts attribution in every
  // downstream report, so both halves of the correction are on the record and the merge's
  // row carries the pre-merge attribution the un-merge replays.
  'config.team_changed',
  'config.team_membership_changed',
  'config.working_calendar_changed',
  'config.repository_tracking_changed',
  'config.project_tracking_changed',
  'identity.link_added',
  'identity.link_removed',
  'identity.merged',
  'identity.unmerged',
  'absence.recorded',
  'absence.ended',
  // Manager Memos. A memo is the one thing a manager writes *into* the model — it changes
  // what the report asserts — so its creation and its expiry are both on the record, and so is
  // the disambiguation when Compass had to ask which person was meant.
  'memo.created',
  'memo.expired',
  'memo.disambiguated',
  'share_link.revoked',
  'report.exported',
  'data.deleted',
  // Privacy. Every one of these changes what Compass keeps, shows or sends about a person,
  // so every one of them is on the record with the actor who did it. `person.anonymized`
  // in particular is required to be auditable and non-silently-reversible, which is why
  // the reversal is its own action rather than the absence of the first.
  'privacy.retention_changed',
  'privacy.llm_mode_changed',
  'privacy.channel_ingestion_enabled',
  'privacy.channel_ingestion_disabled',
  'person.anonymized',
  'person.anonymization_reverted',
  'data.deletion_requested',
  'data.deletion_cancelled',
  'data.exported',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const isAuditAction = (value: string): value is AuditAction =>
  (AUDIT_ACTIONS as readonly string[]).includes(value);

/** What each action is, for the sentence the audit screen prints. */
export const AUDIT_ACTION_LABEL: Readonly<Record<AuditAction, string>> = {
  'seat.invited': 'invited a seat',
  'seat.invite_resent': 'resent an invitation',
  'seat.invite_revoked': 'revoked a pending invitation',
  'seat.accepted': 'accepted an invitation',
  'seat.role_changed': 'changed a role',
  'seat.team_scopes_changed': 'changed which teams a seat can read',
  'seat.removed': 'removed a seat',
  'account.password_changed': 'changed a password',
  'account.sessions_revoked': 'signed out every device',
  'config.changed': 'changed configuration',
  'config.team_changed': 'changed a team',
  'config.team_membership_changed': 'changed who is on a team',
  'config.working_calendar_changed': 'changed a team’s working calendar',
  'config.repository_tracking_changed': 'started or stopped tracking a repository',
  'config.project_tracking_changed': 'started or stopped tracking a project',
  'identity.link_added': 'linked an identifier to a person',
  'identity.link_removed': 'unlinked an identifier',
  'identity.merged': 'merged an unmatched identity into a person',
  'identity.unmerged': 'undid a merge and restored the prior attribution',
  'absence.recorded': 'recorded an absence',
  'absence.ended': 'ended an absence early',
  'memo.created': 'told Compass something it could not have known',
  'memo.expired': 'a memo stopped applying',
  'memo.disambiguated': 'chose which person a memo was about',
  'share_link.revoked': 'revoked a share link',
  'report.exported': 'exported a report',
  'data.deleted': 'deleted data',
  'privacy.retention_changed': 'changed how long Compass keeps data',
  'privacy.llm_mode_changed': 'changed how much a language model is shown',
  'privacy.channel_ingestion_enabled': 'turned on reading of a chat channel',
  'privacy.channel_ingestion_disabled': 'turned off reading of a chat channel',
  'person.anonymized': 'withdrew a person’s name from future reports',
  'person.anonymization_reverted': 'restored a person’s name to future reports',
  'data.deletion_requested': 'asked Compass to delete data',
  'data.deletion_cancelled': 'cancelled a deletion inside the grace period',
  'data.exported': 'exported everything Compass holds',
};

export interface AuditRecordInput {
  readonly action: AuditAction;
  /** Null when the act was the system's — the boot script provisioning the first owner. */
  readonly actorUserId: string | null;
  readonly targetKind:
    | 'membership'
    | 'user'
    | 'session'
    | 'source_config'
    | 'share_link'
    | 'report'
    // Roster and configuration targets. `identity` is the identifier itself
    // (`email:priya@acme.example`), which is what a merge and an un-merge both act on.
    | 'team'
    | 'team_membership'
    | 'working_calendar'
    | 'repository'
    | 'project'
    | 'developer'
    | 'identity'
    | 'absence'
    | 'manager_memo'
    // Privacy targets. `organization` is the tenant itself — the target of a retention
    // change, a narration-mode change and an organization deletion. `conversation` is a
    // chat channel, identified by the provider's own opaque key.
    | 'organization'
    | 'conversation'
    | 'deletion_request';
  readonly targetId: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly occurredAt: Instant;
}

/**
 * Appends one audit row.
 *
 * A thin wrapper over the repository whose whole value is the type: `action` is an
 * `AuditAction` and `targetKind` is a closed set, so a new privileged act cannot be
 * logged under a name nothing queries.
 */
export const recordAudit = (scoped: ScopedDb, input: AuditRecordInput): Promise<AuditLogRow> =>
  appendAuditLogEntry(scoped, input);

/**
 * The changed keys between two states, sorted.
 *
 * The before/after pair is stored whole rather than as a diff — a diff cannot be
 * un-applied and the row is append-only — but the *summary* a human reads is the
 * list of what moved, so it is computed here from the two states rather than
 * remembered by the caller.
 */
export function changedKeys(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): readonly string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys]
    .filter((key) => JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null))
    .sort();
}
