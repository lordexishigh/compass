import { instantFromIso } from '@compass/clock';
import type { CommitRecord } from '@compass/connector-port';
import { describe, expect, it } from 'vitest';

import {
  SEMANTIC_MATCH_THRESHOLD,
  SeedConnector,
  TRACEABILITY_CLASSES,
  classifyCommitTraceability,
  loadSeedBundle,
  resolveSeedDirectory,
  traceabilityDistribution,
  type TraceabilityClass,
} from '@compass/seed-connector';

/**
 * The four resolution paths, exercised on the data the report will actually see.
 *
 * The distribution is the point. A seed where every commit names its ticket
 * makes the alignment engine look perfect and tells a manager nothing about
 * what happens to the commit that says `wip` on a branch called `fix/stuff`.
 */

const SEED_DIRECTORY = resolveSeedDirectory();
const bundle = loadSeedBundle(SEED_DIRECTORY);
const context = bundle.traceabilityContext;

const classify = (commit: CommitRecord): TraceabilityClass =>
  classifyCommitTraceability(commit, context).traceabilityClass;

const commitLike = (overrides: Partial<CommitRecord>): CommitRecord => ({
  sourceKey: 'primary-code',
  sourceKind: 'code',
  sourceRecordId: 'commit-probe',
  occurredAt: instantFromIso('2026-07-30T10:00:00Z'),
  repositoryKey: 'platform-api',
  revisionId: 'probe00',
  parentRevisionIds: [],
  authorIdentity: { kind: 'email', value: 'priya.raman@northwind.example', displayName: 'Priya Raman' },
  committerIdentity: null,
  authoredAt: instantFromIso('2026-07-30T10:00:00Z'),
  message: '',
  changedFileCount: 1,
  branchName: null,
  ...overrides,
});

/** A ticket that sits on a sprint carrying a goal — the structural chain. */
const chainedItemKey = [...context.itemKeysWithGoalChain].sort()[0] ?? 'PLAT-401';
/** A Kanban ticket: real, but with no sprint and therefore no goal above it. */
const unchainedItemKey =
  bundle.dataset.records.issues.find((issue) => issue.sprintRefs.length === 0)?.itemKey ?? 'INS-101';

describe('the resolution order decides the class', () => {
  it('resolves structurally when the message names a ticket with a goal chain', () => {
    const resolution = classifyCommitTraceability(
      commitLike({ message: `${chainedItemKey} extract the retry budget`, branchName: 'feature/whatever' }),
      context,
    );

    expect(resolution.traceabilityClass).toBe('structural');
    expect(resolution.itemKey).toBe(chainedItemKey);
    expect(resolution.foundIn).toBe('message');
  });

  it('falls back to inferred when only the branch name carries the key', () => {
    const resolution = classifyCommitTraceability(
      commitLike({ message: 'extract the retry budget', branchName: `feature/${chainedItemKey}-retry-budget` }),
      context,
    );

    expect(resolution.traceabilityClass).toBe('inferred');
    expect(resolution.foundIn).toBe('branch');
  });

  it('is inferred, not structural, when the ticket has no goal above it', () => {
    const resolution = classifyCommitTraceability(
      commitLike({ message: `${unchainedItemKey} skip the empty partition`, branchName: 'work/loader' }),
      context,
    );

    expect(resolution.traceabilityClass).toBe('inferred');
    expect(resolution.itemKey).toBe(unchainedItemKey);
  });

  it('resolves semantically when the wording clears the documented threshold', () => {
    const resolution = classifyCommitTraceability(
      commitLike({ message: 'reduce payment gateway latency on the hot path', branchName: 'perf/hot-path' }),
      context,
    );

    expect(resolution.traceabilityClass).toBe('semantic');
    expect(resolution.score).toBeGreaterThanOrEqual(SEMANTIC_MATCH_THRESHOLD);
    expect(resolution.targetKey).not.toBeNull();
    expect(resolution.matchedTokens.length).toBeGreaterThan(1);
  });

  it('leaves work with nothing to go on unattributed, with its score on the record', () => {
    const resolution = classifyCommitTraceability(commitLike({ message: 'wip', branchName: 'fix/stuff' }), context);

    expect(resolution.traceabilityClass).toBe('unattributed');
    expect(resolution.itemKey).toBeNull();
    expect(resolution.score).toBeLessThan(SEMANTIC_MATCH_THRESHOLD);
  });

  it('does not treat a ticket key nobody has heard of as a hint', () => {
    expect(classify(commitLike({ message: 'ZZZ-9999 do a thing', branchName: 'fix/stuff' }))).toBe('unattributed');
  });

  it('scores the same text pair identically on every call', () => {
    const commit = commitLike({ message: 'shave cold start time off the payment gateway boot' });

    expect(classifyCommitTraceability(commit, context)).toEqual(classifyCommitTraceability(commit, context));
  });
});

