import { toEpochMillis, toIso, windowContains, type Instant } from '@compass/clock';
import { ARTIFACT_KINDS } from '@compass/connector-port';

import type { SeedDataset } from './dataset.js';
import { FIXTURE_FILE_NAMES, type SeedFixtures } from './fixtures.js';
import type { GeneratedSeed } from './generator.js';
import { artifactFileName, MANIFEST_DATA_FILE_NAME } from './serialize.js';
import {
  SEMANTIC_MATCH_THRESHOLD,
  TRACEABILITY_CLASSES,
  traceabilityDistribution,
  type TraceabilityDistributionEntry,
} from './traceability.js';

/**
 * The manifest: what is in the seed, stated in numbers and identifiers.
 *
 * It is generated, never hand-written, because a hand-written manifest drifts
 * from the data the first time the volume changes and then quietly lies. Two
 * tests keep it honest: one recomputes every count from the generated dataset
 * and compares it to the numbers printed in `seed/MANIFEST.md`, and one pulls
 * every identifier out of the prose and resolves it against a real row.
 */

export interface ManifestRequirement {
  readonly label: string;
  readonly required: number;
  readonly observed: number;
  readonly satisfied: boolean;
}

export interface ManifestIdentity {
  readonly developer: string;
  readonly gitEmails: readonly string[];
  readonly trackerAccount: string;
  readonly chatHandle: string;
}

export interface ManifestUnmappedEmail {
  readonly address: string;
  readonly commitCount: number;
  readonly note: string;
}

export interface ManifestPathology {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  /** Every entity identifier this pathology names; each must resolve to a row. */
  readonly identifiers: readonly string[];
}

export interface ManifestTraceability {
  readonly threshold: number;
  readonly designTargets: readonly { readonly traceabilityClass: string; readonly percentage: number }[];
  readonly dataset: readonly TraceabilityDistributionEntry[];
  readonly reportWindow: readonly TraceabilityDistributionEntry[];
}

export interface SeedManifest {
  readonly datasetId: string;
  readonly organizationId: string;
  readonly companyName: string;
  readonly fixtureFiles: readonly string[];
  readonly generatedFiles: readonly string[];
  readonly window: { readonly start: string; readonly end: string };
  readonly reportWindow: { readonly start: string; readonly end: string };
  readonly now: string;
  readonly recordCounts: Readonly<Record<string, number>>;
  readonly totalRecords: number;
  readonly volumes: {
    readonly projects: number;
    readonly teams: number;
    readonly repositories: number;
    readonly developers: number;
    readonly conversations: number;
    readonly sprintsCompleted: number;
    readonly sprintsInFlight: number;
  };
  readonly requirements: readonly ManifestRequirement[];
  readonly objectives: readonly {
    readonly key: string;
    readonly title: string;
    readonly current: boolean;
    readonly effectiveFrom: string;
    readonly effectiveUntil: string;
  }[];
  readonly identities: readonly ManifestIdentity[];
  readonly unmappedGitEmails: readonly ManifestUnmappedEmail[];
  readonly kanbanTeam: {
    readonly teamKey: string;
    readonly projectKey: string;
    readonly sprintRows: number;
    readonly issueCount: number;
    readonly issuesCarryingPoints: number;
  };
  readonly pathologies: readonly ManifestPathology[];
  readonly traceability: ManifestTraceability;
}

/** The proportions the seed is authored to hit. Observed counts are authoritative. */
const DESIGN_TARGETS = [
  { traceabilityClass: 'structural', percentage: 55 },
  { traceabilityClass: 'inferred', percentage: 25 },
  { traceabilityClass: 'semantic', percentage: 12 },
  { traceabilityClass: 'unattributed', percentage: 8 },
] as const;

