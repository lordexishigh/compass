import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { toEpochMillis, toIso, windowContains } from '@compass/clock';
import { ARTIFACT_KINDS } from '@compass/connector-port';
import { describe, expect, it } from 'vitest';

import {
  buildSeedFiles,
  generateSeed,
  loadSeedBundle,
  loadSeedFixtures,
  resolveSeedDirectory,
  roundTripRecords,
  seedFixturesDirectory,
} from '@compass/seed-connector';

/**
 * The determinism gate for the seed itself.
 *
 * Everything downstream — idempotent ingest, the byte-identical report, the
 * golden fixtures — assumes the substrate does not move underneath it. So the
 * generator is run twice in-process and compared byte for byte, and the result
 * is compared against what is actually checked in.
 */

const SEED_DIRECTORY = resolveSeedDirectory();
const fixtures = loadSeedFixtures(seedFixturesDirectory(SEED_DIRECTORY));
const bundle = loadSeedBundle(SEED_DIRECTORY);

describe('the generator is deterministic', () => {
  const first = buildSeedFiles(seedFixturesDirectory(SEED_DIRECTORY));
  const second = buildSeedFiles(seedFixturesDirectory(SEED_DIRECTORY));

  it('produces the same set of files both times', () => {
    expect([...second.keys()]).toEqual([...first.keys()]);
    expect(first.size).toBeGreaterThan(10);
  });

  it.each([...first.keys()])('writes byte-identical content for %s', (fileName) => {
    expect(second.get(fileName)).toBe(first.get(fileName));
  });

  it.each([...first.keys()])('matches the checked-in %s exactly', (fileName) => {
    const onDisk = readFileSync(join(SEED_DIRECTORY, fileName), 'utf8');

    expect(
      onDisk,
      `seed/${fileName} differs from a fresh generation; run \`pnpm seed:generate\` and commit the result`,
    ).toBe(first.get(fileName));
  });

  it('draws no value from the host clock, locale or RNG', () => {
    // A second, independent expansion from the same fixtures — not the cached
    // file map — must agree record for record.
    const left = generateSeed(fixtures);
    const right = generateSeed(fixtures);

    expect(right.dataset.records).toEqual(left.dataset.records);
    expect(right.now).toBe(left.now);
  });
});

