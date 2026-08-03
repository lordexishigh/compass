import type { Instant } from '@compass/clock';
import type { ConversationKind, MessageRecord } from '@compass/connector-port';
import { historyRowId, recordRawEvents, type RawEventInput, type ScopedDb } from '@compass/db';

/**
 * Chat ingest: opt-in, public channels only, and nothing about it is implicit.
 *
 * Chat is the one artifact family Compass keeps verbatim. Every other family is
 * projected into a typed entity and the original text is discarded — a commit becomes a
 * `commits` row, an issue becomes a `tickets` row — but a message's value *is* its
 * prose, so a message Compass has read is a message Compass is holding. That is exactly
 * the thing a team reading over their manager's shoulder worries about, and it is why
 * this file exists as its own boundary rather than as ten lines inside `model-ingest.ts`.
 *
 * ## The three rules, and which guard enforces each
 *
 *  1. **Nothing is read that a manager has not named.** `allowedConversationKeys` comes
 *     from `slack_channel_ingestion` where `enabled` is true. There is no wildcard, no
 *     "all channels the bot is in", and an empty allowlist means an empty ingest — which
 *     is the correct behaviour on a fresh deployment: Compass reads no chat until
 *     somebody says which chat.
 *  2. **Direct messages and private channels are never read.** Twice over. The database
 *     refuses to mark anything but a public channel enabled
 *     (`slack_channel_ingestion_public_only`), and `isIngestibleKind` below drops any
 *     record whose *own* stamped kind is not `public_channel`. The second guard is what
 *     makes the rule hold against a row that was somehow written wrong, a connector
 *     bug, or a channel that was public when it was enabled and has since been made
 *     private.
 *  3. **Bodies live only as long as the retention window.** The rows this writes are
 *     `raw_events`, which is the one table in Compass whose whole purpose is to be
 *     deleted; `purgeRawEventsBefore` is the other half.
 *
 * ## Why it writes `raw_events` and not a knowledge entity
 *
 * Because a message is not a belief about the world. Nothing in analysis reads a message
 * body, no report cites one, and the narrator is structurally forbidden from seeing one
 * (`assertNoRawIngestedText` fails the build if a field named `body` reaches the
 * narration payload). Storing it as an entity would give it a version history, which
 * would mean an append-only table full of chat that retention could not delete.
 */

/** The only conversation kind Compass will read. */
export const INGESTIBLE_CONVERSATION_KIND = 'public_channel';

/**
 * Whether a record's own stamped kind permits ingestion.
 *
 * `undefined` passes, and that is not a hole: a connector that does not model the
 * distinction — the seeded one produces public channels only — leaves the field absent,
 * and the allowlist is then the sole gate. Its rows carry a kind a manager declared and
 * a CHECK constraint that refuses to enable anything private. A record that *does* carry
 * a kind gets the veto.
 */
export const isIngestibleKind = (kind: ConversationKind | undefined): boolean =>
  kind === undefined || kind === INGESTIBLE_CONVERSATION_KIND;

/** Why a message was not stored. Counted so an empty ingest is never a mystery. */
export interface ChatIngestSkips {
  /** Its conversation is not on the allowlist. */
  readonly notOptedIn: number;
  /** Its own record says direct message, private channel or group message. */
  readonly notPublic: number;
}

export interface ChatIngestResult {
  readonly stored: number;
  readonly skipped: ChatIngestSkips;
  /** Conversation keys actually stored from, sorted. What the settings page can show. */
  readonly conversationKeys: readonly string[];
  /** One sentence for the ingest log. Says what was declined and why. */
  readonly detail: string;
}

export interface ChatIngestRequest {
  readonly messages: readonly MessageRecord[];
  /** From `ingestibleConversationKeys`. Empty means read nothing. */
  readonly allowedConversationKeys: readonly string[];
  /** The ingest instant, threaded from the process edge. Nothing here reads a clock. */
  readonly now: Instant;
}

const EMPTY: ChatIngestResult = {
  stored: 0,
  skipped: { notOptedIn: 0, notPublic: 0 },
  conversationKeys: [],
  detail: 'No chat was read: no channel is enabled for ingestion.',
};

function describe(stored: number, skipped: ChatIngestSkips, channels: number): string {
  if (stored === 0 && skipped.notOptedIn === 0 && skipped.notPublic === 0) {
    return 'No chat messages arrived in this window.';
  }

  const parts = [
    `Read ${stored} message${stored === 1 ? '' : 's'} from ${channels} enabled channel${channels === 1 ? '' : 's'}`,
  ];
  if (skipped.notOptedIn > 0) {
    parts.push(`${skipped.notOptedIn} from channels nobody has enabled were not read`);
  }
  if (skipped.notPublic > 0) {
    // Named separately from the opt-in count on purpose: this one means a *private*
    // conversation reached the ingest path, which is a fact worth seeing in a log rather
    // than folding into a general "skipped" number.
    parts.push(`${skipped.notPublic} from private conversations were refused outright`);
  }

  return `${parts.join('; ')}.`;
}

/**
 * Stores the message bodies from opted-in public channels, and says what it declined.
 *
 * Idempotent: `recordRawEvents` upserts on `(organization, source, source record id)`, so
 * a replayed or overlapping window rewrites the same rows. That is what makes the purge
 * count a count of messages rather than of sightings.
 */
export async function ingestChatMessages(
  scoped: ScopedDb,
  request: ChatIngestRequest,
): Promise<ChatIngestResult> {
  const allowed = new Set(request.allowedConversationKeys);
  if (allowed.size === 0) {
    // Still returns the counts, so a window that carried 400 messages into a deployment
    // with no channels enabled says so rather than reporting silence.
    const notOptedIn = request.messages.length;
    return notOptedIn === 0
      ? EMPTY
      : { ...EMPTY, skipped: { notOptedIn, notPublic: 0 }, detail: describe(0, { notOptedIn, notPublic: 0 }, 0) };
  }

  const rows: RawEventInput[] = [];
  const conversationKeys = new Set<string>();
  let notOptedIn = 0;
  let notPublic = 0;

  for (const message of request.messages) {
    // Order matters for the counts, not for the outcome: the private-conversation refusal
    // is checked first so that a private channel someone managed to add to the allowlist
    // is reported as *refused* rather than as merely absent from it.
    if (!isIngestibleKind(message.conversationKind)) {
      notPublic += 1;
      continue;
    }
    if (!allowed.has(message.conversationKey)) {
      notOptedIn += 1;
      continue;
    }

    conversationKeys.add(message.conversationKey);
    rows.push({
      // Derived from the source's own record id, so the row is the same row on every
      // replay. `historyRowId` is the same derivation the ingest journal uses.
      id: historyRowId(scoped.organizationId, 'raw_events', message.sourceKey, message.sourceRecordId),
      sourceKey: message.sourceKey,
      sourceKind: message.sourceKind,
      artifactKind: 'messages',
      sourceRecordId: message.sourceRecordId,
      conversationKey: message.conversationKey,
      conversationName: message.conversationName,
      authorIdentityKind: message.authorIdentity.kind,
      authorIdentityValue: message.authorIdentity.value,
      body: message.body,
      occurredAt: message.postedAt,
      ingestedAt: request.now,
    });
  }

  const stored = await recordRawEvents(scoped, rows);
  const skipped: ChatIngestSkips = { notOptedIn, notPublic };

  return {
    stored,
    skipped,
    conversationKeys: [...conversationKeys].sort(),
    detail: describe(stored, skipped, conversationKeys.size),
  };
}