export function computeManifest(generated: GeneratedSeed, fixtures: SeedFixtures): SeedManifest {
  const { dataset } = generated;
  const records = dataset.records;

  const recordCounts = Object.fromEntries(
    ARTIFACT_KINDS.map((artifact) => [artifact, (records[artifact] as readonly unknown[]).length]),
  ) as Record<string, number>;
  const totalRecords = Object.values(recordCounts).reduce((sum, count) => sum + count, 0);

  const conversationNames = new Set(records.messages.map((message) => message.conversationName));
  const repositories = new Set(fixtures.projects.projects.flatMap((project) => project.repositories));
  const sprintsCompleted = records.sprints.filter((sprint) => sprint.state === 'closed').length;
  const sprintsInFlight = records.sprints.filter((sprint) => sprint.state === 'active').length;

  const commitEmailCounts = new Map<string, number>();
  for (const commit of records.commits) {
    const address = commit.authorIdentity.value;
    commitEmailCounts.set(address, (commitEmailCounts.get(address) ?? 0) + 1);
  }

  const kanbanTeam = fixtures.organization.teams.find((team) => team.methodology === 'kanban');
  const kanbanProjectKey = kanbanTeam?.projectKey ?? '';
  const kanbanIssues = records.issues.filter((issue) => issue.projectKey === kanbanProjectKey);

  const reportWindowCommits = records.commits.filter((commit) =>
    windowContains(generated.reportWindow, commit.occurredAt),
  );

  return {
    datasetId: dataset.datasetId,
    organizationId: generated.organizationId,
    companyName: generated.companyName,
    fixtureFiles: FIXTURE_FILE_NAMES.map((name) => `seed/fixtures/${name}`),
    generatedFiles: [
      ...ARTIFACT_KINDS.map((artifact) => `seed/generated/${artifactFileName(artifact)}`),
      'seed/generated/dataset.json',
      `seed/generated/${MANIFEST_DATA_FILE_NAME}`,
      'seed/MANIFEST.md',
    ],
    window: { start: toIso(generated.datasetWindow.start), end: toIso(generated.datasetWindow.end) },
    reportWindow: { start: toIso(generated.reportWindow.start), end: toIso(generated.reportWindow.end) },
    now: toIso(generated.now),
    recordCounts,
    totalRecords,
    volumes: {
      projects: fixtures.projects.projects.length,
      teams: fixtures.organization.teams.length,
      repositories: repositories.size,
      developers: fixtures.people.developers.length,
      conversations: conversationNames.size,
      sprintsCompleted,
      sprintsInFlight,
    },
    requirements: [
      requirement('Projects', 3, fixtures.projects.projects.length),
      requirement('Developers', 12, fixtures.people.developers.length),
      requirement('Completed sprints', 4, sprintsCompleted),
      requirement('In-flight sprints', 1, sprintsInFlight),
      requirement('Commits', 600, recordCounts['commits'] ?? 0),
      requirement('Pull requests', 120, recordCounts['pull_requests'] ?? 0),
      requirement('Issues', 300, recordCounts['issues'] ?? 0),
      requirement('Messages', 800, recordCounts['messages'] ?? 0),
      requirement('Conversations carrying messages', 3, conversationNames.size),
      requirement('Commits from unmapped git addresses', 5, countUnmappedCommits(fixtures, commitEmailCounts)),
    ],
    objectives: generated.objectives.map((objective) => ({
      key: objective.key,
      title: objective.title,
      current: objective.current,
      effectiveFrom: objective.effectiveFrom,
      effectiveUntil: objective.effectiveUntil,
    })),
    identities: fixtures.people.developers.map((developer) => ({
      developer: developer.displayName,
      gitEmails: [...developer.gitEmails],
      trackerAccount: developer.trackerAccount,
      chatHandle: developer.chatHandle,
    })),
    unmappedGitEmails: fixtures.people.unmappedGitEmails.map((entry) => ({
      address: entry.address,
      commitCount: commitEmailCounts.get(entry.address) ?? 0,
      note: entry.note,
    })),
    kanbanTeam: {
      teamKey: kanbanTeam?.key ?? '',
      projectKey: kanbanProjectKey,
      sprintRows: records.sprints.filter((sprint) => sprint.projectKey === kanbanProjectKey).length,
      issueCount: kanbanIssues.length,
      issuesCarryingPoints: kanbanIssues.filter((issue) => issue.estimatePoints !== null).length,
    },
    pathologies: describePathologies(fixtures, records),
    traceability: {
      threshold: SEMANTIC_MATCH_THRESHOLD,
      designTargets: DESIGN_TARGETS.map((target) => ({ ...target })),
      dataset: traceabilityDistribution(records.commits, generated.traceabilityContext),
      reportWindow: traceabilityDistribution(reportWindowCommits, generated.traceabilityContext),
    },
  };
}

