import { readFileSync } from 'node:fs';

import { instantFromIso, toEpochMillis, toIso, type Instant } from '@compass/clock';
import { ARTIFACT_KINDS } from '@compass/connector-port';
import { describe, expect, it } from 'vitest';

import { loadSeedBundle, loadSeedFixtures, resolveSeedDirectory, seedFixturesDirectory, seedManifestPath } from '@compass/seed-connector';

/**
 * The manifest is a promise about the data. These tests are the enforcement.
 *
 * Two failure modes matter. A manifest can drift — the numbers were true when
 * written and the volume has changed since — so every count printed in
 * `seed/MANIFEST.md` is recomputed here from the generated rows. And a manifest
 * can name something that does not exist — a ticket key that was renamed, a pull
 * request that was never planted — so every identifier it names is resolved
 * against a real row.
 */

const SEED_DIRECTORY = resolveSeedDirectory();
const bundle = loadSeedBundle(SEED_DIRECTORY);
const fixtures = loadSeedFixtures(seedFixturesDirectory(SEED_DIRECTORY));
const markdown = readFileSync(seedManifestPath(SEED_DIRECTORY), 'utf8');
const records = bundle.dataset.records;

// --------------------------------------------------------------- resolvers

const issuesByKey = new Map(records.issues.map((issue) => [issue.itemKey, issue]));
const pullRequestNumbers = new Set(records.pull_requests.map((request) => request.displayNumber));
const revisionIds = new Set(records.commits.map((commit) => commit.revisionId));
const releaseTagNames = new Set(records.release_tags.map((tag) => tag.name));
const sprintNames = new Set(records.sprints.map((sprint) => sprint.name));
const objectiveKeys = new Set(bundle.meta.objectives.map((objective) => objective.key));
const repositoryKeys = new Set(records.commits.map((commit) => commit.repositoryKey));
const gitEmails = new Set([
  ...records.commits.map((commit) => commit.authorIdentity.value),
  ...fixtures.people.developers.flatMap((developer) => developer.gitEmails),
]);
const trackerAccounts = new Set(
  records.issues.flatMap((issue) =>
    [issue.assigneeIdentity?.value, issue.reporterIdentity?.value].filter((value): value is string => Boolean(value)),
  ),
);
const chatHandles = new Set(records.messages.map((message) => message.authorIdentity.value));
const personNames = new Set(fixtures.people.developers.map((developer) => developer.displayName));

interface IdentifierKind {
  readonly name: string;
  readonly pattern: RegExp;
  readonly resolves: (token: string) => boolean;
}

/**
 * The shapes an identifier can take in the manifest, and what each one has to
 * resolve to. A backticked token matching none of these — `tech-debt`, a file
 * path, a threshold — is prose and is skipped.
 */
const IDENTIFIER_KINDS: readonly IdentifierKind[] = [
  { name: 'ticket key', pattern: /^[A-Z][A-Z0-9]{1,4}-\d+$/, resolves: (token) => issuesByKey.has(token) },
  {
    name: 'pull request number',
    pattern: /^#\d+$/,
    resolves: (token) => pullRequestNumbers.has(Number(token.slice(1))),
  },
  { name: 'commit revision', pattern: /^[0-9a-f]{7}$/, resolves: (token) => revisionIds.has(token) },
  {
    name: 'release tag',
    pattern: /^(?:v\d[\w.-]*|guest-checkout-[\w.-]+)$/,
    resolves: (token) => releaseTagNames.has(token),
  },
  { name: 'objective key', pattern: /^OBJ-[A-Z0-9-]+$/, resolves: (token) => objectiveKeys.has(token) },
  { name: 'sprint name', pattern: /^Sprint \d+$/, resolves: (token) => sprintNames.has(token) },
  { name: 'git email', pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, resolves: (token) => gitEmails.has(token) },
  { name: 'tracker account', pattern: /^acct-[a-z-]+$/, resolves: (token) => trackerAccounts.has(token) },
  { name: 'chat handle', pattern: /^user-[a-z-]+$/, resolves: (token) => chatHandles.has(token) },
  { name: 'person', pattern: /^[A-Z][a-z]+ [A-Z][a-z]+$/, resolves: (token) => personNames.has(token) },
  {
    name: 'repository',
    pattern: /^(?:platform-api|shared-ui|checkout-web|insights-etl)$/,
    resolves: (token) => repositoryKeys.has(token),
  },
];

const kindOf = (token: string): IdentifierKind | null =>
  IDENTIFIER_KINDS.find((kind) => kind.pattern.test(token)) ?? null;

