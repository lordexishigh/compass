import { instantFromIso, type Instant } from '@compass/clock';
import type { MessageRecord } from '@compass/connector-port';
import {
  ingestibleConversationKeys,
  listRawEventsForConversation,
  purgeRawEventsBefore,
  setSlackChannelIngestion,
} from '@compass/db';
import { createMigratedTestDatabase, type TestDatabase } from '@compass/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { INGESTIBLE_CONVERSATION_KIND, ingestChatMessages, isIngestibleKind } from '@compass/ingest';

/**
 * Subtask 005: opt-in chat ingestion, and the two things that are never read.
 *
 * Asserted against a real PostgreSQL, because two of the three guards live *in* the database:
 * the CHECK constraint that makes a private conversation unenablable, and the unique key that
 * makes a replayed window an upsert rather than a duplicate. A test with a fake store would
 * assert the third guard and quietly assume the other two.
 */

const ORGANIZATION_ID = '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5e';
const NOW = instantFromIso('2026-08-05T08:00:00Z');
const at = (iso: string): Instant => instantFromIso(iso);

let database: TestDatabase;

beforeAll(async () => {
  database = await createMigratedTestDatabase({
    organizationId: ORGANIZATION_ID,
    name: 'Northwind Retail',
    slug: 'northwind-retail',
    timezone: 'Europe/London',
    at: new Date(Date.parse('2026-07-01T00:00:00Z')),
  });
});

afterAll(async () => {
  await database.close();
});

const scoped = () => database.scopedFor(ORGANIZATION_ID);

beforeEach(async () => {
  // Each test decides which channels are on. Deleting the rows rather than the whole schema
  // keeps the harness fast and keeps the organization row (and its foreign keys) intact.
  await database.client.query('delete from raw_events');
  await database.client.query('delete from slack_channel_ingestion');
});

function message(overrides: Partial<MessageRecord> & { readonly sourceRecordId: string }): MessageRecord {
  return {
    sourceKey: 'primary-chat',
    sourceKind: 'chat',
    occurredAt: at('2026-08-04T09:00:00Z'),
    conversationKey: 'conv-checkout',
    conversationName: 'checkout-standup',
    authorIdentity: { kind: 'chat_handle', value: '@priya', displayName: 'Priya Raman' },
    body: 'CHK-701 is still waiting on the payments team.',
    threadRef: null,
    referencedItemKeys: ['CHK-701'],
    postedAt: at('2026-08-04T09:00:00Z'),
    ...overrides,
  } as MessageRecord;
}

async function enable(
  conversationKey: string,
  conversationName: string,
  conversationKind: 'public_channel' | 'private_channel' | 'direct_message' | 'group_message' = 'public_channel',
): Promise<void> {
  await setSlackChannelIngestion(scoped(), {
    id: `00000000-0000-4000-8000-${conversationKey.replace(/\D/g, '').padStart(12, '0').slice(0, 12)}`,
    conversationKey,
    conversationName,
    conversationKind,
    enabled: true,
    byUserId: null,
    at: NOW,
  });
}

// ---------------------------------------------------------------------------
// Opt-in
// ---------------------------------------------------------------------------

