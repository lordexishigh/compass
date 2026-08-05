import { CompositeConnector, fetchHttpClient, type ConnectorPort, type HttpClient } from '@compass/connector-port';
import { instantFromEpochMillis, toEpochMillis, type Instant } from '@compass/clock';
import {
  ScopedDb,
  findIntegrationToken,
  listSourceConfigs,
  orgScope,
  type CompassDatabase,
  type StoredSourceConfig,
} from '@compass/db';
import { storeIntegrationToken, useIntegrationToken } from '@compass/auth';
import { GITHUB_CONNECTOR_ID, GithubConnector } from '@compass/github-connector';
import { JIRA_CONNECTOR_ID, JiraConnector, refreshJiraAccessToken } from '@compass/jira-connector';
import { SLACK_CONNECTOR_ID, SlackConnector } from '@compass/slack-connector';
import { SeedConnector } from '@compass/seed-connector';

/**
 * Provider selection: **the only file in the worker that names a provider.**
 *
 * ## What this file is for
 *
 * The architecture's central claim is that swapping the seeded provider for live connectors "touches
 * configuration only" — no change to ingest, the knowledge model, analysis or report generation.
 * `tools/quality-gates/tests/provider-neutrality.test.ts` enforces the negative half of that by failing the
 * build if any of those layers so much as names GitHub. This file is the positive half: the one place where
 * a provider name appears in the worker, reached by *reading configuration* and never by branching on a
 * hard-coded choice.
 *
 * Everything below the port receives an already-constructed `ConnectorPort` and cannot tell what it is.
 *
 * ## Where the configuration comes from
 *
 * Two places, and the split is the point:
 *
 *  - **`source_configs`**, per organization: which sources exist, which connector each is, whether it is
 *    enabled, and which repositories, projects or channels it is scoped to. All of it written by the
 *    connect screen, by a manager, with no file to edit and no operator involved.
 *  - **`integration_tokens`**, per organization: the sealed credential, opened here through
 *    `@compass/auth` — which is the only module that can open one — because the composition root is where
 *    a credential is turned into a configured client and nowhere else.
 *
 * Notably *not* from the environment. A deployment does not choose its provider; each organization does,
 * by connecting one. That is what makes the swap a configuration change rather than a redeploy, and it is
 * what lets one worker serve a tenant on a live code host beside a tenant still on the seeded data.
 *
 * ## Why the fallback is the seeded provider and not an error
 *
 * An organization that has connected nothing still gets a full six-section report — that is the zero-config
 * promise, and it is what makes the product demonstrable before anybody hands it a credential. A composite
 * with no members is refused (`EmptyCompositionError`) precisely so that "nothing connected" cannot be
 * mistaken for "everything connected and silent"; this function makes that choice explicitly instead.
 */

/** What one connected source resolved to, or why it could not be built. */
type ResolvedMember =
  | { readonly ok: true; readonly connector: ConnectorPort; readonly sourceKey: string }
  | { readonly ok: false; readonly sourceKey: string; readonly reason: string };

