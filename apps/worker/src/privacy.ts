import {
  composeDeletionConfirmationMail,
  type AuthMailer,
} from '@compass/auth';
import { formatCivilDate, instantFromEpochMillis, toEpochMillis, type Instant } from '@compass/clock';
import {
  ACCOUNT_ERASURE_CATEGORIES,
  ERASURE_CATEGORIES,
  PRIVACY_DEFAULTS,
  channelsAwaitingNotice,
  eraseAccountData,
  eraseOrganizationData,
  findOrganization,
  latestPurgeRun,
  listDeletionRequestsDue,
  markDeletionPurged,
  purgeRawEventsBefore,
  purgeReportsBefore,
  readPrivacySettings,
  recordChannelNotice,
  recordPurgeRun,
  type ScopedDb,
  type StoredDeletionRequest,
  type StoredPurgeRun,
  type StoredSlackChannel,
} from '@compass/db';
import { renderChannelNotice, type DeliveryOutcome, type SlackTransport } from '@compass/delivery';

/**
 * The three scheduled privacy jobs.
 *
 * Every handler here is an ordinary function whose last parameter is `now`. The clock
 * lives at the process edge in `index.ts` and nothing below it constructs one, which is
 * what makes "the grace period ends seven days later" testable with a `FixedClock` rather
 * than with a sleeping test.
 *
 * ## Why retention, deletion and the channel notice are one file
 *
 * They are three schedules with one property in common: each of them is a promise Compass
 * made to somebody who is not the person operating it. A retention window nobody purges,
 * a deletion nobody completes and a channel nobody was told about are the same failure —
 * a stated policy with no scheduled work behind it — and keeping them together means the
 * registration in `index.ts` is one block a reviewer can check at a glance.
 */

const MILLIS_PER_DAY = 86_400_000;
/** The Gregorian mean year, which is what "3 years of retention" means to a person. */
const MILLIS_PER_YEAR = 365.2425 * MILLIS_PER_DAY;

