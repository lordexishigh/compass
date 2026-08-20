import { randomUUID } from 'node:crypto';

import { instantFromIso, type Instant } from '@compass/clock';
import {
  ScopedDb,
  deactivateSubscription,
  memberships,
  orgScope,
  organizations,
  replaceTeamScopes,
  users,
} from '@compass/db';
import { createTestDatabase, type TestDatabase } from '@compass/db/testing';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DeliverySchedule } from '../components/delivery-schedule';
import {
  DEFAULT_SEND_TIME,
  deliveryOutcomeStatement,
  loadDeliveryView,
  type DeliveryView,
} from '../lib/delivery-source';
import { saveSubscription } from '../lib/subscription-source';

/**
 * The screen that switches the daily on.
 *
 * The delivery *mechanism* is proved elsewhere and is not re-proved here: `packages/delivery` owns
 * the schedule, the DST behaviour and the six-section spine, `apps/worker` owns the tick, and
 * `share-links.test.ts` covers `saveSubscription`'s roster default and unsubscribe token against a
 * real database. Asserting any of that through markup would be theatre.
 *
 * What this suite covers is the half none of those can see, and the half that was actually missing:
 * that a manager can *reach* it. Every piece of the feature existed — the table, the repository, the
 * scheduler, the renderers, the worker, even `lib/subscription-source.ts` — and the only caller was
 * a test file, so no seat could set a send time. An endpoint reachable only by hand-crafting a
 * request is not a feature; neither is a table only a test can write to.
 */

const ORG = '2f0a4d3c-1111-4111-8111-111111111111';
const USER = '2f0a4d3c-2222-4222-8222-222222222222';
const MEMBERSHIP = '2f0a4d3c-3333-4333-8333-333333333333';

const at = (iso: string): Instant => instantFromIso(iso);
const NOW = at('2026-08-03T09:00:00Z');
const asDate = (iso: string) => new Date(Date.parse(iso));

let database: TestDatabase;
const scoped = () => new ScopedDb(database.db, orgScope(ORG));

// ---------------------------------------------------------------------------
// The rendered screen. No database: these are claims about what the page offers.
// ---------------------------------------------------------------------------

const UNCONFIGURED: DeliveryView = {
  defaultScope: 'team',
  teamKeys: ['platform'],
  channels: [
    {
      channel: 'email',
      configured: false,
      active: false,
      target: 'priya@acme.example',
      sendTime: DEFAULT_SEND_TIME,
      timezone: '',
      scopeChoice: 'default',
      changedLabel: null,
    },
    {
      channel: 'slack',
      configured: false,
      active: false,
      target: '',
      sendTime: DEFAULT_SEND_TIME,
      timezone: '',
      scopeChoice: 'default',
      changedLabel: null,
    },
  ],
};

const CONFIGURED: DeliveryView = {
  defaultScope: 'merged',
  teamKeys: ['platform', 'checkout'],
  channels: [
    {
      channel: 'email',
      configured: true,
      active: true,
      target: 'priya@acme.example',
      sendTime: '07:30',
      timezone: 'Europe/London',
      scopeChoice: 'merged',
      changedLabel: '2026-08-03 10:00',
    },
    {
      channel: 'slack',
      configured: true,
      active: false,
      target: '#platform-daily',
      sendTime: '08:45',
      timezone: 'America/New_York',
      scopeChoice: 'team',
      changedLabel: '2026-08-03 05:00',
    },
  ],
};

