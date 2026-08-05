import { createHmac, timingSafeEqual } from 'node:crypto';

import { GITHUB_SCOPES, githubInstallUrl, type GithubScope } from '@compass/github-connector';
import { toEpochMillis, type Instant } from '@compass/clock';
import { findIntegrationToken, type ScopedDb } from '@compass/db';

/**
 * Everything the connect screen and the three connect routes read.
 *
 * ## The rule this module keeps
 *
 * **The scope list is never written twice.** `GITHUB_SCOPES` in `@compass/github-connector` is the one
 * declaration; the install URL is *built* from it and the connect screen *renders* it. The acceptance
 * criterion is that "requested scopes are exactly the documented read-only set and are displayed
 * verbatim before consent", and two copies of that list is precisely the shape where the screen keeps
 * promising read-only after somebody adds a write permission to the request — a drift that is invisible
 * in review because both halves look right on their own.
 *
 * ## Why the provider is resolved here and nowhere below
 *
 * `tools/quality-gates/tests/provider-neutrality.test.ts` fails the build if `ingest`,
 * `knowledge-model`, `analysis` or `renderers` so much as names GitHub. So this module — in the web
 * app, above every layer that gate protects — is one of the only places allowed to know a provider
 * exists at all. It hands the connector its `HttpClient` rather than letting it reach for `fetch`,
 * which is what makes "no workspace-wide call was made" an assertion a test can check.
 */

export const CONNECT_STATE_SECRET_ENV_VAR = 'COMPASS_CONNECT_STATE_SECRET';
export const GITHUB_APP_SLUG_ENV_VAR = 'COMPASS_GITHUB_APP_SLUG';

/** The source key the GitHub connector answers as. One name, shared by the routes and the panel. */
export const GITHUB_SOURCE_KEY = 'primary-code';

/**
 * How long a signed `state` is good for.
 *
 * Ten minutes is the length of an OAuth consent screen a person is actually reading, and it is the
 * same reasoning the mailed-link lifetimes use: long enough for a human, short enough that a captured
 * URL in a browser history is not a standing key.
 */
export const CONNECT_STATE_TTL_MILLIS = 10 * 60 * 1000;

export type ConnectStateVerdict =
  | { readonly ok: true; readonly organizationId: string }
  | { readonly ok: false; readonly reason: 'unconfigured' | 'malformed' | 'bad_signature' | 'expired' };

const secretFrom = (environment: Readonly<Record<string, string | undefined>>): string | null => {
  const value = (environment[CONNECT_STATE_SECRET_ENV_VAR] ?? '').trim();
  return value.length === 0 ? null : value;
};

const sign = (secret: string, payload: string): string =>
  createHmac('sha256', secret).update(payload, 'utf8').digest('hex');

const digestsMatch = (left: string, right: string): boolean =>
  left.length === right.length && timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));

/**
 * The CSRF `state` a GitHub install round-trip carries.
 *
 * ## Why it is signed rather than stored
 *
 * A callback arrives with **no cookie** — it is a top-level navigation from github.com — so the
 * organization it belongs to cannot come from a session. It has to travel in the URL, and anything
 * that travels in a URL an attacker can also write. Signing it is what makes the value trustworthy:
 * `<organizationId>.<issuedAtMillis>.<hmac>`, compared in constant time, inside a ten-minute window.
 *
 * A database row would work too and would be marginally stronger (single-use). It is not used here
 * because it needs a table and a migration for a value that is already unforgeable, and because the
 * repository has an established idiom for exactly this: `COMPASS_FEEDBACK_LINK_SECRET` signs the
 * one-click feedback links, is optional, and its absence disables the feature rather than defaulting
 * to a known key. This follows that pattern to the letter — **there is no fallback secret**, because
 * an HMAC under a key that ships in the repository is not a signature.
 */
