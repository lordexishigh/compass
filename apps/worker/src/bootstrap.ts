import { pathToFileURL } from 'node:url';

import { bootstrapOwner, describeBootstrapOwner, type BootstrapOwnerResult } from '@compass/auth';
import { instantFromIso, type Instant } from '@compass/clock';
import {
  KnowledgeStore,
  provisionRoster,
  type OrgRoster,
  type RosterDeveloper,
  type RosterObjective,
  type RosterTeam,
} from '@compass/knowledge-model';
import {
  ScopedDb,
  createDatabase,
  ensureOrganization,
  orgScope,
  resolveDatabaseUrl,
  runMigrations,
} from '@compass/db';
import { loadSeedFixtures, seedBundle, slugify, type SeedFixtures } from '@compass/seed-connector';

/**
 * Cold start.
 *
 * `docker compose up` on a clean checkout has to end with a manager reading a
 * report, which means three things have to happen before the first request and
 * none of them can be a manual step: the schema has to exist, the tenant row has
 * to exist, and the roster has to be declared.
 *
 * Only the roster deserves an explanation. Company, Team and Developer are
 * *configuration*, not observations — no connector reports them, and inferring a
 * team from who commits together would put someone else's merge in this team's
 * Yesterday. The seeded organization declares its roster in `seed/fixtures`, so
 * this reads the same declaration a real deployment would read from its settings
 * and writes it through the ordinary provisioning path.
 *
 * Every step is idempotent, so this runs on every boot rather than once: drizzle
 * records applied migrations, `ensureOrganization` finds the row it would have
 * created, and re-applying an unchanged roster produces no new entity versions.
 */

/** The zone a seeded team works in. Overridable, never read from the host. */
export const SEED_TIMEZONE = process.env['COMPASS_DEFAULT_TIMEZONE'] ?? 'Europe/London';

export interface BootstrapResult {
  readonly organizationId: string;
  readonly organizationCreated: boolean;
  readonly teamKeys: readonly string[];
  readonly developerCount: number;
  readonly rosterCreated: number;
  readonly rosterChanged: number;
  /** The first owner. Without this the deployment could authenticate and nobody could sign in. */
  readonly owner: BootstrapOwnerResult;
}

/**
 * The roster the seed fixtures declare, in the knowledge model's own vocabulary.
 *
 * Exported so a test can assert the translation without a database: this is the
 * one place a fixture shape becomes a Compass shape, and a silently dropped
 * `projectKey` here would make every report honestly, invisibly empty.
 */
export function rosterFromFixtures(
  fixtures: SeedFixtures,
  timezone: string,
  declaredAt: Instant,
): OrgRoster {
  const objectives: readonly RosterObjective[] = fixtures.organization.objectives.map((objective) => ({
    key: objective.key,
    kind: objective.kind,
    parentKey: objective.parentKey,
    title: objective.title,
    effectiveFrom: instantFromIso(objective.effectiveFrom),
    effectiveUntil: instantFromIso(objective.effectiveUntil),
    isCurrent: objective.current,
  }));

  const teams: readonly RosterTeam[] = fixtures.organization.teams.map((team) => ({
    key: team.key,
    name: team.name,
    methodology: team.methodology,
    projectKey: team.projectKey,
    objectiveKey: team.objectiveKey,
    conversationKey: team.conversationKey,
    timezone,
  }));

  const developers: readonly RosterDeveloper[] = fixtures.people.developers.map((developer) => ({
    key: developer.key,
    displayName: developer.displayName,
    teamKey: developer.teamKey,
    active: true,
    gitEmails: [...developer.gitEmails],
    trackerAccounts: [developer.trackerAccount],
    chatHandles: [developer.chatHandle],
  }));

  return {
    company: {
      key: slugify(fixtures.organization.companyName),
      name: fixtures.organization.companyName,
      timezone,
    },
    objectives,
    teams,
    developers,
    // The dataset's own start, not the boot instant: a roster declared at a
    // moving instant would rewrite its own rows on every container restart.
    absences: [],
    declaredAt,
  };
}

export async function bootstrap(): Promise<BootstrapResult> {
  await runMigrations(resolveDatabaseUrl('direct'));

  const bundle = seedBundle();
  const fixtures = loadSeedFixtures();
  const handle = createDatabase(resolveDatabaseUrl('direct'));

  try {
    const organization = await ensureOrganization(handle.db, {
      id: bundle.organizationId,
      name: fixtures.organization.companyName,
      slug: slugify(fixtures.organization.companyName),
      timezone: SEED_TIMEZONE,
      at: new Date(bundle.window.start),
    });

    const scoped = new ScopedDb(handle.db, orgScope(bundle.organizationId));
    const store = new KnowledgeStore(scoped);
    const roster = rosterFromFixtures(fixtures, SEED_TIMEZONE, bundle.window.start);
    const provisioned = await provisionRoster(store, roster);

    // The first owner, without which the product could authenticate and nobody could
    // sign in. Idempotent, so this runs on every boot beside the roster rather than
    // being a one-off command an operator has to know about.
    const owner = await bootstrapOwner({
      scoped,
      now: bundle.window.start,
      teamKeys: roster.teams.map((team) => team.key),
    });

    return {
      organizationId: bundle.organizationId,
      organizationCreated: organization.created,
      teamKeys: roster.teams.map((team) => team.key),
      developerCount: roster.developers.length,
      rosterCreated: provisioned.created,
      rosterChanged: provisioned.changed,
      owner,
    };
  } finally {
    await handle.close();
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && pathToFileURL(entryPoint).href === import.meta.url) {
  bootstrap()
    .then((result) => {
      console.info(
        `[compass] bootstrap complete: organization ${result.organizationId} ` +
          `(${result.organizationCreated ? 'created' : 'already present'}), ` +
          `teams ${result.teamKeys.join(', ')}, ${result.developerCount} developers, ` +
          `${result.rosterCreated} roster rows created and ${result.rosterChanged} changed.`,
      );
      // Printed separately, and always: it is how an operator knows which address to
      // sign in with, and whether the password is still the published one.
      console.info(describeBootstrapOwner(result.owner));
    })
    .catch((error: unknown) => {
      console.error(`[compass] bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