describe('the delivery screen a manager configures their daily on', () => {
  it('posts both channels to the subscription route', () => {
    const markup = renderToStaticMarkup(<DeliverySchedule view={UNCONFIGURED} stated={null} />);

    expect(markup).toContain('action="/api/delivery/subscription"');
    expect(markup).toContain('name="channel" value="email"');
    expect(markup).toContain('name="channel" value="slack"');
    // Every field the route requires has to be on the form, or saving 303s straight back with a
    // 400 the manager cannot act on.
    for (const field of ['target', 'sendTime', 'timezone', 'scope']) {
      expect(markup).toContain(`name="${field}"`);
    }
  });

  it('states the promise that makes delivery worth switching on', () => {
    const markup = renderToStaticMarkup(<DeliverySchedule view={UNCONFIGURED} stated={null} />);

    // The whole report inline, not a notification with a link. `@compass/delivery`'s spine refuses
    // a delivery missing a section, so this sentence is a claim the code keeps.
    expect(markup).toContain('all six sections in order, in the body of the message');
    expect(markup).not.toContain('click here');
  });

  it('states an unconfigured channel as absent rather than hiding it', () => {
    const markup = renderToStaticMarkup(<DeliverySchedule view={UNCONFIGURED} stated={null} />);

    expect(markup).toContain('not set up');
    expect(markup).toContain('Compass is not sending you the daily by Slack');
    // Nothing to stop, so nothing offers to.
    expect(markup).not.toContain('value="stop"');
  });

  it('states the live schedule and offers to stop only what is sending', () => {
    const markup = renderToStaticMarkup(<DeliverySchedule view={CONFIGURED} stated={null} />);

    expect(markup).toContain('07:30');
    expect(markup).toContain('Europe/London');
    expect(markup).toContain('priya@acme.example');
    expect(markup).toContain('Last changed 2026-08-03 10:00');

    // The switched-off Slack row keeps its schedule and says saving turns it back on.
    expect(markup).toContain('Switched off');
    expect(markup).toContain('#platform-daily');

    // One stop form, for the one channel that is actually sending.
    expect(markup.split('value="stop"')).toHaveLength(2);
  });

  it('refuses to preselect a scope that would send nothing', () => {
    const seatWithNoTeam: DeliveryView = {
      ...UNCONFIGURED,
      teamKeys: [],
      defaultScope: 'team',
      channels: UNCONFIGURED.channels.map((channel) => ({ ...channel, scopeChoice: 'merged' as const })),
    };

    const markup = renderToStaticMarkup(<DeliverySchedule view={seatWithNoTeam} stated={null} />);

    // `scopesFor('team', [])` is the empty list, so "follow my seat" would be a subscription that
    // never sends. The screen says so instead of letting it happen quietly.
    expect(markup).toContain('nothing would be sent');
    expect(markup).toContain('The merged report is preselected');
  });

  it('offers zone suggestions without limiting the field to them', () => {
    const markup = renderToStaticMarkup(<DeliverySchedule view={UNCONFIGURED} stated={null} />);

    expect(markup).toContain('<datalist id="delivery-zone-suggestions">');
    expect(markup).toContain('list="delivery-zone-suggestions"');
    expect(markup).toContain('Asia/Kolkata');
    // A datalist suggests; the input is still free text, which is what lets any IANA zone through.
    expect(markup).toContain('id="delivery-email-timezone" type="text"');
  });

  it('renders a round-trip outcome when there is one', () => {
    const markup = renderToStaticMarkup(
      <DeliverySchedule view={CONFIGURED} stated={deliveryOutcomeStatement('email-saved')} />,
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain('arrives in your inbox');
  });
});

describe('the outcome slug the route redirects with', () => {
  it('is looked up rather than printed', () => {
    // The redirect carries `?delivery=email-saved`, never a sentence, so nobody can hand somebody a
    // Compass URL that prints arbitrary text in Compass's own typography.
    expect(deliveryOutcomeStatement('email-saved')).toContain('all six sections');
    expect(deliveryOutcomeStatement('slack-stopped')).toContain('switched off');
    expect(deliveryOutcomeStatement('schedule-rejected')).toContain('Nothing was saved');
    expect(deliveryOutcomeStatement('<script>alert(1)</script>')).toBeNull();
    expect(deliveryOutcomeStatement(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The view, against a real migrated database.
// ---------------------------------------------------------------------------

describe('what the screen reads out of the database', () => {
  beforeAll(async () => {
    database = await createTestDatabase();
    await database.migrate();

    await database.db
      .insert(organizations)
      .values({
        id: ORG,
        organizationId: ORG,
        name: 'Acme',
        slug: 'acme-delivery',
        timezone: 'Europe/London',
        createdAt: asDate('2026-08-01T00:00:00Z'),
        updatedAt: asDate('2026-08-01T00:00:00Z'),
      })
      .onConflictDoNothing()
      .execute();

    await scoped()
      .insertInto(users, {
        id: USER,
        email: 'priya@acme.example',
        displayName: 'Priya Raman',
        passwordHash: null,
        createdAt: asDate('2026-08-01T00:00:00Z'),
        updatedAt: asDate('2026-08-01T00:00:00Z'),
      })
      .execute();

    await scoped()
      .insertInto(memberships, {
        id: MEMBERSHIP,
        userId: USER,
        role: 'manager',
        status: 'active',
        createdAt: asDate('2026-08-01T00:00:00Z'),
        updatedAt: asDate('2026-08-01T00:00:00Z'),
      })
      .execute();
  }, 120_000);

  afterAll(async () => {
    await database?.close();
  });

  it('offers both channels before either is configured', async () => {
    const view = await loadDeliveryView({
      scoped: scoped(),
      userId: USER,
      teamKeys: [],
      accountEmail: 'priya@acme.example',
    });

    expect(view.channels.map((channel) => channel.channel)).toEqual(['email', 'slack']);
    expect(view.channels.every((channel) => !channel.configured)).toBe(true);
    // Prefilled with the address this seat signed in with — the one field somebody might mistype.
    expect(view.channels[0]?.target).toBe('priya@acme.example');
    expect(view.channels[1]?.target).toBe('');
    expect(view.channels[0]?.sendTime).toBe(DEFAULT_SEND_TIME);
    // No team scope, so the only deliverable scope is the merged report.
    expect(view.channels[0]?.scopeChoice).toBe('merged');
  });

  it('reads a saved subscription back as the form prefill', async () => {
    await replaceTeamScopes(scoped(), MEMBERSHIP, ['platform'], NOW);

    const created = await saveSubscription(
      scoped(),
      {
        userId: USER,
        membershipId: MEMBERSHIP,
        channel: 'email',
        target: 'priya@acme.example',
        sendTime: '06:15',
        timezone: 'Europe/London',
      },
      { newId: () => randomUUID(), at: NOW },
    );

    const view = await loadDeliveryView({
      scoped: scoped(),
      userId: USER,
      teamKeys: ['platform'],
      accountEmail: 'priya@acme.example',
    });
    const email = view.channels.find((channel) => channel.channel === 'email');

    expect(email?.configured).toBe(true);
    expect(email?.active).toBe(true);
    expect(email?.sendTime).toBe('06:15');
    expect(email?.timezone).toBe('Europe/London');
    expect(email?.scopeChoice).toBe(created.subscription.scope);
    // Stamped in the subscription's own zone, not the server's: 09:00Z is 10:00 in London.
    expect(email?.changedLabel).toContain('2026-08-03');

    // The other channel is untouched by the one that was saved.
    expect(view.channels.find((channel) => channel.channel === 'slack')?.configured).toBe(false);
  });

  it('keeps a stopped subscription visible, with its schedule intact', async () => {
    const created = await saveSubscription(
      scoped(),
      {
        userId: USER,
        membershipId: MEMBERSHIP,
        channel: 'slack',
        target: '#platform-daily',
        sendTime: '08:45',
        timezone: 'America/New_York',
      },
      { newId: () => randomUUID(), at: NOW },
    );

    await deactivateSubscription(scoped(), created.subscription.id, NOW);

    const slack = (
      await loadDeliveryView({
        scoped: scoped(),
        userId: USER,
        teamKeys: ['platform'],
        accountEmail: 'priya@acme.example',
      })
    ).channels.find((channel) => channel.channel === 'slack');

    // Stopping is not deleting: the row is kept so turning it back on keeps the same schedule,
    // which is what the screen promises.
    expect(slack?.configured).toBe(true);
    expect(slack?.active).toBe(false);
    expect(slack?.sendTime).toBe('08:45');
    expect(slack?.timezone).toBe('America/New_York');
  });
});