const requirement = (label: string, required: number, observed: number): ManifestRequirement => ({
  label,
  required,
  observed,
  satisfied: observed >= required,
});

function countUnmappedCommits(fixtures: SeedFixtures, counts: ReadonlyMap<string, number>): number {
  return fixtures.people.unmappedGitEmails.reduce((sum, entry) => sum + (counts.get(entry.address) ?? 0), 0);
}

/**
 * Every pull request merged into a repository after its newest release tag.
 *
 * Measured, not read off the fixture. The planted pull requests are not the only
 * ones that can land in that tail — a generated `platform-api` merge whose
 * ticket resolved late falls in it too — so a fixture count would understate the
 * real number the moment volume changes.
 */
function unreleasedMerges(
  records: SeedDataset['records'],
  repositoryKey: string,
): readonly { readonly displayNumber: number; readonly mergedAt: Instant }[] {
  const tags = records.release_tags.filter((tag) => tag.repositoryKey === repositoryKey);
  if (tags.length === 0) return [];
  const latest = tags.reduce((newest, tag) =>
    toEpochMillis(tag.releasedAt) > toEpochMillis(newest.releasedAt) ? tag : newest,
  );

  return records.pull_requests
    .flatMap((request) =>
      request.repositoryKey === repositoryKey &&
      request.mergedAt !== null &&
      toEpochMillis(request.mergedAt) > toEpochMillis(latest.releasedAt)
        ? [{ displayNumber: request.displayNumber, mergedAt: request.mergedAt }]
        : [],
    )
    .sort((left, right) => toEpochMillis(left.mergedAt) - toEpochMillis(right.mergedAt));
}