export function issueConnectState(input: {
  readonly organizationId: string;
  readonly now: Instant;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): string | null {
  const secret = secretFrom(input.environment ?? process.env);
  if (secret === null) return null;

  const payload = `${input.organizationId}.${toEpochMillis(input.now)}`;
  return `${payload}.${sign(secret, payload)}`;
}

export function verifyConnectState(input: {
  readonly state: string | null;
  readonly now: Instant;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): ConnectStateVerdict {
  const secret = secretFrom(input.environment ?? process.env);
  // Fails closed. A callback accepted without a verifiable state is a callback anybody can forge into
  // storing a credential against somebody else's organization.
  if (secret === null) return { ok: false, reason: 'unconfigured' };
  if (input.state === null || input.state.length === 0) return { ok: false, reason: 'malformed' };

  const parts = input.state.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };

  const [organizationId, issuedAtRaw, signature] = parts as [string, string, string];
  const issuedAt = Number.parseInt(issuedAtRaw, 10);
  if (organizationId.length === 0 || !Number.isFinite(issuedAt)) return { ok: false, reason: 'malformed' };

  if (!digestsMatch(signature, sign(secret, `${organizationId}.${issuedAtRaw}`))) {
    return { ok: false, reason: 'bad_signature' };
  }

  // Checked *after* the signature, so an expired-but-valid state and a forged one are distinguishable
  // to us and identical to the caller.
  const age = toEpochMillis(input.now) - issuedAt;
  if (age < 0 || age > CONNECT_STATE_TTL_MILLIS) return { ok: false, reason: 'expired' };

  return { ok: true, organizationId };
}

/** What the connect screen shows about one provider. */
export interface ConnectProviderView {
  readonly providerId: 'github';
  readonly name: string;
  /** The scope list, verbatim from the connector package. Never literals in JSX. */
  readonly scopes: readonly GithubScope[];
  readonly sourceKey: string;
  /** True once a credential is stored for this organization. */
  readonly connected: boolean;
  /** Null when never connected. */
  readonly connectedAtIso: string | null;
  /**
   * Why this provider cannot be connected right now, or null.
   *
   * Configuration, not a fault: a deployment with no GitHub App slug and no state secret cannot start
   * an install, and the screen says which variable is missing rather than offering a button that 503s.
   */
  readonly unavailableReason: string | null;
}

export interface ConnectView {
  readonly providers: readonly ConnectProviderView[];
}

const missingConfigSentence = (missing: readonly string[]): string | null =>
  missing.length === 0
    ? null
    : `Connecting GitHub needs ${missing.join(' and ')} set on this deployment. Compass will not offer a ` +
      'button that cannot work: everything else — the report, delivery, the seeded demonstration data — ' +
      'is unaffected.';

/**
 * The connect screen's whole view.
 *
 * Reads the stored credential's *description* — never its value; `findIntegrationToken` returns the
 * sealed row and this only ever looks at whether one exists and when it was written.
 */
export async function buildConnectView(input: {
  readonly scoped: ScopedDb;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): Promise<ConnectView> {
  const environment = input.environment ?? process.env;

  const missing: string[] = [];
  if ((environment[GITHUB_APP_SLUG_ENV_VAR] ?? '').trim().length === 0) missing.push(GITHUB_APP_SLUG_ENV_VAR);
  if (secretFrom(environment) === null) missing.push(CONNECT_STATE_SECRET_ENV_VAR);

  const stored = await findIntegrationToken(input.scoped, GITHUB_SOURCE_KEY, 'access');

  return {
    providers: [
      {
        providerId: 'github',
        name: 'GitHub',
        // The one declaration, rendered as-is. See the module header.
        scopes: GITHUB_SCOPES,
        sourceKey: GITHUB_SOURCE_KEY,
        connected: stored !== null,
        connectedAtIso: stored === null ? null : stored.updatedAt.toISOString(),
        unavailableReason: missingConfigSentence(missing),
      },
    ],
  };
}

/** The install URL for this organization, or null when the deployment cannot start one. */
export function githubInstallUrlFor(input: {
  readonly organizationId: string;
  readonly now: Instant;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): string | null {
  const environment = input.environment ?? process.env;
  const appSlug = (environment[GITHUB_APP_SLUG_ENV_VAR] ?? '').trim();
  if (appSlug.length === 0) return null;

  const state = issueConnectState({ organizationId: input.organizationId, now: input.now, environment });
  if (state === null) return null;

  // Built from `GITHUB_SCOPES` by `githubInstallUrl`, so the URL and the screen cannot disagree.
  return githubInstallUrl({ appSlug, state });
}
