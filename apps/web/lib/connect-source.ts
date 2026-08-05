import { createHmac, timingSafeEqual } from 'node:crypto';

import { GITHUB_SCOPES, githubInstallUrl, type GithubScope } from '@compass/github-connector';
import {
  JIRA_OFFLINE_SCOPE,
  JIRA_SCOPES,
  jiraAuthorizeUrl,
  type JiraScope,
} from '@compass/jira-connector';
import { SLACK_SCOPES, slackInstallUrl, type SlackScope } from '@compass/slack-connector';
import { toEpochMillis, type Instant } from '@compass/clock';
import {
  findIntegrationToken,
  listSourceConfigs,
  type ScopedDb,
  type SourceSelection,
  type StoredSourceConfig,
} from '@compass/db';

/**
 * Everything the connect screen and the connect routes read.
 *
 * ## The rule this module keeps
 *
 * **A scope list is never written twice.** `GITHUB_SCOPES`, `JIRA_SCOPES` and `SLACK_SCOPES` in the three
 * connector packages are the one declaration each; the install URL is *built* from it and the connect
 * screen *renders* it. The acceptance criteria say the requested scopes must be "displayed verbatim
 * before consent", and two copies of a scope list is precisely the shape where the screen keeps promising
 * read-only after somebody adds a write scope to the request — a drift that is invisible in review
 * because both halves look right on their own.
 *
 * The three connectors spell a permission differently (`contents` + `read` versus `read:jira-work`), so
 * `PROVIDERS` below carries a *normaliser* per provider rather than a copy of the list. The label it
 * produces is the exact string that provider's own consent screen shows, derived from the connector's
 * constant — so "verbatim" means verbatim on all three.
 *
 * ## Why the provider is resolved here and nowhere below
 *
 * `tools/quality-gates/tests/provider-neutrality.test.ts` fails the build if `ingest`,
 * `knowledge-model`, `analysis`, `renderers`, `narrator`, `memos` or `pipeline` so much as names a
 * provider. This module — in the web app, above every layer that gate protects — is one of the few
 * places allowed to know a provider exists at all. It hands a connector its `HttpClient` rather than
 * letting it reach for `fetch`, which is what makes "no workspace-wide call was made" an assertion a test
 * can check.
 *
 * ## What is deliberately *not* here
 *
 * Any credential value. `findIntegrationToken` returns a sealed row and this module looks at nothing but
 * its presence, so no code path from the connect screen can echo a token.
 */

// ---------------------------------------------------------------------------
// Configuration this deployment needs
// ---------------------------------------------------------------------------

export const CONNECT_STATE_SECRET_ENV_VAR = 'COMPASS_CONNECT_STATE_SECRET';
export const GITHUB_APP_SLUG_ENV_VAR = 'COMPASS_GITHUB_APP_SLUG';
export const JIRA_CLIENT_ID_ENV_VAR = 'COMPASS_JIRA_CLIENT_ID';
export const JIRA_CLIENT_SECRET_ENV_VAR = 'COMPASS_JIRA_CLIENT_SECRET';
export const SLACK_CLIENT_ID_ENV_VAR = 'COMPASS_SLACK_CLIENT_ID';
export const SLACK_CLIENT_SECRET_ENV_VAR = 'COMPASS_SLACK_CLIENT_SECRET';
export const BASE_URL_ENV_VAR = 'COMPASS_BASE_URL';

/**
 * The source key each provider answers as. One name, shared by the routes, the panel and the worker.
 *
 * Provider-neutral on purpose: the key is what the freshness indicator prints and what
 * `source_configs.source_key` stores, and a key called `github` would put a provider's name in the
 * report — which is the thing the port exists to prevent. Swapping a code host therefore changes which
 * connector is constructed and nothing a manager reads.
 */
export const GITHUB_SOURCE_KEY = 'primary-code';
export const JIRA_SOURCE_KEY = 'primary-tracker';
export const SLACK_SOURCE_KEY = 'primary-chat';

export const CONNECT_PROVIDER_IDS = ['github', 'jira', 'slack'] as const;
export type ConnectProviderId = (typeof CONNECT_PROVIDER_IDS)[number];

export const isConnectProviderId = (value: string): value is ConnectProviderId =>
  (CONNECT_PROVIDER_IDS as readonly string[]).includes(value);

/**
 * How long a signed `state` is good for.
 *
 * Ten minutes is the length of an OAuth consent screen a person is actually reading, and it is the same
 * reasoning the mailed-link lifetimes use: long enough for a human, short enough that a captured URL in a
 * browser history is not a standing key.
 */