export interface PrivacyDependencies {
  readonly scopedFor: (organizationId: string) => ScopedDb;
  /** Mail for the deletion confirmation. The same port sign-in mail goes through. */
  readonly mailer: AuthMailer;
  readonly slack: SlackTransport;
  /** Absolute origin for the links inside the channel notice. */
  readonly baseUrl: string;
  readonly newId: () => string;
  readonly logger: Pick<Console, 'info' | 'warn' | 'error'>;
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

const daysBefore = (now: Instant, days: number): Instant =>
  instantFromEpochMillis(toEpochMillis(now) - Math.round(days * MILLIS_PER_DAY));

const yearsBefore = (now: Instant, years: number): Instant =>
  instantFromEpochMillis(toEpochMillis(now) - Math.round(years * MILLIS_PER_YEAR));

export interface RetentionPurgeResult {
  readonly rawEventsDeleted: number;
  readonly reportsDeleted: number;
  readonly rawCutoff: Instant;
  readonly derivedCutoff: Instant | null;
  readonly detail: string;
}

/**
 * The purge. Reads the org's own window, deletes what has passed it, records what it did.
 *
 * ## Every run writes a row, including the ones that delete nothing
 *
 * That is not tidiness. The retention page's "last purge" line is the only evidence an
 * owner has that this job is alive, and a page reading "never" because the window has not
 * been crossed yet is indistinguishable from one whose scheduler died in March. A row
 * saying "nothing was old enough" is a different and much more useful sentence.
 *
 * ## A failure keeps its row too
 *
 * If the delete throws — a lock, a connection drop — the run is recorded as `failed` with
 * the driver's own sentence and then rethrown so pg-boss retries with backoff. A purge
 * that failed silently and left the page showing the *previous* successful run would be
 * the worst available outcome: an owner reading a green line over data that was never
 * deleted.
 */
export async function runRetentionPurge(
  dependencies: PrivacyDependencies,
  organizationId: string,
  now: Instant,
): Promise<RetentionPurgeResult> {
  const scoped = dependencies.scopedFor(organizationId);
  const settings = await readPrivacySettings(scoped);

  const rawDays = settings?.rawEventRetentionDays ?? PRIVACY_DEFAULTS.rawEventRetentionDays;
  // `undefined` means no row at all, which falls back to the documented default. `null` is
  // a *stored* choice — indefinite — and must not be confused with the absence of one.
  const derivedYears =
    settings === null ? PRIVACY_DEFAULTS.derivedRetentionYears : settings.derivedRetentionYears;

  const rawCutoff = daysBefore(now, rawDays);
  const derivedCutoff = derivedYears === null ? null : yearsBefore(now, derivedYears);
  const runId = dependencies.newId();

  try {
    const rawEventsDeleted = await purgeRawEventsBefore(scoped, rawCutoff);
    const reportsDeleted = derivedCutoff === null ? 0 : await purgeReportsBefore(scoped, derivedCutoff);

    const detail = describePurge({ rawDays, rawEventsDeleted, derivedYears, reportsDeleted });

    await recordPurgeRun(scoped, {
      id: runId,
      startedAt: now,
      completedAt: now,
      rawCutoff,
      derivedCutoff,
      rawEventsDeleted,
      reportsDeleted,
      outcome: 'complete',
      detail,
    });

    dependencies.logger.info(`[compass] retention purge for ${organizationId}: ${detail}`);
    return { rawEventsDeleted, reportsDeleted, rawCutoff, derivedCutoff, detail };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await recordPurgeRun(scoped, {
      id: runId,
      startedAt: now,
      completedAt: null,
      rawCutoff,
      derivedCutoff,
      rawEventsDeleted: 0,
      reportsDeleted: 0,
      outcome: 'failed',
      detail: `The purge did not complete: ${reason}. Nothing was deleted and it will be retried.`,
    });
    throw error;
  }
}

function describePurge(input: {
  readonly rawDays: number;
  readonly rawEventsDeleted: number;
  readonly derivedYears: number | null;
  readonly reportsDeleted: number;
}): string {
  const raw =
    input.rawEventsDeleted === 0
      ? `No chat message was older than ${input.rawDays} days.`
      : `Deleted ${input.rawEventsDeleted} chat message${input.rawEventsDeleted === 1 ? '' : 's'} older than ${input.rawDays} days.`;

  const derived =
    input.derivedYears === null
      ? 'Reports and derived data are kept indefinitely, so none were touched.'
      : input.reportsDeleted === 0
        ? `No report was older than ${input.derivedYears} year${input.derivedYears === 1 ? '' : 's'}.`
        : `Deleted ${input.reportsDeleted} report${input.reportsDeleted === 1 ? '' : 's'} older than ${input.derivedYears} year${input.derivedYears === 1 ? '' : 's'}.`;

  return `${raw} ${derived}`;
}

/**
 * When the next purge will run, given the cron and the last one.
 *
 * Derived rather than stored, because the schedule is a property of the deployment's cron
 * and not of the organization: storing it would mean a changed cron left every tenant's
 * page claiming the old time. The retention page prints this beside the last outcome.
 */
export function nextPurgeAfter(last: StoredPurgeRun | null, now: Instant): Instant {
  const anchor = last === null ? now : last.startedAt;
  const next = toEpochMillis(anchor) + PURGE_INTERVAL_MILLIS;
  // A run that is already overdue — the worker was down — reports the next tick rather
  // than a time in the past, which would read as a stuck job rather than a late one.
  return instantFromEpochMillis(Math.max(next, toEpochMillis(now)));
}

/** Daily. The window is measured in days at its shortest, so an hourly purge would be noise. */
export const PURGE_INTERVAL_MILLIS = MILLIS_PER_DAY;
export const PURGE_CRON = '17 3 * * *';

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

/**
 * What Compass keeps after an organization erasure, stated to the person who asked.
 *
 * Named here rather than buried, because a confirmation email that listed only deletions
 * would be a true list and a misleading message. Neither entry carries a name: a purge row
 * is counts and cutoffs, and an anonymization row is a developer key and a pseudonym.
 */
export const ORGANIZATION_ERASURE_RETAINED: readonly string[] = Object.freeze([
  'the record that this deletion happened, with its dates and this list',
  'the counts and timestamps of past retention purges, which carry no names',
  'the record of any anonymization, which carries a person key and a pseudonym but no name',
]);

export interface DeletionSweepResult {
  readonly purged: number;
  readonly failed: number;
  readonly details: readonly string[];
}

/**
 * Completes every deletion whose grace period has ended.
 *
 * `grace_ends_at <= now`, not `hard_delete_by <= now`. The seven days are the person's
 * window to change their mind; the thirty are Compass's deadline to have *finished*.
 * Waiting for the second would honour the outer bound by missing the point of the inner
 * one, and would leave a person who asked to be deleted on the 1st still in the database
 * on the 29th with no explanation.
 *
 * One request failing does not stop the others: the sweep records the failure on that row
 * and carries on, because a tenant whose erasure hit a lock must not block an unrelated
 * person's.
 */
export async function runDeletionSweep(
  dependencies: PrivacyDependencies,
  organizationId: string,
  now: Instant,
): Promise<DeletionSweepResult> {
  const scoped = dependencies.scopedFor(organizationId);
  const due = await listDeletionRequestsDue(scoped, now);

  let purged = 0;
  let failed = 0;
  const details: string[] = [];

  for (const request of due) {
    try {
      details.push(await completeDeletion(dependencies, scoped, request, now));
      purged += 1;
    } catch (error) {
      failed += 1;
      const reason = error instanceof Error ? error.message : String(error);
      await markDeletionPurged(scoped, {
        id: request.id,
        at: now,
        categories: [],
        confirmationSentAt: null,
        detail: `The deletion did not complete: ${reason}. It will be retried, and the deadline is unchanged.`,
        outcome: 'failed',
      });
      dependencies.logger.error(`[compass] deletion ${request.id} failed: ${reason}`);
    }
  }

  return { purged, failed, details };
}

async function completeDeletion(
  dependencies: PrivacyDependencies,
  scoped: ScopedDb,
  request: StoredDeletionRequest,
  now: Instant,
): Promise<string> {
  // Read before the erasure, because an organization erasure renames the row to a
  // tombstone and the email is supposed to name the organization the reader knew.
  const organization = await findOrganization(scoped);
  const organizationName = organization?.name ?? 'your organization';
  const subjectKind = request.subjectKind === 'organization' ? 'organization' : 'account';

  const categories =
    subjectKind === 'organization'
      ? await eraseOrganizationData(scoped, {
          at: now,
          tombstoneName: `Deleted organization (erased ${formatCivilDate(now, 'UTC')})`,
        })
      : await eraseAccountData(scoped, { userId: request.subjectId });

  const mail = composeDeletionConfirmationMail({
    to: request.notifyEmail,
    organizationName,
    subjectKind,
    categories,
    completedOn: formatCivilDate(now, 'UTC'),
    retained: subjectKind === 'organization' ? ORGANIZATION_ERASURE_RETAINED : [],
  });

  /**
   * The mail is sent *after* the erasure and its failure does not undo it.
   *
   * The order is the honest one. A person who asked to be deleted has been deleted; a mail
   * server that is down is Compass's problem, not a reason to keep their data another day.
   * So a send failure is logged and the row still records `purged` with the categories —
   * and `confirmation_sent_at` stays null, which is exactly the state an operator needs to
   * be able to see.
   */
  let confirmationSentAt: Instant | null = now;
  try {
    await dependencies.mailer.send(mail);
  } catch (error) {
    confirmationSentAt = null;
    dependencies.logger.warn(
      `[compass] deletion ${request.id} completed but its confirmation could not be sent: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const detail =
    `Deleted on ${formatCivilDate(now, 'UTC')}. ${categories.length} categor${categories.length === 1 ? 'y' : 'ies'} ` +
    `removed; the confirmation ${confirmationSentAt === null ? 'could not be sent' : 'was sent'} to ${request.notifyEmail}.`;

  await markDeletionPurged(scoped, {
    id: request.id,
    at: now,
    categories,
    confirmationSentAt,
    detail,
    outcome: 'purged',
  });

  dependencies.logger.info(`[compass] deletion ${request.id} (${subjectKind}) completed`);
  return detail;
}

/** The categories a request will delete, for the page that offers the export. */
export const categoriesFor = (subjectKind: string): readonly string[] =>
  subjectKind === 'organization' ? ERASURE_CATEGORIES : ACCOUNT_ERASURE_CATEGORIES;

/** Hourly. The grace period is measured in days; an hour of lateness is not a breach. */
export const DELETION_CRON = '23 * * * *';

// ---------------------------------------------------------------------------
// The channel notice
// ---------------------------------------------------------------------------

export interface ChannelNoticeResult {
  readonly posted: number;
  readonly skipped: number;
  readonly details: readonly string[];
}

/**
 * Posts the "Compass reads this channel" notice in every channel that has not had one.
 *
 * ## Why this is a job and not part of the enable request
 *
 * The manager's click has to succeed or fail on its own terms. Slack being unreachable,
 * the bot not being in the channel yet, a revoked token — none of those mean the manager's
 * decision did not happen, and none of them should turn a settings change into an error
 * page. So enabling writes the row and this job carries the announcement, retrying every
 * tick until it lands.
 *
 * The consequence is stated rather than hidden: until the notice posts,
 * `notice_posted_at` is null and the settings page says so beside the channel name in
 * plain words. A team that has not been told is a fact a manager should be able to see.
 *
 * The job is also the reason ingestion and announcement cannot drift apart: it selects on
 * `enabled AND notice_posted_at IS NULL`, so a channel that is being read and has not been
 * announced is, by construction, on this list.
 */
export async function runChannelNotices(
  dependencies: PrivacyDependencies,
  organizationId: string,
  now: Instant,
): Promise<ChannelNoticeResult> {
  const scoped = dependencies.scopedFor(organizationId);
  const awaiting = await channelsAwaitingNotice(scoped);
  if (awaiting.length === 0) return { posted: 0, skipped: 0, details: [] };

  const settings = await readPrivacySettings(scoped);
  const retentionDays = settings?.rawEventRetentionDays ?? PRIVACY_DEFAULTS.rawEventRetentionDays;

  let posted = 0;
  let skipped = 0;
  const details: string[] = [];

  for (const channel of awaiting) {
    const outcome = await postNotice(dependencies, channel, retentionDays);

    if (outcome.status === 'sent') {
      posted += 1;
      await recordChannelNotice(scoped, {
        conversationKey: channel.conversationKey,
        postedAt: now,
        detail: `Announced in #${channel.conversationName} on ${formatCivilDate(now, 'UTC')}.`,
      });
    } else {
      skipped += 1;
      // `postedAt: null` keeps the channel on the work list, so the notice is retried on
      // the next tick rather than being lost with a stored excuse.
      await recordChannelNotice(scoped, {
        conversationKey: channel.conversationKey,
        postedAt: null,
        detail: outcome.detail,
      });
    }

