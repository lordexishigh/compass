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
 *
 * Both, or neither. The defaults exist for the deployment that configures *nothing*, not as
 * per-variable fallbacks: one of the two set is a misconfiguration, `ownerConfigurationProblem`
 * is the sentence for it, and `bootstrapOwner` refuses to provision on it. See that function
 * for why pairing a configured address with a published password is worse than either choice.
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

/**
 * The address these credentials are POSTed to, named once.
 *
 * Three places need to agree on this string and they are in three different packages: the seed
 * writes it into `.nous/demo_account.json` as `login_path`, the role matrix carries the route
 * rule for it, and the App Router serves it from `apps/web/app/login/route.ts`. A literal in
 * each would be three chances for a harness to POST at a 404 — and the symptom of that is
 * "Compass cannot authenticate", which is the worst possible thing to be wrong about by a typo.
 *
 * It lives here rather than in the web app because the *writer* of the file is the worker, and
 * `@compass/auth` is the one package both processes already depend on for exactly this kind of
 * shared fact.
 */
export const DEMO_ACCOUNT_LOGIN_PATH = '/login';

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

/**
 * Half-configured owner credentials, which are a misconfiguration and not a fallback.
 *
 * `resolveOwnerCredentials` fills each of the three values in independently, so setting
 * `COMPASS_OWNER_EMAIL` and forgetting `COMPASS_OWNER_PASSWORD` used to resolve to a real
 * organization's address protected by the *published* demonstration password — the worst
 * combination of the two, and a silent one. The deployment looked configured to whoever set
 * the variable, `/account` printed the demonstration email rather than the address that
 * actually had the seat, and the only signal was `seats: not_configured` on `/api/health`.
 *
 * Both set is a configured deployment. Neither set is the demonstration, which is a
 * supported state the whole zero-config path depends on. One of the two is neither, and this
 * is the sentence that says so, naming the variable that is missing.
 *
 * A predicate rather than a throw so it stays usable from `/account` and `/api/health`, which
 * must render a diagnosis rather than raise one. `bootstrapOwner` is where it becomes fatal.
 */
export function ownerConfigurationProblem(env: OwnerEnvironment = process.env): string | null {
  const set = (name: string): boolean => {
    const value = env[name];
    return value !== undefined && value.length > 0;
  };

  const hasEmail = set(OWNER_EMAIL_ENV_VAR);
  const hasPassword = set(OWNER_PASSWORD_ENV_VAR);

  if (hasEmail === hasPassword) return null;

  const missing = hasEmail ? OWNER_PASSWORD_ENV_VAR : OWNER_EMAIL_ENV_VAR;
  const present = hasEmail ? OWNER_EMAIL_ENV_VAR : OWNER_PASSWORD_ENV_VAR;

  return (
    `${present} is set but ${missing} is not, so Compass cannot tell whether this deployment wants its own ` +
    `owner seat or the published demonstration one. Set both to configure the owner, or neither to use the ` +
    `demonstration credentials. Compass will not pair a configured value with a published default: an owner ` +
    `seat at a real address protected by a password printed in this repository's README is worse than either ` +
    'choice made deliberately.'
  );
}

/**
 * A named error, so the boot script can tell this apart from a database that is not up yet.
 *
 * The two failures need opposite responses — one is retried, the other is fixed by an
 * operator — and a bare `Error` would make the entrypoint's retry loop wait out a
 * misconfiguration that no amount of waiting resolves.
 */
export class OwnerConfigurationError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'OwnerConfigurationError';
  }
}

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
  const env = input.env ?? process.env;

  // Before the first query, so a half-configured deployment fails on its configuration rather
  // than after provisioning a seat whose password it did not choose. Every other secret in
  // Compass fails closed on a partial configuration; this one used to fail open.
  const problem = ownerConfigurationProblem(env);
  if (problem !== null) throw new OwnerConfigurationError(problem);

  const credentials = resolveOwnerCredentials(env);
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
