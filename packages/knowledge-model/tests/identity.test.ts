import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DuplicateIdentityLinkError,
  IdentityResolver,
  identityNaturalKey,
  normalizeIdentityValue,
  provisionRoster,
  type OrgRoster,
} from '@compass/knowledge-model';

import { TEST_TIMEZONE, at, createStoreHarness, type StoreHarness } from './helpers/store.js';

/**
 * Identity resolution, and the rule that gives the product its credibility: an
 * artifact is attributed to a person only through a declared IdentityLink that
 * matches the source's own identifier exactly.
 *
 * `p.raman@personal.example` with the display name "P. Raman" is not Priya Raman.
 * The tests below prove that in three directions — the address does not resolve,
 * the display name is never consulted, and the artifact ends up in the
 * unmatched-identity queue rather than being dropped.
 */
let harness: StoreHarness;
let resolver: IdentityResolver;

const DEVELOPERS = [
  {
    key: 'priya-raman',
    displayName: 'Priya Raman',
    teamKey: 'platform',
    active: true,
    gitEmails: ['priya.raman@northwind.example', 'praman@platform.northwind.example', 'priya@laptop.local'],
    trackerAccounts: ['acct-priya-raman'],
    chatHandles: ['user-priya-raman'],
  },
  {
    key: 'naomi-chen',
    displayName: 'Naomi Chen',
    teamKey: 'checkout',
    active: true,
    gitEmails: ['naomi.chen@northwind.example'],
    trackerAccounts: ['acct-naomi-chen'],
    chatHandles: ['user-naomi-chen'],
  },
] as const;

const roster: OrgRoster = {
  company: { key: 'northwind', name: 'Northwind Retail', timezone: TEST_TIMEZONE },
  objectives: [
    {
      key: 'OBJ-Q3-CHK',
      kind: 'quarter',
      parentKey: null,
      title: 'Cut guest-checkout abandonment',
      effectiveFrom: at('2026-07-01T00:00:00Z'),
      effectiveUntil: at('2026-10-01T00:00:00Z'),
      isCurrent: true,
    },
  ],
  teams: [
    {
      key: 'checkout',
      name: 'Checkout',
      methodology: 'scrum',
      projectKey: 'CHK',
      objectiveKey: 'OBJ-Q3-CHK',
      conversationKey: 'conv-checkout',
      timezone: TEST_TIMEZONE,
    },
  ],
  developers: [...DEVELOPERS],
  absences: [
    {
      developerKey: 'naomi-chen',
      kind: 'leave',
      startAt: at('2026-08-03T00:00:00Z'),
      endAt: at('2026-08-10T00:00:00Z'),
      note: 'Booked before the sprint was planned.',
    },
  ],
  declaredAt: at('2026-07-01T09:00:00Z'),
};

beforeAll(async () => {
  harness = await createStoreHarness();
  await provisionRoster(harness.store, roster);
  resolver = new IdentityResolver(harness.store);
  await resolver.load();
});

afterAll(async () => {
  await harness.close();
});

describe('provisioning a declared roster', () => {
  it('creates every declared entity once, and nothing on a second pass', async () => {
    const again = await provisionRoster(harness.store, roster);

    expect(again.created).toBe(0);
    expect(again.changed).toBe(0);
    expect(again.unchanged).toBeGreaterThan(0);
  });

  it('records one version per entity, not one per provisioning run', async () => {
    const versions = await harness.store.versions({ entityKind: 'developer', entityNaturalKey: 'priya-raman' });

    expect(versions).toHaveLength(1);
  });

  it('expands one developer into one link per declared identifier', async () => {
    const links = await harness.store.list('identity_link');

    expect(links).toHaveLength(3 + 1 + 1 + 1 + 1 + 1);
    expect(links.map((link) => link.naturalKey)).toContain('email:priya@laptop.local');
    expect(links.map((link) => link.naturalKey)).toContain('account:acct-naomi-chen');
  });

  it('refuses a roster that gives one address to two people', async () => {
    await expect(
      provisionRoster(harness.store, {
        ...roster,
        developers: [
          ...DEVELOPERS,
          {
            key: 'impostor',
            displayName: 'Someone Else',
            teamKey: 'platform',
            active: true,
            gitEmails: ['priya.raman@northwind.example'],
            trackerAccounts: [],
            chatHandles: [],
          },
        ],
      }),
    ).rejects.toThrow(DuplicateIdentityLinkError);
  });
});

describe('a commit author that matches an IdentityLink', () => {
  it('is attributed to that developer', async () => {
    const resolution = await resolver.resolve(
      { kind: 'email', value: 'praman@platform.northwind.example', displayName: 'Priya Raman' },
      {
        artifactKind: 'commits',
        sourceKey: 'primary-code',
        sourceRecordId: 'commit-1a2b3c4',
        observedAt: at('2026-07-30T10:00:00Z'),
      },
    );

    expect(resolution.matched).toBe(true);
    expect(resolution.developerKey).toBe('priya-raman');
    expect(resolution.unmatchedIdentityKey).toBeNull();
  });

  it('matches regardless of the case git recorded, because mail is case-insensitive', async () => {
    const resolution = await resolver.resolve(
      { kind: 'email', value: '  Priya.Raman@Northwind.Example  ', displayName: null },
      {
        artifactKind: 'commits',
        sourceKey: 'primary-code',
        sourceRecordId: 'commit-2b3c4d5',
        observedAt: at('2026-07-30T10:05:00Z'),
      },
    );

    expect(resolution.matched).toBe(true);
    expect(resolution.developerKey).toBe('priya-raman');
  });

  it('does not fold case on an opaque provider id, which could collapse two accounts', () => {
    expect(normalizeIdentityValue('account', ' ACCT-Priya ')).toBe('ACCT-Priya');
    expect(normalizeIdentityValue('email', ' A@B.example ')).toBe('a@b.example');
    expect(identityNaturalKey('handle', 'U0A1B2C3')).toBe('handle:U0A1B2C3');
  });
});

