import { createHash, randomBytes } from 'node:crypto';


import { formatCivilDate, instantFromEpochMillis, toEpochMillis, toIso, type Instant } from '@compass/clock';
import {
  ACCOUNT_ERASURE_CATEGORIES,
  ERASURE_CATEGORIES,
  PRIVACY_DEFAULTS,
  anonymizationRowId,
  countRawEvents,
  deletionRequestRowId,
  privacySettingsRowId,
  slackChannelRowId,
  ensurePrivacySettings,
  findAnonymization,
  findDeletionRequestByUndoHash,
  findLiveDeletionRequest,
  findOrganization,
  findUserById,
  insertDeletionRequest,
  listAnonymizations,
  listDeletionRequests,
  listPurgeRuns,
  listRawEventsForIdentities,
  listSlackChannels,
  markDeletionUndone,
  readPrivacySettings,
  recordAnonymization,
  revertAnonymization,
  setSlackChannelIngestion,
  updatePrivacySettings,
  type ConversationKind,
  type DerivedRetentionYears,
  type LlmMinimizationMode,
  type RawRetentionDays,
  type ScopedDb,
  type StoredAnonymization,
  type StoredDeletionRequest,
  type StoredPurgeRun,
  type StoredRawEvent,
  type StoredSlackChannel,
} from '@compass/db';
import {
  KnowledgeStore,
  currentAnonymization,
  pseudonymFor,
  readRosterView,
  setDeveloperAnonymization,
} from '@compass/knowledge-model';
import { recordAudit, type Identity } from '@compass/auth';
import { loadReportBundle, findReportsForDate, listReportArchive } from '@compass/db';

import { DeletionAlreadyPendingError, InvalidRetentionError } from './auth/http';

/**
 * Everything the two privacy screens read and write.
 *
 * Same arrangement as `roster-source.ts`: the pages and the route handlers both come
 * through here, so the screen and the endpoint behind it cannot disagree about what a
 * retention window is or what an anonymization does. Nothing here reads a clock —
 * `now` arrives from the request edge.
 */

// ---------------------------------------------------------------------------
// The admin view
// ---------------------------------------------------------------------------

const MILLIS_PER_DAY = 86_400_000;
const MILLIS_PER_YEAR = 365.2425 * MILLIS_PER_DAY;

/** Daily, matching `PURGE_CRON` in the worker. Stated here so the page can say when. */
const PURGE_INTERVAL_MILLIS = MILLIS_PER_DAY;

export interface RetentionView {
  readonly rawEventRetentionDays: number;
  readonly derivedRetentionYears: number | null;
  readonly llmMinimizationMode: LlmMinimizationMode;
  /** The instant raw events currently have to postdate to survive. */
  readonly rawCutoff: Instant;
  readonly derivedCutoff: Instant | null;
  readonly nextPurgeAt: Instant;
  readonly lastPurge: StoredPurgeRun | null;
  readonly recentPurges: readonly StoredPurgeRun[];
  /** How many chat messages Compass is holding right now. */
  readonly rawEventsHeld: number;
}

export interface PrivacyAdminView {
  readonly organizationName: string;
  readonly retention: RetentionView;
  readonly channels: readonly StoredSlackChannel[];
  readonly anonymizations: readonly StoredAnonymization[];
  readonly deletionRequests: readonly StoredDeletionRequest[];
  readonly liveDeletion: StoredDeletionRequest | null;
  /** People a manager could anonymise, name and key. */
  readonly people: readonly { readonly key: string; readonly displayName: string; readonly anonymized: boolean }[];
}

/**
 * The whole admin screen, in one read.
 *
 * `ensurePrivacySettings` rather than `readPrivacySettings`, so the page renders a real
 * stored setting on the very first visit instead of the words "using the default" over a
 * value nothing has written. It is idempotent and the row is created once.
 */