describe('the whole dataset is distributed across all four classes', () => {
  const observed = traceabilityDistribution(bundle.dataset.records.commits, context);

  it.each([...TRACEABILITY_CLASSES])('has a non-empty %s class', (traceabilityClass) => {
    const entry = observed.find((candidate) => candidate.traceabilityClass === traceabilityClass);

    expect(entry?.count, `no commit resolves as ${traceabilityClass}`).toBeGreaterThan(0);
  });

  it('matches the counts and percentages the manifest documents, exactly', () => {
    expect(observed).toEqual(bundle.manifest.traceability.dataset);
  });

  it('adds up to every commit in the dataset, so nothing is unclassified', () => {
    const total = observed.reduce((sum, entry) => sum + entry.count, 0);

    expect(total).toBe(bundle.dataset.records.commits.length);
    expect(observed.reduce((sum, entry) => sum + entry.percentage, 0)).toBeCloseTo(100, 0);
  });

  it('stays within a few points of the documented design proportions', () => {
    for (const target of bundle.manifest.traceability.designTargets) {
      const entry = observed.find((candidate) => candidate.traceabilityClass === target.traceabilityClass);
      expect(
        Math.abs((entry?.percentage ?? 0) - target.percentage),
        `${target.traceabilityClass} is ${entry?.percentage ?? 0}% against a ${target.percentage}% target`,
      ).toBeLessThanOrEqual(3);
    }
  });
});

describe('a single report over the seeded window exercises every resolution path', () => {
  it('returns commits from all four classes through the port', async () => {
    const connector = new SeedConnector(bundle.dataset);
    const result = await connector.fetchCommits({
      organizationId: bundle.organizationId,
      window: bundle.reportWindow,
      now: bundle.now,
    });

    const distribution = traceabilityDistribution(result.records, context);

    expect(result.records.length).toBeGreaterThan(0);
    expect(distribution.map((entry) => entry.traceabilityClass)).toEqual([...TRACEABILITY_CLASSES]);
    for (const entry of distribution) {
      expect(
        entry.count,
        `one report over ${bundle.manifest.reportWindow.start} → ${bundle.manifest.reportWindow.end} resolves nothing as ${entry.traceabilityClass}`,
      ).toBeGreaterThan(0);
    }
    expect(distribution).toEqual(bundle.manifest.traceability.reportWindow);
  });

  it('names an alignment target for every semantically resolved commit', async () => {
    const connector = new SeedConnector(bundle.dataset);
    const result = await connector.fetchCommits({
      organizationId: bundle.organizationId,
      window: bundle.reportWindow,
      now: bundle.now,
    });

    const semantic = result.records
      .map((commit) => classifyCommitTraceability(commit, context))
      .filter((resolution) => resolution.traceabilityClass === 'semantic');

    expect(semantic.length).toBeGreaterThan(0);
    for (const resolution of semantic) {
      // The evidence panel needs the target and the literal matched text.
      expect(resolution.targetKey).not.toBeNull();
      expect(resolution.matchedTokens.length).toBeGreaterThan(0);
      expect(resolution.score).toBeGreaterThanOrEqual(SEMANTIC_MATCH_THRESHOLD);
    }
  });

  it('names no developer as the subject of an unattributed commit', async () => {
    const connector = new SeedConnector(bundle.dataset);
    const result = await connector.fetchCommits({
      organizationId: bundle.organizationId,
      window: bundle.reportWindow,
      now: bundle.now,
    });

    const unattributed = result.records.filter((commit) => classify(commit) === 'unattributed');

    expect(unattributed.length).toBeGreaterThan(0);
    for (const commit of unattributed) {
      const resolution = classifyCommitTraceability(commit, context);
      expect(resolution.itemKey).toBeNull();
      expect(resolution.targetKey).toBeNull();
    }
  });
});
