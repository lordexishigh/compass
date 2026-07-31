import {
  MILLIS_PER_DAY,
  MILLIS_PER_HOUR,
  MILLIS_PER_MINUTE,
  addMillis,
  instantFromIso,
  timeWindow,
  toEpochMillis,
  toIso,
  windowContains,
  type Instant,
  type TimeWindow,
} from '@compass/clock';
import {
  sortRecords,
  type BranchRefRecord,
  type CommitRecord,
  type ExternalIdentity,
  type IssueRecord,
  type IssueTransitionRecord,
  type MessageRecord,
  type PullRequestRecord,
  type ReleaseTagRecord,
  type ReviewRecord,
  type SprintRecord,
  type SprintScopeChangeRecord,
  type WorkItemStatusCategory,
} from '@compass/connector-port';

import type { SeedDataset } from './dataset.js';
import type { FixtureDeveloper, FixtureProject, SeedFixtures } from './fixtures.js';
import { createRng, hashSeed, type Rng } from './rng.js';
import { slugify } from './text.js';
import {
  TRACEABILITY_CLASSES,
  buildTraceabilityContext,
  classifyCommitTraceability,
  type TraceabilityClass,
  type TraceabilityContext,
} from './traceability.js';

/**
 * The deterministic seed generator.
 *
 * Given the checked-in fixtures it expands them into the full dataset â€” around
 * three thousand records â€” with no randomness the machine can see: no host
 * clock, no `Math.random`, no locale-sensitive comparison, no dependence on
 * object iteration order beyond the fixed order this file writes. Run it twice
 * and the bytes are identical; that is the property `pnpm seed:generate`
 * followed by `git diff --exit-code` checks.
 *
 * It is also self-checking. The generator records the traceability class each
 * commit was *authored* to be, then re-derives every class through the same
 * classifier the report uses and refuses to emit a dataset if the two disagree.
 * An edit to `seed/fixtures/narrative.json` that quietly turns a semantic commit
 * into an unattributed one therefore fails here, loudly, rather than silently
 * changing what the alignment section says.
 */

export class SeedGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedGenerationError';
  }
}

export interface GeneratedObjective {
  readonly key: string;
  readonly kind: 'company' | 'quarter';
  readonly parentKey: string | null;
  readonly current: boolean;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string;
  readonly title: string;
}

export interface GeneratedSeed {
  readonly dataset: SeedDataset;
  readonly organizationId: string;
  readonly companyName: string;
  /** The whole span the fixtures cover â€” the window the contract suite uses. */
  readonly datasetWindow: TimeWindow;
  /** Yesterday relative to `now`: the window one daily report covers. */
  readonly reportWindow: TimeWindow;
  readonly now: Instant;
  readonly objectives: readonly GeneratedObjective[];
  readonly unavailableSourceKey: string | null;
  /** Authored intent per commit revision, checked against the classifier. */
  readonly intendedTraceability: ReadonlyMap<string, TraceabilityClass>;
  readonly traceabilityContext: TraceabilityContext;
}

const CODE_SOURCE_KEY = 'primary-code';
const TRACKER_SOURCE_KEY = 'primary-tracker';
const CHAT_SOURCE_KEY = 'team-chat';

const CODE = { sourceKey: CODE_SOURCE_KEY, sourceKind: 'code' } as const;
const TRACKER = { sourceKey: TRACKER_SOURCE_KEY, sourceKind: 'tracker' } as const;
const CHAT = { sourceKey: CHAT_SOURCE_KEY, sourceKind: 'chat' } as const;

const FIRST_PULL_REQUEST_NUMBER = 8001;

/** Title qualifiers, so a stem reused across a long backlog is not a duplicate. */
const TITLE_QUALIFIERS = [
  '',
  ' on the retry path',
  ' for large merchants',
  ' under sustained load',
  ' after a redeploy',
  ' in the sandbox environment',
  ' for the mobile client',
  ' when the cache is cold',
] as const;

const identity = (
  kind: ExternalIdentity['kind'],
  value: string,
  displayName: string | null,
): ExternalIdentity => ({ kind, value, displayName });

const gitIdentity = (developer: FixtureDeveloper, rotation: number): ExternalIdentity =>
  identity(
    'email',
    developer.gitEmails[rotation % developer.gitEmails.length] ?? developer.gitEmails[0] ?? 'unknown@example',
    developer.displayName,
  );

const trackerIdentity = (developer: FixtureDeveloper): ExternalIdentity =>
  identity('account', developer.trackerAccount, developer.displayName);

const chatIdentity = (developer: FixtureDeveloper): ExternalIdentity =>
  identity('handle', developer.chatHandle, developer.displayName);

interface WorkingIssue {
  readonly record: IssueRecord;
  readonly project: FixtureProject;
  readonly sprintRecordId: string | null;
  readonly assignee: FixtureDeveloper;
  readonly hasGoalChain: boolean;
}

/** The part of a sprint an issue needs: its identity and its committed scope. */
interface SprintRef {
  readonly recordId: string;
  readonly committedItemKeys: string[];
  readonly startAt: Instant;
}

interface BuildIssueInput {
  readonly project: FixtureProject;
  readonly itemKey: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: string;
  readonly statusCategory: WorkItemStatusCategory;
  readonly itemType: string;
  readonly priority: string | null;
  readonly estimatePoints: number | null;
  readonly labels: readonly string[];
  readonly assignee: FixtureDeveloper;
  readonly reporter: FixtureDeveloper;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly resolvedAt: Instant | null;
  readonly sprint: SprintRef | null;
  readonly flaggedBlocked: boolean;
}

interface TransitionInput {
  readonly fromStatus: string | null;
  readonly toStatus: string;
  readonly fromStatusCategory: WorkItemStatusCategory | null;
  readonly toStatusCategory: WorkItemStatusCategory;
  readonly at: Instant;
}

/**
 * Everything the generator accumulates, in one mutable bag. Records are frozen
 * into `SeedRecords` only at the very end, after sorting.
 */
interface Accumulator {
  readonly commits: CommitRecord[];
  readonly pullRequests: PullRequestRecord[];
  readonly reviews: ReviewRecord[];
  readonly branchRefs: BranchRefRecord[];
  readonly releaseTags: ReleaseTagRecord[];
  readonly issues: IssueRecord[];
  readonly issueTransitions: IssueTransitionRecord[];
  readonly sprints: SprintRecord[];
  readonly sprintScopeChanges: SprintScopeChangeRecord[];
  readonly messages: MessageRecord[];
  readonly intent: Map<string, TraceabilityClass>;
}