function describePathologies(
  fixtures: SeedFixtures,
  records: SeedDataset['records'],
): readonly ManifestPathology[] {
  const pathologies = fixtures.pathologies;
  const offGoal = pathologies.offGoalWorkStream;
  const bottleneck = pathologies.reviewBottleneck;
  const slip = pathologies.slippingRelease;
  const blocked = pathologies.blockedThenMerged;
  const noise = pathologies.estimationNoise;
  const hygiene = pathologies.doneWithNoPullRequest;
  const unreleased = pathologies.mergedNotReleased;
  const unreleasedTail = unreleasedMerges(records, unreleased.repositoryKey);
  const hygieneAudit = pathologies.processHygiene;
  const debt = pathologies.technicalDebtGrowth;

  return [
    {
      id: offGoal.id,
      title: offGoal.title,
      detail:
        `${offGoal.issues.length} tickets and ${offGoal.commits.length} commits inside \`${offGoal.sprintName}\` ` +
        `serve \`${offGoal.servesObjectiveKey}\`, an objective that stopped being current on ` +
        `${fixtures.organization.objectives.find((objective) => objective.key === offGoal.servesObjectiveKey)?.effectiveUntil ?? 'an earlier date'}. ` +
        `The current objective for that team is \`${offGoal.currentObjectiveKey}\`. Window ${offGoal.windowStart} to ${offGoal.windowEnd}.`,
      identifiers: [
        ...offGoal.issues.map((issue) => issue.itemKey),
        ...offGoal.commits.map((commit) => commit.revisionId),
        offGoal.servesObjectiveKey,
        offGoal.currentObjectiveKey,
        offGoal.sprintName,
      ],
    },
    {
      id: bottleneck.id,
      title: bottleneck.title,
      detail:
        `${bottleneck.pullRequests.length} open pull requests on \`${bottleneck.repositoryKey}\` all name ` +
        `\`${bottleneck.reviewerName}\` as the requested reviewer, the oldest opened ${bottleneck.pullRequests[0]?.createdAt ?? ''}. ` +
        `Window ${bottleneck.windowStart} to ${bottleneck.windowEnd}.`,
      identifiers: [
        bottleneck.reviewerName,
        ...bottleneck.pullRequests.map((request) => `#${request.displayNumber}`),
        ...bottleneck.pullRequests.map((request) => request.itemKey),
      ],
    },
    {
      id: slip.id,
      title: slip.title,
      detail:
        `\`${slip.releaseTagName}\` was planned for ${slip.plannedAt} and cut at ${slip.actualAt}; ` +
        `\`${slip.candidateTagName}\` is the candidate that preceded it. The slip is tracked by \`${slip.trackingItemKey}\` ` +
        `and narrated day by day in the release conversation. Window ${slip.windowStart} to ${slip.windowEnd}.`,
      identifiers: [slip.releaseTagName, slip.candidateTagName, slip.trackingItemKey],
    },
    {
      id: blocked.id,
      title: blocked.title,
      detail:
        `\`${blocked.itemKey}\` carries the tracker's blocked flag from ${blocked.blockedFlaggedAt} and its ` +
        `pull request \`#${blocked.pullRequestNumber}\` merged at ${blocked.mergedAt} — the same day. ` +
        `The merge commit is \`${blocked.mergeRevisionId}\`; the claim of being blocked is in the checkout conversation at ${blocked.chatClaimAt}.`,
      identifiers: [
        blocked.itemKey,
        `#${blocked.pullRequestNumber}`,
        blocked.mergeRevisionId,
        blocked.headRevisionId,
        blocked.sprintName,
      ],
    },
    {
      id: noise.id,
      title: noise.title,
      detail:
        `${noise.samples.length} completed tickets carry a story-point estimate and a measured elapsed duration whose ` +
        `Pearson correlation sits below the documented threshold of ${noise.correlationThreshold} at n ≥ ${noise.minimumSampleSize}, ` +
        `which is what a \`${noise.expectedVerdict}\` verdict is computed from.`,
      identifiers: noise.samples.map((sample) => sample.itemKey),
    },
    {
      id: hygiene.id,
      title: hygiene.title,
      detail:
        `\`${hygiene.itemKey}\` transitions to Done at ${hygiene.doneAt} with no pull request, no branch and no commit ` +
        `referencing it anywhere in the dataset.`,
      identifiers: [hygiene.itemKey],
    },
    {
      id: unreleased.id,
      title: unreleased.title,
      detail:
        `${unreleasedTail.length} pull requests merged into \`${unreleased.repositoryKey}\` after ` +
        `\`${unreleased.latestReleaseTagName}\` was cut at ${unreleased.latestReleaseAt}. The oldest unreleased item is ` +
        `\`#${unreleasedTail[0]?.displayNumber ?? unreleased.oldestUnreleasedPullRequestNumber}\`.`,
      identifiers: [
        ...new Set([
          unreleased.latestReleaseTagName,
          // The measured oldest, which the prose names and which need not be one
          // of the planted three.
          ...unreleasedTail.slice(0, 1).map((request) => `#${request.displayNumber}`),
          ...unreleased.pullRequests.map((request) => `#${request.displayNumber}`),
          ...unreleased.pullRequests.map((request) => request.itemKey),
          ...unreleased.pullRequests.map((request) => request.mergeRevisionId),
        ]),
      ],
    },
    {
      id: hygieneAudit.id,
      title: hygieneAudit.title,
      detail:
        `\`${hygieneAudit.doubleCountedParent.itemKey}\` carries ${hygieneAudit.doubleCountedParent.points} points ` +
        `and its ${hygieneAudit.doubleCountedParent.subTasks.length} sub-tasks carry ` +
        `${hygieneAudit.doubleCountedParent.subTasks.map((subTask) => subTask.points).join(' and ')}, so a total ` +
        'spanning both levels counts it twice.\n' +
        `\`${hygieneAudit.staleTicket.itemKey}\` entered In Progress at ${hygieneAudit.staleTicket.inProgressAt} and ` +
        `sat for ${hygieneAudit.staleTicket.expectedStaleWorkingDays} working days with no commit and no pull ` +
        'request.\n' +
        `Negative controls: \`${hygieneAudit.recentlyMoved.itemKey}\` moved yesterday; ` +
        `\`${hygieneAudit.activelyPushed.itemKey}\` is older but was committed to as ` +
        `\`${hygieneAudit.activelyPushed.revisionId}\`.`,
      identifiers: [
        hygieneAudit.doubleCountedParent.itemKey,
        ...hygieneAudit.doubleCountedParent.subTasks.map((subTask) => subTask.itemKey),
        hygieneAudit.staleTicket.itemKey,
        hygieneAudit.recentlyMoved.itemKey,
        hygieneAudit.activelyPushed.itemKey,
        hygieneAudit.activelyPushed.revisionId,
      ],
    },
    {
      id: debt.id,
      title: debt.title,
      detail:
        `Tickets labelled \`${debt.label}\` opened per sprint: ` +
        debt.cohorts.map((cohort) => `${cohort.sprintName} → ${cohort.issues.length}`).join(', ') +
        '. The count rises every sprint, which is the growth signal.',
      identifiers: debt.cohorts.flatMap((cohort) => [
        cohort.sprintName,
        ...cohort.issues.map((issue) => issue.itemKey),
      ]),
    },
  ];
}