describe('an actor no IdentityLink covers', () => {
  const contractor = {
    kind: 'email' as const,
    value: 'contractor.jm@vendorlabs.example',
    displayName: 'J. Mensah',
  };

  it('creates an UnmatchedIdentity row and attributes the artifact to no person', async () => {
    const resolution = await resolver.resolve(contractor, {
      artifactKind: 'commits',
      sourceKey: 'primary-code',
      sourceRecordId: 'commit-9f8e7d6',
      observedAt: at('2026-07-29T11:00:00Z'),
    });

    expect(resolution.matched).toBe(false);
    expect(resolution.developerKey).toBeNull();
    expect(resolution.unmatchedIdentityKey).toBe('email:contractor.jm@vendorlabs.example');

    const stored = await harness.store.read('unmatched_identity', 'email:contractor.jm@vendorlabs.example');
    expect(stored?.fields['occurrenceCount']).toBe(1);
    expect(stored?.fields['displayName']).toBe('J. Mensah');
    expect(stored?.fields['artifactKinds']).toEqual(['commits']);
  });

  it('increments on a genuinely new artifact', async () => {
    await resolver.resolve(contractor, {
      artifactKind: 'pull_requests',
      sourceKey: 'primary-code',
      sourceRecordId: 'pull-request-8801',
      observedAt: at('2026-07-29T12:00:00Z'),
    });

    const stored = await harness.store.read('unmatched_identity', 'email:contractor.jm@vendorlabs.example');
    expect(stored?.fields['occurrenceCount']).toBe(2);
    expect(stored?.fields['artifactKinds']).toEqual(['commits', 'pull_requests']);
    expect(stored?.version).toBe(2);
  });

  it('does not increment when the same artifact is seen again in an overlapping window', async () => {
    const before = await harness.store.read('unmatched_identity', 'email:contractor.jm@vendorlabs.example');

    await resolver.resolve(contractor, {
      artifactKind: 'commits',
      sourceKey: 'primary-code',
      sourceRecordId: 'commit-9f8e7d6',
      observedAt: at('2026-07-29T11:00:00Z'),
    });

    const after = await harness.store.read('unmatched_identity', 'email:contractor.jm@vendorlabs.example');
    expect(after?.fields['occurrenceCount']).toBe(before?.fields['occurrenceCount']);
    expect(after?.version).toBe(before?.version);
  });

  it('widens the sighting bounds so the queue can say how long it has been unplaced', async () => {
    const stored = await harness.store.read('unmatched_identity', 'email:contractor.jm@vendorlabs.example');

    expect(stored?.firstSeenAt).toBe(at('2026-07-29T11:00:00Z'));
    expect(stored?.lastSeenAt).toBe(at('2026-07-29T12:00:00Z'));
  });
});

/**
 * The rule stated as its own test, because it is the one a well-meaning future
 * change is most likely to break.
 */
describe('attribution by name similarity', () => {
  it('never happens: an unknown address with a real developer name does not resolve', async () => {
    const lookalike = {
      kind: 'email' as const,
      value: 'p.raman@personal.example',
      displayName: 'P. Raman',
    };

    expect(resolver.lookup(lookalike)).toBeNull();

    const resolution = await resolver.resolve(lookalike, {
      artifactKind: 'commits',
      sourceKey: 'primary-code',
      sourceRecordId: 'commit-lookalike',
      observedAt: at('2026-07-29T13:00:00Z'),
    });

    expect(resolution.matched).toBe(false);
    expect(resolution.developerKey).toBeNull();
  });

  it('never happens for an exact display-name match either', () => {
    for (const developer of DEVELOPERS) {
      // Same human-readable name, an identifier nobody declared.
      expect(
        resolver.lookup({ kind: 'email', value: 'nobody+probe@unknown.example', displayName: developer.displayName }),
        `${developer.displayName} was matched by name alone`,
      ).toBeNull();
      expect(
        resolver.lookup({ kind: 'account', value: 'acct-unknown-probe', displayName: developer.displayName }),
      ).toBeNull();
      expect(
        resolver.lookup({ kind: 'handle', value: 'user-unknown-probe', displayName: developer.displayName }),
      ).toBeNull();
    }
  });

  it('gives the same answer for one identifier whatever display name arrives with it', () => {
    const answers = new Set(
      [null, 'Priya Raman', 'Naomi Chen', 'P. Raman', '', 'priya.raman'].map(
        (displayName) =>
          resolver.lookup({ kind: 'email', value: 'priya@laptop.local', displayName })?.developerKey ?? 'unmatched',
      ),
    );

    expect([...answers]).toEqual(['priya-raman']);
  });

  it('refuses to resolve at all before the roster has been loaded', () => {
    const cold = new IdentityResolver(harness.store);

    expect(() => cold.lookup({ kind: 'email', value: 'priya@laptop.local', displayName: null })).toThrow(
      /load\(\) must run/,
    );
  });
});
