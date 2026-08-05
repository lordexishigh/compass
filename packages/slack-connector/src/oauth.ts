import type { HttpClient } from '@compass/connector-port';

/**
 * The OAuth v2 code exchange, and the one piece of parsing that makes per-channel scoping self-serve.
 *
 * ## Why this is in the connector package and not in the web app
 *
 * It is provider knowledge: one URL, a form-encoded body, and an envelope that reports failure as HTTP
 * 200 with `ok: false`. It sits beside `scopes.ts`, the module that already owns "how this provider is
 * asked for permission", so that one provider's OAuth dance is described in one place.
 */

export type SlackExchangeOutcome =
  | {
      readonly ok: true;
      /** The **bot** token. See `scopes.ts` for why it is never the user token. */
      readonly botToken: string;
      readonly workspaceName: string;
      /** The scopes actually granted, so the caller can compare them against what it asked for. */
      readonly grantedScopes: readonly string[];
    }
  | { readonly ok: false; readonly reason: 'exchange_failed' | 'no_bot_token' };

const TOKEN_URL = 'https://slack.com/api/oauth.v2.access';

export interface SlackExchangeInput {
  readonly http: HttpClient;
  readonly clientId: string;
  readonly clientSecret: string;
  /** The `code` the callback arrived with. Single-use and short-lived. */
  readonly code: string;
  /** Must match the one the install URL carried, byte for byte, or the provider refuses. */
  readonly redirectUri: string;
  /** Overridable so a test can point at a recorded host. */
  readonly tokenUrl?: string;
}

export async function exchangeSlackAuthorizationCode(input: SlackExchangeInput): Promise<SlackExchangeOutcome> {
  /**
   * Form-encoded, not JSON, because this endpoint is one of the few that requires it — and the
   * credentials go in the body rather than in a Basic header for the same reason: it is what the
   * provider documents, and a client that guesses gets a `200 {"ok":false}` that reads like a bad code.
   */
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    redirect_uri: input.redirectUri,
  }).toString();

  const response = await input.http.send({
    method: 'POST',
    url: input.tokenUrl ?? TOKEN_URL,
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  });

  if (response.status !== 200) return { ok: false, reason: 'exchange_failed' };

  let envelope: {
    ok?: unknown;
    access_token?: unknown;
    scope?: unknown;
    team?: { name?: unknown; id?: unknown };
  };
  try {
    envelope = JSON.parse(response.body) as typeof envelope;
  } catch {
    return { ok: false, reason: 'exchange_failed' };
  }

  // The provider's own quirk, handled here as it is in the connector: failure arrives as a 200.
  if (envelope.ok !== true) return { ok: false, reason: 'exchange_failed' };

  const botToken = typeof envelope.access_token === 'string' ? envelope.access_token : '';
  if (botToken.length === 0) return { ok: false, reason: 'no_bot_token' };

  return {
    ok: true,
    botToken,
    workspaceName:
      typeof envelope.team?.name === 'string' && envelope.team.name.length > 0
        ? envelope.team.name
        : typeof envelope.team?.id === 'string'
          ? envelope.team.id
          : 'your workspace',
    grantedScopes:
      typeof envelope.scope === 'string' ? envelope.scope.split(',').filter((entry) => entry.length > 0) : [],
  };
}

/**
 * The conversation id inside a channel link, or null.
 *
 * ## Why a manager pastes a link instead of picking from a list
 *
 * Picking from a list would mean **enumerating the workspace's channels**, which needs `channels:read` —
 * the one scope this connector refuses on principle, because a credential that can list every channel is
 * a credential that has already outgrown "read the four channels I named". So the direction of the
 * knowledge is reversed: the manager tells Compass which conversations exist, rather than Compass
 * discovering them.
 *
 * A link rather than a name because the API addresses conversations by id, and a *name* would have to be
 * resolved to one — which is the enumeration again, by another route. Slack's own "Copy link" on a
 * channel produces `https://acme.slack.com/archives/C04AB12CD34`, so this is one click in Slack and one
 * paste here: self-serve, no config file, no admin, and no scope Compass would rather not hold.
 *
 * A bare id is accepted too, because somebody who knows it will type it and refusing that would be
 * pedantry.
 */
export function conversationKeyFromChannelLink(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  // `/archives/<id>` is the shape of every channel permalink, with an optional message id after it.
  const fromLink = /\/archives\/([A-Z][A-Z0-9]{6,})/i.exec(trimmed);
  const candidate = fromLink?.[1] ?? trimmed;

  // Conversation ids are upper-case alphanumeric and at least seven long. Anything else is a channel
  // *name*, a typo, or a link to something that is not a conversation — and a wrong id is worth
  // refusing here rather than discovering as `channel_not_found` on tomorrow's ingest.
  return /^[A-Z][A-Z0-9]{6,}$/.test(candidate.toUpperCase()) ? candidate.toUpperCase() : null;
}
