import { RecordingMailer } from '@compass/auth';
import { addExactDays, instantFromIso, toEpochMillis, type Instant } from '@compass/clock';
import { ScopedDb, confirmNoticeSubscriber, orgScope, subscribeToSubprocessorNotices } from '@compass/db';
import { createMigratedTestDatabase, type TestDatabase } from '@compass/db/testing';
import { SUBPROCESSORS, SUBPROCESSOR_NOTICE_DAYS, subprocessorDigest } from '@compass/trust';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SUBPROCESSOR_NOTICE_CRON, handleSubprocessorNotice } from '../src/trust-notices.js';

/**
 * The 30-day subprocessor change notice, against a real database.
 *
 * The acceptance criterion is that "changes to the subprocessor list trigger a 30-day advance notice to
 * subscribers; documented and covered by a test on the notice job". This is that test, and the properties
 * it pins are the ones that would make the commitment worthless if they broke:
 *
 *  - a change is detected from the *content* of the published list, not from somebody remembering;
 *  - the notice states an effective date at least 30 days out, computed from the injected clock;
 *  - an unconfirmed address is never mailed, because the endpoint is public;
 *  - nobody is told twice about the same change;
 *  - a transport failure leaves the subscriber un-notified so the next run retries.
 *
 * `RecordingMailer` is the auth package's own fake, so the production code path runs with the network
 * removed. `now` is a parameter throughout, which is what lets the thirty days be asserted by choosing an
 * instant rather than by waiting a month.
 */

const ORGANIZATION_ID = '6f6f6f6f-6f6f-4f6f-8f6f-6f6f6f6f6f6f';
const T0: Instant = instantFromIso('2026-08-05T04:41:00Z');

let database: TestDatabase;
const scoped = () => new ScopedDb(database.db, orgScope(ORGANIZATION_ID));

/** The digest as it stood *before* a subprocessor was added — one entry short of the published list. */
const previousDigest = (): string => subprocessorDigest(SUBPROCESSORS.slice(1));

const dependencies = (mailer: RecordingMailer) => ({
  scopedFor: (_organizationId: string): ScopedDb => scoped(),
  mailer,
  baseUrl: 'https://compass.example.com',
  logger: { info: () => {}, warn: () => {}, error: () => {} },
});

beforeAll(async () => {
  database = await createMigratedTestDatabase({
    organizationId: ORGANIZATION_ID,
    name: 'Northwind Systems',
    slug: 'northwind-trust',
    timezone: 'Europe/London',
    at: new Date(T0),
  });
}, 180_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await scoped()
    .deleteFrom((await import('@compass/db')).subprocessorNoticeSubscribers)
    .execute();
});

/** Subscribes an address and, unless told otherwise, confirms it. */
async function subscribe(input: {
  readonly email: string;
  readonly digest: string;
  readonly confirm?: boolean;
}): Promise<void> {
  const tokenHash = `hash-${input.email}`;
  await subscribeToSubprocessorNotices(
    scoped(),
    { email: input.email, unsubscribeTokenHash: tokenHash, currentDigest: input.digest },
    T0,
  );
  if (input.confirm !== false) await confirmNoticeSubscriber(scoped(), tokenHash, T0);
}