export async function loadPrivacyAdminView(scoped: ScopedDb, now: Instant): Promise<PrivacyAdminView> {
  const settings = await ensurePrivacySettings(scoped, { id: privacySettingsRowId(scoped.organizationId), at: now });
  const organization = await findOrganization(scoped);
  const roster = await readRosterView(new KnowledgeStore(scoped), now);
  const anonymizations = await listAnonymizations(scoped);
  const anonymised = new Set(anonymizations.map((entry) => entry.developerKey));

  const recentPurges = await listPurgeRuns(scoped, 10);
  const lastPurge = recentPurges.at(0) ?? null;

  return {
    organizationName: organization?.name ?? 'this organization',
    retention: {
      rawEventRetentionDays: settings.rawEventRetentionDays,
      derivedRetentionYears: settings.derivedRetentionYears,
      llmMinimizationMode: settings.llmMinimizationMode,
      rawCutoff: instantFromEpochMillis(
        toEpochMillis(now) - Math.round(settings.rawEventRetentionDays * MILLIS_PER_DAY),
      ),
      derivedCutoff:
        settings.derivedRetentionYears === null
          ? null
          : instantFromEpochMillis(toEpochMillis(now) - Math.round(settings.derivedRetentionYears * MILLIS_PER_YEAR)),
      // Derived from the cron and the last run rather than stored: a changed cron must not
      // leave every tenant's page claiming the old time.
      nextPurgeAt: instantFromEpochMillis(
        Math.max(toEpochMillis(lastPurge?.startedAt ?? now) + PURGE_INTERVAL_MILLIS, toEpochMillis(now)),
      ),
      lastPurge,
      recentPurges,
      rawEventsHeld: await countRawEvents(scoped),
    },
    channels: await listSlackChannels(scoped),
    anonymizations,
    deletionRequests: await listDeletionRequests(scoped),
    liveDeletion: await findLiveDeletionRequest(scoped, 'organization', scoped.organizationId),
    people: roster.developers.map((developer) => ({
      key: developer.key,
      displayName: developer.displayName,
      anonymized: anonymised.has(developer.key),
    })),
  };
}

/**
 * The row-id derivations live in `@compass/db` and are re-exported here.
 *
 * Not a stylistic choice: `apps/worker`'s boot script writes the settings row too, and
 * `onConflictDoNothing` can only turn that race into a no-op if both processes derive the
 * *same* id. A second copy of the hash in this file would be a second id, and the loser of
 * the boot race would fail on the unique constraint instead of finding the row.
 */
export { privacySettingsRowId };

// ---------------------------------------------------------------------------
// Settings writes
// ---------------------------------------------------------------------------

/**
 * Both refusal classes live in `lib/auth/http.ts` and are re-exported here.
 *
 * Not an aesthetic choice: `failure()` has to recognise them to turn them into the right
 * status, and `http.ts` is imported by `guard.ts` — so declaring them here and importing
 * them there would be a cycle. Same arrangement `MergeRecordNotFoundError` already has.
 */
export { DeletionAlreadyPendingError, InvalidRetentionError };

export async function saveRetention(
  scoped: ScopedDb,
  input: {
    readonly rawEventRetentionDays?: RawRetentionDays;
    readonly derivedRetentionYears?: DerivedRetentionYears;
    readonly llmMinimizationMode?: LlmMinimizationMode;
  },
  identity: Identity | null,
  now: Instant,
): Promise<RetentionView['llmMinimizationMode']> {
  const before = await ensurePrivacySettings(scoped, {
    id: privacySettingsRowId(scoped.organizationId),
    at: now,
  });

  await updatePrivacySettings(scoped, { ...input, at: now });

  const after = (await readPrivacySettings(scoped)) ?? before;

  /**
   * Two audit rows rather than one, when both moved.
   *
   * They are different decisions with different consequences — how long data is kept, and
   * who is shown it — and an owner reading the audit log to answer "when did we turn
   * redaction on" should find that sentence rather than a `config.changed` they have to
   * open and diff.
   */
  if (
    before.rawEventRetentionDays !== after.rawEventRetentionDays ||
    before.derivedRetentionYears !== after.derivedRetentionYears
  ) {
    await recordAudit(scoped, {
      action: 'privacy.retention_changed',
      actorUserId: identity?.user.id ?? null,
      targetKind: 'organization',
      targetId: scoped.organizationId,
      before: {
        rawEventRetentionDays: before.rawEventRetentionDays,
        derivedRetentionYears: before.derivedRetentionYears,
      },
      after: {
        rawEventRetentionDays: after.rawEventRetentionDays,
        derivedRetentionYears: after.derivedRetentionYears,
      },
      occurredAt: now,
    });
  }

  if (before.llmMinimizationMode !== after.llmMinimizationMode) {
    await recordAudit(scoped, {
      action: 'privacy.llm_mode_changed',
      actorUserId: identity?.user.id ?? null,
      targetKind: 'organization',
      targetId: scoped.organizationId,
      before: { llmMinimizationMode: before.llmMinimizationMode },
      after: { llmMinimizationMode: after.llmMinimizationMode },
      occurredAt: now,
    });
  }

  return after.llmMinimizationMode;
}