export function generateSeed(fixtures: SeedFixtures): GeneratedSeed {
  const { organization, people, projects, narrative } = fixtures;
  const timeline = organization.timeline;

  const datasetStart = instantFromIso(timeline.datasetStart);
  const datasetEnd = instantFromIso(timeline.datasetEnd);
  const datasetWindow = timeWindow(datasetStart, datasetEnd);
  const reportWindow = timeWindow(
    instantFromIso(timeline.reportWindowStart),
    instantFromIso(timeline.reportWindowEnd),
  );
  const now = instantFromIso(timeline.now);
  const firstSprintStart = instantFromIso(timeline.firstSprintStart);
  const sprintSpanMillis = timeline.sprintLengthDays * MILLIS_PER_DAY;
  const datasetSpanDays = Math.floor((toEpochMillis(datasetEnd) - toEpochMillis(datasetStart)) / MILLIS_PER_DAY);

  const rng = createRng(organization.randomSeed);
  const accumulator: Accumulator = {
    commits: [],
    pullRequests: [],
    reviews: [],
    branchRefs: [],
    releaseTags: [],
    issues: [],
    issueTransitions: [],
    sprints: [],
    sprintScopeChanges: [],
    messages: [],
    intent: new Map(),
  };

  const developersByKey = new Map(people.developers.map((developer) => [developer.key, developer]));
  const developersByTeam = new Map<string, FixtureDeveloper[]>();
  for (const developer of people.developers) {
    const roster = developersByTeam.get(developer.teamKey) ?? [];
    roster.push(developer);
    developersByTeam.set(developer.teamKey, roster);
  }

  const developerOrFail = (key: string): FixtureDeveloper => {
    const developer = developersByKey.get(key);
    if (!developer) throw new SeedGenerationError(`No developer with key \`${key}\` in seed/fixtures/people.json.`);
    return developer;
  };

  const rosterOrFail = (teamKey: string): readonly FixtureDeveloper[] => {
    const roster = developersByTeam.get(teamKey);
    if (!roster || roster.length === 0) {
      throw new SeedGenerationError(`Team \`${teamKey}\` has no developers in seed/fixtures/people.json.`);
    }
    return roster;
  };

  /** An instant `dayOffset` days into the dataset, inside working hours. */
  const workInstant = (dayOffset: number, stream: Rng): Instant => {
    const clampedDay = Math.max(0, Math.min(datasetSpanDays - 1, dayOffset));
    const hour = stream.between(timeline.workdayStartHour, timeline.workdayEndHour - 1);
    const minute = stream.between(0, 59);
    return addMillis(datasetStart, clampedDay * MILLIS_PER_DAY + hour * MILLIS_PER_HOUR + minute * MILLIS_PER_MINUTE);
  };

  /** Keeps a derived instant strictly inside the dataset window. */
  const clampToWindow = (instant: Instant): Instant => {
    const millis = toEpochMillis(instant);
    const min = toEpochMillis(datasetStart);
    const max = toEpochMillis(datasetEnd) - MILLIS_PER_MINUTE;
    if (millis < min) return datasetStart;
    if (millis > max) return addMillis(datasetEnd, -MILLIS_PER_MINUTE);
    return instant;
  };

  // ---------------------------------------------------------------- revisions

  const usedRevisions = new Set<string>();
  let revisionCounter = 0;
  const nextRevisionId = (): string => {
    for (let salt = 0; salt < 64; salt += 1) {
      revisionCounter += 1;
      const candidate = hashSeed(`${organization.datasetId}:revision:${revisionCounter}:${salt}`)
        .toString(16)
        .padStart(8, '0')
        .slice(0, 7);
      if (!usedRevisions.has(candidate)) {
        usedRevisions.add(candidate);
        return candidate;
      }
    }
    throw new SeedGenerationError('Could not find an unused revision identifier after 64 attempts.');
  };
  const reserveRevision = (revisionId: string): string => {
    if (usedRevisions.has(revisionId)) {
      throw new SeedGenerationError(`Planted revision \`${revisionId}\` collides with another revision.`);
    }
    usedRevisions.add(revisionId);
    return revisionId;
  };

  const pushCommit = (commit: CommitRecord, intended: TraceabilityClass): void => {
    accumulator.commits.push(commit);
    accumulator.intent.set(commit.revisionId, intended);
  };

  // ------------------------------------------------------------------ sprints

  interface WorkingSprint extends SprintRef {
    readonly project: FixtureProject;
    readonly name: string;
    readonly goal: string;
    readonly endAt: Instant;
  }

  const workingSprints: WorkingSprint[] = [];
  const sprintsByProjectAndName = new Map<string, WorkingSprint>();

  for (const project of projects.projects) {
    project.sprints.forEach((plan, index) => {
      const startAt = addMillis(firstSprintStart, index * sprintSpanMillis);
      const sprint: WorkingSprint = {
        recordId: `sprint-${project.key}-${index + 1}`,
        project,
        name: plan.name,
        goal: plan.goal,
        startAt,
        endAt: addMillis(startAt, sprintSpanMillis),
        committedItemKeys: [],
      };
      workingSprints.push(sprint);
      sprintsByProjectAndName.set(`${project.key}/${plan.name}`, sprint);
    });
  }

  const sprintCovering = (project: FixtureProject, instant: Instant): WorkingSprint | null => {
    const candidates = workingSprints.filter((sprint) => sprint.project.key === project.key);
    if (candidates.length === 0) return null;
    for (const sprint of candidates) {
      if (windowContains(timeWindow(sprint.startAt, sprint.endAt), instant)) return sprint;
    }
    return toEpochMillis(instant) < toEpochMillis(candidates[0]?.startAt ?? datasetStart)
      ? (candidates[0] ?? null)
      : (candidates[candidates.length - 1] ?? null);
  };

  // ------------------------------------------------------------------- issues

  const workingIssues: WorkingIssue[] = [];

  const buildIssue = (input: BuildIssueInput): WorkingIssue => {
    const record: IssueRecord = {
      ...TRACKER,
      sourceRecordId: `issue-${input.itemKey}`,
      occurredAt: clampToWindow(input.updatedAt),
      projectKey: input.project.key,
      itemKey: input.itemKey,
      title: input.title,
      description: input.description,
      status: input.status,
      statusCategory: input.statusCategory,
      itemType: input.itemType,
      priority: input.priority,
      estimatePoints: input.estimatePoints,
      labels: [...input.labels],
      assigneeIdentity: trackerIdentity(input.assignee),
      reporterIdentity: trackerIdentity(input.reporter),
      createdAt: clampToWindow(input.createdAt),
      updatedAt: clampToWindow(input.updatedAt),
      resolvedAt: input.resolvedAt === null ? null : clampToWindow(input.resolvedAt),
      parentItemKey: null,
      sprintRefs: input.sprint === null ? [] : [input.sprint.recordId],
      flaggedBlocked: input.flaggedBlocked,
    };
    if (input.sprint !== null) input.sprint.committedItemKeys.push(input.itemKey);

    const working: WorkingIssue = {
      record,
      project: input.project,
      sprintRecordId: input.sprint?.recordId ?? null,
      assignee: input.assignee,
      hasGoalChain: input.sprint !== null,
    };
    workingIssues.push(working);
    accumulator.issues.push(record);
    return working;
  };

  const pushTransitions = (issue: WorkingIssue, transitions: readonly TransitionInput[]): void => {
    transitions.forEach((transition, index) => {
      accumulator.issueTransitions.push({
        ...TRACKER,
        sourceRecordId: `transition-${issue.record.itemKey}-${index + 1}`,
        occurredAt: clampToWindow(transition.at),
        itemKey: issue.record.itemKey,
        fromStatus: transition.fromStatus,
        toStatus: transition.toStatus,
        fromStatusCategory: transition.fromStatusCategory,
        toStatusCategory: transition.toStatusCategory,
        actorIdentity: trackerIdentity(issue.assignee),
        transitionedAt: clampToWindow(transition.at),
      });
    });
  };

  for (const project of projects.projects) {
    const roster = rosterOrFail(project.teamKey);
    const isScrum = project.methodology === 'scrum';
    const backlogStatus = project.statuses[0] ?? 'To Do';
    const inProgressStatus = 'In Progress';
    const inReviewStatus = 'In Review';

    for (let index = 0; index < project.issueCount; index += 1) {
      const itemKey = `${project.key}-${project.firstIssueNumber + index}`;
      const stem = project.titleStems[index % project.titleStems.length] ?? 'Untitled work item';
      const qualifier = TITLE_QUALIFIERS[Math.floor(index / project.titleStems.length) % TITLE_QUALIFIERS.length] ?? '';
      const title = `${stem}${qualifier}`;

      const createdDay = Math.floor((index / project.issueCount) * (datasetSpanDays - 4));
      const createdAt = workInstant(createdDay, rng);
      const sprint = isScrum ? sprintCovering(project, createdAt) : null;
      const sprintIsClosed = sprint !== null && toEpochMillis(sprint.endAt) <= toEpochMillis(now);

      const assignee = rng.pick(roster);
      const reporter = rng.pick(roster);
      const doneChance = sprintIsClosed ? 0.86 : isScrum ? 0.42 : 0.5;
      const isDone = rng.chance(doneChance);
      const isBlocked = !isDone && isScrum && rng.chance(0.06);
      const inFlight = !isDone && !isBlocked && rng.chance(0.62);

      const workingDays = rng.between(1, 11);
      const resolvedAt = isDone ? clampToWindow(addMillis(createdAt, workingDays * MILLIS_PER_DAY)) : null;
      const updatedAt = resolvedAt ?? clampToWindow(addMillis(createdAt, rng.between(1, 6) * MILLIS_PER_DAY));

      const status = isDone
        ? 'Done'
        : isBlocked
          ? 'Blocked'
          : inFlight
            ? rng.chance(0.4)
              ? inReviewStatus
              : inProgressStatus
            : backlogStatus;
      const statusCategory: WorkItemStatusCategory = isDone ? 'done' : status === backlogStatus ? 'todo' : 'in_progress';

      const labels: string[] = [];
      if (rng.chance(0.55)) labels.push(rng.pick(project.labels));
      if (rng.chance(0.13)) labels.push('tech-debt');

      const estimatePoints =
        isScrum && project.pointScale.length > 0 && rng.chance(0.82) ? rng.pick(project.pointScale) : null;

      const issue = buildIssue({
        project,
        itemKey,
        title,
        description: rng.chance(0.6) ? `${title}. Raised by ${reporter.displayName} during triage.` : null,
        status,
        statusCategory,
        itemType: rng.pick(project.itemTypes),
        priority: rng.pick(['Low', 'Medium', 'High']),
        estimatePoints,
        labels: [...new Set(labels)].sort(),
        assignee,
        reporter,
        createdAt,
        updatedAt,
        resolvedAt,
        sprint,
        flaggedBlocked: isBlocked,
      });

      // A ticket cannot transition before it exists, and it cannot leave a
      // status it never entered. The offsets below are drawn independently of
      // `workingDays`, so each one is bounded by the interval the issue was
      // actually open for rather than trusted to land inside it: a one-day
      // ticket that drew a late start would otherwise be marked In Review
      // sixteen hours before it was raised. `assertGeneratedSeedIsSound` checks
      // the invariant over the emitted dataset, so this cannot drift.
      const openMillis = resolvedAt === null ? null : toEpochMillis(resolvedAt) - toEpochMillis(createdAt);
      const startOffset = MILLIS_PER_HOUR * rng.between(2, 30);
      const startedAt = addMillis(
        createdAt,
        openMillis === null ? startOffset : Math.min(startOffset, Math.floor(openMillis / 2)),
      );
      const transitions: TransitionInput[] = [];
      if (statusCategory !== 'todo') {
        transitions.push({
          fromStatus: backlogStatus,
          toStatus: inProgressStatus,
          fromStatusCategory: 'todo',
          toStatusCategory: 'in_progress',
          at: startedAt,
        });
      }
      if (isBlocked) {
        transitions.push({
          fromStatus: inProgressStatus,
          toStatus: 'Blocked',
          fromStatusCategory: 'in_progress',
          toStatusCategory: 'in_progress',
          at:
            toEpochMillis(updatedAt) > toEpochMillis(startedAt)
              ? updatedAt
              : addMillis(startedAt, MILLIS_PER_HOUR),
        });
      }
      if (isDone && resolvedAt !== null) {
        // The review window is a fraction of the interval the ticket was open,
        // not a fixed number of hours before it closed â€” long-lived tickets keep
        // the original spread, one-day tickets degrade to a few hours.
        const openHours = Math.max(
          1,
          Math.floor((toEpochMillis(resolvedAt) - toEpochMillis(startedAt)) / MILLIS_PER_HOUR),
        );
        transitions.push({
          fromStatus: inProgressStatus,
          toStatus: inReviewStatus,
          fromStatusCategory: 'in_progress',
          toStatusCategory: 'in_progress',
          at: addMillis(resolvedAt, -MILLIS_PER_HOUR * rng.between(1, Math.min(40, openHours))),
        });
        transitions.push({
          fromStatus: inReviewStatus,
          toStatus: 'Done',
          fromStatusCategory: 'in_progress',
          toStatusCategory: 'done',
          at: resolvedAt,
        });
      }
      pushTransitions(issue, transitions);
    }
  }

  // ------------------------------------------- branches, commits, PRs, reviews

  let pullRequestNumber = FIRST_PULL_REQUEST_NUMBER;

  const pushBranchRef = (repositoryKey: string, name: string, revisionId: string, observedAt: Instant, isDefault: boolean): void => {
    accumulator.branchRefs.push({
      ...CODE,
      sourceRecordId: `branch-${repositoryKey}-${name}`,
      occurredAt: clampToWindow(observedAt),
      repositoryKey,
      name,
      revisionId,
      isDefault,
      observedAt: clampToWindow(observedAt),
    });
  };

  for (const project of projects.projects) {
    const roster = rosterOrFail(project.teamKey);
    const implementable = workingIssues.filter(
      (issue) => issue.project.key === project.key && issue.record.statusCategory !== 'todo',
    );
    if (implementable.length < project.implementedCount) {
      throw new SeedGenerationError(
        `${project.key} needs ${project.implementedCount} implementable issues but only ${implementable.length} are not in the backlog. Raise issueCount in seed/fixtures/projects.json.`,
      );
    }
    // Taken at an even stride rather than off the front of the list. Issues are
    // created in date order, so `slice(0, n)` would put every branch, pull
    // request and review in the first weeks of the dataset and leave the window
    // the daily report actually covers almost empty.
    const stride = implementable.length / project.implementedCount;
    const implemented = Array.from({ length: project.implementedCount }, (_unused, position) => {
      const chosen = implementable[Math.min(implementable.length - 1, Math.floor(position * stride))];
      if (!chosen) throw new SeedGenerationError(`${project.key} could not select implementable issue ${position}.`);
      return chosen;
    });

    implemented.forEach((issue, position) => {
      const repositoryKey = project.repositories[position % project.repositories.length] ?? project.repositories[0] ?? project.key.toLowerCase();
      const prefix = project.methodology === 'scrum' ? 'feature' : 'work';
      const branchName = `${prefix}/${issue.record.itemKey}-${slugify(issue.record.title, 4)}`;

      // Eight branches in ten also name their ticket in every commit message
      // (structural); the rest leave the key in the branch alone, which is what
      // most real repositories look like. The Kanban project lands in `inferred`
      // whatever it does here, because its tickets have no goal above them.
      const keyInMessage = position % 10 < 8;
      const intended: TraceabilityClass = keyInMessage && issue.hasGoalChain ? 'structural' : 'inferred';

      // The merge instant is the ticket's own resolution, so the branch schedule
      // is laid out inside the interval the ticket was open rather than at a
      // fixed day per commit. A four-commit branch on a one-day ticket would
      // otherwise run past its own merge, and the merge commit would be dated
      // before the head commit it declares as its only parent â€” a child that
      // precedes its parent, which no code host could return. Same technique as
      // the issue transitions above; `assertGeneratedSeedIsSound` checks it over
      // the emitted dataset.
      const isMerged = issue.record.statusCategory === 'done';
      const plannedMergeAt = isMerged ? (issue.record.resolvedAt ?? null) : null;

      const commitCount = rng.between(3, 5);
      const startOffsetMillis = MILLIS_PER_HOUR * rng.between(4, 30);
      const startedAt = addMillis(
        issue.record.createdAt,
        plannedMergeAt === null
          ? startOffsetMillis
          : Math.min(
              startOffsetMillis,
              Math.floor((toEpochMillis(plannedMergeAt) - toEpochMillis(issue.record.createdAt)) / 4),
            ),
      );
      const strideMillis =
        plannedMergeAt === null
          ? MILLIS_PER_DAY
          : Math.max(
              MILLIS_PER_HOUR,
              Math.floor((toEpochMillis(plannedMergeAt) - toEpochMillis(startedAt)) / (commitCount + 1)),
            );
      const revisions: string[] = [];

      for (let step = 0; step < commitCount; step += 1) {
        const subject = rng.pick(narrative.workSubjects);
        const drawnAt = addMillis(startedAt, step * strideMillis + MILLIS_PER_MINUTE * rng.between(0, 59));
        const occurredAt = clampToWindow(
          plannedMergeAt !== null && toEpochMillis(drawnAt) >= toEpochMillis(plannedMergeAt)
            ? addMillis(plannedMergeAt, -MILLIS_PER_MINUTE)
            : drawnAt,
        );
        const revisionId = nextRevisionId();
        revisions.push(revisionId);
        pushCommit(
          {
            ...CODE,
            sourceRecordId: `commit-${revisionId}`,
            occurredAt,
            repositoryKey,
            revisionId,
            parentRevisionIds: step === 0 ? [] : [revisions[step - 1] ?? revisionId],
            authorIdentity: gitIdentity(issue.assignee, step),
            committerIdentity: gitIdentity(issue.assignee, step),
            authoredAt: occurredAt,
            message: keyInMessage ? `${issue.record.itemKey} ${subject}` : subject,
            changedFileCount: rng.between(1, 9),
            branchName,
          },
          intended,
        );
      }

      const headRevisionId = revisions[revisions.length - 1] ?? nextRevisionId();
      const lastCommitAt = accumulator.commits[accumulator.commits.length - 1]?.occurredAt ?? startedAt;
      const mergedAt = isMerged ? (plannedMergeAt ?? lastCommitAt) : null;
      const displayNumber = pullRequestNumber;
      pullRequestNumber += 1;

      const mergeRevisionId = isMerged ? nextRevisionId() : null;
      if (isMerged && mergeRevisionId !== null && mergedAt !== null) {
        pushCommit(
          {
            ...CODE,
            sourceRecordId: `commit-${mergeRevisionId}`,
            occurredAt: clampToWindow(mergedAt),
            repositoryKey,
            revisionId: mergeRevisionId,
            parentRevisionIds: [headRevisionId],
            authorIdentity: gitIdentity(issue.assignee, 0),
            committerIdentity: null,
            authoredAt: clampToWindow(mergedAt),
            message: `${issue.record.itemKey} merge pull request #${displayNumber} from ${branchName}`,
            changedFileCount: rng.between(2, 14),
            branchName: project.defaultBranch,
          },
          issue.hasGoalChain ? 'structural' : 'inferred',
        );
      }

      const reviewers = roster.filter((developer) => developer.key !== issue.assignee.key);
      const reviewer = reviewers.length > 0 ? rng.pick(reviewers) : issue.assignee;
      const state: PullRequestRecord['state'] = isMerged
        ? 'merged'
        : issue.record.status === 'In Review'
          ? 'open'
          : 'draft';
      const createdAt = clampToWindow(startedAt);
      const updatedAt = clampToWindow(mergedAt ?? lastCommitAt);

      accumulator.pullRequests.push({
        ...CODE,
        sourceRecordId: `pull-request-${displayNumber}`,
        occurredAt: updatedAt,
        repositoryKey,
        displayNumber,
        title: `${issue.record.itemKey} ${issue.record.title}`,
        description: issue.record.description,
        authorIdentity: gitIdentity(issue.assignee, 0),
        state,
        createdAt,
        updatedAt,
        mergedAt: mergedAt === null ? null : clampToWindow(mergedAt),
        closedAt: mergedAt === null ? null : clampToWindow(mergedAt),
        sourceBranch: branchName,
        targetBranch: project.defaultBranch,
        headRevisionId,
        mergeRevisionId,
        requestedReviewerIdentities: [gitIdentity(reviewer, 0)],
        linkedWorkItemKeys: [issue.record.itemKey],
      });

      // A merged pull request's reviews are spread across the interval it was
      // actually open, so the approval that gated a merge is never dated after
      // it. An open pull request has no upper bound to respect, so it keeps the
      // wider spread â€” that is what makes the review-latency tail readable.
      const reviewCount = rng.between(1, 3);
      const reviewSpanMillis =
        mergedAt === null ? null : toEpochMillis(clampToWindow(mergedAt)) - toEpochMillis(createdAt);
      for (let step = 0; step < reviewCount; step += 1) {
        const submittedAt = clampToWindow(
          addMillis(
            createdAt,
            reviewSpanMillis === null
              ? MILLIS_PER_HOUR * rng.between(4, 60) * (step + 1)
              : Math.floor((Math.max(0, reviewSpanMillis) * (step + 1)) / (reviewCount + 1)),
          ),
        );
        const verdict: ReviewRecord['verdict'] =
          step === reviewCount - 1 && isMerged ? 'approved' : rng.pick(['changes_requested', 'commented']);
        accumulator.reviews.push({
          ...CODE,
          sourceRecordId: `review-${displayNumber}-${step + 1}`,
          occurredAt: submittedAt,
          repositoryKey,
          pullRequestRef: `pull-request-${displayNumber}`,
          reviewerIdentity: gitIdentity(reviewer, step),
          verdict,
          submittedAt,
          commentCount: verdict === 'approved' ? 0 : rng.between(1, 6),
        });
      }

      pushBranchRef(repositoryKey, branchName, headRevisionId, updatedAt, false);
    });

    for (const repositoryKey of project.repositories) {
      pushBranchRef(
        repositoryKey,
        project.defaultBranch,
        nextRevisionId(),
        addMillis(datasetEnd, -MILLIS_PER_HOUR * 3),
        true,
      );
    }
  }

  // ---------------------------------------- semantic and unattributed commits

  const attributedCommitCount = accumulator.commits.length;
  const semanticTarget = Math.round(attributedCommitCount * 0.15);
  const unattributedTarget = Math.round(attributedCommitCount * 0.1);
  const allRepositories = projects.projects.flatMap((project) => project.repositories);

  const pushLooseCommit = (
    subject: string,
    branchName: string,
    intended: TraceabilityClass,
    dayOffset: number,
    developer: FixtureDeveloper,
    rotation: number,
  ): void => {
    const repositoryKey = allRepositories[rotation % allRepositories.length] ?? 'platform-api';
    const occurredAt = workInstant(dayOffset, rng);
    const revisionId = nextRevisionId();
    pushCommit(
      {
        ...CODE,
        sourceRecordId: `commit-${revisionId}`,
        occurredAt,
        repositoryKey,
        revisionId,
        parentRevisionIds: [],
        authorIdentity: gitIdentity(developer, rotation),
        committerIdentity: gitIdentity(developer, rotation),
        authoredAt: occurredAt,
        message: subject,
        changedFileCount: rng.between(1, 5),
        branchName,
      },
      intended,
    );
  };

  for (let index = 0; index < semanticTarget; index += 1) {
    const semantic = narrative.semanticSubjects[index % narrative.semanticSubjects.length];
    const branchName = narrative.semanticBranchNames[index % narrative.semanticBranchNames.length] ?? 'perf/hot-path';
    if (!semantic) break;
    pushLooseCommit(
      semantic.subject,
      branchName,
      'semantic',
      Math.floor((index / Math.max(1, semanticTarget)) * (datasetSpanDays - 2)),
      rng.pick(people.developers),
      index,
    );
  }

  for (let index = 0; index < unattributedTarget; index += 1) {
    const subject = narrative.unattributedSubjects[index % narrative.unattributedSubjects.length];
    const branchName =
      narrative.unattributedBranchNames[index % narrative.unattributedBranchNames.length] ?? 'fix/stuff';
    if (!subject) break;
    pushLooseCommit(
      subject,
      branchName,
      'unattributed',
      Math.floor((index / Math.max(1, unattributedTarget)) * (datasetSpanDays - 2)),
      rng.pick(people.developers),
      index,
    );
  }

  // ------------------------------------------------------------ release tags

  for (const release of projects.releases) {
    const releasedAt = instantFromIso(release.releasedAt);
    accumulator.releaseTags.push({
      ...CODE,
      sourceRecordId: `release-${release.repositoryKey}-${release.name}`,
      occurredAt: clampToWindow(releasedAt),
      repositoryKey: release.repositoryKey,
      name: release.name,
      revisionId: nextRevisionId(),
      releasedAt: clampToWindow(releasedAt),
      description: release.description,
    });
  }

  // ------------------------------------------------------ sprint scope changes

  for (const sprint of workingSprints) {
    const roster = rosterOrFail(sprint.project.teamKey);
    const changeCount = rng.between(1, 3);
    for (let step = 0; step < changeCount; step += 1) {
      const itemKey = sprint.committedItemKeys[rng.int(Math.max(1, sprint.committedItemKeys.length))];
      if (itemKey === undefined) continue;
      const changedAt = clampToWindow(addMillis(sprint.startAt, MILLIS_PER_DAY * rng.between(2, 11)));
      accumulator.sprintScopeChanges.push({
        ...TRACKER,
        sourceRecordId: `scope-change-${sprint.recordId}-${step + 1}`,
        occurredAt: changedAt,
        sprintRef: sprint.recordId,
        itemKey,
        change: rng.chance(0.7) ? 'added' : 'removed',
        actorIdentity: trackerIdentity(rng.pick(roster)),
        changedAt,
      });
    }
  }

  // ----------------------------------------------------------------- planted

  plantPathologies({
    fixtures,
    accumulator,
    rng,
    clampToWindow,
    reserveRevision,
    nextRevisionId,
    developerOrFail,
    sprintsByProjectAndName,
    buildIssue,
    pushTransitions,
    pushCommit,
    pushBranchRef,
  });

  plantReportDayCommits({
    fixtures,
    reportWindow,
    workingIssues,
    nextRevisionId,
    pushCommit,
    developerOrFail,
  });

  // ---------------------------------------------------------------- messages

  const itemKeysByTeam = new Map<string, string[]>();
  for (const issue of workingIssues) {
    const teamKey = issue.project.teamKey;
    const keys = itemKeysByTeam.get(teamKey) ?? [];
    keys.push(issue.record.itemKey);
    itemKeysByTeam.set(teamKey, keys);
  }
  const allItemKeys = workingIssues.map((issue) => issue.record.itemKey);
  const allPullRequestNumbers = accumulator.pullRequests.map((request) => request.displayNumber);
  const releaseNames = projects.releases.map((release) => release.name);

  for (const conversation of organization.conversations) {
    const templates =
      conversation.key === 'conversation-release'
        ? narrative.messageTemplates.release
        : conversation.teamKey === 'insights'
          ? narrative.messageTemplates.flow
          : narrative.messageTemplates.standup;
    const roster = conversation.teamKey === null ? people.developers : rosterOrFail(conversation.teamKey);
    const conversationItemKeys =
      conversation.teamKey === null ? allItemKeys : (itemKeysByTeam.get(conversation.teamKey) ?? allItemKeys);

    for (let index = 0; index < conversation.messageCount; index += 1) {
      const template = templates[index % templates.length] ?? '{key} has no update today.';
      const author = rng.pick(roster);
      const itemKey = rng.pick(conversationItemKeys);
      const mentioned = rng.pick(roster);
      const pullNumber = allPullRequestNumbers.length > 0 ? rng.pick(allPullRequestNumbers) : FIRST_PULL_REQUEST_NUMBER;
      const tag = releaseNames.length > 0 ? rng.pick(releaseNames) : 'v0.0.0';
      const body = template
        .replace(/\{key\}/g, itemKey)
        .replace(/\{name\}/g, mentioned.displayName)
        .replace(/\{pull\}/g, String(pullNumber))
        .replace(/\{tag\}/g, tag);
      const postedAt = workInstant(
        Math.floor((index / conversation.messageCount) * (datasetSpanDays - 1)),
        rng,
      );

      accumulator.messages.push({
        ...CHAT,
        sourceRecordId: `message-${conversation.key}-${index + 1}`,
        occurredAt: postedAt,
        conversationKey: conversation.key,
        conversationName: conversation.name,
        authorIdentity: chatIdentity(author),
        body,
        threadRef: index > 0 && rng.chance(0.18) ? `message-${conversation.key}-${index}` : null,
        referencedItemKeys: body.includes(itemKey) ? [itemKey] : [],
        postedAt,
      });
    }
  }

  // ----------------------------------------------------------------- assemble

  const sprintRecords: SprintRecord[] = workingSprints.map((sprint) => {
    const closed = toEpochMillis(sprint.endAt) <= toEpochMillis(now);
    const started = toEpochMillis(sprint.startAt) <= toEpochMillis(now);
    return {
      ...TRACKER,
      sourceRecordId: sprint.recordId,
      occurredAt: clampToWindow(sprint.startAt),
      projectKey: sprint.project.key,
      name: sprint.name,
      goal: sprint.goal,
      state: closed ? 'closed' : started ? 'active' : 'future',
      startAt: sprint.startAt,
      endAt: sprint.endAt,
      completedAt: closed ? sprint.endAt : null,
      committedItemKeys: [...new Set(sprint.committedItemKeys)].sort(),
    };
  });
  accumulator.sprints.push(...sprintRecords);

  const dataset: SeedDataset = {
    datasetId: organization.datasetId,
    deploySignal: false,
    sources: organization.sources.map((source) => ({
      sourceKey: source.sourceKey,
      sourceKind: source.sourceKind,
      availability: source.availability,
    })),
    records: {
      commits: sortRecords(accumulator.commits),
      pull_requests: sortRecords(accumulator.pullRequests),
      reviews: sortRecords(accumulator.reviews),
      branch_refs: sortRecords(accumulator.branchRefs),
      release_tags: sortRecords(accumulator.releaseTags),
      issues: sortRecords(accumulator.issues),
      issue_transitions: sortRecords(accumulator.issueTransitions),
      sprints: sortRecords(accumulator.sprints),
      sprint_scope_changes: sortRecords(accumulator.sprintScopeChanges),
      messages: sortRecords(accumulator.messages),
    },
  };

  const traceabilityContext = buildTraceabilityContext({
    issues: dataset.records.issues,
    sprints: dataset.records.sprints,
    objectives: organization.objectives,
  });

  assertGeneratedSeedIsSound(dataset, accumulator.intent, traceabilityContext, datasetWindow, reportWindow);

  return {
    dataset,
    organizationId: organization.organizationId,
    companyName: organization.companyName,
    datasetWindow,
    reportWindow,
    now,
    objectives: organization.objectives.map((objective) => ({ ...objective })),
    unavailableSourceKey:
      organization.sources.find((source) => source.availability.status === 'unavailable')?.sourceKey ?? null,
    intendedTraceability: accumulator.intent,
    traceabilityContext,
  };
}