describe('the readable form is the dataset, not a rendering of it', () => {
  it('round-trips every artifact family through ISO instants without loss', () => {
    expect(roundTripRecords(bundle.dataset.records)).toEqual(bundle.dataset.records);
  });

  it('writes instants as ISO-8601 strings a reviewer can read', () => {
    const raw = JSON.parse(readFileSync(join(SEED_DIRECTORY, 'generated', 'commits.json'), 'utf8')) as {
      occurredAt: unknown;
    }[];

    expect(typeof raw[0]?.occurredAt).toBe('string');
    expect(raw[0]?.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe('the dataset meets every documented volume floor', () => {
  it.each([
    ['projects', 3, fixtures.projects.projects.length],
    ['developers', 12, fixtures.people.developers.length],
    ['commits', 600, bundle.dataset.records.commits.length],
    ['pull requests', 120, bundle.dataset.records.pull_requests.length],
    ['issues', 300, bundle.dataset.records.issues.length],
    ['messages', 800, bundle.dataset.records.messages.length],
  ])('has at least %s: %i required', (_label, required, observed) => {
    expect(observed).toBeGreaterThanOrEqual(required as number);
  });

  it('has four completed sprints and at least one still in flight', () => {
    const sprints = bundle.dataset.records.sprints;

    expect(sprints.filter((sprint) => sprint.state === 'closed').length).toBeGreaterThanOrEqual(4);
    expect(sprints.filter((sprint) => sprint.state === 'active').length).toBeGreaterThanOrEqual(1);
  });

  it('spreads its messages across at least three conversations', () => {
    const conversations = new Set(bundle.dataset.records.messages.map((message) => message.conversationKey));

    expect(conversations.size).toBeGreaterThanOrEqual(3);
  });

  it.each([...ARTIFACT_KINDS])('has %s inside the dataset window and nowhere else', (artifact) => {
    const records = bundle.dataset.records[artifact] as readonly { occurredAt: number; sourceRecordId: string }[];

    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(
        windowContains(bundle.window, record.occurredAt as never),
        `${artifact} record ${record.sourceRecordId} sits outside the dataset window`,
      ).toBe(true);
    }
  });
});

describe('a ticket history reads the way a tracker would have written it', () => {
  const createdAt = new Map(bundle.dataset.records.issues.map((issue) => [issue.itemKey, issue.createdAt]));

  it('never transitions an issue before the issue exists', () => {
    const early = bundle.dataset.records.issue_transitions.filter((transition) => {
      const created = createdAt.get(transition.itemKey);
      return created !== undefined && toEpochMillis(transition.transitionedAt) < toEpochMillis(created);
    });

    expect(
      early.map((transition) => `${transition.sourceRecordId} at ${toIso(transition.transitionedAt)}`),
      'a transition is dated before the issue it belongs to was raised',
    ).toEqual([]);
  });

  it('names every transitioned item as an actual issue', () => {
    const orphans = bundle.dataset.records.issue_transitions.filter(
      (transition) => !createdAt.has(transition.itemKey),
    );

    expect(orphans.map((transition) => transition.sourceRecordId)).toEqual([]);
  });

  it('records each history in non-decreasing order of the instant it happened', () => {
    // `transition-<itemKey>-<n>` carries the order the generator authored, which
    // is the order a reader of the ticket would see the statuses in.
    const families = new Map<string, { readonly ordinal: number; readonly at: number; readonly toStatus: string }[]>();
    for (const transition of bundle.dataset.records.issue_transitions) {
      const family = families.get(transition.itemKey) ?? [];
      family.push({
        ordinal: Number.parseInt(transition.sourceRecordId.slice(transition.sourceRecordId.lastIndexOf('-') + 1), 10),
        at: toEpochMillis(transition.transitionedAt),
        toStatus: transition.toStatus,
      });
      families.set(transition.itemKey, family);
    }

    const backwards: string[] = [];
    for (const [itemKey, family] of families) {
      const ordered = [...family].sort((left, right) => left.ordinal - right.ordinal);
      for (let index = 1; index < ordered.length; index += 1) {
        const previous = ordered[index - 1];
        const current = ordered[index];
        if (previous && current && current.at < previous.at) {
          backwards.push(`${itemKey}: ${previous.toStatus} then ${current.toStatus}`);
        }
      }
    }

    expect(backwards, 'a ticket reads its statuses out of order').toEqual([]);
  });

  it('holds the same invariants on a fresh expansion, not only on the checked-in files', () => {
    const fresh = generateSeed(fixtures);
    const freshCreatedAt = new Map(fresh.dataset.records.issues.map((issue) => [issue.itemKey, issue.createdAt]));

    for (const transition of fresh.dataset.records.issue_transitions) {
      const created = freshCreatedAt.get(transition.itemKey);
      if (created === undefined) throw new Error(`${transition.sourceRecordId} has no issue row`);
      expect(
        toEpochMillis(transition.transitionedAt) >= toEpochMillis(created),
        `${transition.sourceRecordId} precedes its own issue`,
      ).toBe(true);
    }
  });
});

describe('identities are fragmented on purpose', () => {
  it.each(fixtures.people.developers.map((developer) => [developer.displayName, developer] as const))(
    '%s holds two or more git emails, one tracker account and one chat handle',
    (_label, developer) => {
      expect(new Set(developer.gitEmails).size).toBeGreaterThanOrEqual(2);
      expect(developer.trackerAccount.length).toBeGreaterThan(0);
      expect(developer.chatHandle.length).toBeGreaterThan(0);
    },
  );

  it('never reuses a git email across two developers', () => {
    const allEmails = fixtures.people.developers.flatMap((developer) => developer.gitEmails);

    expect(new Set(allEmails).size).toBe(allEmails.length);
  });

  it('actually uses more than one email per developer in the commit log', () => {
    const emailsInLog = new Set(bundle.dataset.records.commits.map((commit) => commit.authorIdentity.value));

    for (const developer of fixtures.people.developers) {
      const used = developer.gitEmails.filter((email) => emailsInLog.has(email));
      expect(used.length, `${developer.displayName} only ever commits as ${used.join(', ')}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('commits from at least five addresses that map to no developer', () => {
    const known = new Set(fixtures.people.developers.flatMap((developer) => developer.gitEmails));
    const unmapped = bundle.dataset.records.commits.filter((commit) => !known.has(commit.authorIdentity.value));

    expect(unmapped.length).toBeGreaterThanOrEqual(5);
    for (const commit of unmapped) {
      expect(
        fixtures.people.unmappedGitEmails.some((entry) => entry.address === commit.authorIdentity.value),
        `${commit.authorIdentity.value} authors commits but is not listed in the manifest's unmatched queue`,
      ).toBe(true);
    }
  });

  it('lists every documented unmapped address as an actual commit author', () => {
    const authors = new Set(bundle.dataset.records.commits.map((commit) => commit.authorIdentity.value));

    for (const entry of fixtures.people.unmappedGitEmails) {
      expect(authors.has(entry.address), `${entry.address} is documented but authors nothing`).toBe(true);
    }
  });
});

describe('the Kanban team has no sprint machinery at all', () => {
  const kanbanTeam = fixtures.organization.teams.find((team) => team.methodology === 'kanban');
  const projectKey = kanbanTeam?.projectKey ?? '';

  it('is configured in the fixtures', () => {
    expect(kanbanTeam, 'no team is configured as kanban').toBeDefined();
    expect(fixtures.projects.projects.find((project) => project.key === projectKey)?.sprints).toEqual([]);
  });

  it('has zero Sprint rows', () => {
    expect(bundle.dataset.records.sprints.filter((sprint) => sprint.projectKey === projectKey)).toEqual([]);
  });

  it('carries no story points on any of its tickets', () => {
    const issues = bundle.dataset.records.issues.filter((issue) => issue.projectKey === projectKey);

    expect(issues.length).toBeGreaterThan(0);
    expect(issues.filter((issue) => issue.estimatePoints !== null).map((issue) => issue.itemKey)).toEqual([]);
  });

  it('puts none of its tickets in a sprint', () => {
    const issues = bundle.dataset.records.issues.filter((issue) => issue.projectKey === projectKey);

    expect(issues.flatMap((issue) => issue.sprintRefs)).toEqual([]);
  });

  it('leaves the Scrum teams with goals, so the contrast is real', () => {
    const scrumSprints = bundle.dataset.records.sprints.filter((sprint) => sprint.projectKey !== projectKey);

    expect(scrumSprints.length).toBeGreaterThan(0);
    expect(scrumSprints.every((sprint) => (sprint.goal ?? '').length > 0)).toBe(true);
  });
});
