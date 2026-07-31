import type { Instant } from '@compass/clock';
import { listSeats, replaceTeamScopes, type MembershipRow, type ScopedDb, type UserRow } from '@compass/db';

import { hasOwner, registerAccount } from './accounts.js';
import { recordAudit } from './audit.js';

/**
 * The first owner.
 *
 * Seats are invite-only: every route that creates one requires an owner, and the
 * owner role can only be granted by an owner. So an organization with no owner has no
 * path to its first one, and a deployment that could authenticate would be a
 * deployment nobody could sign in to. This is that path, and it is deliberately the
 * only one.
 *
 * It runs from the boot script — `pnpm run seed`, and `tools/docker/entrypoint.sh` —
 * so `docker compose up` on a clean checkout produces a working owner account with no
 * manual step. It is idempotent: the user id is derived from the address, so a second
 * boot finds the seat it created rather than making another.
 *
 * ## The credentials
 *
 * `COMPASS_OWNER_EMAIL` and `COMPASS_OWNER_PASSWORD` name them. Both have documented
 * demonstration defaults, because the alternative for the zero-config demo is an
 * operator reading a log for a generated password before they can do anything — and
 * this deployment's data is a fixture. The defaults are printed at boot and shown on
 * `/account`, and `ownerCredentialsAreDefault` is what the readiness endpoint reads to
 * say, out loud, that a real deployment must change them.
 */

export const OWNER_EMAIL_ENV_VAR = 'COMPASS_OWNER_EMAIL';
export const OWNER_PASSWORD_ENV_VAR = 'COMPASS_OWNER_PASSWORD';
export const OWNER_NAME_ENV_VAR = 'COMPASS_OWNER_NAME';

/**
 * The demonstration owner.
 *
 * Twelve characters or more, because `assertUsablePassword` holds the bootstrap to the
 * same floor as a human — a seed script that could set a password the product would
 * refuse would be a second, weaker rule.
 */
export const DEMO_OWNER_EMAIL = 'owner@compass.demo';
export const DEMO_OWNER_PASSWORD = 'compass-demo-owner';
export const DEMO_OWNER_NAME = 'Demo Owner';

export interface OwnerCredentials {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
  /** True when nothing was configured and the published demonstration values are in use. */
  readonly isDefault: boolean;
}

/**
 * The three keys this reads, and nothing more.
 *
 * Narrower than `NodeJS.ProcessEnv` on purpose. That type is augmented by whatever is in
 * scope — Next.js declares `NODE_ENV` as *required* on it — so a caller wanting to ask
 * "what would this resolve to with nothing set" could not pass `{}`, which is precisely
 * the question a test needs to ask. A function that reads three optional strings should
 * demand three optional strings.
 */
export type OwnerEnvironment = Readonly<Record<string, string | undefined>>;

export function resolveOwnerCredentials(env: OwnerEnvironment = process.env): OwnerCredentials {
  const email = env[OWNER_EMAIL_ENV_VAR];
  const password = env[OWNER_PASSWORD_ENV_VAR];
  const displayName = env[OWNER_NAME_ENV_VAR];

  const configured =
    email !== undefined && email.length > 0 && password !== undefined && password.length > 0;

  return {
    email: email !== undefined && email.length > 0 ? email : DEMO_OWNER_EMAIL,
    password: password !== undefined && password.length > 0 ? password : DEMO_OWNER_PASSWORD,
    displayName: displayName !== undefined && displayName.length > 0 ? displayName : DEMO_OWNER_NAME,
    isDefault: !configured,
  };
}

export const ownerCredentialsAreDefault = (env: OwnerEnvironment = process.env): boolean =>
  resolveOwnerCredentials(env).isDefault;

export interface BootstrapOwnerResult {
  readonly user: UserRow;
  readonly membership: MembershipRow;
  /** False on every boot after the first. */
  readonly created: boolean;
  readonly teamKeys: readonly string[];
  readonly usingDefaultCredentials: boolean;
}

/**
 * Ensures the organization has an owner, and returns the one it has.
 *
 * `teamKeys` is written even though owners are unscoped, for one reason: the seats
 * screen shows the scopes, and an owner row with none reads as a mistake to the next
 * person who looks at it. Recording the teams the deployment actually serves makes
 * the list say something true.
 *
 * If an owner already exists, nothing is created and nothing is overwritten — in
 * particular, a password an operator has changed is never reset back to the
 * environment's value on the next restart.
 */
export async function bootstrapOwner(input: {
  readonly scoped: ScopedDb;
  readonly now: Instant;
  readonly teamKeys?: readonly string[];
  readonly env?: OwnerEnvironment;
}): Promise<BootstrapOwnerResult> {
  const credentials = resolveOwnerCredentials(input.env ?? process.env);
  const alreadyOwned = await hasOwner(input.scoped);

  const registered = await registerAccount({
    scoped: input.scoped,
    email: credentials.email,
    displayName: credentials.displayName,
    password: credentials.password,
    role: 'owner',
    status: 'active',
    now: input.now,
  });

  const teamKeys = await replaceTeamScopes(
    input.scoped,
    registered.membership.id,
    input.teamKeys ?? [],
    input.now,
  );

  if (registered.created && !alreadyOwned) {
    await recordAudit(input.scoped, {
      action: 'seat.invited',
      // The system, not a person: nobody was signed in when the container booted.
      actorUserId: null,
      targetKind: 'membership',
      targetId: registered.membership.id,
      before: null,
      after: {
        email: registered.user.email,
        role: 'owner',
        status: 'active',
        teamKeys,
        via: 'bootstrap',
        usingDefaultCredentials: credentials.isDefault,
      },
      occurredAt: input.now,
    });
  }

  return {
    user: registered.user,
    membership: registered.membership,
    created: registered.created,
    teamKeys,
    usingDefaultCredentials: credentials.isDefault,
  };
}

/** One line an operator can read at boot to know how to sign in. */
export function describeBootstrapOwner(result: BootstrapOwnerResult): string {
  const state = result.created ? 'created' : 'already present';
  const warning = result.usingDefaultCredentials
    ? ` Using the published demonstration password — set ${OWNER_EMAIL_ENV_VAR} and ${OWNER_PASSWORD_ENV_VAR} before this deployment holds real data.`
    : '';
  return `[compass] owner seat ${state}: ${result.user.email}, scoped to ${result.teamKeys.length === 0 ? 'every team' : result.teamKeys.join(', ')}.${warning}`;
}

/** Whether anyone can sign in at all — what `/api/health` reports. */
export async function seatReadiness(scoped: ScopedDb): Promise<{
  readonly owners: number;
  readonly activeSeats: number;
  readonly pendingInvitations: number;
}> {
  const seats = await listSeats(scoped);
  return {
    owners: seats.filter((seat) => seat.role === 'owner' && seat.status === 'active').length,
    activeSeats: seats.filter((seat) => seat.status === 'active').length,
    pendingInvitations: seats.filter((seat) => seat.status === 'pending').length,
  };
}
