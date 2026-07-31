import { type Instant } from '@compass/clock';
import { listTeamScopes, upsertSubscription, type ScopedDb, type StoredSubscription } from '@compass/db';
import {
  assertSchedulable,
  defaultScopeFor,
  hashShareToken,
  mintShareToken,
  type DeliveryChannel,
  type DeliveryScope,
} from '@compass/delivery';

/**
 * Creating and editing a subscription.
 *
 * Three things happen here that must not happen anywhere else, and each closes a gap that would
 * otherwise be invisible until a manager's daily failed to arrive.
 *
 * **The unsubscribe token is minted here.** `subscriptions.unsubscribe_token_hash` is NOT NULL, so
 * a creation path that did not mint one could not write a row at all — and the RFC 8058 button in
 * every email points at whatever this produces. It is a 128-bit CSPRNG value from the same
 * `mintShareToken` the share links use.
 *
 * **The default scope is read from the roster, not guessed.** `defaultScopeFor` decides from the
 * team keys on the membership: one team means that team's report, two or more means the merged one.
 * Reading `membership_team_scopes` rather than taking a team list from the caller is what makes the
 * default follow a person being moved between teams.
 *
 * **The schedule is validated at this boundary.** `assertSchedulable` refuses an unparseable zone
 * or send time *before* the row is written, because the failure mode otherwise is the worst one
 * this feature has: a subscription that looks configured and silently never sends.
 */

export interface SubscriptionRequest {
  readonly userId: string;
  /** The membership whose team scopes decide the default. */
  readonly membershipId: string;
  readonly channel: DeliveryChannel;
  readonly target: string;
  /** Omitted means "use the roster default". */
  readonly scope?: DeliveryScope | undefined;
  readonly sendTime: string;
  readonly timezone: string;
}

export interface CreatedSubscription {
  readonly subscription: StoredSubscription;
  /**
   * The unsubscribe token, shown once.
   *
   * Returned so the caller can build a link for a preview or a test. The stored value is its
   * digest; the plaintext is not recoverable afterwards.
   */
  readonly unsubscribeToken: string;
  /** The team keys the default was derived from, so a caller can state it back. */
  readonly teamKeys: readonly string[];
}

/**
 * Writes a subscription, defaulting the scope from roster membership.
 *
 * `newId` is injected rather than called, so a test gets deterministic ids and the route gets
 * `randomUUID`. `at` is the request edge's instant; nothing here reads a clock.
 */
export async function saveSubscription(
  scoped: ScopedDb,
  request: SubscriptionRequest,
  options: { readonly newId: () => string; readonly at: Instant },
): Promise<CreatedSubscription> {
  // Before anything is written. A bad zone is a daily that never arrives, and the manager who
  // typed it should be told now rather than wonder for a week.
  assertSchedulable(request.sendTime, request.timezone);

  const teamKeys = await listTeamScopes(scoped, request.membershipId);
  const scope = request.scope ?? defaultScopeFor(teamKeys);

  const minted = mintShareToken();

  const subscription = await upsertSubscription(
    scoped,
    {
      id: options.newId(),
      userId: request.userId,
      channel: request.channel,
      target: request.target,
      scope,
      sendTime: request.sendTime,
      timezone: request.timezone,
      unsubscribeTokenHash: minted.tokenHash,
    },
    options.at,
  );

  return { subscription, unsubscribeToken: minted.token, teamKeys };
}

/**
 * The one-click unsubscribe URL for a subscription.
 *
 * The URL carries the stored **digest** rather than a plaintext token, and that is a deliberate
 * trade worth stating. The worker sends mail long after the subscription was created and cannot
 * recover a pre-image of the digest, so the alternatives were to store the plaintext (a leaked
 * backup would then yield working links *and* a reversible secret) or to introduce a signing key
 * purely for this. The digest is itself a SHA-256 over 128 bits of CSPRNG entropy, so it is
 * unguessable; what is given up is that someone who can already read the database could
 * unsubscribe somebody — and because the row is kept rather than deleted, that is reversible from
 * the roster screen.
 */
export const unsubscribeUrlFor = (baseUrl: string, subscription: StoredSubscription): string =>
  `${baseUrl.replace(/\/+$/, '')}/api/delivery/unsubscribe?token=${encodeURIComponent(subscription.unsubscribeTokenHash)}`;

/** The digest a presented unsubscribe token is matched against. */
export const unsubscribeHashOf = (token: string): string => hashShareToken(token);