export async function saveChannelIngestion(
  scoped: ScopedDb,
  input: {
    readonly conversationKey: string;
    readonly conversationName: string;
    readonly conversationKind: ConversationKind;
    readonly enabled: boolean;
  },
  identity: Identity | null,
  now: Instant,
): Promise<StoredSlackChannel> {
  const stored = await setSlackChannelIngestion(scoped, {
    id: slackChannelRowId(scoped.organizationId, input.conversationKey),
    conversationKey: input.conversationKey,
    conversationName: input.conversationName,
    conversationKind: input.conversationKind,
    enabled: input.enabled,
    byUserId: identity?.user.id ?? null,
    at: now,
  });

  await recordAudit(scoped, {
    action: input.enabled ? 'privacy.channel_ingestion_enabled' : 'privacy.channel_ingestion_disabled',
    actorUserId: identity?.user.id ?? null,
    targetKind: 'conversation',
    targetId: input.conversationKey,
    before: null,
    after: { conversationName: input.conversationName, enabled: input.enabled },
    occurredAt: now,
  });

  return stored;
}

// ---------------------------------------------------------------------------
// Anonymization
// ---------------------------------------------------------------------------

export interface AnonymizationResult {
  readonly developerKey: string;
  readonly pseudonym: string;
  readonly detail: string;
}

/**
 * Withdraws a person's name from future reports.
 *
 * Three writes, in this order, and the order is the guarantee:
 *
 *  1. the `anonymizations` row, which reserves the pseudonym under a unique constraint;
 *  2. the Developer entity, which is what `developerName` reads and therefore what every
 *     future report prints;
 *  3. the audit row naming the actor.
 *
 * The pseudonym is *reserved first* so that two managers anonymising two people in the
 * same second cannot be assigned the same stand-in — the database refuses the second, the
 * salt loop tries again, and only then does the name change. Doing it the other way round
 * would leave two people printing as one.
 */
export async function anonymizeDeveloper(
  scoped: ScopedDb,
  input: { readonly developerKey: string; readonly reason: string; readonly note: string | null },
  identity: Identity | null,
  now: Instant,
): Promise<AnonymizationResult> {
  const store = new KnowledgeStore(scoped);

  const pseudonym = await reservePseudonym(scoped, input, identity, now);
  await setDeveloperAnonymization(store, { developerKey: input.developerKey, pseudonym, at: now });

  await recordAudit(scoped, {
    action: 'person.anonymized',
    actorUserId: identity?.user.id ?? null,
    targetKind: 'developer',
    targetId: input.developerKey,
    before: null,
    after: { pseudonym, reason: input.reason, note: input.note },
    occurredAt: now,
  });

  return {
    developerKey: input.developerKey,
    pseudonym,
    detail:
      `Done. Every report generated from now on calls this person \`${pseudonym}\`, and reports already written ` +
      'render "a former team member" in place of the name while keeping every ticket key, pull request number and ' +
      'count intact. The change is on the audit log and in the append-only version history, so it cannot be ' +
      'undone quietly — restoring the name is a second recorded act.',
  };
}

/**
 * Reserves a distinct pseudonym, salting until the unique constraint accepts one.
 *
 * `pseudonymFor` is a 32-bit digest into two 64-word lists, so it collides eventually. The
 * loop is what turns "unlikely to collide" into "cannot collide": the database is the
 * arbiter, and the salt is deterministic in the key so the same person re-anonymised after
 * a revert gets the same stand-in back.
 */