// ---------------------------------------------------------------------------

interface PlantContext {
  readonly fixtures: SeedFixtures;
  readonly accumulator: Accumulator;
  readonly rng: Rng;
  readonly clampToWindow: (instant: Instant) => Instant;
  readonly reserveRevision: (revisionId: string) => string;
  readonly nextRevisionId: () => string;
  readonly developerOrFail: (key: string) => FixtureDeveloper;
  readonly sprintsByProjectAndName: ReadonlyMap<string, SprintRef>;
  readonly buildIssue: (input: BuildIssueInput) => WorkingIssue;
  readonly pushTransitions: (issue: WorkingIssue, transitions: readonly TransitionInput[]) => void;
  readonly pushCommit: (commit: CommitRecord, intended: TraceabilityClass) => void;
  readonly pushBranchRef: (
    repositoryKey: string,
    name: string,
    revisionId: string,
    observedAt: Instant,
    isDefault: boolean,
  ) => void;
}

function plantPathologies(context: PlantContext): void {
  const { fixtures, accumulator, rng, clampToWindow, reserveRevision, nextRevisionId, developerOrFail } = context;
  const { pathologies, projects } = fixtures;
  const projectByKey = new Map(projects.projects.map((project) => [project.key, project]));
  const projectOrFail = (key: string): FixtureProject => {
    const project = projectByKey.get(key);
    if (!project) throw new SeedGenerationError(`No project \`${key}\` in seed/fixtures/projects.json.`);
    return project;
  };

  const sprintOrFail = (
    projectKey: string,
    sprintName: string,
  ): { readonly recordId: string; readonly committedItemKeys: string[]; readonly startAt: Instant } => {
    const sprint = context.sprintsByProjectAndName.get(`${projectKey}/${sprintName}`);
    if (!sprint) throw new SeedGenerationError(`No sprint \`${projectKey}/${sprintName}\` was generated.`);
    return sprint;
  };

  // ---- 1. the off-goal work stream ----------------------------------------
  const offGoal = pathologies.offGoalWorkStream;
  const offGoalProject = projectOrFail(offGoal.projectKey);
  const offGoalDeveloper = developerOrFail(offGoal.developerKey);
  const offGoalSprint = sprintOrFail(offGoal.projectKey, offGoal.sprintName);

  for (const planted of offGoal.issues) {
    const createdAt = instantFromIso(planted.createdAt);
    const issue = context.buildIssue({
      project: offGoalProject,
      itemKey: planted.itemKey,
      title: planted.title,
      description: `Serves the ${offGoal.servesObjectiveKey} objective, which closed at the end of last quarter.`,
      status: planted.status,
      statusCategory: planted.status === 'To Do' ? 'todo' : 'in_progress',
      itemType: 'Story',
      priority: 'Medium',
      estimatePoints: planted.points,
      labels: ['billing-migration', 'platform'],
      assignee: offGoalDeveloper,
      reporter: offGoalDeveloper,
      createdAt,
      updatedAt: addMillis(createdAt, MILLIS_PER_DAY),
      resolvedAt: null,
      sprint: offGoalSprint,
      flaggedBlocked: false,
    });
    if (planted.status !== 'To Do') {
      context.pushTransitions(issue, [
        {
          fromStatus: 'To Do',
          toStatus: 'In Progress',
          fromStatusCategory: 'todo',
          toStatusCategory: 'in_progress',
          at: addMillis(createdAt, MILLIS_PER_HOUR * 2),
        },
      ]);
    }
  }

  offGoal.commits.forEach((planted, index) => {
    const occurredAt = instantFromIso(planted.occurredAt);
    context.pushCommit(
      {
        ...CODE,
        sourceRecordId: `commit-${reserveRevision(planted.revisionId)}`,
        occurredAt,
        repositoryKey: offGoal.repositoryKey,
        revisionId: planted.revisionId,
        parentRevisionIds: index === 0 ? [] : [offGoal.commits[index - 1]?.revisionId ?? planted.revisionId],
        authorIdentity: gitIdentity(offGoalDeveloper, index),
        committerIdentity: gitIdentity(offGoalDeveloper, index),
        authoredAt: occurredAt,
        message: `${planted.itemKey} ${planted.subject}`,
        changedFileCount: 3 + index,
        branchName: offGoal.branchName,
      },
      'structural',
    );
  });
  context.pushBranchRef(
    offGoal.repositoryKey,
    offGoal.branchName,
    offGoal.commits[offGoal.commits.length - 1]?.revisionId ?? nextRevisionId(),
    instantFromIso(offGoal.windowEnd),
    false,
  );

  // ---- 2. the review bottleneck -------------------------------------------
  const bottleneck = pathologies.reviewBottleneck;
  const bottleneckProject = projectOrFail('PLAT');
  const bottleneckReviewer = developerOrFail(bottleneck.reviewerDeveloperKey);
  const bottleneckSprint = sprintOrFail('PLAT', 'Sprint 46');

  for (const planted of bottleneck.pullRequests) {
    const author = developerOrFail(planted.authorDeveloperKey);
    const createdAt = instantFromIso(planted.createdAt);
    const branchName = `feature/${planted.itemKey}-${slugify(planted.title.replace(planted.itemKey, ''), 3)}`;
    const revisionId = nextRevisionId();

    const issue = context.buildIssue({
      project: bottleneckProject,
      itemKey: planted.itemKey,
      title: planted.title.replace(`${planted.itemKey} `, ''),
      description: null,
      status: 'In Review',
      statusCategory: 'in_progress',
      itemType: 'Task',
      priority: 'Medium',
      estimatePoints: 3,
      labels: ['platform'],
      assignee: author,
      reporter: author,
      createdAt,
      updatedAt: createdAt,
      resolvedAt: null,
      sprint: bottleneckSprint,
      flaggedBlocked: false,
    });
    context.pushTransitions(issue, [
      {
        fromStatus: 'In Progress',
        toStatus: 'In Review',
        fromStatusCategory: 'in_progress',
        toStatusCategory: 'in_progress',
        at: createdAt,
      },
    ]);

    context.pushCommit(
      {
        ...CODE,
        sourceRecordId: `commit-${revisionId}`,
        occurredAt: createdAt,
        repositoryKey: bottleneck.repositoryKey,
        revisionId,
        parentRevisionIds: [],
        authorIdentity: gitIdentity(author, 0),
        committerIdentity: gitIdentity(author, 0),
        authoredAt: createdAt,
        message: planted.title,
        changedFileCount: 4,
        branchName,
      },
      'structural',
    );

    accumulator.pullRequests.push({
      ...CODE,
      sourceRecordId: `pull-request-${planted.displayNumber}`,
      occurredAt: createdAt,
      repositoryKey: bottleneck.repositoryKey,
      displayNumber: planted.displayNumber,
      title: planted.title,
      description: `Waiting on ${bottleneck.reviewerName}.`,
      authorIdentity: gitIdentity(author, 0),
      state: 'open',
      createdAt,
      updatedAt: createdAt,
      mergedAt: null,
      closedAt: null,
      sourceBranch: branchName,
      targetBranch: bottleneckProject.defaultBranch,
      headRevisionId: revisionId,
      mergeRevisionId: null,
      requestedReviewerIdentities: [gitIdentity(bottleneckReviewer, 0)],
      linkedWorkItemKeys: [planted.itemKey],
    });
    context.pushBranchRef(bottleneck.repositoryKey, branchName, revisionId, createdAt, false);
  }

  // ---- 3. the slipping release --------------------------------------------
  const slip = pathologies.slippingRelease;
  const slipCreatedAt = instantFromIso(slip.windowStart);
  const slipIssue = context.buildIssue({
    project: bottleneckProject,
    itemKey: slip.trackingItemKey,
    title: slip.trackingTitle,
    description: `Planned for ${toIso(instantFromIso(slip.plannedAt))}; cut on ${toIso(instantFromIso(slip.actualAt))}.`,
    status: 'Done',
    statusCategory: 'done',
    itemType: 'Task',
    priority: 'High',
    estimatePoints: 2,
    labels: ['platform'],
    assignee: developerOrFail('priya-raman'),
    reporter: developerOrFail('marcus-hale'),
    createdAt: slipCreatedAt,
    updatedAt: instantFromIso(slip.actualAt),
    resolvedAt: instantFromIso(slip.actualAt),
    sprint: bottleneckSprint,
    flaggedBlocked: false,
  });
  context.pushTransitions(slipIssue, [
    {
      fromStatus: 'To Do',
      toStatus: 'In Progress',
      fromStatusCategory: 'todo',
      toStatusCategory: 'in_progress',
      at: slipCreatedAt,
    },
    {
      fromStatus: 'In Progress',
      toStatus: 'Done',
      fromStatusCategory: 'in_progress',
      toStatusCategory: 'done',
      at: instantFromIso(slip.actualAt),
    },
  ]);

  // Five days of "it is going out this afternoon" in the release room.
  const slipDays = Math.round(
    (toEpochMillis(instantFromIso(slip.actualAt)) - toEpochMillis(instantFromIso(slip.plannedAt))) / MILLIS_PER_DAY,
  );
  for (let day = 0; day <= slipDays; day += 1) {
    const postedAt = addMillis(instantFromIso(slip.plannedAt), day * MILLIS_PER_DAY - MILLIS_PER_HOUR * 6);
    accumulator.messages.push({
      ...CHAT,
      sourceRecordId: `message-release-slip-${day + 1}`,
      occurredAt: clampToWindow(postedAt),
      conversationKey: slip.conversationKey,
      conversationName: 'release-room',
      authorIdentity: chatIdentity(developerOrFail('priya-raman')),
      body:
        day === slipDays
          ? `${slip.releaseTagName} is tagged and out. Five days later than we said.`
          : `${slip.releaseTagName} is not going out today either â€” ${slip.trackingItemKey} still has an open item.`,
      threadRef: day === 0 ? null : 'message-release-slip-1',
      referencedItemKeys: [slip.trackingItemKey],
      postedAt: clampToWindow(postedAt),
    });
  }

  // ---- 4. reported blocked, actually merged the same day -------------------
  const blocked = pathologies.blockedThenMerged;
  const blockedProject = projectOrFail(blocked.projectKey);
  const blockedDeveloper = developerOrFail(blocked.developerKey);
  const blockedSprint = sprintOrFail(blocked.projectKey, blocked.sprintName);
  const blockedFlaggedAt = instantFromIso(blocked.blockedFlaggedAt);
  const blockedMergedAt = instantFromIso(blocked.mergedAt);

  const blockedIssue = context.buildIssue({
    project: blockedProject,
    itemKey: blocked.itemKey,
    title: blocked.issueTitle,
    description: 'Flagged blocked at the morning stand-up; the fix merged the same evening.',
    status: 'Blocked',
    statusCategory: 'in_progress',
    itemType: 'Bug',
    priority: 'High',
    estimatePoints: blocked.points,
    labels: ['checkout', 'payments'],
    assignee: blockedDeveloper,
    reporter: blockedDeveloper,
    createdAt: instantFromIso(blocked.createdAt),
    updatedAt: blockedFlaggedAt,
    resolvedAt: null,
    sprint: blockedSprint,
    flaggedBlocked: true,
  });
  context.pushTransitions(blockedIssue, [
    {
      fromStatus: 'To Do',
      toStatus: 'In Progress',
      fromStatusCategory: 'todo',
      toStatusCategory: 'in_progress',
      at: instantFromIso(blocked.createdAt),
    },
    {
      fromStatus: 'In Progress',
      toStatus: 'Blocked',
      fromStatusCategory: 'in_progress',
      toStatusCategory: 'in_progress',
      at: blockedFlaggedAt,
    },
  ]);

  context.pushCommit(
    {
      ...CODE,
      sourceRecordId: `commit-${reserveRevision(blocked.headRevisionId)}`,
      occurredAt: addMillis(blockedMergedAt, -MILLIS_PER_HOUR * 2),
      repositoryKey: blocked.repositoryKey,
      revisionId: blocked.headRevisionId,
      parentRevisionIds: [],
      authorIdentity: gitIdentity(blockedDeveloper, 1),
      committerIdentity: gitIdentity(blockedDeveloper, 1),
      authoredAt: addMillis(blockedMergedAt, -MILLIS_PER_HOUR * 2),
      message: `${blocked.itemKey} stop retrying a declined card on a slow network`,
      changedFileCount: 3,
      branchName: blocked.branchName,
    },
    'structural',
  );
  context.pushCommit(
    {
      ...CODE,
      sourceRecordId: `commit-${reserveRevision(blocked.mergeRevisionId)}`,
      occurredAt: blockedMergedAt,
      repositoryKey: blocked.repositoryKey,
      revisionId: blocked.mergeRevisionId,
      parentRevisionIds: [blocked.headRevisionId],
      authorIdentity: gitIdentity(blockedDeveloper, 0),
      committerIdentity: null,
      authoredAt: blockedMergedAt,
      message: `${blocked.itemKey} merge pull request #${blocked.pullRequestNumber} from ${blocked.branchName}`,
      changedFileCount: 3,
      branchName: blockedProject.defaultBranch,
    },
    'structural',
  );

  accumulator.pullRequests.push({
    ...CODE,
    sourceRecordId: `pull-request-${blocked.pullRequestNumber}`,
    occurredAt: blockedMergedAt,
    repositoryKey: blocked.repositoryKey,
    displayNumber: blocked.pullRequestNumber,
    title: `${blocked.itemKey} ${blocked.issueTitle}`,
    description: null,
    authorIdentity: gitIdentity(blockedDeveloper, 0),
    state: 'merged',
    createdAt: addMillis(blockedMergedAt, -MILLIS_PER_DAY),
    updatedAt: blockedMergedAt,
    mergedAt: blockedMergedAt,
    closedAt: blockedMergedAt,
    sourceBranch: blocked.branchName,
    targetBranch: blockedProject.defaultBranch,
    headRevisionId: blocked.headRevisionId,
    mergeRevisionId: blocked.mergeRevisionId,
    requestedReviewerIdentities: [gitIdentity(developerOrFail('rafael-lima'), 0)],
    linkedWorkItemKeys: [blocked.itemKey],
  });
  accumulator.reviews.push({
    ...CODE,
    sourceRecordId: `review-${blocked.pullRequestNumber}-1`,
    occurredAt: addMillis(blockedMergedAt, -MILLIS_PER_HOUR),
    repositoryKey: blocked.repositoryKey,
    pullRequestRef: `pull-request-${blocked.pullRequestNumber}`,
    reviewerIdentity: gitIdentity(developerOrFail('rafael-lima'), 0),
    verdict: 'approved',
    submittedAt: addMillis(blockedMergedAt, -MILLIS_PER_HOUR),
    commentCount: 0,
  });
  context.pushBranchRef(blocked.repositoryKey, blocked.branchName, blocked.headRevisionId, blockedMergedAt, false);

  accumulator.messages.push({
    ...CHAT,
    sourceRecordId: 'message-blocked-claim-1',
    occurredAt: instantFromIso(blocked.chatClaimAt),
    conversationKey: 'conversation-checkout',
    conversationName: 'checkout-standup',
    authorIdentity: chatIdentity(blockedDeveloper),
    body: `${blocked.itemKey} is blocked â€” I cannot reproduce the decline without the merchant sandbox.`,
    threadRef: null,
    referencedItemKeys: [blocked.itemKey],
    postedAt: instantFromIso(blocked.chatClaimAt),
  });

  // ---- 5. estimation noise -------------------------------------------------
  const noise = pathologies.estimationNoise;
  const noiseProject = projectOrFail(noise.projectKey);
  for (const sample of noise.samples) {
    const sprint = sprintOrFail(noise.projectKey, sample.sprintName);
    const createdAt = addMillis(sprint.startAt, MILLIS_PER_DAY);
    const resolvedAt = addMillis(createdAt, sample.elapsedWorkingDays * MILLIS_PER_DAY);
    const assignee = developerOrFail(rng.pick(['priya-raman', 'elena-sokolova', 'aisha-bello', 'tom-whitfield']));
    const issue = context.buildIssue({
      project: noiseProject,
      itemKey: sample.itemKey,
      title: `Estimated at ${sample.points} points, took ${sample.elapsedWorkingDays} days`,
      description: null,
      status: 'Done',
      statusCategory: 'done',
      itemType: 'Story',
      priority: 'Medium',
      estimatePoints: sample.points,
      labels: ['platform'],
      assignee,
      reporter: assignee,
      createdAt,
      updatedAt: resolvedAt,
      resolvedAt,
      sprint,
      flaggedBlocked: false,
    });
    context.pushTransitions(issue, [
      {
        fromStatus: 'To Do',
        toStatus: 'In Progress',
        fromStatusCategory: 'todo',
        toStatusCategory: 'in_progress',
        at: createdAt,
      },
      {
        fromStatus: 'In Progress',
        toStatus: 'Done',
        fromStatusCategory: 'in_progress',
        toStatusCategory: 'done',
        at: resolvedAt,
      },
    ]);
  }

  // ---- 6. done with no pull request ---------------------------------------
  const hygiene = pathologies.doneWithNoPullRequest;
  const hygieneProject = projectOrFail(hygiene.projectKey);
  const hygieneDeveloper = developerOrFail(hygiene.developerKey);
  const hygieneIssue = context.buildIssue({
    project: hygieneProject,
    itemKey: hygiene.itemKey,
    title: hygiene.issueTitle,
    description: 'Closed as Done with nothing in version control referencing it.',
    status: 'Done',
    statusCategory: 'done',
    itemType: 'Task',
    priority: 'Medium',
    estimatePoints: null,
    labels: ['insights'],
    assignee: hygieneDeveloper,
    reporter: hygieneDeveloper,
    createdAt: instantFromIso(hygiene.createdAt),
    updatedAt: instantFromIso(hygiene.doneAt),
    resolvedAt: instantFromIso(hygiene.doneAt),
    sprint: null,
    flaggedBlocked: false,
  });
  context.pushTransitions(hygieneIssue, [
    {
      fromStatus: 'Selected',
      toStatus: 'In Progress',
      fromStatusCategory: 'todo',
      toStatusCategory: 'in_progress',
      at: instantFromIso(hygiene.createdAt),
    },
    {
      fromStatus: 'In Progress',
      toStatus: 'Done',
      fromStatusCategory: 'in_progress',
      toStatusCategory: 'done',
      at: instantFromIso(hygiene.doneAt),
    },
  ]);

  // ---- 7. merged but not released -----------------------------------------
  const unreleased = pathologies.mergedNotReleased;
  for (const planted of unreleased.pullRequests) {
    const author = developerOrFail(planted.authorDeveloperKey);
    const mergedAt = instantFromIso(planted.mergedAt);
    const branchName = `feature/${planted.itemKey}-${slugify(planted.title.replace(planted.itemKey, ''), 3)}`;
    const headRevisionId = nextRevisionId();

    const issue = context.buildIssue({
      project: bottleneckProject,
      itemKey: planted.itemKey,
      title: planted.title.replace(`${planted.itemKey} `, ''),
      description: null,
      status: 'Done',
      statusCategory: 'done',
      itemType: 'Task',
      priority: 'Medium',
      estimatePoints: 3,
      labels: ['platform'],
      assignee: author,
      reporter: author,
      createdAt: addMillis(mergedAt, -MILLIS_PER_DAY * 3),
      updatedAt: mergedAt,
      resolvedAt: mergedAt,
      sprint: bottleneckSprint,
      flaggedBlocked: false,
    });
    context.pushTransitions(issue, [
      {
        fromStatus: 'In Progress',
        toStatus: 'Done',
        fromStatusCategory: 'in_progress',
        toStatusCategory: 'done',
        at: mergedAt,
      },
    ]);

    context.pushCommit(
      {
        ...CODE,
        sourceRecordId: `commit-${headRevisionId}`,
        occurredAt: addMillis(mergedAt, -MILLIS_PER_HOUR * 5),
        repositoryKey: unreleased.repositoryKey,
        revisionId: headRevisionId,
        parentRevisionIds: [],
        authorIdentity: gitIdentity(author, 1),
        committerIdentity: gitIdentity(author, 1),
        authoredAt: addMillis(mergedAt, -MILLIS_PER_HOUR * 5),
        message: planted.title,
        changedFileCount: 5,
        branchName,
      },
      'structural',
    );
    context.pushCommit(
      {
        ...CODE,
        sourceRecordId: `commit-${reserveRevision(planted.mergeRevisionId)}`,
        occurredAt: mergedAt,
        repositoryKey: unreleased.repositoryKey,
        revisionId: planted.mergeRevisionId,
        parentRevisionIds: [headRevisionId],
        authorIdentity: gitIdentity(author, 0),
        committerIdentity: null,
        authoredAt: mergedAt,
        message: `${planted.itemKey} merge pull request #${planted.displayNumber} from ${branchName}`,
        changedFileCount: 5,
        branchName: 'main',
      },
      'structural',
    );

    accumulator.pullRequests.push({
      ...CODE,
      sourceRecordId: `pull-request-${planted.displayNumber}`,
      occurredAt: mergedAt,
      repositoryKey: unreleased.repositoryKey,
      displayNumber: planted.displayNumber,
      title: planted.title,
      description: null,
      authorIdentity: gitIdentity(author, 0),
      state: 'merged',
      createdAt: addMillis(mergedAt, -MILLIS_PER_DAY * 2),
      updatedAt: mergedAt,
      mergedAt,
      closedAt: mergedAt,
      sourceBranch: branchName,
      targetBranch: 'main',
      headRevisionId,
      mergeRevisionId: planted.mergeRevisionId,
      requestedReviewerIdentities: [gitIdentity(developerOrFail('marcus-hale'), 0)],
      linkedWorkItemKeys: [planted.itemKey],
    });
    accumulator.reviews.push({
      ...CODE,
      sourceRecordId: `review-${planted.displayNumber}-1`,
      occurredAt: addMillis(mergedAt, -MILLIS_PER_HOUR * 2),
      repositoryKey: unreleased.repositoryKey,
      pullRequestRef: `pull-request-${planted.displayNumber}`,
      reviewerIdentity: gitIdentity(developerOrFail('marcus-hale'), 0),
      verdict: 'approved',
      submittedAt: addMillis(mergedAt, -MILLIS_PER_HOUR * 2),
      commentCount: 0,
    });
    context.pushBranchRef(unreleased.repositoryKey, branchName, headRevisionId, mergedAt, false);
  }

  // ---- 8. growing technical debt -------------------------------------------
  const debt = pathologies.technicalDebtGrowth;
  const debtProject = projectOrFail(debt.projectKey);
  for (const cohort of debt.cohorts) {
    const sprint = sprintOrFail(debt.projectKey, cohort.sprintName);
    const openedAt = instantFromIso(cohort.openedAt);
    cohort.issues.forEach((planted, index) => {
      const assignee = developerOrFail(rng.pick(['priya-raman', 'elena-sokolova', 'aisha-bello', 'tom-whitfield']));
      context.buildIssue({
        project: debtProject,
        itemKey: planted.itemKey,
        title: planted.title,
        description: null,
        status: 'To Do',
        statusCategory: 'todo',
        itemType: 'Task',
        priority: 'Low',
        estimatePoints: null,
        labels: [debt.label, 'platform'],
        assignee,
        reporter: assignee,
        createdAt: addMillis(openedAt, index * MILLIS_PER_HOUR),
        updatedAt: addMillis(openedAt, index * MILLIS_PER_HOUR),
        resolvedAt: null,
        sprint,
        flaggedBlocked: false,
      });
    });
  }

  // ---- 9. commits from addresses that belong to nobody ----------------------
  const unmatched = pathologies.unmatchedIdentityCommits;
  const unmappedByAddress = new Map(fixtures.people.unmappedGitEmails.map((entry) => [entry.address, entry]));
  for (const planted of unmatched.commits) {
    const author = unmappedByAddress.get(planted.address);
    if (!author) {
      throw new SeedGenerationError(
        `Commit ${planted.revisionId} uses \`${planted.address}\`, which is not listed in unmappedGitEmails.`,
      );
    }
    const occurredAt = instantFromIso(planted.occurredAt);
    context.pushCommit(
      {
        ...CODE,
        sourceRecordId: `commit-${reserveRevision(planted.revisionId)}`,
        occurredAt,
        repositoryKey: unmatched.repositoryKey,
        revisionId: planted.revisionId,
        parentRevisionIds: [],
        authorIdentity: identity('email', planted.address, author.displayName),
        committerIdentity: identity('email', planted.address, author.displayName),
        authoredAt: occurredAt,
        message: planted.subject,
        changedFileCount: 2,
        branchName: unmatched.branchName,
      },
      'unattributed',
    );
  }
}

