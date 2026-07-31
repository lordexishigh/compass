import { instantFromIso, type Instant } from '@compass/clock';
import { createMigratedTestDatabase, type TestDatabase } from '@compass/db/testing';
import type { ScopedDb } from '@compass/db';

import { RecordingMailer } from '@compass/auth';

/**
 * A migrated PostgreSQL 17 with one organization in it, for the auth suites.
 *
 * Real engine, real migrations, real constraints — the same rule the rest of the repo
 * follows. A mocked query builder would happily accept an UPDATE on the audit log,
 * which is one of the things these tests exist to catch.
 */

export const ORG_A = '11111111-1111-4111-8111-1111111111a1';
export const ORG_B = '22222222-2222-4222-8222-2222222222b2';

export const at = (iso: string): Instant => instantFromIso(iso);

/** The instant every fixture starts from, so nothing here reads a clock. */
export const T0 = at('2026-07-31T09:00:00Z');

export interface AuthHarness {
  readonly database: TestDatabase;
  readonly scoped: ScopedDb;
  readonly other: ScopedDb;
  readonly mailer: RecordingMailer;
  close(): Promise<void>;
}

export async function createAuthHarness(): Promise<AuthHarness> {
  const database = await createMigratedTestDatabase({
    organizationId: ORG_A,
    name: 'Acme Platform',
    slug: 'acme-platform',
    timezone: 'Europe/London',
    at: new Date(T0),
  });

  // A second tenant in the same database, so every cross-tenant assertion is a real
  // query against real rows rather than a claim about the predicate.
  await database.seedOrganization({
    organizationId: ORG_B,
    name: 'Beta Robotics',
    slug: 'beta-robotics',
    timezone: 'Europe/London',
    at: new Date(T0),
  });

  return {
    database,
    scoped: database.scopedFor(ORG_A),
    other: database.scopedFor(ORG_B),
    mailer: new RecordingMailer(),
    close: () => database.close(),
  };
}

/** The mail arguments every link flow needs, in one place. */
export const mailContext = (mailer: RecordingMailer) =>
  ({
    mailer,
    organizationName: 'Acme Platform',
    baseUrl: 'https://compass.test',
  }) as const;

/** Pulls the `token` query parameter out of a mailed link. */
export function tokenFromLink(link: string): string {
  const value = new URL(link).searchParams.get('token');
  if (value === null) throw new Error(`No token in ${link}`);
  return value;
}