async function reservePseudonym(
  scoped: ScopedDb,
  input: { readonly developerKey: string; readonly reason: string; readonly note: string | null },
  identity: Identity | null,
  now: Instant,
): Promise<string> {
  for (let salt = 0; salt <= 64; salt += 1) {
    const candidate = pseudonymFor(salt === 0 ? input.developerKey : `${input.developerKey}#${salt}`);
    try {
      const stored = await recordAnonymization(scoped, {
        id: anonymizationRowId(scoped.organizationId, input.developerKey),
        developerKey: input.developerKey,
        pseudonym: candidate,
        reason: input.reason,
        note: input.note,
        requestedByUserId: identity?.user.id ?? null,
        anonymizedAt: now,
      });
      return stored.pseudonym;
    } catch (error) {
      // A unique violation on the pseudonym is the expected, recoverable case; anything
      // else is not ours to swallow.
      if (!isUniqueViolation(error)) throw error;
    }
  }

  throw new InvalidRetentionError(
    'Compass could not find an unused pseudonym for this person after 64 attempts, which should be impossible ' +
      'below tens of thousands of people in one organization. Nothing was changed.',
  );
}

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  ((error as { code?: string }).code === '23505' ||
    (error as { code?: string }).code === '23_505' ||
    /duplicate key|unique constraint/i.test(error instanceof Error ? error.message : ''));

/** Puts a name back, as its own recorded act. */
export async function restoreDeveloperName(
  scoped: ScopedDb,
  developerKey: string,
  identity: Identity | null,
  now: Instant,
): Promise<string> {
  const existing = await findAnonymization(scoped, developerKey);
  if (existing === null) {
    throw new InvalidRetentionError(
      `\`${developerKey}\` has not been anonymised, so there is no name to restore.`,
    );
  }

  await setDeveloperAnonymization(new KnowledgeStore(scoped), { developerKey, pseudonym: null, at: now });
  await revertAnonymization(scoped, { developerKey, byUserId: identity?.user.id ?? null, at: now });

  await recordAudit(scoped, {
    action: 'person.anonymization_reverted',
    actorUserId: identity?.user.id ?? null,
    targetKind: 'developer',
    targetId: developerKey,
    before: { pseudonym: existing.pseudonym },
    after: null,
    occurredAt: now,
  });

  return (
    'Restored. Future reports name this person again. The original anonymization row is kept and stamped with ' +
    'this reversal, so the sequence of both acts stays on the record.'
  );
}

/**
 * The real names that must not appear in an already-written report.
 *
 * Read from the two tables together, and it has to be both: `anonymizations` says *whose*
 * name was withdrawn (by developer key), and the roster says what that name *is*. The
 * `developers` row keeps the real name deliberately — anonymization decides what Compass
 * prints, not what it knows, so that a mistaken erasure is fixable — which is exactly why
 * the name is still available to be substituted out of the archive.
 *
 * Returns an empty list when nothing is withdrawn, which is the common case and makes
 * `substituteFormerMembers` a no-op that costs one length check per string.
 */