/**
 * Guarantees the daily report window exercises all four resolution paths.
 *
 * Volume alone would probably put one of each in yesterday's window, and
 * "probably" is not a property. These commits are planted explicitly, drawn from
 * the same vocabulary as the rest, so the alignment distribution over one report
 * is never empty in a class.
 */
function plantReportDayCommits(input: {
  readonly fixtures: SeedFixtures;
  readonly reportWindow: TimeWindow;
  readonly workingIssues: readonly WorkingIssue[];
  readonly nextRevisionId: () => string;
  readonly pushCommit: (commit: CommitRecord, intended: TraceabilityClass) => void;
  readonly developerOrFail: (key: string) => FixtureDeveloper;
}): void {
  const { fixtures, reportWindow, workingIssues, nextRevisionId, pushCommit, developerOrFail } = input;
  const perClass = 3;
  const slotMillis = MILLIS_PER_HOUR;

  const goalChainIssues = workingIssues.filter(
    (issue) => issue.hasGoalChain && issue.project.methodology === 'scrum' && issue.record.statusCategory !== 'todo',
  );
  const kanbanIssues = workingIssues.filter((issue) => issue.project.methodology === 'kanban');

  const authors = ['priya-raman', 'naomi-chen', 'yusuf-demir', 'ingrid-falk', 'elena-sokolova', 'oskar-lindqvist'];
  let slot = 9;

  const emit = (
    message: string,
    branchName: string,
    repositoryKey: string,
    intended: TraceabilityClass,
    authorKey: string,
  ): void => {
    const occurredAt = addMillis(reportWindow.start, slot * slotMillis);
    slot += 1;
    const developer = developerOrFail(authorKey);
    const revisionId = nextRevisionId();
    pushCommit(
      {
        ...CODE,
        sourceRecordId: `commit-${revisionId}`,
        occurredAt,
        repositoryKey,
        revisionId,
        parentRevisionIds: [],
        authorIdentity: gitIdentity(developer, slot),
        committerIdentity: gitIdentity(developer, slot),
        authoredAt: occurredAt,
        message,
        changedFileCount: 2 + (slot % 5),
        branchName,
      },
      intended,
    );
  };

  for (let index = 0; index < perClass; index += 1) {
    const issue = goalChainIssues[(index * 7) % Math.max(1, goalChainIssues.length)];
    const subject = fixtures.narrative.workSubjects[index % fixtures.narrative.workSubjects.length] ?? 'update the module';
    if (issue) {
      emit(
        `${issue.record.itemKey} ${subject}`,
        `feature/${issue.record.itemKey}-${slugify(issue.record.title, 3)}`,
        issue.project.repositories[0] ?? 'platform-api',
        'structural',
        authors[index % authors.length] ?? 'priya-raman',
      );
    }
  }

  for (let index = 0; index < perClass; index += 1) {
    const issue = kanbanIssues[(index * 5) % Math.max(1, kanbanIssues.length)];
    const subject =
      fixtures.narrative.workSubjects[(index + 6) % fixtures.narrative.workSubjects.length] ?? 'update the loader';
    if (issue) {
      emit(
        subject,
        `work/${issue.record.itemKey}-${slugify(issue.record.title, 3)}`,
        issue.project.repositories[0] ?? 'insights-etl',
        'inferred',
        authors[(index + 2) % authors.length] ?? 'yusuf-demir',
      );
    }
  }

  for (let index = 0; index < perClass; index += 1) {
    const semantic = fixtures.narrative.semanticSubjects[index % fixtures.narrative.semanticSubjects.length];
    const branchName = fixtures.narrative.semanticBranchNames[index % fixtures.narrative.semanticBranchNames.length];
    if (semantic && branchName) {
      emit(semantic.subject, branchName, 'platform-api', 'semantic', authors[(index + 4) % authors.length] ?? 'elena-sokolova');
    }
  }

  for (let index = 0; index < perClass; index += 1) {
    const subject = fixtures.narrative.unattributedSubjects[index % fixtures.narrative.unattributedSubjects.length];
    const branchName =
      fixtures.narrative.unattributedBranchNames[index % fixtures.narrative.unattributedBranchNames.length];
    if (subject && branchName) {
      emit(subject, branchName, 'checkout-web', 'unattributed', authors[(index + 1) % authors.length] ?? 'naomi-chen');
    }
  }
}