// ---------------------------------------------------------------------------

const backtick = (value: string | number): string => `\`${value}\``;

const row = (cells: readonly (string | number)[]): string => `| ${cells.join(' | ')} |`;

const table = (headers: readonly string[], rows: readonly (readonly (string | number)[])[]): string =>
  [row(headers), row(headers.map(() => '---')), ...rows.map(row)].join('\n');

/** Renders `seed/MANIFEST.md`. Every number here is recomputed by a test. */
export function renderManifestMarkdown(manifest: SeedManifest, dataset: SeedDataset): string {
  const lines: string[] = [];

  lines.push(
    '# Seed manifest',
    '',
    `**Generated file — do not edit.** Run \`pnpm seed:generate\` after changing anything under \`seed/fixtures/\`.`,
    '',
    `Dataset \`${manifest.datasetId}\` for ${manifest.companyName}, organization \`${manifest.organizationId}\`.`,
    '',
    `- Dataset window: \`${manifest.window.start}\` → \`${manifest.window.end}\` (half-open)`,
    `- One daily report covers: \`${manifest.reportWindow.start}\` → \`${manifest.reportWindow.end}\``,
    `- The seeded \`now\`: \`${manifest.now}\``,
    `- Sources: ${dataset.sources.map((source) => `\`${source.sourceKey}\` (${source.sourceKind}${source.availability.status === 'unavailable' ? ', deliberately down' : ''})`).join(', ')}`,
    '',
    '## How to regenerate',
    '',
    'The fixtures are the input and are hand-edited; everything under `seed/generated/` and this file are output.',
    '',
    ...manifest.fixtureFiles.map((file) => `- \`${file}\``),
    '',
    'Running the generator twice produces byte-identical files: there is no clock read, no `Math.random` and no',
    'locale-sensitive comparison anywhere in the expansion. `pnpm seed:generate` followed by `git diff --exit-code`',
    'is therefore a determinism check, and the test suite runs the equivalent in memory.',
    '',
    '## Volume',
    '',
    table(
      ['Requirement', 'Required', 'In this dataset', 'Met'],
      manifest.requirements.map((entry) => [
        entry.label,
        entry.required,
        entry.observed,
        entry.satisfied ? 'yes' : 'NO',
      ]),
    ),
    '',
    'Record counts by artifact family, as the connector returns them:',
    '',
    table(
      ['Artifact', 'Rows', 'File'],
      Object.entries(manifest.recordCounts).map(([artifact, count]) => [
        artifact,
        count,
        backtick(`seed/generated/${artifact}.json`),
      ]),
    ),
    '',
    `Total: **${manifest.totalRecords}** records across ${manifest.volumes.projects} projects, ${manifest.volumes.teams} teams, ${manifest.volumes.repositories} repositories and ${manifest.volumes.conversations} conversations.`,
    '',
    '## Objectives',
    '',
    table(
      ['Key', 'Title', 'Current at `now`', 'Effective'],
      manifest.objectives.map((objective) => [
        backtick(objective.key),
        objective.title,
        objective.current ? 'yes' : 'no',
        `${objective.effectiveFrom} → ${objective.effectiveUntil}`,
      ]),
    ),
    '',
    '## Fragmented identities',
    '',
    'Every developer holds two or more git author emails, exactly one tracker account and exactly one chat handle.',
    'Nothing in the dataset lets a consumer assume one address is one person.',
    '',
    table(
      ['Developer', 'Git emails', 'Tracker account', 'Chat handle'],
      manifest.identities.map((entry) => [
        backtick(entry.developer),
        entry.gitEmails.map(backtick).join(' '),
        backtick(entry.trackerAccount),
        backtick(entry.chatHandle),
      ]),
    ),
    '',
    '### Addresses that must land in the unmatched queue',
    '',
    'These addresses author commits and belong to no developer. Attribution by name similarity is forbidden, which is',
    'why one of them is a near-miss for a real person.',
    '',
    table(
      ['Address', 'Commits', 'Why it is here'],
      manifest.unmappedGitEmails.map((entry) => [backtick(entry.address), entry.commitCount, entry.note]),
    ),
    '',
    '## The Kanban team',
    '',
    `Team \`${manifest.kanbanTeam.teamKey}\` (project \`${manifest.kanbanTeam.projectKey}\`) runs Kanban: it has **${manifest.kanbanTeam.sprintRows} sprint rows**, and **${manifest.kanbanTeam.issuesCarryingPoints} of its ${manifest.kanbanTeam.issueCount} tickets carry story points**.`,
    '',
    'Sprint completion percentage, velocity and a sprint goal do not exist for this team, and the report must not',
    'invent them. Alignment for its work resolves against the quarter objective instead.',
    '',
    '## Planted pathologies',
    '',
    'Each of these is planted deliberately and named here by the exact identifiers involved. A test resolves every',
    'identifier below against a real row in the generated dataset.',
    '',
  );

  for (const pathology of manifest.pathologies) {
    lines.push(
      `### ${pathology.title}`,
      '',
      `**id:** \`${pathology.id}\``,
      '',
      pathology.detail,
      '',
      `**Entities:** ${[...new Set(pathology.identifiers)].map(backtick).join(', ')}`,
      '',
    );
  }

  lines.push(
    '## Traceability classes',
    '',
    'Commits are distributed across four classes on purpose. The resolution order is: a ticket key in the commit',
    'message for a ticket that sits on a sprint with a goal (`structural`); a ticket key in the branch name only, or a',
    'ticket with no goal chain (`inferred`); no key at all but wording that clears the documented Sørensen–Dice',
    `threshold of \`${manifest.traceability.threshold}\` against a goal or objective (\`semantic\`); nothing (\`unattributed\`).`,
    '',
    '### Across the whole dataset',
    '',
    table(
      ['Class', 'Commits', 'Share', 'Design target'],
      manifest.traceability.dataset.map((entry) => [
        backtick(entry.traceabilityClass),
        entry.count,
        `${entry.percentage.toFixed(1)}%`,
        `${manifest.traceability.designTargets.find((target) => target.traceabilityClass === entry.traceabilityClass)?.percentage ?? 0}%`,
      ]),
    ),
    '',
    '### Inside the single report window',
    '',
    'All four resolution paths are exercised by one report, so the alignment section can never be tested against a',
    'dataset that quietly avoids its hardest case.',
    '',
    table(
      ['Class', 'Commits', 'Share'],
      manifest.traceability.reportWindow.map((entry) => [
        backtick(entry.traceabilityClass),
        entry.count,
        `${entry.percentage.toFixed(1)}%`,
      ]),
    ),
    '',
    '## Generated files',
    '',
    ...manifest.generatedFiles.map((file) => `- \`${file}\``),
    '',
  );

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** The four class names, re-exported so the manifest test does not import two modules. */
export const MANIFEST_TRACEABILITY_CLASSES = TRACEABILITY_CLASSES;