describe('nothing is read that nobody named', () => {
  it('stores nothing on a fresh deployment, and says how much it declined', async () => {
    const result = await ingestChatMessages(scoped(), {
      messages: [message({ sourceRecordId: 'm-1' }), message({ sourceRecordId: 'm-2' })],
      allowedConversationKeys: await ingestibleConversationKeys(scoped()),
      now: NOW,
    });

    expect(result.stored).toBe(0);
    // The count matters as much as the zero: a window that carried 400 messages into a
    // deployment with no channels enabled must say so rather than report silence.
    expect(result.skipped.notOptedIn).toBe(2);
    expect(result.detail).toContain('nobody has enabled');
    expect(await listRawEventsForConversation(scoped(), 'conv-checkout')).toEqual([]);
  });

  it('reads only the enabled channel, even when both arrive in the same window', async () => {
    await enable('conv-checkout', 'checkout-standup');

    const result = await ingestChatMessages(scoped(), {
      messages: [
        message({ sourceRecordId: 'm-1' }),
        message({ sourceRecordId: 'm-2', conversationKey: 'conv-random', conversationName: 'random' }),
      ],
      allowedConversationKeys: await ingestibleConversationKeys(scoped()),
      now: NOW,
    });

    expect(result.stored).toBe(1);
    expect(result.skipped.notOptedIn).toBe(1);
    expect(result.conversationKeys).toEqual(['conv-checkout']);
    expect(await listRawEventsForConversation(scoped(), 'conv-random')).toEqual([]);
  });

  it('stops reading a channel that is turned off', async () => {
    await enable('conv-checkout', 'checkout-standup');
    await setSlackChannelIngestion(scoped(), {
      id: '00000000-0000-4000-8000-000000000001',
      conversationKey: 'conv-checkout',
      conversationName: 'checkout-standup',
      conversationKind: 'public_channel',
      enabled: false,
      byUserId: null,
      at: NOW,
    });

    expect(await ingestibleConversationKeys(scoped())).toEqual([]);

    const result = await ingestChatMessages(scoped(), {
      messages: [message({ sourceRecordId: 'm-3' })],
      allowedConversationKeys: await ingestibleConversationKeys(scoped()),
      now: NOW,
    });

    expect(result.stored).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Direct messages and private channels: never, unconditionally
// ---------------------------------------------------------------------------

describe('direct messages and private channels are never ingested', () => {
  it('refuses to mark a private conversation as read, in the database itself', async () => {
    for (const kind of ['private_channel', 'direct_message', 'group_message'] as const) {
      await expect(
        setSlackChannelIngestion(scoped(), {
          id: '00000000-0000-4000-8000-000000000002',
          conversationKey: `conv-${kind}`,
          conversationName: kind,
          conversationKind: kind,
          enabled: true,
          byUserId: null,
          at: NOW,
        }),
        `${kind} was accepted`,
      ).rejects.toThrow(/will not read/i);
    }
  });

  it('drops a private-conversation record even when its key is on the allowlist', async () => {
    // The allowlist is *forced* here — the row claims a public channel while the records claim
    // otherwise — precisely to prove the ingest filter is independent of the table. This is the
    // state a connector bug, or a channel made private after it was enabled, would produce.
    await enable('conv-sneaky', 'sneaky');

    const result = await ingestChatMessages(scoped(), {
      messages: [
        message({ sourceRecordId: 'dm-1', conversationKey: 'conv-sneaky', conversationKind: 'direct_message' }),
        message({ sourceRecordId: 'pc-1', conversationKey: 'conv-sneaky', conversationKind: 'private_channel' }),
        message({ sourceRecordId: 'gm-1', conversationKey: 'conv-sneaky', conversationKind: 'group_message' }),
        message({ sourceRecordId: 'ok-1', conversationKey: 'conv-sneaky', conversationKind: 'public_channel' }),
      ],
      allowedConversationKeys: ['conv-sneaky'],
      now: NOW,
    });

    expect(result.skipped.notPublic).toBe(3);
    expect(result.stored).toBe(1);

    const stored = await listRawEventsForConversation(scoped(), 'conv-sneaky');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.body).toContain('CHK-701');
  });

  it('names the refusal separately from the opt-in count, so a private record is visible in a log', async () => {
    await enable('conv-sneaky', 'sneaky');

    const result = await ingestChatMessages(scoped(), {
      messages: [message({ sourceRecordId: 'dm-2', conversationKey: 'conv-sneaky', conversationKind: 'direct_message' })],
      allowedConversationKeys: ['conv-sneaky'],
      now: NOW,
    });

    expect(result.detail).toContain('private conversations were refused outright');
  });

  it('admits an unstamped record, because the allowlist is then the only gate', () => {
    // A connector that does not model the distinction leaves the field absent. That passes the
    // record-level veto and is still bounded by the allowlist, whose rows carry a kind a manager
    // declared and a CHECK constraint that refuses to enable anything private.
    expect(isIngestibleKind(undefined)).toBe(true);
    expect(isIngestibleKind(INGESTIBLE_CONVERSATION_KIND)).toBe(true);
    expect(isIngestibleKind('direct_message')).toBe(false);
    expect(isIngestibleKind('private_channel')).toBe(false);
    expect(isIngestibleKind('group_message')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Idempotency, and the window
// ---------------------------------------------------------------------------

describe('storage and retention', () => {
  it('replays a window into the same rows rather than accumulating copies', async () => {
    await enable('conv-checkout', 'checkout-standup');
    const allowed = await ingestibleConversationKeys(scoped());
    const batch = [message({ sourceRecordId: 'm-1' }), message({ sourceRecordId: 'm-2' })];

    await ingestChatMessages(scoped(), { messages: batch, allowedConversationKeys: allowed, now: NOW });
    await ingestChatMessages(scoped(), { messages: batch, allowedConversationKeys: allowed, now: NOW });
    await ingestChatMessages(scoped(), { messages: batch, allowedConversationKeys: allowed, now: NOW });

    // Two messages, three ingests, two rows. Without this the purge count would count
    // sightings and mean nothing.
    expect(await listRawEventsForConversation(scoped(), 'conv-checkout')).toHaveLength(2);
  });

  it('keeps a body only until the window passes it', async () => {
    await enable('conv-checkout', 'checkout-standup');
    const allowed = await ingestibleConversationKeys(scoped());

    await ingestChatMessages(scoped(), {
      messages: [
        message({ sourceRecordId: 'old', postedAt: at('2026-01-02T09:00:00Z') }),
        message({ sourceRecordId: 'recent', postedAt: at('2026-08-04T09:00:00Z') }),
      ],
      allowedConversationKeys: allowed,
      now: NOW,
    });

    expect(await listRawEventsForConversation(scoped(), 'conv-checkout')).toHaveLength(2);

    // The retention window, applied. 90 days before 2026-08-05 is 2026-05-07.
    const deleted = await purgeRawEventsBefore(scoped(), at('2026-05-07T08:00:00Z'));

    expect(deleted).toBe(1);
    const remaining = await listRawEventsForConversation(scoped(), 'conv-checkout');
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.occurredAt).toBe(at('2026-08-04T09:00:00Z'));
  });

  it('records who the source said wrote it, unresolved', async () => {
    await enable('conv-checkout', 'checkout-standup');

    await ingestChatMessages(scoped(), {
      messages: [message({ sourceRecordId: 'm-1' })],
      allowedConversationKeys: await ingestibleConversationKeys(scoped()),
      now: NOW,
    });

    const [stored] = await listRawEventsForConversation(scoped(), 'conv-checkout');

    // The source's own identifier, not a resolved developer key. A raw event is stored before
    // identity resolution and has to stay readable when a link is later removed — which is what
    // makes the transparency page able to answer "which of these did I write".
    expect(stored?.authorIdentityKind).toBe('chat_handle');
    expect(stored?.authorIdentityValue).toBe('@priya');
  });
});