    details.push(`#${channel.conversationName}: ${outcome.detail}`);
  }

  dependencies.logger.info(
    `[compass] channel notices for ${organizationId}: ${posted} posted, ${skipped} pending`,
  );

  return { posted, skipped, details };
}

async function postNotice(
  dependencies: PrivacyDependencies,
  channel: StoredSlackChannel,
  retentionDays: number,
): Promise<DeliveryOutcome> {
  const message = renderChannelNotice({
    conversationName: channel.conversationName,
    // The row stores the actor's user id, not their name. Resolving it to a display name
    // would mean a join here for a single word, and "An owner or manager" is both true and
    // the right level of specificity for a channel-wide notice.
    enabledByName: null,
    retentionDays,
    transparencyUrl: `${dependencies.baseUrl}/me`,
    settingsUrl: `${dependencies.baseUrl}/privacy`,
  });

  try {
    return await dependencies.slack.send({ target: channel.conversationKey }, [message]);
  } catch (error) {
    return {
      status: 'failed',
      providerMessageId: null,
      error: error instanceof Error ? error.message : String(error),
      detail:
        'Compass could not post the notice in this channel yet, so the team has not been told. ' +
        'Check that the bot has been invited to it. Compass will keep trying.',
    };
  }
}

/** Every ten minutes: a team should learn on the same coffee break, not the next day. */
export const CHANNEL_NOTICE_CRON = '*/10 * * * *';

/** Re-exported so the retention page and the job cannot disagree about the last run. */
export { latestPurgeRun };