describe('a change to the published list notifies the people who asked', () => {
  it('mails a confirmed subscriber whose digest is behind, and says what changed', async () => {
    await subscribe({ email: 'dpo@customer.example', digest: previousDigest() });
    const mailer = new RecordingMailer();

    const outcome = await handleSubprocessorNotice(dependencies(mailer), {
      organizationId: ORGANIZATION_ID,
      now: T0,
    });

    expect(outcome.notified).toEqual(['dpo@customer.example']);
    expect(mailer.sent).toHaveLength(1);

    const message = mailer.sent[0];
    expect(message?.purpose).toBe('subprocessor_change_notice');
    // The change is *described*, not merely announced: a notice that says "something changed, go and diff
    // a web page" has not given anybody thirty days of anything useful.
    expect(message?.body).toContain('Added:');
    expect(message?.body).toContain(SUBPROCESSORS[0]?.name ?? '');
    // And the unsubscribe is in every notice.
    expect(message?.body).toContain('/api/trust/subprocessor-notices/confirm');
  });

  it('states an effective date at least the committed number of days out', async () => {
    await subscribe({ email: 'dpo@customer.example', digest: previousDigest() });
    const mailer = new RecordingMailer();

    const outcome = await handleSubprocessorNotice(dependencies(mailer), {
      organizationId: ORGANIZATION_ID,
      now: T0,
    });

    /**
     * The thirty days, asserted rather than trusted.
     *
     * Computed from the injected clock, so the advance notice is structural: the date in the email is
     * derived from when the email is sent and cannot be closer than the commitment.
     */
    const expected = addExactDays(T0, SUBPROCESSOR_NOTICE_DAYS);
    expect(outcome.effectiveAtIso).toBe(new Date(toEpochMillis(expected)).toISOString());
    expect(toEpochMillis(expected) - toEpochMillis(T0)).toBe(SUBPROCESSOR_NOTICE_DAYS * 86_400_000);
    expect(mailer.sent[0]?.body).toContain(`at least ${SUBPROCESSOR_NOTICE_DAYS} days`);
    // The date itself is in the subject, so it survives a mail client that collapses the body.
    expect(mailer.sent[0]?.subject).toContain('2026-09-04');
  });

  it('never mails an address that has not confirmed', async () => {
    /**
     * The endpoint is public, so anybody can type anybody's address into it. If an unconfirmed row were
     * mailed, the first thing that address would receive from Compass is a notice it never asked for —
     * indistinguishable, to the person receiving it, from Compass having leaked their address.
     */
    await subscribe({ email: 'never-asked@customer.example', digest: previousDigest(), confirm: false });
    const mailer = new RecordingMailer();

    const outcome = await handleSubprocessorNotice(dependencies(mailer), {
      organizationId: ORGANIZATION_ID,
      now: T0,
    });

    expect(outcome.considered).toBe(0);
    expect(mailer.sent).toEqual([]);
  });

  it('does not tell the same person twice about the same change', async () => {
    await subscribe({ email: 'dpo@customer.example', digest: previousDigest() });

    const first = new RecordingMailer();
    await handleSubprocessorNotice(dependencies(first), { organizationId: ORGANIZATION_ID, now: T0 });
    expect(first.sent).toHaveLength(1);

    // The job runs daily. Without the per-subscriber digest it would re-send every morning forever, and
    // the recipient would filter the address before the *next* real change arrived.
    const second = new RecordingMailer();
    const outcome = await handleSubprocessorNotice(dependencies(second), {
      organizationId: ORGANIZATION_ID,
      now: addExactDays(T0, 1),
    });

    expect(second.sent).toEqual([]);
    expect(outcome.considered).toBe(0);
  });

  it('sends nothing at all when the list has not changed', async () => {
    // Subscribed at the *current* digest, which is the state of everybody on an ordinary morning.
    await subscribe({ email: 'dpo@customer.example', digest: subprocessorDigest() });
    const mailer = new RecordingMailer();

    const outcome = await handleSubprocessorNotice(dependencies(mailer), {
      organizationId: ORGANIZATION_ID,
      now: T0,
    });

    expect(outcome.considered).toBe(0);
    expect(mailer.sent).toEqual([]);
  });

  it('leaves a subscriber un-notified when the transport fails, so the next run retries', async () => {
    await subscribe({ email: 'dpo@customer.example', digest: previousDigest() });

    const broken = {
      sent: [] as never[],
      send: () => Promise.reject(new Error('the mail transport is down')),
    };

    // Does not throw: one address that will not accept mail must not stop the others being told.
    const outcome = await handleSubprocessorNotice(
      { ...dependencies(new RecordingMailer()), mailer: broken as never },
      { organizationId: ORGANIZATION_ID, now: T0 },
    );
    expect(outcome.notified).toEqual([]);

    // And the digest was not advanced, so a working transport tomorrow still sends it.
    const retry = new RecordingMailer();
    await handleSubprocessorNotice(dependencies(retry), {
      organizationId: ORGANIZATION_ID,
      now: addExactDays(T0, 1),
    });
    expect(retry.sent).toHaveLength(1);
  });
});

describe('the schedule', () => {
  it('runs daily, off the hour', () => {
    // Daily because the obligation is measured in days; off the hour because everything in the world
    // fires at :00 and a job that starts 40 minutes late every night is one whose logs nobody trusts.
    expect(SUBPROCESSOR_NOTICE_CRON).toBe('41 4 * * *');
  });
});
