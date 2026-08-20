import { formatCivilDateTime } from '@compass/clock';
import { listSubscriptionsForUser, type ScopedDb } from '@compass/db';
import { defaultScopeFor, type DeliveryChannel, type DeliveryScope } from '@compass/delivery';

/**
 * What the account screen needs to show about the manager's own daily.
 *
 * ## Why this reads the row rather than describing an intent
 *
 * The screen states what is *currently true* — the same posture `/start` takes — so an editable form
 * and a statement of fact are the same thing here: the fields are prefilled from the stored
 * subscription, and the sentence above them says when the next one arrives. There is no "pending" or
 * "saving" state to model, because the write is a form POST and the answer is a fresh render.
 *
 * ## Two channels, always both rendered
 *
 * Email and Slack each get a block whether or not they are configured, because a screen that hides
 * the channel you have not set up yet cannot tell you it exists. An unconfigured channel is stated as
 * absent in the product's own voice rather than drawn as an empty box.
 */

export const DELIVERY_CHANNELS: readonly DeliveryChannel[] = ['email', 'slack'];

/**
 * The send time a fresh form suggests.
 *
 * 07:30 is the hour the whole delivery layer is written around — `schedule.ts` uses it in every
 * example and the DST reasoning is about it — so the form suggests the same thing the code does
 * rather than inventing a second default.
 */
export const DEFAULT_SEND_TIME = '07:30';

/**
 * Zones offered as suggestions, not as the permitted set.
 *
 * The input accepts any IANA name and `assertSchedulable` is what decides — this is a `datalist`, so
 * a manager in Asia/Kolkata types it and it is accepted. The list exists because typing
 * `Europe/London` correctly from memory is a surprisingly common way to configure a daily that never
 * arrives, and the failure would not be visible until the next morning.
 */
export const SUGGESTED_TIME_ZONES: readonly string[] = [
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Kyiv',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Asia/Jerusalem',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
];

/** The scope a form offers. `default` follows the roster rather than pinning a choice. */
export type DeliveryScopeChoice = DeliveryScope | 'default';

export interface DeliveryChannelView {
  readonly channel: DeliveryChannel;
  /** True when a row exists at all, whether or not it is switched on. */
  readonly configured: boolean;
  readonly active: boolean;
  /** Prefilled: the stored target, or the best suggestion for a first-time setup. */
  readonly target: string;
  readonly sendTime: string;
  readonly timezone: string;
  readonly scopeChoice: DeliveryScopeChoice;
  /** When the subscription was last changed, or null if it has never been written. */
  readonly changedLabel: string | null;
}

export interface DeliveryView {
  readonly channels: readonly DeliveryChannelView[];
  /** What `default` resolves to for this seat, so the screen can name it instead of hinting at it. */
  readonly defaultScope: DeliveryScope;
  readonly teamKeys: readonly string[];
}

/**
 * The manager's delivery settings, one entry per channel.
 *
 * `accountEmail` prefills the email target for a first-time setup. Prefilling the address the seat
 * already signed in with removes the one field somebody might mistype, and it is not a hidden
 * default: it renders in the input, where it can be changed before saving.
 */
export async function loadDeliveryView(input: {
  readonly scoped: ScopedDb;
  readonly userId: string;
  readonly teamKeys: readonly string[];
  readonly accountEmail: string;
}): Promise<DeliveryView> {
  const stored = await listSubscriptionsForUser(input.scoped, input.userId);
  const defaultScope = defaultScopeFor(input.teamKeys);

  const channels = DELIVERY_CHANNELS.map((channel): DeliveryChannelView => {
    const row = stored.find((entry) => entry.channel === channel) ?? null;

    if (row === null) {
      return {
        channel,
        configured: false,
        active: false,
        target: channel === 'email' ? input.accountEmail : '',
        sendTime: DEFAULT_SEND_TIME,
        timezone: '',
        /**
         * `default` normally, but `merged` for a seat with no team scope — and that is not a
         * disagreement with `defaultScopeFor`, it is a refusal to preselect a choice that sends
         * nothing.
         *
         * `scopesFor('team', [])` is the empty list, so a per-team daily for somebody with no team
         * is a subscription that looks configured and never sends: exactly the failure the delivery
         * layer validates its zone to avoid. The shared rule still answers `team` there, on the
         * stated grounds that there is nothing to merge; this screen preselects the one scope that
         * can actually be delivered and says so beneath the field. An owner reads every team and
         * carries no explicit scope, so this is the ordinary case rather than an edge.
         */
        scopeChoice: input.teamKeys.length === 0 ? 'merged' : 'default',
        changedLabel: null,
      };
    }

    return {
      channel,
      configured: true,
      active: row.active,
      target: row.target,
      sendTime: row.sendTime,
      timezone: row.timezone,
      scopeChoice: row.scope,
      // In the subscription's own zone, not the server's: the whole point of the row is that this
      // manager's morning is the one that matters, and a UTC timestamp here would need mental
      // arithmetic to check against the send time three lines below it.
      changedLabel: formatCivilDateTime(row.updatedAt, row.timezone),
    };
  });

  return { channels, defaultScope, teamKeys: input.teamKeys };
}

/**
 * What a delivery round-trip did, looked up from a slug.
 *
 * The same rule the SSO outcomes follow, and for the same reason: the route redirects with
 * `?delivery=email-saved`, never with a sentence, so nobody can hand somebody a Compass URL that
 * prints arbitrary text in Compass's own typography. An unknown slug returns null and the screen
 * simply says nothing.
 */
export function deliveryOutcomeStatement(slug: string | null): string | null {
  switch (slug) {
    case 'email-saved':
      return 'Saved. The whole report — all six sections, in order — arrives in your inbox at that time, starting with the next one Compass writes.';
    case 'slack-saved':
      return 'Saved. The whole report arrives in Slack at that time, split across blocks rather than trimmed, starting with the next one Compass writes.';
    case 'email-stopped':
      return 'The email daily is switched off. Nothing was deleted, so turning it back on keeps the same schedule.';
    case 'slack-stopped':
      return 'The Slack daily is switched off. Nothing was deleted, so turning it back on keeps the same schedule.';
    case 'schedule-rejected':
      return 'Nothing was saved: that send time or zone is not one Compass can schedule. Use 24-hour HH:MM, and an IANA zone name such as Europe/London.';
    case 'email-target-rejected':
      return 'Nothing was saved: that does not look like an email address.';
    case 'slack-target-rejected':
      return 'Nothing was saved: a Slack target is a channel (#platform-standup), a direct message (@you), or the id Slack shows in a channel’s details.';
    default:
      return null;
  }
}