export interface ResolveConnectorInput {
  readonly db: CompassDatabase;
  readonly organizationId: string;
  /**
   * The process edge's own instant, threaded down like everywhere else in Compass.
   *
   * Required rather than optional because it decides whether a stored access token is still alive, and a
   * resolver that read its own clock would be the one place in the worker doing so — `no-direct-time` bans
   * it, and a default of "assume it is fine" would silently stop refreshing.
   */
  readonly now: Instant;
  /** Injected so a test can watch every request. The worker passes `fetchHttpClient()`. */
  readonly http?: HttpClient;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface ResolvedConnector {
  readonly connector: ConnectorPort;
  /** True when nothing was connected and the seeded provider is answering. */
  readonly seeded: boolean;
  /**
   * One line per source that was configured but could not be built, for the boot log.
   *
   * A configured source that silently failed to resolve would mean an organization believing Compass reads
   * its tracker while the report is built from two sources — so it is said out loud at boot, and the
   * freshness indicator states it again on the page from the same underlying fact.
   */
  readonly skipped: readonly string[];
}

/**
 * How long before expiry a token is treated as already expired.
 *
 * Five minutes, and the margin is the whole point. An access token that is valid for another ten seconds
 * will be expired by the time the ingest run that uses it finishes its second page — so a resolver that
 * refreshed only on `expiresAt <= now` would hand out credentials that die mid-read, and the ingest would
 * report a partial window as an authentication failure. Refreshing early costs one request per tick at
 * worst and makes the token's lifetime irrelevant to the read.
 */
const EXPIRY_MARGIN_MILLIS = 5 * 60 * 1000;

/** Environment variables the tracker's refresh grant needs. Named here, where the provider is known. */
const JIRA_CLIENT_ID_ENV_VAR = 'COMPASS_JIRA_CLIENT_ID';
const JIRA_CLIENT_SECRET_ENV_VAR = 'COMPASS_JIRA_CLIENT_SECRET';

/**
 * The access token to use, refreshing it first when it is at or near expiry.
 *
 * ## Why the refresh is lazy rather than scheduled
 *
 * `integration_tokens.expires_at` is in the clear specifically so a scheduler need not decrypt every row
 * to find the expiring ones — and a scheduler is what the schema comment anticipated. This does it at
 * resolve time instead, which is strictly better here for two reasons: the refresh happens exactly when a
 * credential is about to be *used*, so there is no window in which a schedule has drifted behind reality;
 * and there is no second place that has to agree with this one about what "expiring" means.
 *
 * The cost is bounded: the resolver runs once per ingest tick per organization, and a refresh only fires
 * when the margin above is crossed.
 *
 * ## Why a failed refresh is not a thrown error
 *
 * The caller turns this into a sentence in the boot log and the freshness panel. A grant that has been
 * revoked in the provider's own settings is a thing a manager has to *act* on, and "reconnect the tracker
 * on /connect" is the action — whereas a stack trace in a worker log is not something they will ever see.
 */
async function openCredential(
  config: StoredSourceConfig,
  scoped: ScopedDb,
  http: HttpClient,
  now: Instant,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<string | { readonly reason: string }> {
  const unusable = (reason: string): { readonly reason: string } => ({ reason });

  let stored;
  try {
    stored = await findIntegrationToken(scoped, config.sourceKey, 'access');
  } catch {
    return unusable(`${config.sourceKey} could not be read from the credential store, so it was not read.`);
  }

  if (stored === null) {
    return unusable(
      `${config.sourceKey} has no stored credential, so it was not read. Reconnect it on /connect.`,
    );
  }

  const alive =
    stored.expiresAt === null || toEpochMillis(stored.expiresAt) - toEpochMillis(now) > EXPIRY_MARGIN_MILLIS;

  if (!alive) {
    const refreshed = await refreshCredential(config, scoped, http, now, environment);
    if (refreshed !== null) return refreshed;
    // The refresh was attempted and failed, or this provider has none. Falling through to use the expired
    // token deliberately: the provider's own 401 becomes an `authentication_failed` coverage record naming
    // the source, which is a better statement than a guess made here about why it will fail.
  }

  try {
    const opened = await useIntegrationToken(scoped, config.sourceKey, 'access');
    if (opened === null) {
      return unusable(
        `${config.sourceKey} has no stored credential, so it was not read. Reconnect it on /connect.`,
      );
    }
    return opened;
  } catch {
    return unusable(
      `${config.sourceKey} has a credential Compass could not open, so it was not read. That is almost ` +
        'always a missing or changed encryption key.',
    );
  }
}

/**
 * Exchanges this source's refresh token for a live access token, or returns null.
 *
 * Null covers three cases that are one case to the caller: the provider has no refresh grant (a code host
 * mints its own tokens on demand from an installation id, so there is nothing to refresh), no refresh
 * token is stored, or the deployment has no client credentials to refresh with. In all three the stored
 * access token is the best available answer and the provider will say if it is not.
 *
 * **Both tokens are stored on success.** This provider rotates refresh tokens — the one just sent is dead —
 * so keeping the old one would leave a connection that works now and is unrecoverable in an hour.
 */
async function refreshCredential(
  config: StoredSourceConfig,
  scoped: ScopedDb,
  http: HttpClient,
  now: Instant,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<string | null> {
  if (config.connectorId !== JIRA_CONNECTOR_ID) return null;

  const clientId = (environment[JIRA_CLIENT_ID_ENV_VAR] ?? '').trim();
  const clientSecret = (environment[JIRA_CLIENT_SECRET_ENV_VAR] ?? '').trim();
  if (clientId.length === 0 || clientSecret.length === 0) return null;

  let refreshToken: string | null;
  try {
    refreshToken = await useIntegrationToken(scoped, config.sourceKey, 'refresh');
  } catch {
    return null;
  }
  if (refreshToken === null) return null;

  const outcome = await refreshJiraAccessToken({ http, clientId, clientSecret, refreshToken });
  if (!outcome.ok) return null;

  await storeIntegrationToken(
    scoped,
    {
      sourceKey: config.sourceKey,
      tokenKind: 'access',
      token: outcome.accessToken,
      ...(outcome.expiresInSeconds === null
        ? {}
        : { expiresAt: instantFromEpochMillis(toEpochMillis(now) + outcome.expiresInSeconds * 1000) }),
    },
    now,
  );

  // The replacement, written in the same pass. The token that was just spent is already dead at the
  // provider, so a failure between these two writes has to leave the *new* one stored.
  await storeIntegrationToken(
    scoped,
    { sourceKey: config.sourceKey, tokenKind: 'refresh', token: outcome.refreshToken },
    now,
  );

  return outcome.accessToken;
}

/** The connector each stored configuration builds, keyed by the connector id the config records. */
async function buildMember(
  config: StoredSourceConfig,
  scoped: ScopedDb,
  http: HttpClient,
  now: Instant,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<ResolvedMember> {
  const unusable = (reason: string): ResolvedMember => ({ ok: false, sourceKey: config.sourceKey, reason });

  if (!config.enabled) {
    return unusable(
      `${config.sourceKey} is disconnected, so it was not read. Every row already read is unchanged.`,
    );
  }

  if (config.selections.length === 0) {
    // The connectors refuse an empty selection at construction, deliberately. Catching it here as well
    // turns a throw at boot into a stated line, and says the same thing the connect screen says.
    return unusable(
      `${config.sourceKey} has nothing selected, so it was not read. Choose what Compass may read on ` +
        '/connect — an unscoped read is refused rather than treated as "everything".',
    );
  }

  /**
   * The credential, opened here and nowhere else — and renewed here if it is about to die.
   *
   * `useIntegrationToken` is the only function that can turn a sealed row back into a value, and this is
   * the only caller in the worker. A deployment with no `COMPASS_KMS_MASTER_KEY` cannot open one, which
   * surfaces as a stated line rather than as a crash on the first ingest tick.
   */
  const credential = await openCredential(config, scoped, http, now, environment);
  if (typeof credential !== 'string') return unusable(credential.reason);
  const token = credential;

  switch (config.connectorId) {
    case GITHUB_CONNECTOR_ID: {
      /**
       * `owner/name` split here, at the one boundary that knows this provider's addressing.
       *
       * `selectionKey` is stored whole so the connect screen prints back what a manager typed; the
       * connector needs the two halves. A selection with no slash was already refused at the form, so a
       * missing half here means a row written by an older version — dropped rather than guessed at,
       * because guessing an owner is how one organization's repository gets read into another's report.
       */
      const repositories = config.selections.flatMap((selection) => {
        const [owner, name] = selection.selectionKey.split('/');
        if (owner === undefined || name === undefined || owner.length === 0 || name.length === 0) return [];
        return [{ repositoryKey: selection.displayName, owner, name }];
      });
      if (repositories.length === 0) {
        return unusable(`${config.sourceKey} has no readable repository selection, so it was not read.`);
      }
      return {
        ok: true,
        sourceKey: config.sourceKey,
        connector: new GithubConnector({ sourceKey: config.sourceKey, repositories, token, http }),
      };
    }

    case JIRA_CONNECTOR_ID: {
      const cloudId = config.settings['cloudId'] ?? '';
      if (cloudId.length === 0) {
        // Without a site id there is no address to query: this provider routes by it. Reconnecting is what
        // produces one, so that is what the line says.
        return unusable(
          `${config.sourceKey} has no site recorded, so it was not read. Reconnect it on /connect — the ` +
            'site is recorded as part of the grant.',
        );
      }
      return {
        ok: true,
        sourceKey: config.sourceKey,
        connector: new JiraConnector({
          sourceKey: config.sourceKey,
          projects: config.selections.map((selection) => ({ projectKey: selection.selectionKey })),
          accessToken: token,
          cloudId,
          http,
        }),
      };
    }

    case SLACK_CONNECTOR_ID:
      return {
        ok: true,
        sourceKey: config.sourceKey,
        connector: new SlackConnector({
          sourceKey: config.sourceKey,
          channels: config.selections.map((selection) => ({
            conversationKey: selection.selectionKey,
            name: selection.displayName,
          })),
          botToken: token,
          http,
        }),
      };

    default:
      return unusable(
        `${config.sourceKey} names a connector Compass does not have (${config.connectorId}), so it was ` +
          'not read.',
      );
  }
}

/**
 * The connector this organization's pipeline runs against, resolved from its configuration.
 *
 * One composite when anything is connected, the seeded provider when nothing is. Either way the caller
 * gets a `ConnectorPort` and hands it down; nothing below can tell which it got, which is the property the
 * whole architecture rests on and the one `provider-neutrality.test.ts` guards.
 */
export async function resolveConnector(input: ResolveConnectorInput): Promise<ResolvedConnector> {
  const scoped = new ScopedDb(input.db, orgScope(input.organizationId));
  const http = input.http ?? fetchHttpClient();

  const environment = input.environment ?? process.env;

  const configs = await listSourceConfigs(scoped);
  const resolved = await Promise.all(
    configs.map(async (config) => await buildMember(config, scoped, http, input.now, environment)),
  );

  const members = resolved.filter((member): member is Extract<ResolvedMember, { ok: true }> => member.ok);
  const skipped = resolved.filter((member) => !member.ok).map((member) => member.reason);

  if (members.length === 0) {
    return { connector: new SeedConnector(), seeded: true, skipped };
  }

  return {
    connector: new CompositeConnector({
      /**
       * The id the ingest journal records, built from the sources rather than from the providers.
       *
       * `live:primary-chat+primary-code` and not `live:github+slack`, because `ingest_runs.connector_id` is
       * a column the freshness panel reads and a report renders — so a provider name in it would put the
       * provider's name in front of a manager, which is the one thing the port exists to prevent. Sorted,
       * so the id does not change when a manager reconnects sources in a different order.
       */
      connectorId: `live:${members
        .map((member) => member.sourceKey)
        .sort()
        .join('+')}`,
      members: members.map((member) => member.connector),
    }),
    seeded: false,
    skipped,
  };
}

/** One line per resolution outcome, for the boot log. Says what is being read and what is not. */
export function describeConnector(resolved: ResolvedConnector): readonly string[] {
  const lines = resolved.seeded
    ? [
        'connector: the seeded demonstration organization. Nothing is connected, so Compass reports on ' +
          'seeded data — a full six-section report, and every code path the live providers use.',
      ]
    : [`connector: ${resolved.connector.connectorId}`];

  return [...lines, ...resolved.skipped.map((reason) => `connector: ${reason}`)];
}
