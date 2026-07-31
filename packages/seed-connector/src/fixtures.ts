import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CoverageReason, SourceKind } from '@compass/connector-port';

import { resolveSeedDirectory, seedFixturesDirectory } from './seed-paths.js';

/**
 * The declarative fixture format.
 *
 * These types mirror `seed/fixtures/*.json` exactly. The fixtures are the thing
 * a human edits; everything under `seed/generated/` is derived from them by
 * `pnpm seed:generate` and must never be hand-edited.
 *
 * Every instant is an ISO-8601 string here rather than an `Instant`, because a
 * fixture is text a person reads. The generator converts them once, at the
 * boundary, through `@compass/clock` — no other layer parses a date string.
 */

export interface FixtureTimeline {
  readonly datasetStart: string;
  readonly datasetEnd: string;
  readonly now: string;
  readonly reportWindowStart: string;
  readonly reportWindowEnd: string;
  readonly firstSprintStart: string;
  readonly sprintLengthDays: number;
  readonly workdayStartHour: number;
  readonly workdayEndHour: number;
}

export interface FixtureSource {
  readonly sourceKey: string;
  readonly sourceKind: SourceKind;
  readonly availability:
    | { readonly status: 'available' }
    | { readonly status: 'unavailable'; readonly reason: CoverageReason; readonly detail: string };
}

export interface FixtureObjective {
  readonly key: string;
  readonly kind: 'company' | 'quarter';
  readonly parentKey: string | null;
  readonly current: boolean;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string;
  readonly title: string;
}

export interface FixtureTeam {
  readonly key: string;
  readonly name: string;
  readonly methodology: 'scrum' | 'kanban';
  readonly projectKey: string;
  readonly objectiveKey: string;
  readonly conversationKey: string;
}

export interface FixtureConversation {
  readonly key: string;
  readonly name: string;
  readonly teamKey: string | null;
  readonly messageCount: number;
}

export interface FixtureOrganization {
  readonly datasetId: string;
  readonly organizationId: string;
  readonly companyName: string;
  readonly randomSeed: string;
  readonly timeline: FixtureTimeline;
  readonly sources: readonly FixtureSource[];
  readonly objectives: readonly FixtureObjective[];
  readonly teams: readonly FixtureTeam[];
  readonly conversations: readonly FixtureConversation[];
}

export interface FixtureDeveloper {
  readonly key: string;
  readonly displayName: string;
  readonly teamKey: string;
  readonly gitEmails: readonly string[];
  readonly trackerAccount: string;
  readonly chatHandle: string;
}

export interface FixtureUnmappedEmail {
  readonly address: string;
  readonly displayName: string | null;
  readonly note: string;
}

export interface FixturePeople {
  readonly developers: readonly FixtureDeveloper[];
  readonly unmappedGitEmails: readonly FixtureUnmappedEmail[];
}

export interface FixtureSprintPlan {
  readonly name: string;
  readonly goal: string;
}

export interface FixtureProject {
  readonly key: string;
  readonly name: string;
  readonly teamKey: string;
  readonly methodology: 'scrum' | 'kanban';
  readonly firstIssueNumber: number;
  readonly issueCount: number;
  readonly implementedCount: number;
  readonly repositories: readonly string[];
  readonly defaultBranch: string;
  readonly statuses: readonly string[];
  readonly itemTypes: readonly string[];
  readonly pointScale: readonly number[];
  readonly labels: readonly string[];
  readonly sprints: readonly FixtureSprintPlan[];
  readonly titleStems: readonly string[];
}

export interface FixtureRelease {
  readonly repositoryKey: string;
  readonly name: string;
  readonly releasedAt: string;
  readonly description: string;
}

export interface FixtureProjects {
  readonly projects: readonly FixtureProject[];
  readonly releases: readonly FixtureRelease[];
}

export interface FixtureSemanticSubject {
  readonly subject: string;
  /** `PLAT/Sprint 43` or `OBJ-Q3-CHK` — the text this subject was written against. */
  readonly matches: string;
}

export interface FixtureNarrative {
  readonly workSubjects: readonly string[];
  readonly semanticSubjects: readonly FixtureSemanticSubject[];
  readonly unattributedSubjects: readonly string[];
  readonly semanticBranchNames: readonly string[];
  readonly unattributedBranchNames: readonly string[];
  readonly reviewComments: readonly string[];
  readonly messageTemplates: {
    readonly standup: readonly string[];
    readonly release: readonly string[];
    readonly flow: readonly string[];
  };
}