export async function withdrawnNames(scoped: ScopedDb, now: Instant): Promise<readonly string[]> {
  const withdrawn = await listAnonymizations(scoped);
  if (withdrawn.length === 0) return [];

  const roster = await readRosterView(new KnowledgeStore(scoped), now);
  const byKey = new Map(roster.developers.map((developer) => [developer.key, developer.displayName]));

  return withdrawn
    .map((entry) => byKey.get(entry.developerKey) ?? null)
    .filter((name): name is string => name !== null && name.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

/** Seven days. Frozen onto the row at request time, never re-derived on read. */
export const GRACE_PERIOD_DAYS = 7;
/** Thirty days. The outer deadline the purge must have completed by. */
export const HARD_DELETE_DAYS = 30;
const UNDO_TOKEN_BYTES = 32;

export const hashUndoToken = (secret: string): string =>
  createHash('sha256').update(secret, 'utf8').digest('hex');

export interface RequestedDeletion {
  readonly request: StoredDeletionRequest;
  /** Shown once, mailed once, stored never. */
  readonly undoSecret: string;
}

/**
 * Records a deletion request and mints its undo token.
 *
 * Both deadlines are computed here, once, from the injected instant — not derived on read
 * from `requested_at` plus a constant. `sessions.expires_at` freezes for the same reason: a
 * deadline derived on read moves whenever the constant is edited, and "you have seven days"
 * is a promise Compass made to a person rather than a configuration value.
 */
export async function requestDeletion(
  scoped: ScopedDb,
  input: {
    readonly subjectKind: 'account' | 'organization';
    readonly subjectId: string;
    readonly notifyEmail: string;
  },
  identity: Identity | null,
  now: Instant,
): Promise<RequestedDeletion> {
  const existing = await findLiveDeletionRequest(scoped, input.subjectKind, input.subjectId);
  if (existing !== null) {
    throw new DeletionAlreadyPendingError(formatCivilDate(existing.graceEndsAt, 'UTC'));
  }

  const graceEndsAt = instantFromEpochMillis(toEpochMillis(now) + GRACE_PERIOD_DAYS * MILLIS_PER_DAY);
  const hardDeleteBy = instantFromEpochMillis(toEpochMillis(now) + HARD_DELETE_DAYS * MILLIS_PER_DAY);
  const undoSecret = randomBytes(UNDO_TOKEN_BYTES).toString('base64url');

  const request = await insertDeletionRequest(scoped, {
    id: deletionRequestRowId(scoped.organizationId, input.subjectKind, input.subjectId, toIso(now)),
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    requestedByUserId: identity?.user.id ?? null,
    notifyEmail: input.notifyEmail,
    requestedAt: now,
    graceEndsAt,
    hardDeleteBy,
    undoTokenHash: hashUndoToken(undoSecret),
    // Offered in the same act as the request, which is the only order that works: an export
    // offered after the purge is an export of nothing.
    exportOfferedAt: now,
    detail:
      `Requested on ${formatCivilDate(now, 'UTC')}. Nothing has been deleted. The undo link works until ` +
      `${formatCivilDate(graceEndsAt, 'UTC')}, and the deletion will have completed by ` +
      `${formatCivilDate(hardDeleteBy, 'UTC')}.`,
  });

  await recordAudit(scoped, {
    action: 'data.deletion_requested',
    actorUserId: identity?.user.id ?? null,
    targetKind: 'deletion_request',
    targetId: request.id,
    before: null,
    after: {
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      graceEndsAt: toIso(graceEndsAt),
      hardDeleteBy: toIso(hardDeleteBy),
    },
    occurredAt: now,
  });

  return { request, undoSecret };
}

/**
 * What a deletion of each kind will remove, for the screen that asks and the mail that
 * confirms.
 *
 * Both read the same constants the erasure itself uses, so the list a person is shown before
 * they decide is the list the code actually acts on.
 */
export const categoriesForSubject = (subjectKind: 'account' | 'organization'): readonly string[] =>
  subjectKind === 'organization' ? ERASURE_CATEGORIES : ACCOUNT_ERASURE_CATEGORIES;

export type UndoOutcome =
  | { readonly kind: 'restored'; readonly request: StoredDeletionRequest; readonly detail: string }
  | { readonly kind: 'unknown_token'; readonly detail: string }
  | { readonly kind: 'expired'; readonly request: StoredDeletionRequest; readonly detail: string }
  | { readonly kind: 'already_settled'; readonly request: StoredDeletionRequest; readonly detail: string };

/**
 * Spends an undo link.
 *
 * A closed set of outcomes rather than a boolean, because the four cases need four
 * different sentences and one of them — "the grace period has passed" — is the one a person
 * will be most upset to read. Telling them "invalid link" when the link was fine and they
 * were two hours late would be a lie of omission at the worst possible moment.
 *
 * An unknown digest says so without confirming whether any request exists. There is nothing
 * to protect here beyond good manners: the token is the only capability, so a wrong one
 * learns nothing either way.
 */
export async function undoDeletion(scoped: ScopedDb, undoSecret: string, now: Instant): Promise<UndoOutcome> {
  const request = await findDeletionRequestByUndoHash(scoped, hashUndoToken(undoSecret));

  if (request === null) {
    return {
      kind: 'unknown_token',
      detail:
        'That undo link does not match a pending deletion. If you have already used it, the deletion is already ' +
        'cancelled and nothing further is needed.',
    };
  }

  if (request.status !== 'grace') {
    return {
      kind: 'already_settled',
      request,
      detail:
        request.status === 'undone'
          ? 'This deletion was already cancelled. Nothing was deleted and nothing further is needed.'
          : 'This deletion has already run, so there is nothing left to cancel. A confirmation listing what was ' +
            'deleted was sent when it completed.',
    };
  }

  if (toEpochMillis(now) >= toEpochMillis(request.graceEndsAt)) {
    return {
      kind: 'expired',
      request,
      detail:
        `The grace period for this deletion ended on ${formatCivilDate(request.graceEndsAt, 'UTC')}, so the undo ` +
        'link no longer works. If the deletion has not run yet it will shortly, and Compass will send a message ' +
        'listing what was removed.',
    };
  }

  const detail =
    `Cancelled on ${formatCivilDate(now, 'UTC')}. Nothing was deleted and everything works exactly as it did.`;

  await markDeletionUndone(scoped, { id: request.id, at: now, detail });

  await recordAudit(scoped, {
    action: 'data.deletion_cancelled',
    actorUserId: request.requestedByUserId,
    targetKind: 'deletion_request',
    targetId: request.id,
    before: { status: 'grace' },
    after: { status: 'undone' },
    occurredAt: now,
  });

  return { kind: 'restored', request, detail };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Everything Compass holds, as one JSON document.
 *
 * Offered *before* the purge, which is the only useful time to offer it, and readable by an
 * owner at any time — a data export that only exists as part of a deletion flow makes
 * leaving the product the price of seeing your own data.
 *
 * The archive is exported as stored report bundles rather than as re-derived reports: what
 * a person is owed is what Compass actually holds, not what it would compute today.
 */
export async function buildOrganizationExport(
  scoped: ScopedDb,
  identity: Identity | null,
  now: Instant,
): Promise<Record<string, unknown>> {
  const organization = await findOrganization(scoped);
  const archive = await listReportArchive(scoped);
  const settings = await readPrivacySettings(scoped);

  const reports = [];
  for (const entry of archive) {
    const bundle = await loadReportBundle(scoped, entry.id);
    if (bundle !== null) reports.push(bundle);
  }

  await recordAudit(scoped, {
    action: 'data.exported',
    actorUserId: identity?.user.id ?? null,
    targetKind: 'organization',
    targetId: scoped.organizationId,
    before: null,
    after: { reports: reports.length },
    occurredAt: now,
  });

  return {
    exportedAt: toIso(now),
    organization,
    privacySettings: settings ?? PRIVACY_DEFAULTS,
    retentionPurges: await listPurgeRuns(scoped, 100),
    anonymizations: await listAnonymizations(scoped),
    ingestedChannels: await listSlackChannels(scoped),
    deletionRequests: await listDeletionRequests(scoped),
    roster: await readRosterView(new KnowledgeStore(scoped), now),
    reports,
  };
}

// ---------------------------------------------------------------------------
// "What does Compass say about me"
// ---------------------------------------------------------------------------

export interface AboutMeField {
  readonly label: string;
  readonly value: string;
  /** Where it came from, so a reader can check the claim rather than trust it. */
  readonly source: string;
}

export interface AboutMeMention {
  readonly reportId: string;
  readonly reportDate: string;
  readonly scopeLabel: string;
  readonly sectionTitle: string;
  readonly line: string;
}

export interface AboutMeView {
  readonly displayName: string;
  readonly email: string;
  /** Null when the account is not matched to a person on the roster. */
  readonly developerKey: string | null;
  readonly matched: boolean;
  readonly anonymized: boolean;
  readonly fields: readonly AboutMeField[];
  readonly identifiers: readonly { readonly kind: string; readonly value: string }[];
  readonly mentions: readonly AboutMeMention[];
  readonly chatMessagesHeld: readonly StoredRawEvent[];
  readonly rawRetentionDays: number;
  readonly llmMinimizationMode: LlmMinimizationMode;
}

/**
 * What Compass stores about the signed-in person, and every report line naming them.
 *
 * ## Why this page needs no manager approval and no admin action
 *
 * Because the answer is computed from the reader's own session. A member opens it and it
 * works; there is no request, no queue and nobody to ask. That is the acceptance criterion
 * and it is also the point — a transparency page you have to be granted is not one.
 *
 * ## Why the matching is by *account email*, and what happens when it fails
 *
 * The account and the roster are separate models on purpose: a Developer is somebody whose
 * work Compass observes, and a User is somebody who signs in. They are matched here by
 * comparing the account's email against the person's declared identifiers, and when no
 * match exists the page says so plainly rather than showing an empty list — "Compass has
 * not connected your account to anybody on the roster" is a fact a reader can act on,
 * whereas an empty page reads as "nothing is held about you", which may be false.
 *
 * ## What is deliberately absent
 *
 * No ranking, no comparison to a colleague, no score. Every mention is quoted verbatim from
 * a stored report, and nothing here is computed *about* the reader that the report did not
 * already say to their manager. A page that told somebody they were 7th of 9 on review
 * latency would be the surveillance product this whole task exists to avoid being.
 */
export async function loadAboutMe(
  scoped: ScopedDb,
  identity: Identity,
  now: Instant,
): Promise<AboutMeView> {
  const settings = await readPrivacySettings(scoped);
  const store = new KnowledgeStore(scoped);
  const roster = await readRosterView(store, now);
  const account = await findUserById(scoped, identity.user.id);
  const email = (account?.email ?? identity.user.email).toLowerCase();

  const person =
    roster.developers.find((developer) =>
      developer.identities.some((entry) => entry.value.toLowerCase() === email),
    ) ??
    roster.developers.find((developer) => developer.displayName === (account?.displayName ?? '')) ??
    null;

  /**
   * The anonymization state, read off the one row rather than out of a snapshot.
   *
   * Building a knowledge snapshot to answer "is this person anonymised" would materialise
   * every entity and every version in the organization for two fields, on a page a member
   * opens casually. `currentAnonymization` is one indexed read, and it is the same function
   * the roster write path uses — so the page and the writer cannot disagree.
   */
  const anonymization = person === null ? null : await currentAnonymization(store, person.key);
  const anonymized = anonymization !== null && anonymization.anonymizedAt !== null;

  const identifiers = person?.identities.map((entry) => ({ kind: entry.kind, value: entry.value })) ?? [];

  const fields: AboutMeField[] = [
    { label: 'Account name', value: account?.displayName ?? identity.user.displayName, source: 'you, when you signed up' },
    { label: 'Account email', value: email, source: 'you, when you signed up' },
    { label: 'Seat role', value: identity.membership.role, source: 'an owner of this organization' },
    {
      label: 'Teams you can read',
      value: identity.teamScopes.length === 0 ? 'none' : identity.teamScopes.join(', '),
      source: 'an owner of this organization',
    },
  ];

  if (person !== null) {
    fields.push(
      { label: 'Roster name', value: person.displayName, source: 'the roster your manager maintains' },
      { label: 'Team', value: person.teamKey ?? 'not on a team', source: 'the roster your manager maintains' },
      {
        label: 'Name shown in reports',
        value: anonymized ? `${anonymization?.pseudonym ?? ''} (anonymised)` : person.displayName,
        source: anonymized ? 'anonymised at your or your manager’s request' : 'the roster',
      },
    );
  }

  return {
    displayName: account?.displayName ?? identity.user.displayName,
    email,
    developerKey: person?.key ?? null,
    matched: person !== null,
    anonymized,
    fields,
    identifiers,
    mentions: person === null ? [] : await mentionsOf(scoped, person.displayName, person.key),
    chatMessagesHeld:
      identifiers.length === 0
        ? []
        : await listRawEventsForIdentities(
            scoped,
            identifiers.map((entry) => entry.value),
          ),
    rawRetentionDays: settings?.rawEventRetentionDays ?? PRIVACY_DEFAULTS.rawEventRetentionDays,
    llmMinimizationMode: settings?.llmMinimizationMode ?? PRIVACY_DEFAULTS.llmMinimizationMode,
  };
}

/**
 * Every stored report line that names the person.
 *
 * Matched on the *rendered* headline and detail rather than on an attribution column,
 * because the question a person is asking is "where does it say my name" and the answer has
 * to be the text they would read. An attribution-based answer would miss the line that
 * mentions them in passing, which is precisely the line they would most want to see.
 */
async function mentionsOf(
  scoped: ScopedDb,
  displayName: string,
  developerKey: string,
): Promise<readonly AboutMeMention[]> {
  const archive = await listReportArchive(scoped);
  const mentions: AboutMeMention[] = [];
  const needles = [displayName, developerKey].filter((value) => value.trim().length > 0);

  for (const entry of archive) {
    const bundle = await loadReportBundle(scoped, entry.id);
    if (bundle === null) continue;

    for (const section of bundle.sections) {
      for (const item of section.items) {
        for (const line of [item.headline, item.detail]) {
          if (line === null || line === undefined) continue;
          if (!needles.some((needle) => line.includes(needle))) continue;
          mentions.push({
            reportId: bundle.report.id,
            reportDate: bundle.report.reportDate,
            scopeLabel: bundle.report.scopeKey,
            sectionTitle: section.title,
            line,
          });
        }
      }
    }
  }

  return mentions;
}

/** Reports for a date, re-exported so the page need not import two modules. */
export { findReportsForDate };