// ---------------------------------------------------------------------------

/**
 * The generator's own acceptance test, run before it will hand a dataset back.
 *
 * Everything here would otherwise be a silent corruption: a record outside the
 * window the connector claims to cover, two records sharing a natural key, or a
 * commit whose authored traceability class disagrees with the classifier the
 * report will use.
 */
/**
 * The order a transition was pushed in, recovered from its record id.
 *
 * `pushTransitions` names each row `transition-<itemKey>-<n>`, and the emitted
 * dataset is sorted by instant â€” so the authored order is only readable back off
 * the id. It is the authored order the history has to be non-decreasing in.
 */
function transitionOrdinal(transition: IssueTransitionRecord): number {
  const ordinal = Number.parseInt(transition.sourceRecordId.slice(transition.sourceRecordId.lastIndexOf('-') + 1), 10);
  return Number.isNaN(ordinal) ? 0 : ordinal;
}

function assertGeneratedSeedIsSound(
  dataset: SeedDataset,
  intent: ReadonlyMap<string, TraceabilityClass>,
  context: TraceabilityContext,
  datasetWindow: TimeWindow,
  reportWindow: TimeWindow,
): void {
  const problems: string[] = [];

  for (const [artifact, records] of Object.entries(dataset.records)) {
    const identities = new Set<string>();
    const envelopes = records as unknown as readonly {
      sourceKey: string;
      sourceRecordId: string;
      occurredAt: Instant;
    }[];
    for (const record of envelopes) {
      const key = `${record.sourceKey}::${record.sourceRecordId}`;
      if (identities.has(key)) problems.push(`${artifact}: duplicate record identity \`${key}\``);
      identities.add(key);
      if (!windowContains(datasetWindow, record.occurredAt)) {
        problems.push(
          `${artifact}: \`${record.sourceRecordId}\` occurs at ${toIso(record.occurredAt)}, outside the dataset window`,
        );
      }
    }
  }

  for (const commit of dataset.records.commits) {
    const intended = intent.get(commit.revisionId);
    if (intended === undefined) {
      problems.push(`commits: \`${commit.revisionId}\` was emitted without a declared traceability class`);
      continue;
    }
    const resolved = classifyCommitTraceability(commit, context).traceabilityClass;
    if (resolved !== intended) {
      problems.push(
        `commits: \`${commit.revisionId}\` was authored as ${intended} but classifies as ${resolved} â€” message ${JSON.stringify(commit.message)} on branch ${JSON.stringify(commit.branchName)}`,
      );
    }
  }

  // No tracker can record a status change before the ticket exists, or record a
  // history that runs backwards. Both are cheap to produce by accident, because
  // the instants that feed a transition are drawn independently of one another.
  const issueCreatedAt = new Map(dataset.records.issues.map((issue) => [issue.itemKey, issue.createdAt]));
  const transitionsByItemKey = new Map<string, IssueTransitionRecord[]>();
  for (const transition of dataset.records.issue_transitions) {
    const createdAt = issueCreatedAt.get(transition.itemKey);
    if (createdAt === undefined) {
      problems.push(
        `issue_transitions: \`${transition.sourceRecordId}\` names item \`${transition.itemKey}\`, which has no issue row`,
      );
    } else if (toEpochMillis(transition.transitionedAt) < toEpochMillis(createdAt)) {
      problems.push(
        `issue_transitions: ${transition.itemKey} moves to ${transition.toStatus} at ${toIso(transition.transitionedAt)}, before the issue was created at ${toIso(createdAt)}`,
      );
    }
    const family = transitionsByItemKey.get(transition.itemKey) ?? [];
    family.push(transition);
    transitionsByItemKey.set(transition.itemKey, family);
  }
  for (const [itemKey, family] of transitionsByItemKey) {
    const inPushOrder = [...family].sort((left, right) => transitionOrdinal(left) - transitionOrdinal(right));
    for (let index = 1; index < inPushOrder.length; index += 1) {
      const previous = inPushOrder[index - 1];
      const current = inPushOrder[index];
      if (!previous || !current) continue;
      if (toEpochMillis(current.transitionedAt) < toEpochMillis(previous.transitionedAt)) {
        problems.push(
          `issue_transitions: ${itemKey} reads ${previous.toStatus} at ${toIso(previous.transitionedAt)} then ${current.toStatus} at ${toIso(current.transitionedAt)} â€” the history runs backwards`,
        );
      }
    }
  }

  // The pull-request analogues of the transition invariant above. A merge cannot
  // land before the request was opened, a review cannot be submitted before it
  // was opened or after the merge it gated, and a commit cannot precede a commit
  // it declares as a parent. Each of these is produced by drawing an instant
  // from one stream and comparing it against an instant drawn from another, so
  // none of them is safe to merely believe.
  const pullRequestsByRecordId = new Map(dataset.records.pull_requests.map((request) => [request.sourceRecordId, request]));
  for (const request of dataset.records.pull_requests) {
    if (request.mergedAt !== null && toEpochMillis(request.mergedAt) < toEpochMillis(request.createdAt)) {
      problems.push(
        `pull_requests: \`${request.sourceRecordId}\` merged at ${toIso(request.mergedAt)}, before it was opened at ${toIso(request.createdAt)}`,
      );
    }
    if (toEpochMillis(request.updatedAt) < toEpochMillis(request.createdAt)) {
      problems.push(
        `pull_requests: \`${request.sourceRecordId}\` was last updated at ${toIso(request.updatedAt)}, before it was opened at ${toIso(request.createdAt)}`,
      );
    }
  }

  for (const review of dataset.records.reviews) {
    const request = pullRequestsByRecordId.get(review.pullRequestRef);
    if (request === undefined) {
      problems.push(
        `reviews: \`${review.sourceRecordId}\` names \`${review.pullRequestRef}\`, which has no pull request row`,
      );
      continue;
    }
    const submitted = toEpochMillis(review.submittedAt);
    if (submitted < toEpochMillis(request.createdAt)) {
      problems.push(
        `reviews: \`${review.sourceRecordId}\` was submitted at ${toIso(review.submittedAt)}, before \`${request.sourceRecordId}\` was opened at ${toIso(request.createdAt)}`,
      );
    } else if (request.mergedAt !== null && submitted >= toEpochMillis(request.mergedAt)) {
      problems.push(
        `reviews: \`${review.sourceRecordId}\` was submitted at ${toIso(review.submittedAt)}, at or after the merge of \`${request.sourceRecordId}\` at ${toIso(request.mergedAt)}`,
      );
    }
  }

  const commitOccurredAt = new Map(dataset.records.commits.map((commit) => [commit.revisionId, commit.occurredAt]));
  for (const commit of dataset.records.commits) {
    for (const parentRevisionId of commit.parentRevisionIds) {
      const parentAt = commitOccurredAt.get(parentRevisionId);
      if (parentAt === undefined) continue;
      if (toEpochMillis(commit.occurredAt) < toEpochMillis(parentAt)) {
        problems.push(
          `commits: \`${commit.sourceRecordId}\` occurs at ${toIso(commit.occurredAt)}, before its parent \`${parentRevisionId}\` at ${toIso(parentAt)}`,
        );
      }
    }
  }

  const reportDayCommits = dataset.records.commits.filter((commit) => windowContains(reportWindow, commit.occurredAt));
  const classesInReportWindow = new Set(
    reportDayCommits.map((commit) => classifyCommitTraceability(commit, context).traceabilityClass),
  );
  for (const traceabilityClass of TRACEABILITY_CLASSES) {
    if (!classesInReportWindow.has(traceabilityClass)) {
      problems.push(`the report window contains no ${traceabilityClass} commit; one report must exercise all four paths`);
    }
  }

  if (problems.length > 0) {
    throw new SeedGenerationError(
      `The generated seed is not sound:\n  - ${problems.slice(0, 20).join('\n  - ')}${
        problems.length > 20 ? `\n  ...and ${problems.length - 20} more` : ''
      }`,
    );
  }
}