export interface FixturePathologies {
  readonly offGoalWorkStream: {
    readonly id: string;
    readonly title: string;
    readonly servesObjectiveKey: string;
    readonly currentObjectiveKey: string;
    readonly projectKey: string;
    readonly repositoryKey: string;
    readonly developerKey: string;
    readonly sprintName: string;
    readonly branchName: string;
    readonly windowStart: string;
    readonly windowEnd: string;
    readonly issues: readonly {
      readonly itemKey: string;
      readonly title: string;
      readonly points: number;
      readonly createdAt: string;
      readonly status: string;
    }[];
    readonly commits: readonly {
      readonly revisionId: string;
      readonly itemKey: string;
      readonly subject: string;
      readonly occurredAt: string;
    }[];
  };
  readonly reviewBottleneck: {
    readonly id: string;
    readonly title: string;
    readonly reviewerDeveloperKey: string;
    readonly reviewerName: string;
    readonly repositoryKey: string;
    readonly windowStart: string;
    readonly windowEnd: string;
    readonly pullRequests: readonly {
      readonly displayNumber: number;
      readonly authorDeveloperKey: string;
      readonly itemKey: string;
      readonly title: string;
      readonly createdAt: string;
    }[];
  };
  readonly slippingRelease: {
    readonly id: string;
    readonly title: string;
    readonly repositoryKey: string;
    readonly releaseTagName: string;
    readonly candidateTagName: string;
    readonly plannedAt: string;
    readonly actualAt: string;
    readonly windowStart: string;
    readonly windowEnd: string;
    readonly trackingItemKey: string;
    readonly trackingTitle: string;
    readonly conversationKey: string;
  };
  readonly blockedThenMerged: {
    readonly id: string;
    readonly title: string;
    readonly itemKey: string;
    readonly issueTitle: string;
    readonly projectKey: string;
    readonly repositoryKey: string;
    readonly developerKey: string;
    readonly sprintName: string;
    readonly points: number;
    readonly createdAt: string;
    readonly blockedFlaggedAt: string;
    readonly mergedAt: string;
    readonly pullRequestNumber: number;
    readonly branchName: string;
    readonly mergeRevisionId: string;
    readonly headRevisionId: string;
    readonly chatClaimAt: string;
  };
  readonly estimationNoise: {
    readonly id: string;
    readonly title: string;
    readonly projectKey: string;
    readonly expectedVerdict: string;
    readonly correlationThreshold: number;
    readonly minimumSampleSize: number;
    readonly samples: readonly {
      readonly itemKey: string;
      readonly points: number;
      readonly elapsedWorkingDays: number;
      readonly sprintName: string;
    }[];
  };
  readonly doneWithNoPullRequest: {
    readonly id: string;
    readonly title: string;
    readonly itemKey: string;
    readonly issueTitle: string;
    readonly projectKey: string;
    readonly developerKey: string;
    readonly createdAt: string;
    readonly doneAt: string;
  };
  readonly mergedNotReleased: {
    readonly id: string;
    readonly title: string;
    readonly repositoryKey: string;
    readonly latestReleaseTagName: string;
    readonly latestReleaseAt: string;
    readonly oldestUnreleasedPullRequestNumber: number;
    readonly pullRequests: readonly {
      readonly displayNumber: number;
      readonly itemKey: string;
      readonly title: string;
      readonly authorDeveloperKey: string;
      readonly mergedAt: string;
      readonly mergeRevisionId: string;
    }[];
  };
  readonly technicalDebtGrowth: {
    readonly id: string;
    readonly title: string;
    readonly projectKey: string;
    readonly label: string;
    readonly cohorts: readonly {
      readonly sprintName: string;
      readonly openedAt: string;
      readonly issues: readonly { readonly itemKey: string; readonly title: string }[];
    }[];
  };
  readonly unmatchedIdentityCommits: {
    readonly id: string;
    readonly title: string;
    readonly repositoryKey: string;
    readonly branchName: string;
    readonly commits: readonly {
      readonly revisionId: string;
      readonly address: string;
      readonly subject: string;
      readonly occurredAt: string;
    }[];
  };
}

export interface SeedFixtures {
  readonly organization: FixtureOrganization;
  readonly people: FixturePeople;
  readonly projects: FixtureProjects;
  readonly narrative: FixtureNarrative;
  readonly pathologies: FixturePathologies;
}

/** The five fixture files, in the order the manifest lists them. */
export const FIXTURE_FILE_NAMES = [
  'organization.json',
  'people.json',
  'projects.json',
  'narrative.json',
  'pathologies.json',
] as const;

export class FixtureParseError extends Error {
  constructor(fileName: string, cause: string) {
    super(`seed/fixtures/${fileName} could not be read: ${cause}`);
    this.name = 'FixtureParseError';
  }
}

function readFixture<TShape>(directory: string, fileName: string): TShape {
  let raw: string;
  try {
    raw = readFileSync(join(directory, fileName), 'utf8');
  } catch (cause) {
    throw new FixtureParseError(fileName, cause instanceof Error ? cause.message : String(cause));
  }
  try {
    return JSON.parse(raw) as TShape;
  } catch (cause) {
    throw new FixtureParseError(fileName, cause instanceof Error ? cause.message : String(cause));
  }
}

/** Loads all five fixture files from `seed/fixtures` (or an explicit directory). */
export function loadSeedFixtures(fixturesDirectory: string = seedFixturesDirectory(resolveSeedDirectory())): SeedFixtures {
  return {
    organization: readFixture<FixtureOrganization>(fixturesDirectory, 'organization.json'),
    people: readFixture<FixturePeople>(fixturesDirectory, 'people.json'),
    projects: readFixture<FixtureProjects>(fixturesDirectory, 'projects.json'),
    narrative: readFixture<FixtureNarrative>(fixturesDirectory, 'narrative.json'),
    pathologies: readFixture<FixturePathologies>(fixturesDirectory, 'pathologies.json'),
  };
}
