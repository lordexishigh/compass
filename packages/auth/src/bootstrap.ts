import { randomBytes } from 'node:crypto';

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
 * The demonstration owner's address and display name.
 *
 * There is deliberately **no** `DEMO_OWNER_PASSWORD` beside these. There was, and it was a
 * working owner password compiled into a published package — `'compass-demo-owner'`, reachable
 * by any deployment that never set `COMPASS_OWNER_PASSWORD`. The comment above it called it a
 * documented demonstration default, which described the intent and not the consequence.
 * `compass/no-credential-literal` now fails the build on its return.
 *
 * An address and a display name are not credentials: knowing `owner@compass.demo` opens
 * nothing. The password is either configured or generated — see `generateOwnerPassword`.
 */
export const DEMO_OWNER_EMAIL = 'owner@compass.demo';
export const DEMO_OWNER_NAME = 'Demo Owner';

/**
 * Bytes of entropy in a generated first-run password.
 *
 * 18 bytes is 24 base64url characters, comfortably past the floor `assertUsablePassword`
 * holds a human to — a seed script that could set a password the product would refuse would
 * be a second, weaker rule.
 */
export const GENERATED_PASSWORD_BYTES = 18;

/**
 * A first-run owner password, when the deployment configured none.
 *
 * This is what replaces the literal, and why the replacement is a generator rather than a
 * throw at module load. The production-readiness requirement is that a deployment which can
 * authenticate must have *some* path to its first owner; the zero-config path — `docker compose
 * up` on a clean checkout, and the CI cold-start job that boots with no `.env` at all and
 * asserts a six-section report inside 60 seconds — has no operator standing by to invent one.
 * So a boot with nothing configured mints a password nobody has ever seen, and the caller is
 * responsible for telling somebody what it was: `describeBootstrapOwner` prints it and the
 * worker writes it to `.nous/demo_account.json` at mode 0600.
 *
 * `randomBytes` and not `Math.random`: this value protects an owner seat from the moment it is
 * created, whether or not the data behind it is a fixture on the day it is generated.
 */
export function generateOwnerPassword(): string {
  return randomBytes(GENERATED_PASSWORD_BYTES).toString('base64url');
}

/**
 * The configured owner password, or null when the deployment set none.
 *
 * Separate from `resolveOwnerCredentials` because `/api/health` and `/account` need to ask
 * *whether* one is configured without needing a value, and the value is no longer something
 * this module can produce on its own.
 */
export function configuredOwnerPassword(env: OwnerEnvironment = process.env): string | null {
  const password = env[OWNER_PASSWORD_ENV_VAR];
  return password !== undefined && password.length > 0 ? password : null;
}

/**
 * Thrown when a password is required and neither configured nor supplied.
 *
 * Named after the variable, so an operator reading a crashed boot log learns what to set
 * rather than that something was undefined. The same shape as `resolveMasterKey`'s refusal for
 * `COMPASS_KMS_MASTER_KEY`, which is the other secret in Compass with deliberately no default.
 */
export class MissingOwnerPasswordError extends Error {
  constructor() {
    super(
      `Missing required environment variable: ${OWNER_PASSWORD_ENV_VAR}. Compass will not fall back to a ` +
        'password compiled into its own source: one published in this repository would be no password at all. ' +
        'Set it, or call bootstrapOwner, which mints a random one for a first run and prints it.',
    );
    this.name = 'MissingOwnerPasswordError';
  }
}

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

/**
 * The owner credentials this deployment will use.
 *
 * `password` is the configured one when there is one, and otherwise `fallbackPassword` — which
 * the caller supplies because the caller is the only party that can also *record* a generated
 * value. With neither, this throws `MissingOwnerPasswordError` rather than inventing a
 * credential silently: a function that quietly returned a fresh random password on every call
 * would put a different one in the database, in the log line and in `.nous/demo_account.json`.
 */
