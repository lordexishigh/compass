import type { HttpClient } from '@compass/connector-port';

/**
 * The 3LO code exchange, and the site lookup that has to follow it.
 *
 * ## Why this is in the connector package and not in the web app
 *
 * It is provider knowledge: two specific URLs, a body shape, and the fact that an Atlassian token does
 * not identify a site on its own. The web app is allowed to *name* a provider — it is above the port —
 * but if the exchange lived there then the connect route, the connector and the test fixture would each
 * hold a piece of one provider's OAuth dance, and the scope list would be the only part of it declared
 * once. So it sits beside `scopes.ts`, which is the module that already owns "how this provider is asked
 * for permission".
 *
 * ## Why the site lookup is not optional
 *
 * `JiraConnectorConfig` needs a `cloudId`, because `api.atlassian.com` routes by it: one token is valid
 * for every site the installing person granted, and the id is what says which one this source is. The
 * callback carries no site, so a connector configured from the token alone would have no address to
 * query — and the failure would arrive a day later as an empty report rather than at connect time as a
 * refusal. `accessible-resources` is therefore part of the exchange, not a later step.
 *
 * ## Why every outcome is a value and not a throw
 *
 * The caller is a browser callback. It has to redirect a person to a page that states what happened, so
 * a stated reason is more useful than an exception — and the reasons are deliberately coarse, because
 * which check failed is a tuning signal for anybody probing the endpoint.
 */

export type JiraExchangeOutcome =
  | {
      readonly ok: true;
      readonly accessToken: string;
      /** Present when `offline_access` was granted, which is what survives the one-hour access lifetime. */
      readonly refreshToken: string | null;
      /** Seconds from now, as the provider reported it. Null when it did not say. */
      readonly expiresInSeconds: number | null;
      /** The site this source addresses. */
      readonly cloudId: string;
      readonly siteName: string;
      /** The scopes actually granted, so the caller can compare them against what it asked for. */
      readonly grantedScopes: readonly string[];
    }
  | { readonly ok: false; readonly reason: 'exchange_failed' | 'no_accessible_site' };

const TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const ACCESSIBLE_RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';

export interface JiraExchangeInput {
  readonly http: HttpClient;
  readonly clientId: string;
  readonly clientSecret: string;
  /** The `code` the callback arrived with. Single-use and short-lived. */
  readonly code: string;
  /** Must match the one the authorize URL carried, byte for byte, or the provider refuses. */
  readonly redirectUri: string;
  /** Overridable so a test can point at a recorded host. */
  readonly tokenUrl?: string;
  readonly accessibleResourcesUrl?: string;
}

export async function exchangeJiraAuthorizationCode(input: JiraExchangeInput): Promise<JiraExchangeOutcome> {
  const tokenResponse = await input.http.send({
    method: 'POST',
    url: input.tokenUrl ?? TOKEN_URL,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
    }),
  });

  if (tokenResponse.status !== 200) return { ok: false, reason: 'exchange_failed' };

  let token: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown };
  try {
    token = JSON.parse(tokenResponse.body) as typeof token;
  } catch {
    return { ok: false, reason: 'exchange_failed' };
  }

  const accessToken = typeof token.access_token === 'string' ? token.access_token : '';
  if (accessToken.length === 0) return { ok: false, reason: 'exchange_failed' };

  const resourcesResponse = await input.http.send({
    method: 'GET',
    url: input.accessibleResourcesUrl ?? ACCESSIBLE_RESOURCES_URL,
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });

  if (resourcesResponse.status !== 200) return { ok: false, reason: 'no_accessible_site' };

  let resources: unknown;
  try {
    resources = JSON.parse(resourcesResponse.body);
  } catch {
    return { ok: false, reason: 'no_accessible_site' };
  }

  /**
   * The first site, and the choice is stated rather than hidden.
   *
   * A person who granted access to several sites has to be asked which one, and that is a screen this
   * pass does not have. Taking the first is the honest interim: it is deterministic, it is the only site
   * for the overwhelming majority of installs, and `siteName` comes back so the connect screen can name
   * it — a manager who sees the wrong site named can disconnect and grant narrower access, which is a
   * recoverable state. Silently reading a site nobody was told about would not be.
   */
  const first = Array.isArray(resources) ? resources[0] : undefined;
  const cloudId = typeof (first as { id?: unknown } | undefined)?.id === 'string' ? (first as { id: string }).id : '';
  if (cloudId.length === 0) return { ok: false, reason: 'no_accessible_site' };

  const siteName = (first as { name?: unknown; url?: unknown } | undefined) ?? {};

  return {
    ok: true,
    accessToken,
    refreshToken: typeof token.refresh_token === 'string' ? token.refresh_token : null,
    expiresInSeconds:
      typeof token.expires_in === 'number' && Number.isFinite(token.expires_in) ? token.expires_in : null,
    cloudId,
    siteName:
      typeof siteName.name === 'string' && siteName.name.length > 0
        ? siteName.name
        : typeof siteName.url === 'string'
          ? siteName.url
          : cloudId,
    grantedScopes: typeof token.scope === 'string' ? token.scope.split(' ').filter((entry) => entry.length > 0) : [],
  };
}

/**
 * The projects a granted token can actually see, so the connect screen offers a list to pick from
 * rather than a text box to type a key into.
 *
 * This is what makes per-project scoping self-serve: a manager who has to know that their project key is
 * `DEV` has been handed a configuration file with extra steps. It reads the *search* endpoint rather
 * than enumerating issues, so it needs only `read:jira-work` — the scope already requested — and it is
 * called exactly once, at connect time, never during ingest.
 */
export interface JiraProjectOption {
  readonly projectKey: string;
  readonly name: string;
}

export async function listJiraProjects(input: {
  readonly http: HttpClient;
  readonly accessToken: string;
  readonly cloudId: string;
  readonly apiBaseUrl?: string;
}): Promise<readonly JiraProjectOption[]> {
  const base = (input.apiBaseUrl ?? 'https://api.atlassian.com').replace(/\/$/, '');
  const response = await input.http.send({
    method: 'GET',
    url: `${base}/ex/jira/${input.cloudId}/rest/api/3/project/search?maxResults=100&orderBy=key`,
    headers: { authorization: `Bearer ${input.accessToken}`, accept: 'application/json' },
  });

  if (response.status !== 200) return [];

  let parsed: { values?: unknown };
  try {
    parsed = JSON.parse(response.body) as typeof parsed;
  } catch {
    return [];
  }

  const values = Array.isArray(parsed.values) ? parsed.values : [];
  return values.flatMap((entry) => {
    const key = (entry as { key?: unknown }).key;
    const name = (entry as { name?: unknown }).name;
    if (typeof key !== 'string' || key.length === 0) return [];
    return [{ projectKey: key, name: typeof name === 'string' && name.length > 0 ? name : key }];
  });
}