export const CONNECT_STATE_TTL_MILLIS = 10 * 60 * 1000;

export type ConnectStateVerdict =
  | { readonly ok: true; readonly organizationId: string; readonly providerId: ConnectProviderId }
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
 * The CSRF `state` an install round-trip carries.
 *
 * ## Why it is signed rather than stored
 *
 * A callback arrives with **no cookie** — it is a top-level navigation from the provider — so the
 * organization it belongs to cannot come from a session. It has to travel in the URL, and anything that
 * travels in a URL an attacker can also write. Signing is what makes the value trustworthy:
 * `<organizationId>.<providerId>.<issuedAtMillis>.<hmac>`, compared in constant time, inside a ten-minute
 * window.
 *
 * ## Why the provider is inside the signature
 *
 * Three providers now share this mechanism, and without the provider bound into the payload a state
 * minted for one could be replayed against another's callback — storing a chat token under the tracker's
 * source key, where the tracker connector would then try to use it. Binding it means a state is only ever
 * valid for the flow it was issued for, which is the same argument the sealed-token layer makes for
 * binding ciphertext to its source.
 *
 * There is no fallback secret, because an HMAC under a key that ships in the repository is not a
 * signature. Absence disables connecting and the screen says which variable is missing.
 */
export function issueConnectState(input: {
  readonly organizationId: string;
  readonly now: Instant;
  readonly providerId?: ConnectProviderId;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): string | null {
  const secret = secretFrom(input.environment ?? process.env);
  if (secret === null) return null;

  const payload = `${input.organizationId}.${input.providerId ?? 'github'}.${toEpochMillis(input.now)}`;
  return `${payload}.${sign(secret, payload)}`;
}

export function verifyConnectState(input: {
  readonly state: string | null;
  readonly now: Instant;
  /** When given, a state minted for another provider is rejected as a bad signature would be. */
  readonly providerId?: ConnectProviderId;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): ConnectStateVerdict {
  const secret = secretFrom(input.environment ?? process.env);
  // Fails closed. A callback accepted without a verifiable state is a callback anybody can forge into
  // storing a credential against somebody else's organization.
  if (secret === null) return { ok: false, reason: 'unconfigured' };
  if (input.state === null || input.state.length === 0) return { ok: false, reason: 'malformed' };

  const parts = input.state.split('.');
  if (parts.length !== 4) return { ok: false, reason: 'malformed' };

  const [organizationId, providerId, issuedAtRaw, signature] = parts as [string, string, string, string];
  const issuedAt = Number.parseInt(issuedAtRaw, 10);
  if (organizationId.length === 0 || !Number.isFinite(issuedAt)) return { ok: false, reason: 'malformed' };
  if (!isConnectProviderId(providerId)) return { ok: false, reason: 'malformed' };

  if (!digestsMatch(signature, sign(secret, `${organizationId}.${providerId}.${issuedAtRaw}`))) {
    return { ok: false, reason: 'bad_signature' };
  }

  // A state for the wrong flow is treated exactly as a forged one, and for the same reason: the caller
  // must not learn which of the two checks it failed.
  if (input.providerId !== undefined && providerId !== input.providerId) {
    return { ok: false, reason: 'bad_signature' };
  }

  // Checked *after* the signature, so an expired-but-valid state and a forged one are distinguishable
  // to us and identical to the caller.
  const age = toEpochMillis(input.now) - issuedAt;
  if (age < 0 || age > CONNECT_STATE_TTL_MILLIS) return { ok: false, reason: 'expired' };

  return { ok: true, organizationId, providerId };
}

// ---------------------------------------------------------------------------
// The three providers, as configuration
// ---------------------------------------------------------------------------

/** One permission, in the words the provider's own consent screen uses. */
export interface ConnectScopeView {
  /** Exactly what the provider will show, e.g. `contents:read` or `read:jira-work`. */
  readonly label: string;
  readonly access: 'read';
  /** One sentence a manager can evaluate: what breaks without it. */
  readonly because: string;
}

/** What a manager picks per provider, in the vocabulary they think in. */
export interface SelectionVocabulary {
  /** Singular noun, e.g. `repository`. */
  readonly noun: string;
  readonly plural: string;
  /** The label on the input, and the shape it expects. */
  readonly inputLabel: string;
  readonly inputHint: string;
}

interface ProviderDefinition {
  readonly providerId: ConnectProviderId;
  readonly name: string;
  readonly sourceKey: string;
  readonly sourceKind: 'code' | 'tracker' | 'chat';
  readonly scopes: readonly ConnectScopeView[];
  /**
   * A scope that is not a permission over anybody's data, stated apart from the list.
   *
   * `offline_access` grants a refresh token so a connection survives the one-hour access-token lifetime.
   * Lumping it in with "read your issues" would blur the only distinction a reader cares about, so it is
   * shown separately with its own sentence — the same argument `jira-connector/src/scopes.ts` makes for
   * keeping it out of `JIRA_SCOPES`.
   */
  readonly refreshScope: { readonly label: string; readonly because: string } | null;
  readonly selection: SelectionVocabulary;
  /** Which environment variables this provider needs before it can be offered at all. */
  readonly requiredEnvVars: readonly string[];
  /** What Compass reads from it, in one sentence, before any permission is listed. */
  readonly reads: string;
}

const asGithubScope = (scope: GithubScope): ConnectScopeView => ({
  // GitHub's consent screen shows `contents: read`, so the label is the pair — built from the constant,
  // never typed out.
  label: `${scope.permission}:${scope.access}`,
  access: scope.access,
  because: scope.because,
});

const asJiraScope = (scope: JiraScope): ConnectScopeView => ({
  label: scope.scope,
  access: scope.access,
  because: scope.because,
});

const asSlackScope = (scope: SlackScope): ConnectScopeView => ({
  label: scope.scope,
  access: scope.access,
  because: scope.because,
});

export const PROVIDERS: readonly ProviderDefinition[] = Object.freeze([
  Object.freeze({
    providerId: 'github',
    name: 'GitHub',
    sourceKey: GITHUB_SOURCE_KEY,
    sourceKind: 'code',
    scopes: Object.freeze(GITHUB_SCOPES.map(asGithubScope)),
    refreshScope: null,
    selection: {
      noun: 'repository',
      plural: 'repositories',
      inputLabel: 'Repositories to read',
      inputHint: 'One per line, as owner/name — for example northwind/checkout-web.',
    },
    requiredEnvVars: [GITHUB_APP_SLUG_ENV_VAR, CONNECT_STATE_SECRET_ENV_VAR],
    reads:
      'Compass reads commits, pull requests, reviews, branch tips and release tags from the repositories ' +
      'you select — and nothing else. It never pushes a commit, opens a pull request, changes a setting ' +
      'or installs a webhook.',
  }),
  Object.freeze({
    providerId: 'jira',
    name: 'Jira',
    sourceKey: JIRA_SOURCE_KEY,
    sourceKind: 'tracker',
    scopes: Object.freeze(JIRA_SCOPES.map(asJiraScope)),
    refreshScope: {
      label: JIRA_OFFLINE_SCOPE,
      because:
        'Not a permission over anybody’s data. It grants a refresh token so this connection survives the ' +
        'one-hour access-token lifetime instead of asking you to re-approve it every morning.',
    },
    selection: {
      noun: 'project',
      plural: 'projects',
      inputLabel: 'Projects to read',
      inputHint: 'Chosen from the projects your grant can see. Unselected projects are never queried.',
    },
    requiredEnvVars: [JIRA_CLIENT_ID_ENV_VAR, JIRA_CLIENT_SECRET_ENV_VAR, CONNECT_STATE_SECRET_ENV_VAR],
    reads:
      'Compass reads issues, their status history, sprints and scope changes from the projects you ' +
      'select — and nothing else. It never transitions an issue, edits a field, comments or installs a ' +
      'hook.',
  }),
  Object.freeze({
    providerId: 'slack',
    name: 'Slack',
    sourceKey: SLACK_SOURCE_KEY,
    sourceKind: 'chat',
    scopes: Object.freeze(SLACK_SCOPES.map(asSlackScope)),
    refreshScope: null,
    selection: {
      noun: 'channel',
      plural: 'channels',
      inputLabel: 'Channels to read',
      inputHint:
        'One per line. Use Slack’s own “Copy link” on a channel and paste it here — Compass cannot list ' +
        'your channels, so it only ever reads the ones you name.',
    },
    requiredEnvVars: [SLACK_CLIENT_ID_ENV_VAR, SLACK_CLIENT_SECRET_ENV_VAR, CONNECT_STATE_SECRET_ENV_VAR],
    reads:
      'Compass reads the messages in the public channels you name, and in no others. It never posts, ' +
      'never reads a direct message or a private channel, and cannot list your workspace’s channels at ' +
      'all — the permission that would allow that is deliberately not requested.',
  }),
]);

export const providerById = (providerId: ConnectProviderId): ProviderDefinition => {
  const found = PROVIDERS.find((provider) => provider.providerId === providerId);
  // Unreachable through the type, and thrown rather than defaulted: a silent fallback would connect one
  // provider's credential to another's source key.
  if (found === undefined) throw new Error(`No provider definition for ${providerId}.`);
  return found;
};

// ---------------------------------------------------------------------------
// The connect screen's view
// ---------------------------------------------------------------------------

export interface ConnectProviderView {
  readonly providerId: ConnectProviderId;
  readonly name: string;
  /** The scope list, verbatim from the connector package. Never literals in JSX. */
  readonly scopes: readonly ConnectScopeView[];
  readonly refreshScope: { readonly label: string; readonly because: string } | null;
  readonly sourceKey: string;
  readonly sourceKind: string;
  readonly reads: string;
  readonly selection: SelectionVocabulary;
  /** True once a credential is stored for this organization. */
  readonly connected: boolean;
  /**
   * What this source is scoped to, in the manager's own order.
   *
   * Empty while connected is a *stated* state and not an oversight: a credential with no selection reads
   * nothing, and the screen says so rather than quietly reading everything the token can see — which is
   * what the connectors themselves refuse at construction.
   */
  readonly selections: readonly SourceSelection[];
  /**
   * True when a configuration survives with no credential: the source was connected and then
   * disconnected. What the freshness indicator states, and why the selections are still on the screen.
   */
  readonly disconnected: boolean;
  /**
   * Why this provider cannot be connected right now, or null.
   *
   * Configuration, not a fault: a deployment with no client id cannot start an install, and the screen
   * says which variable is missing rather than offering a button that 503s.
   */
  readonly unavailableReason: string | null;
  readonly installPath: string;
  readonly disconnectPath: string;
  readonly scopePath: string;
}

export interface ConnectView {
  readonly providers: readonly ConnectProviderView[];
}

const missingConfigSentence = (name: string, missing: readonly string[]): string | null =>
  missing.length === 0
    ? null
    : `Connecting ${name} needs ${missing.join(' and ')} set on this deployment. Compass will not offer a ` +
      'button that cannot work: everything else — the report, delivery, the seeded demonstration data — ' +
      'is unaffected.';

const missingEnvVars = (
  provider: ProviderDefinition,
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[] => provider.requiredEnvVars.filter((name) => (environment[name] ?? '').trim().length === 0);

/**
 * The connect screen's whole view, for all three providers.
 *
 * Reads only *whether* a credential exists — never its value.
 *
 * There is deliberately no "connected since" date: `StoredIntegrationToken` exposes no timestamp, and the
 * honest options were to add one to the row's public shape or to leave the fact out. It is left out,
 * because a date invented from the request instant would tell a manager when the *page* was rendered —
 * the same fabrication the freshness panel refuses. The audit log is where "when was this connected" is
 * answerable, and it answers it with the acting principal attached.
 */
export async function buildConnectView(input: {
  readonly scoped: ScopedDb;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): Promise<ConnectView> {
  const environment = input.environment ?? process.env;
  const configs = await listSourceConfigs(input.scoped);

  const providers = await Promise.all(
    PROVIDERS.map(async (provider): Promise<ConnectProviderView> => {
      const stored = await findIntegrationToken(input.scoped, provider.sourceKey, 'access');
      const config = configs.find((entry) => entry.sourceKey === provider.sourceKey) ?? null;

      return {
        providerId: provider.providerId,
        name: provider.name,
        // The one declaration, rendered as-is. See the module header.
        scopes: provider.scopes,
        refreshScope: provider.refreshScope,
        sourceKey: provider.sourceKey,
        sourceKind: provider.sourceKind,
        reads: provider.reads,
        selection: provider.selection,
        connected: stored !== null,
        selections: config?.selections ?? [],
        disconnected: stored === null && config !== null,
        unavailableReason: missingConfigSentence(provider.name, missingEnvVars(provider, environment)),
        installPath: `/api/connect/${provider.providerId}/install`,
        disconnectPath: `/api/connect/${provider.providerId}/disconnect`,
        scopePath: `/api/connect/${provider.providerId}/scope`,
      };
    }),
  );

  return { providers };
}

// ---------------------------------------------------------------------------
// What the freshness indicator needs
// ---------------------------------------------------------------------------

/** A source that has a configuration and no credential, so it is knowingly not being read. */
export interface DisconnectedSource {
  readonly sourceKey: string;
  readonly sourceKind: string;
  /** The provider's name, for the sentence the panel prints. */
  readonly name: string;
  /** How many repositories, projects or channels are still selected, ready for a reconnect. */
  readonly retainedSelectionCount: number;
}

/**
 * The sources a manager disconnected, so the freshness indicator can state it.
 *
 * The criterion is that disconnecting "states the source is disconnected in the freshness indicator", and
 * the journal alone cannot say that: a disconnected source simply stops appearing in coverage, which
 * renders identically to a source that was never configured. So the fact comes from the configuration —
 * a `source_configs` row with no `integration_tokens` row — and the panel prints it beside the journal's
 * own rows rather than inferring it from an absence.
 */
export async function listDisconnectedSources(scoped: ScopedDb): Promise<readonly DisconnectedSource[]> {
  const configs = await listSourceConfigs(scoped);
  const disconnected: DisconnectedSource[] = [];

  for (const config of configs) {
    const provider = PROVIDERS.find((entry) => entry.sourceKey === config.sourceKey);
    if (provider === undefined) continue;

    const stored = await findIntegrationToken(scoped, config.sourceKey, 'access');
    if (stored !== null) continue;

    disconnected.push({
      sourceKey: config.sourceKey,
      sourceKind: config.sourceKind,
      name: provider.name,
      retainedSelectionCount: config.selections.length,
    });
  }

  return disconnected;
}

// ---------------------------------------------------------------------------
// Install URLs
// ---------------------------------------------------------------------------

const baseUrlFrom = (environment: Readonly<Record<string, string | undefined>>): string =>
  (environment[BASE_URL_ENV_VAR] ?? 'http://localhost:3000').replace(/\/+$/, '');

/**
 * The redirect this deployment registers with a provider.
 *
 * Built from one expression so the URL in the authorize request and the URL in the token exchange are the
 * same string. Both providers compare them byte for byte and refuse the exchange on any difference, and a
 * mismatch produced by two hand-written copies is the single most common way an OAuth integration fails
 * in a way that says nothing useful.
 */
export const connectRedirectUri = (
  providerId: ConnectProviderId,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string => `${baseUrlFrom(environment)}/api/connect/${providerId}/callback`;

/** The install or authorize URL for this organization, or null when the deployment cannot start one. */
export function connectStartUrlFor(input: {
  readonly providerId: ConnectProviderId;
  readonly organizationId: string;
  readonly now: Instant;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): string | null {
  const environment = input.environment ?? process.env;
  const provider = providerById(input.providerId);
  if (missingEnvVars(provider, environment).length > 0) return null;

  const state = issueConnectState({
    organizationId: input.organizationId,
    now: input.now,
    providerId: input.providerId,
    environment,
  });
  if (state === null) return null;

  const redirectUri = connectRedirectUri(input.providerId, environment);

  // Each URL is *built* from the provider's own scope constant by the provider's own package, so the URL
  // and the screen cannot disagree.
  switch (input.providerId) {
    case 'github':
      return githubInstallUrl({ appSlug: (environment[GITHUB_APP_SLUG_ENV_VAR] ?? '').trim(), state });
    case 'jira':
      return jiraAuthorizeUrl({
        clientId: (environment[JIRA_CLIENT_ID_ENV_VAR] ?? '').trim(),
        redirectUri,
        state,
      });
    case 'slack':
      return slackInstallUrl({
        clientId: (environment[SLACK_CLIENT_ID_ENV_VAR] ?? '').trim(),
        redirectUri,
        state,
      });
  }
}

/**
 * Kept for the GitHub-specific callers that predate the other two providers.
 *
 * A thin alias rather than a second implementation: one code path builds every install URL, so a change
 * to how `state` is minted cannot reach one provider and miss another.
 */
export const githubInstallUrlFor = (input: {
  readonly organizationId: string;
  readonly now: Instant;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): string | null => connectStartUrlFor({ ...input, providerId: 'github' });

/** The stored configuration for one provider, or null. Used by the scope form and the callbacks. */
export const findProviderConfig = async (
  scoped: ScopedDb,
  providerId: ConnectProviderId,
): Promise<StoredSourceConfig | null> => {
  const configs = await listSourceConfigs(scoped);
  return configs.find((entry) => entry.sourceKey === providerById(providerId).sourceKey) ?? null;
};