export function resolveOwnerCredentials(
  env: OwnerEnvironment = process.env,
  fallbackPassword: string | null = null,
): OwnerCredentials {
  const email = env[OWNER_EMAIL_ENV_VAR];
  const displayName = env[OWNER_NAME_ENV_VAR];
  const configuredPassword = configuredOwnerPassword(env);

  const password = configuredPassword ?? fallbackPassword;
  if (password === null) throw new MissingOwnerPasswordError();

  const configured = email !== undefined && email.length > 0 && configuredPassword !== null;

  return {
    email: email !== undefined && email.length > 0 ? email : DEMO_OWNER_EMAIL,
    password,
    displayName: displayName !== undefined && displayName.length > 0 ? displayName : DEMO_OWNER_NAME,
    isDefault: !configured,
  };
}

/**
 * Whether this deployment is running on credentials it never configured.
 *
 * Reads the environment directly rather than through `resolveOwnerCredentials`, which now
 * throws when nothing is configured — and the callers of this predicate are `/api/health` and
 * `/account`, both of which must render a diagnosis rather than raise one.
 */
export const ownerCredentialsAreDefault = (env: OwnerEnvironment = process.env): boolean => {
  const email = env[OWNER_EMAIL_ENV_VAR];
  return !(email !== undefined && email.length > 0 && configuredOwnerPassword(env) !== null);
};

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
  /**
   * The password minted for this seat, on the one boot that created it with nothing configured.
   *
   * Null on every other boot — including a later boot of the same unconfigured deployment,
   * which mints nothing it can use. The caller is the only party that can record it, and it is
   * the only chance anybody has to learn it: what the database holds is an Argon2id digest.
   */
  readonly generatedPassword: string | null;
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

  /**
   * A generated password is minted only when none is configured, and it only *matters* on the
   * boot that creates the seat: `registerAccount` is keyed on the address and never overwrites
   * an existing password, so a second boot mints a value it then discards. That is why
   * `generatedPassword` on the result is null unless `created` is true — a caller writing it to
   * `.nous/demo_account.json` on every boot would replace a working credential with one the
   * database has never seen.
   */
  const generated = configuredOwnerPassword(env) === null ? generateOwnerPassword() : null;
  const credentials = resolveOwnerCredentials(env, generated);
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
    generatedPassword: registered.created ? generated : null,
  };
}

/**
 * One line an operator can read at boot to know how to sign in.
 *
 * When a password was minted this is the **only** place it is ever printed, and the only reason
 * a credential appears in a log line anywhere in Compass. It is deliberate rather than an
 * oversight of `no-secret-disclosure`: the alternative to printing a generated password once,
 * at the moment of generation, is a deployment nobody can sign in to. What the rule exists to
 * stop is a credential that was *already* stored being logged again on every request; this one
 * has no other copy — the database holds an Argon2id digest of it and nothing else.
 *
 * On a later boot of the same deployment `generatedPassword` is null and nothing is printed, so
 * the value does not recur in the log even though the seat still exists.
 */
export function describeBootstrapOwner(result: BootstrapOwnerResult): string {
  const scope = result.teamKeys.length === 0 ? 'every team' : result.teamKeys.join(', ');
  const line = `[compass] owner seat ${result.created ? 'created' : 'already present'}: ${result.user.email}, scoped to ${scope}.`;

  if (result.generatedPassword !== null) {
    return (
      `${line} No ${OWNER_PASSWORD_ENV_VAR} was set, so Compass generated one for this first run: ` +
      `${result.generatedPassword} — it is printed here once and never again, and it is written to ` +
      `.nous/demo_account.json. Set ${OWNER_EMAIL_ENV_VAR} and ${OWNER_PASSWORD_ENV_VAR} to choose your own.`
    );
  }

  if (result.usingDefaultCredentials) {
    return (
      `${line} This deployment configured no owner credentials, so the seat is on a password generated at ` +
      `first boot — see .nous/demo_account.json. Set ${OWNER_EMAIL_ENV_VAR} and ${OWNER_PASSWORD_ENV_VAR} ` +
      'before this deployment holds real data.'
    );
  }

  return line;
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