const backtickedTokens = [...markdown.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? '');
const namedIdentifiers = [...new Set(backtickedTokens)]
  .map((token) => ({ token, kind: kindOf(token) }))
  .filter((entry): entry is { token: string; kind: IdentifierKind } => entry.kind !== null)
  .sort((left, right) => (left.token < right.token ? -1 : 1));

// ------------------------------------------------------------------- tables

const recordCountRows = [...markdown.matchAll(/^\| ([a-z_]+) \| (\d+) \| `seed\/generated\/[a-z_]+\.json` \|$/gm)].map(
  (match) => ({ artifact: match[1] ?? '', count: Number(match[2]) }),
);

const traceabilityRows = [...markdown.matchAll(/^\| `(structural|inferred|semantic|unattributed)` \| (\d+) \| ([\d.]+)%/gm)].map(
  (match) => ({ traceabilityClass: match[1] ?? '', count: Number(match[2]), percentage: Number(match[3]) }),
);

// --------------------------------------------------------------------- tests

describe('every number printed in seed/MANIFEST.md is recomputed from the rows', () => {
  it('names all ten artifact families with their real counts', () => {
    expect(recordCountRows.map((row) => row.artifact)).toEqual([...ARTIFACT_KINDS]);

    for (const row of recordCountRows) {
      const actual = (records[row.artifact as (typeof ARTIFACT_KINDS)[number]] as readonly unknown[]).length;
      expect(row.count, `MANIFEST.md claims ${row.count} ${row.artifact}; the dataset has ${actual}`).toBe(actual);
    }
  });

  it('states a total that is the sum of the parts', () => {
    const total = ARTIFACT_KINDS.reduce((sum, artifact) => sum + (records[artifact] as readonly unknown[]).length, 0);

    expect(markdown).toContain(`Total: **${total}** records`);
    expect(bundle.manifest.totalRecords).toBe(total);
  });

  it('reports every volume requirement as met', () => {
    const unmet = bundle.manifest.requirements.filter((requirement) => !requirement.satisfied);

    expect(unmet.map((requirement) => `${requirement.label}: ${requirement.observed}/${requirement.required}`)).toEqual(
      [],
    );
    expect(markdown).not.toContain('| NO |');
  });

  it('states the Kanban team as having no sprints and no points', () => {
    expect(bundle.manifest.kanbanTeam.sprintRows).toBe(0);
    expect(bundle.manifest.kanbanTeam.issuesCarryingPoints).toBe(0);
    expect(markdown).toContain('**0 sprint rows**');
  });

  it('counts commits per unmapped address exactly', () => {
    for (const entry of bundle.manifest.unmappedGitEmails) {
      const actual = records.commits.filter((commit) => commit.authorIdentity.value === entry.address).length;
      expect(actual, `${entry.address} is documented with ${entry.commitCount} commits`).toBe(entry.commitCount);
      expect(markdown).toContain(`\`${entry.address}\``);
    }
  });
});

describe('every identifier the manifest names resolves to a real row', () => {
  it('finds a substantial set of identifiers to check, so the extractor cannot pass vacuously', () => {
    expect(namedIdentifiers.length).toBeGreaterThan(80);
    // Every kind must be represented; a pattern that matches nothing is a bug in
    // this test, not a clean bill of health for the manifest.
    for (const kind of IDENTIFIER_KINDS) {
      expect(
        namedIdentifiers.some((entry) => entry.kind.name === kind.name),
        `no ${kind.name} appears in MANIFEST.md`,
      ).toBe(true);
    }
  });

  it.each(namedIdentifiers.map((entry) => [`${entry.kind.name} ${entry.token}`, entry] as const))(
    '%s resolves',
    (_label, entry) => {
      expect(entry.kind.resolves(entry.token), `MANIFEST.md names ${entry.token} but no row matches it`).toBe(true);
    },
  );

  it.each(
    bundle.manifest.pathologies.map((pathology) => [pathology.id, pathology] as const),
  )('%s names its entities in the prose and every one exists', (_label, pathology) => {
    expect(pathology.identifiers.length).toBeGreaterThan(0);
    expect(markdown).toContain(`**id:** \`${pathology.id}\``);

    for (const token of pathology.identifiers) {
      expect(markdown, `${pathology.id} names ${token} but MANIFEST.md does not print it`).toContain(`\`${token}\``);
      const kind = kindOf(token);
      expect(kind, `${token} is not a recognisable identifier shape`).not.toBeNull();
      expect(kind?.resolves(token), `${pathology.id} names ${token}, which resolves to nothing`).toBe(true);
    }
  });

  it('documents all eight planted pathologies', () => {
    expect(bundle.manifest.pathologies.map((pathology) => pathology.id)).toEqual([
      'off-goal-billing-migration',
      'review-bottleneck-marcus-hale',
      'release-slip-v4-2-0',
      'blocked-then-merged-CHK-701',
      'estimation-noise-plat',
      'done-with-no-pull-request-INS-204',
      'merged-not-released-platform-api',
      'tech-debt-growth-plat',
    ]);
  });
});

describe('the planted pathologies behave the way the manifest describes them', () => {
  const utcDay = (instant: Instant): string => toIso(instant).slice(0, 10);
  const required = <TValue>(value: TValue | undefined | null, what: string): TValue => {
    if (value === undefined || value === null) throw new Error(`${what} is missing from the generated dataset`);
    return value;
  };

  it('flags the blocked-then-merged ticket and merges it on the same day', () => {
    const planted = fixtures.pathologies.blockedThenMerged;
    const issue = required(issuesByKey.get(planted.itemKey), planted.itemKey);
    const pullRequest = required(
      records.pull_requests.find((request) => request.displayNumber === planted.pullRequestNumber),
      `pull request #${planted.pullRequestNumber}`,
    );
    const blockedTransition = required(
      records.issue_transitions.find(
        (transition) => transition.itemKey === planted.itemKey && transition.toStatus === 'Blocked',
      ),
      `the Blocked transition on ${planted.itemKey}`,
    );
    const mergedAt = required(pullRequest.mergedAt, `the merge instant of #${planted.pullRequestNumber}`);

    expect(issue.flaggedBlocked).toBe(true);
    expect(blockedTransition.transitionedAt).toBe(instantFromIso(planted.blockedFlaggedAt));
    expect(pullRequest.state).toBe('merged');
    expect(mergedAt).toBe(instantFromIso(planted.mergedAt));

    // Day N in the tracker, day N in version control — the correction case.
    expect(utcDay(blockedTransition.transitionedAt)).toBe(utcDay(mergedAt));
    expect(toEpochMillis(mergedAt)).toBeGreaterThan(toEpochMillis(blockedTransition.transitionedAt));
  });

  it('queues every bottleneck pull request on one named reviewer, still open', () => {
    const planted = fixtures.pathologies.reviewBottleneck;
    const queued = records.pull_requests.filter((request) =>
      planted.pullRequests.some((entry) => entry.displayNumber === request.displayNumber),
    );

    expect(queued.length).toBe(planted.pullRequests.length);
    expect(queued.length).toBeGreaterThanOrEqual(5);
    for (const request of queued) {
      expect(request.state).toBe('open');
      expect(request.mergedAt).toBeNull();
      expect(request.requestedReviewerIdentities.map((reviewer) => reviewer.displayName)).toEqual([
        planted.reviewerName,
      ]);
    }
  });

  it('cuts the slipping release days after it was planned', () => {
    const planted = fixtures.pathologies.slippingRelease;
    const tag = required(
      records.release_tags.find((entry) => entry.name === planted.releaseTagName),
      planted.releaseTagName,
    );
    const slipDays =
      (toEpochMillis(tag.releasedAt) - toEpochMillis(instantFromIso(planted.plannedAt))) / (24 * 60 * 60 * 1000);

    expect(slipDays).toBeGreaterThanOrEqual(3);
    expect(records.messages.filter((message) => message.body.includes(planted.releaseTagName)).length).toBeGreaterThan(
      1,
    );
  });

  it('closes the hygiene ticket with nothing in version control pointing at it', () => {
    const planted = fixtures.pathologies.doneWithNoPullRequest;
    const issue = issuesByKey.get(planted.itemKey);

    expect(issue?.statusCategory).toBe('done');
    expect(records.pull_requests.some((request) => request.linkedWorkItemKeys.includes(planted.itemKey))).toBe(false);
    expect(records.commits.some((commit) => commit.message.includes(planted.itemKey))).toBe(false);
    expect(records.commits.some((commit) => (commit.branchName ?? '').includes(planted.itemKey))).toBe(false);
  });

  it('leaves merged work sitting ahead of the newest release tag', () => {
    const planted = fixtures.pathologies.mergedNotReleased;
    const latest = records.release_tags
      .filter((tag) => tag.repositoryKey === planted.repositoryKey)
      .reduce((newest, tag) => (toEpochMillis(tag.releasedAt) > toEpochMillis(newest.releasedAt) ? tag : newest));
    const unreleased = records.pull_requests
      .flatMap((request) =>
        request.repositoryKey === planted.repositoryKey && request.mergedAt !== null
          ? [{ displayNumber: request.displayNumber, mergedAt: request.mergedAt }]
          : [],
      )
      .filter((request) => toEpochMillis(request.mergedAt) > toEpochMillis(latest.releasedAt));

    expect(latest.name).toBe(planted.latestReleaseTagName);
    expect(unreleased.length).toBeGreaterThan(0);
    const oldest = unreleased.reduce((first, request) =>
      toEpochMillis(request.mergedAt) < toEpochMillis(first.mergedAt) ? request : first,
    );
    expect(oldest.displayNumber).toBe(planted.oldestUnreleasedPullRequestNumber);
  });

  it('grows the tech-debt cohort every sprint', () => {
    const planted = fixtures.pathologies.technicalDebtGrowth;
    const counts = planted.cohorts.map(
      (cohort) =>
        cohort.issues.filter((entry) => issuesByKey.get(entry.itemKey)?.labels.includes(planted.label) === true).length,
    );

    expect(counts).toEqual(planted.cohorts.map((cohort) => cohort.issues.length));
    for (let index = 1; index < counts.length; index += 1) {
      expect(counts[index], `cohort ${index} did not grow`).toBeGreaterThan(counts[index - 1] ?? 0);
    }
  });

  it('produces story points uncorrelated with elapsed days, which is what points_uninformative means', () => {
    const planted = fixtures.pathologies.estimationNoise;
    const pairs = planted.samples.map((sample) => {
      const issue = issuesByKey.get(sample.itemKey);
      const elapsedDays =
        issue?.resolvedAt != null
          ? (toEpochMillis(issue.resolvedAt) - toEpochMillis(issue.createdAt)) / (24 * 60 * 60 * 1000)
          : Number.NaN;
      return { points: issue?.estimatePoints ?? Number.NaN, elapsedDays, itemKey: sample.itemKey };
    });

    expect(pairs.filter((pair) => Number.isNaN(pair.points) || Number.isNaN(pair.elapsedDays))).toEqual([]);
    expect(pairs.length).toBeGreaterThanOrEqual(planted.minimumSampleSize);

    // The elapsed duration the fixture declares is the duration the rows carry.
    for (const [index, sample] of planted.samples.entries()) {
      expect(pairs[index]?.elapsedDays, `${sample.itemKey} elapsed duration`).toBe(sample.elapsedWorkingDays);
      expect(pairs[index]?.points, `${sample.itemKey} estimate`).toBe(sample.points);
    }

    const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
    const meanPoints = mean(pairs.map((pair) => pair.points));
    const meanDays = mean(pairs.map((pair) => pair.elapsedDays));
    const covariance = pairs.reduce(
      (sum, pair) => sum + (pair.points - meanPoints) * (pair.elapsedDays - meanDays),
      0,
    );
    const spreadPoints = Math.sqrt(pairs.reduce((sum, pair) => sum + (pair.points - meanPoints) ** 2, 0));
    const spreadDays = Math.sqrt(pairs.reduce((sum, pair) => sum + (pair.elapsedDays - meanDays) ** 2, 0));
    const correlation = covariance / (spreadPoints * spreadDays);

    expect(Math.abs(correlation)).toBeLessThan(planted.correlationThreshold);
  });

  it('runs the off-goal stream inside the current sprint while serving a closed objective', () => {
    const planted = fixtures.pathologies.offGoalWorkStream;
    const sprint = records.sprints.find((entry) => entry.name === planted.sprintName && entry.projectKey === 'PLAT');
    const servedObjective = bundle.meta.objectives.find((objective) => objective.key === planted.servesObjectiveKey);

    expect(sprint?.state).toBe('active');
    expect(servedObjective?.current).toBe(false);
    for (const entry of planted.issues) {
      expect(issuesByKey.get(entry.itemKey)?.sprintRefs).toEqual([sprint?.sourceRecordId]);
    }
    for (const entry of planted.commits) {
      const commit = records.commits.find((candidate) => candidate.revisionId === entry.revisionId);
      expect(commit?.branchName).toBe(planted.branchName);
      expect(commit?.message.startsWith(entry.itemKey)).toBe(true);
    }
  });
});

describe('the traceability tables in the manifest match the rows', () => {
  it('prints two four-row tables, dataset then report window', () => {
    expect(traceabilityRows.length).toBe(8);
    expect(traceabilityRows.slice(0, 4).map((row) => row.traceabilityClass)).toEqual([
      'structural',
      'inferred',
      'semantic',
      'unattributed',
    ]);
  });

  it('prints the same counts the structured manifest holds', () => {
    const printed = traceabilityRows.slice(0, 4);
    bundle.manifest.traceability.dataset.forEach((entry, index) => {
      expect(printed[index]?.count).toBe(entry.count);
      expect(printed[index]?.percentage).toBeCloseTo(entry.percentage, 1);
    });

    const printedWindow = traceabilityRows.slice(4);
    bundle.manifest.traceability.reportWindow.forEach((entry, index) => {
      expect(printedWindow[index]?.count).toBe(entry.count);
    });
  });
});
