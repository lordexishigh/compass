import { instantFromEpochMillis, toIso, windowContains, type Instant } from '@compass/clock';
import {
  ARTIFACT_KINDS,
  ARTIFACT_SOURCE_KIND,
  completeCoverage,
  connectorResult,
  isAuthFailure,
  isRateLimited,
  sortRecords,
  unavailableCoverage,
  worstCoverageStatus,
  type ArtifactKind,
  type BranchRefRecord,
  type CommitRecord,
  type ConnectorCapabilities,
  type ConnectorPort,
  type ConnectorRequest,
  type ConnectorResult,
  type CoverageReason,
  type ExternalIdentity,
  type HttpClient,
  type HttpResponse,
  type IssueRecord,
  type IssueTransitionRecord,
  type MessageRecord,
  type PullRequestRecord,
  type ReleaseTagRecord,
  type ReviewRecord,
  type SourceCoverage,
  type SourceHealthEntry,
  type SourceHealthReport,
  type SprintRecord,
  type SprintScopeChangeRecord,
} from '@compass/connector-port';

/**
 * A live code connector, behind the port every other provider implements.
 *
 * ## The whole point of this file
 *
 * It passes `describeConnectorContract` **unmodified**. That is the architectural claim the port was
 * built to make good on: the layers above cannot tell this from the seeded provider, so swapping one
 * for the other is configuration and nothing else. Everything awkward in here exists to keep that
 * true rather than to make the code shorter.
 *
 * ## Three properties the contract demands that a naive live client would fail
 *
 * 1. **Idempotence, including across fresh instances.** The suite calls the same fetch twice and
 *    demands deeply-equal results. So this class holds *no* cursor, no cache and no mutable state:
 *    every call re-derives its answer from the request. Pagination is followed to exhaustion inside a
 *    single call rather than remembered between them.
 * 2. **Half-open `[start, end)` windowing, partitioning exactly.** Providers are vague about window
 *    edges — GitHub's `since` is inclusive and `until` is *also* inclusive — so the API window is only
 *    ever a coarse prefilter and the authoritative filter is `windowContains` applied here. Without
 *    that, a record landing exactly on `window.end` would be returned by two abutting windows and the
 *    partition property would fail.
 * 3. **Unavailability as coverage, never a throw.** A 429 becomes an `unavailable` coverage record
 *    naming the source and the reason. This is the rate-limit criterion: the report states a gap
 *    rather than presenting the remainder as a complete picture.
 *
 * ## Provider vocabulary stops at this file
 *
 * The suite runs `findProviderVocabularyViolations` over every record, and the banned token list
 * includes `sha`. So a commit's revision is `revisionId`, a pull request's identifier is
 * `displayNumber`, and GitHub's own words appear only as *values* and as local variables — never as a
 * field name that could reach the knowledge model.
 */

/** One configured repository, as a manager selected it on the connect screen. */
export interface GithubRepository {
  /** The provider-neutral key the report shows, e.g. `checkout-web`. */
  readonly repositoryKey: string;
  readonly owner: string;
  readonly name: string;
}

export interface GithubConnectorConfig {
  /** The configured source this connector answers as, e.g. `primary-code`. */
  readonly sourceKey: string;
  /**
   * The repositories to read, and the only ones that will ever be requested.
   *
   * An empty list is a configuration error rather than "read everything": the whole point of per-repo
   * scoping is that Compass reads what it was pointed at. See `EmptyRepositorySelectionError`.
   */
  readonly repositories: readonly GithubRepository[];
  /** The installation access token. Resolved by the composition root; never read from env here. */
  readonly token: string;
  readonly http: HttpClient;
  /** Overridable so a test can point at a recorded host. */
  readonly apiBaseUrl?: string;
}

export class EmptyRepositorySelectionError extends Error {
  constructor() {
    super(
      'The code connector was configured with no repositories. That is refused rather than treated as ' +
        '"every repository the token can see": an unscoped read would put another team\'s merges in ' +
        "this team's Yesterday, and a manager who selected nothing has not consented to anything.",
    );
    this.name = 'EmptyRepositorySelectionError';
  }
}

export const GITHUB_CONNECTOR_ID = 'code:github-app-v1';
const DEFAULT_API_BASE_URL = 'https://api.github.com';

/** The artifacts a code host can answer. The five it cannot are reported as absent capability. */
const SUPPORTED: Readonly<Record<ArtifactKind, boolean>> = Object.freeze({
  commits: true,
  pull_requests: true,
  reviews: true,
  branch_refs: true,
  release_tags: true,
  issues: false,
  issue_transitions: false,
  sprints: false,
  sprint_scope_changes: false,
  messages: false,
});

/** Tracker keys referenced in prose, e.g. `DEV-501`. Opaque to Compass; only ever compared. */
const WORK_ITEM_KEY_PATTERN = /\b[A-Z][A-Z0-9]+-\d+\b/g;

/**
 * Returns a mutable array on purpose: the port's record schemas infer `string[]` from
 * `z.array(z.string())`, so a `readonly string[]` here would not assign to `linkedWorkItemKeys`.
 * Sorted and de-duplicated so two runs over the same prose produce the same list, which the
 * contract's idempotence assertion requires.
 */
const workItemKeysIn = (...texts: readonly (string | null | undefined)[]): string[] =>
  [
    ...new Set(
      texts
        .filter((text): text is string => typeof text === 'string')
        .flatMap((text) => text.match(WORK_ITEM_KEY_PATTERN) ?? []),
    ),
  ].sort();

const instantFromIsoOrNull = (value: unknown): Instant | null =>
  typeof value === 'string' && value.length > 0 ? instantFromEpochMillis(Date.parse(value)) : null;

/**
 * A person as the code host knows them, which is an email when one is published and an account
 * handle otherwise.
 *
 * Never resolved to a Compass developer here — identity resolution is the roster's job, and a
 * connector that guessed would attribute one person's work to another.
 */
const identityFrom = (input: {
  readonly email?: unknown;
  readonly login?: unknown;
  readonly displayName?: unknown;
}): ExternalIdentity => {
  const email = typeof input.email === 'string' && input.email.includes('@') ? input.email : null;
  const login = typeof input.login === 'string' && input.login.length > 0 ? input.login : null;
  const displayName = typeof input.displayName === 'string' && input.displayName.length > 0 ? input.displayName : null;

  if (email !== null) return { kind: 'email', value: email, displayName };
  if (login !== null) return { kind: 'handle', value: login, displayName };
  // Neither published: an anonymous author is a real state on a squashed or imported commit.
  return { kind: 'handle', value: 'unknown', displayName };
};

/** What one repository read produced, plus whether it was complete. */
interface RepositoryOutcome<TRecord> {
  readonly records: readonly TRecord[];
  readonly failure: { readonly reason: CoverageReason; readonly detail: string } | null;
}

const ok = <TRecord>(records: readonly TRecord[]): RepositoryOutcome<TRecord> => ({ records, failure: null });

export class GithubConnector implements ConnectorPort {
  readonly connectorId = GITHUB_CONNECTOR_ID;
  readonly #config: GithubConnectorConfig;
  readonly #baseUrl: string;

  constructor(config: GithubConnectorConfig) {
    if (config.repositories.length === 0) throw new EmptyRepositorySelectionError();
    this.#config = config;
    this.#baseUrl = (config.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, '');
  }

  capabilities(): ConnectorCapabilities {
    return {
      connectorId: this.connectorId,
      artifacts: SUPPORTED,
      // R5 of the ladder. A code host knows about tags, not about deployments, and inferring a deploy
      // from a tag would be the single most damaging claim this product could make.
      deploySignal: false,
      chatScope: 'none',
      sources: [{ sourceKey: this.#config.sourceKey, sourceKind: 'code' }],
    };
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  /**
   * One request, with the headers the API expects.
   *
   * `X-GitHub-Api-Version` is pinned: an unpinned client silently changes shape when the provider
   * ships a new default, and a connector whose parsing depends on the default is a connector that
   * breaks on somebody else's release schedule.
   */
  async #get(path: string): Promise<HttpResponse> {
    return await this.#config.http.send({
      method: 'GET',
      url: `${this.#baseUrl}${path}`,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.#config.token}`,
        'x-github-api-version': '2022-11-28',
      },
    });
  }

  /**
   * A JSON array from a paginated collection, followed to exhaustion.
   *
   * Pagination is resolved *inside* one call, never remembered on the instance: the contract requires
   * a fresh instance to answer identically, so a cursor held as state would be a contract failure as
   * well as a correctness one. Pages are requested by explicit `page=` rather than by following the
   * `Link` header, so the URL sequence is deterministic and a replayed fixture can key on it.
   */
  async #collect(pathWithQuery: string): Promise<{ readonly rows: readonly unknown[]; readonly failure: RepositoryOutcome<never>['failure'] }> {
    const rows: unknown[] = [];

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const separator = pathWithQuery.includes('?') ? '&' : '?';
      const response = await this.#get(`${pathWithQuery}${separator}per_page=${PAGE_SIZE}&page=${page}`);

      const failure = this.#failureFor(response);
      if (failure !== null) return { rows, failure };

      const parsed = JSON.parse(response.body) as unknown;
      if (!Array.isArray(parsed)) return { rows, failure: null };

      rows.push(...parsed);
      // A short page is the last page. Asking for one more would be a wasted request on every read.
      if (parsed.length < PAGE_SIZE) break;
    }

    return { rows, failure: null };
  }

  /**
   * Turns a non-200 into the coverage reason a manager will read, or null when the response is fine.
   *
   * This is the single place an HTTP status becomes a *stated* condition. Every caller funnels
   * through it so that no endpoint can grow its own idea of what a 429 means.
   */
  #failureFor(response: HttpResponse): RepositoryOutcome<never>['failure'] {
    if (response.status === 200) return null;

    if (isRateLimited(response)) {
      const retryAfter = response.headers['retry-after'];
      return {
        reason: 'rate_limited',
        detail:
          `${this.#config.sourceKey} was rate limited by the code host, so none of this window was read` +
          (retryAfter === undefined ? '.' : `; it asked Compass to wait ${retryAfter} seconds.`),
      };
    }

    if (isAuthFailure(response)) {
      return {
        reason: response.status === 401 ? 'authentication_failed' : 'permission_denied',
        detail:
          `${this.#config.sourceKey} refused the stored credential (HTTP ${response.status}). Reconnect the ` +
          'code host; Compass will not report on a partial read as though it were complete.',
      };
    }

    return {
      reason: 'provider_error',
      detail: `${this.#config.sourceKey} answered HTTP ${response.status}, so this window was not read.`,
    };
  }

  // -------------------------------------------------------------------------
  // The shared shape of every fetch method
  // -------------------------------------------------------------------------

  /**
   * Runs a per-repository read and assembles the one coverage record the contract requires.
   *
   * Coverage is per *source*, not per repository: a manager configures "the code host" and wants to
   * know whether to trust it today, not which of six repositories answered. So the worst outcome
   * across the selected repositories decides the source's status, and the failing repository's own
   * sentence is what gets shown.
   */
  async #answer<TRecord>(
    artifact: ArtifactKind,
    request: ConnectorRequest,
    read: (repository: GithubRepository) => Promise<RepositoryOutcome<TRecord>>,
  ): Promise<ConnectorResult<TRecord>> {
    const { sourceKey } = this.#config;
    const sourceKind = ARTIFACT_SOURCE_KIND[artifact];

    // `sourceKeys` restricts the query to named sources. This connector is one source, so a request
    // naming others has nothing to do with it — and must still answer with coverage, not silence.
    if (request.sourceKeys !== undefined && !request.sourceKeys.includes(sourceKey)) {
      return connectorResult(artifact, request.window, [], []);
    }

    if (!SUPPORTED[artifact]) {
      return connectorResult(artifact, request.window, [], [
        unavailableCoverage({
          sourceKey,
          sourceKind,
          artifact,
          requestedWindow: request.window,
          observedAt: request.now,
          reason: 'capability_absent',
          detail:
            `${sourceKey} is a code host and cannot answer for ${artifact.replace(/_/g, ' ')}. This is an ` +
            'absent capability, not an empty day — the report says so rather than implying nothing happened.',
        }),
      ]);
    }

    const collected: TRecord[] = [];
    let failure: RepositoryOutcome<never>['failure'] = null;

    for (const repository of this.#config.repositories) {
      const outcome = await read(repository);
      collected.push(...outcome.records);
      // First failure wins the sentence: a manager needs one actionable reason, not six.
      if (outcome.failure !== null && failure === null) failure = outcome.failure;
    }

    if (failure !== null) {
      // Records already read are deliberately discarded. A partial read presented with a `complete`
      // count is exactly the "reporting on partial data as complete" the criterion forbids, and the
      // half-window Compass did get is not worth the sentence it would take to qualify it.
      return connectorResult(artifact, request.window, [], [
        unavailableCoverage({
          sourceKey,
          sourceKind,
          artifact,
          requestedWindow: request.window,
          observedAt: request.now,
          reason: failure.reason,
          detail: failure.detail,
        }),
      ]);
    }

    // The authoritative window filter, applied here rather than trusted from the API. See the class
    // comment: provider window parameters are inclusive at both ends and only ever a prefilter.
    const inWindow = collected.filter((record) =>
      windowContains(request.window, (record as { readonly occurredAt: Instant }).occurredAt),
    );
    const ordered = sortRecords(inWindow as never) as readonly TRecord[];

    return connectorResult(artifact, request.window, ordered, [
      completeCoverage({
        sourceKey,
        sourceKind,
        artifact,
        requestedWindow: request.window,
        observedAt: request.now,
        recordCount: ordered.length,
      }),
    ]);
  }

  // -------------------------------------------------------------------------
  // The ten port methods
  // -------------------------------------------------------------------------

  /**
   * Commits, each with the file count the report quotes.
   *
   * The list endpoint does not carry a file count, so each commit is read once more for its own
   * detail. That is deliberate rather than lazy: `changedFileCount` is a required field, and the
   * alternatives were to invent a zero — a fabricated number in a product whose whole argument is
   * that its numbers are real — or to make the field optional and push the problem into analysis. The
   * cost is bounded because the window is a day, not a history.
   */
  async fetchCommits(request: ConnectorRequest): Promise<ConnectorResult<CommitRecord>> {
    const since = toIso(request.window.start);
    const until = toIso(request.window.end);

    return await this.#answer('commits', request, async (repository) => {
      const listed = await this.#collect(
        `/repos/${repository.owner}/${repository.name}/commits?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`,
      );
      if (listed.failure !== null) return { records: [], failure: listed.failure };

      const records: CommitRecord[] = [];
      for (const row of listed.rows) {
        const summary = row as {
          sha?: unknown;
          commit?: { author?: Record<string, unknown>; committer?: Record<string, unknown>; message?: unknown };
          author?: { login?: unknown } | null;
          committer?: { login?: unknown } | null;
          parents?: readonly { sha?: unknown }[];
        };
        const revisionId = typeof summary.sha === 'string' ? summary.sha : null;
        if (revisionId === null) continue;

        const detailResponse = await this.#get(`/repos/${repository.owner}/${repository.name}/commits/${revisionId}`);
        const detailFailure = this.#failureFor(detailResponse);
        if (detailFailure !== null) return { records: [], failure: detailFailure };
        const detail = JSON.parse(detailResponse.body) as { files?: readonly unknown[] };

        const committedAt = instantFromIsoOrNull(summary.commit?.committer?.['date']);
        const authoredAt = instantFromIsoOrNull(summary.commit?.author?.['date']);
        if (committedAt === null || authoredAt === null) continue;

        records.push({
          sourceKey: this.#config.sourceKey,
          sourceKind: 'code',
          sourceRecordId: revisionId,
          // When it landed, not when it was written: a commit authored last week and pushed today is
          // today's event, and dating it by `authoredAt` would put it in a report nobody was reading.
          occurredAt: committedAt,
          repositoryKey: repository.repositoryKey,
          revisionId,
          parentRevisionIds: (summary.parents ?? [])
            .map((parent) => parent.sha)
            .filter((value): value is string => typeof value === 'string'),
          authorIdentity: identityFrom({
            email: summary.commit?.author?.['email'],
            login: summary.author?.login,
            displayName: summary.commit?.author?.['name'],
          }),
          committerIdentity: identityFrom({
            email: summary.commit?.committer?.['email'],
            login: summary.committer?.login,
            displayName: summary.commit?.committer?.['name'],
          }),
          authoredAt,
          message: typeof summary.commit?.message === 'string' ? summary.commit.message : '',
          changedFileCount: Array.isArray(detail.files) ? detail.files.length : 0,
          branchName: null,
        });
      }

      return ok(records);
    });
  }

  async fetchPullRequests(request: ConnectorRequest): Promise<ConnectorResult<PullRequestRecord>> {
    return await this.#answer('pull_requests', request, async (repository) => {
      const listed = await this.#collect(
        `/repos/${repository.owner}/${repository.name}/pulls?state=all&sort=updated&direction=desc`,
      );
      if (listed.failure !== null) return { records: [], failure: listed.failure };

      return ok(
        listed.rows.flatMap((row) => {
          const pull = row as Record<string, unknown>;
          const updatedAt = instantFromIsoOrNull(pull['updated_at']);
          const createdAt = instantFromIsoOrNull(pull['created_at']);
          const identifier = pull['id'];
          const displayNumber = pull['number'];
          if (updatedAt === null || createdAt === null || typeof identifier !== 'number' || typeof displayNumber !== 'number') {
            return [];
          }

          const mergedAt = instantFromIsoOrNull(pull['merged_at']);
          const closedAt = instantFromIsoOrNull(pull['closed_at']);
          const head = pull['head'] as { sha?: unknown; ref?: unknown } | undefined;
          const base = pull['base'] as { ref?: unknown } | undefined;
          const title = typeof pull['title'] === 'string' ? pull['title'] : '';
          const description = typeof pull['body'] === 'string' ? pull['body'] : null;

          const record: PullRequestRecord = {
            sourceKey: this.#config.sourceKey,
            sourceKind: 'code',
            sourceRecordId: String(identifier),
            occurredAt: updatedAt,
            repositoryKey: repository.repositoryKey,
            displayNumber,
            title,
            description,
            authorIdentity: identityFrom({
              login: (pull['user'] as { login?: unknown } | null)?.login,
              displayName: (pull['user'] as { name?: unknown } | null)?.name,
            }),
            state:
              mergedAt !== null ? 'merged' : closedAt !== null ? 'closed' : pull['draft'] === true ? 'draft' : 'open',
            createdAt,
            updatedAt,
            mergedAt,
            closedAt,
            sourceBranch: typeof head?.ref === 'string' && head.ref.length > 0 ? head.ref : 'unknown',
            targetBranch: typeof base?.ref === 'string' && base.ref.length > 0 ? base.ref : 'unknown',
            headRevisionId: typeof head?.sha === 'string' && head.sha.length > 0 ? head.sha : 'unknown',
            mergeRevisionId: typeof pull['merge_commit_sha'] === 'string' ? (pull['merge_commit_sha'] as string) : null,
            requestedReviewerIdentities: ((pull['requested_reviewers'] as readonly { login?: unknown }[] | undefined) ?? []).map(
              (reviewer) => identityFrom({ login: reviewer.login }),
            ),
            // Read out of the prose rather than from a link table: this is how a code host that is not
            // the tracker says which tracker item a change serves.
            linkedWorkItemKeys: workItemKeysIn(title, description),
          };
          return [record];
        }),
      );
    });
  }

  /**
   * Reviews, which are per pull request and therefore need the pull requests first.
   *
   * `pullRequestRef` is the pull request's own `sourceRecordId` — the provider's opaque id, not its
   * display number — because that is what the port says the reference is, and because two
   * repositories can both have a `#12`.
   */
  async fetchReviews(request: ConnectorRequest): Promise<ConnectorResult<ReviewRecord>> {
    return await this.#answer('reviews', request, async (repository) => {
      const listed = await this.#collect(
        `/repos/${repository.owner}/${repository.name}/pulls?state=all&sort=updated&direction=desc`,
      );
      if (listed.failure !== null) return { records: [], failure: listed.failure };

      const records: ReviewRecord[] = [];
      for (const row of listed.rows) {
        const pull = row as { id?: unknown; number?: unknown };
        if (typeof pull.id !== 'number' || typeof pull.number !== 'number') continue;

        const reviews = await this.#collect(
          `/repos/${repository.owner}/${repository.name}/pulls/${pull.number}/reviews`,
        );
        if (reviews.failure !== null) return { records: [], failure: reviews.failure };

        for (const reviewRow of reviews.rows) {
          const review = reviewRow as Record<string, unknown>;
          const submittedAt = instantFromIsoOrNull(review['submitted_at']);
          const identifier = review['id'];
          if (submittedAt === null || typeof identifier !== 'number') continue;

          const state = String(review['state'] ?? '').toUpperCase();
          records.push({
            sourceKey: this.#config.sourceKey,
            sourceKind: 'code',
            sourceRecordId: String(identifier),
            occurredAt: submittedAt,
            repositoryKey: repository.repositoryKey,
            pullRequestRef: String(pull.id),
            reviewerIdentity: identityFrom({ login: (review['user'] as { login?: unknown } | null)?.login }),
            verdict:
              state === 'APPROVED'
                ? 'approved'
                : state === 'CHANGES_REQUESTED'
                  ? 'changes_requested'
                  : state === 'DISMISSED'
                    ? 'dismissed'
                    : 'commented',
            submittedAt,
            commentCount: 0,
          });
        }
      }

      return ok(records);
    });
  }

  /**
   * Branch tips, dated by the commit they point at.
   *
   * A branch has no timestamp of its own, and the contract requires every record's `occurredAt` to sit
   * inside the window — so the tip commit's own date is the event time. That is also the honest
   * reading: "this branch moved" happened when the commit it now points at landed. Dating it `now`
   * instead would put every branch in every window and break the partition property.
   */
  async fetchBranchRefs(request: ConnectorRequest): Promise<ConnectorResult<BranchRefRecord>> {
    return await this.#answer('branch_refs', request, async (repository) => {
      const repoResponse = await this.#get(`/repos/${repository.owner}/${repository.name}`);
      const repoFailure = this.#failureFor(repoResponse);
      if (repoFailure !== null) return { records: [], failure: repoFailure };
      const defaultBranch = (JSON.parse(repoResponse.body) as { default_branch?: unknown }).default_branch;

      const listed = await this.#collect(`/repos/${repository.owner}/${repository.name}/branches`);
      if (listed.failure !== null) return { records: [], failure: listed.failure };

      const records: BranchRefRecord[] = [];
      for (const row of listed.rows) {
        const branch = row as { name?: unknown; commit?: { sha?: unknown } };
        const revisionId = branch.commit?.sha;
        if (typeof branch.name !== 'string' || typeof revisionId !== 'string') continue;

        const tipResponse = await this.#get(`/repos/${repository.owner}/${repository.name}/commits/${revisionId}`);
        const tipFailure = this.#failureFor(tipResponse);
        if (tipFailure !== null) return { records: [], failure: tipFailure };
        const tip = JSON.parse(tipResponse.body) as { commit?: { committer?: Record<string, unknown> } };
        const movedAt = instantFromIsoOrNull(tip.commit?.committer?.['date']);
        if (movedAt === null) continue;

        records.push({
          sourceKey: this.#config.sourceKey,
          sourceKind: 'code',
          sourceRecordId: `${repository.repositoryKey}:${branch.name}`,
          occurredAt: movedAt,
          repositoryKey: repository.repositoryKey,
          name: branch.name,
          revisionId,
          isDefault: branch.name === defaultBranch,
          observedAt: request.now,
        });
      }

      return ok(records);
    });
  }

  /**
   * Release tags — R4 of the completion ladder.
   *
   * The tag's commit is resolved through the git-ref endpoint rather than taken from a release's
   * `target_commitish`, which is a *branch name* on most releases and a revision on some. Reading a
   * branch name into `revisionId` would silently break the "was this change released" comparison for
   * every repository that tags from a branch.
   */
  async fetchReleaseTags(request: ConnectorRequest): Promise<ConnectorResult<ReleaseTagRecord>> {
    return await this.#answer('release_tags', request, async (repository) => {
      const listed = await this.#collect(`/repos/${repository.owner}/${repository.name}/releases`);
      if (listed.failure !== null) return { records: [], failure: listed.failure };

      const records: ReleaseTagRecord[] = [];
      for (const row of listed.rows) {
        const release = row as Record<string, unknown>;
        const tagName = release['tag_name'];
        const releasedAt = instantFromIsoOrNull(release['published_at']);
        if (typeof tagName !== 'string' || releasedAt === null) continue;

        const refResponse = await this.#get(
          `/repos/${repository.owner}/${repository.name}/git/ref/tags/${encodeURIComponent(tagName)}`,
        );
        const refFailure = this.#failureFor(refResponse);
        if (refFailure !== null) return { records: [], failure: refFailure };
        const revisionId = (JSON.parse(refResponse.body) as { object?: { sha?: unknown } }).object?.sha;
        if (typeof revisionId !== 'string') continue;

        records.push({
          sourceKey: this.#config.sourceKey,
          sourceKind: 'code',
          sourceRecordId: `${repository.repositoryKey}:${tagName}`,
          occurredAt: releasedAt,
          repositoryKey: repository.repositoryKey,
          name: tagName,
          revisionId,
          releasedAt,
          description: typeof release['body'] === 'string' ? (release['body'] as string) : null,
        });
      }

      return ok(records);
    });
  }

  // The five a code host cannot answer. Each reports absent capability rather than an empty day; the
  // shared `#answer` does that from the `SUPPORTED` table, so there is one statement of it, not five.
  async fetchIssues(request: ConnectorRequest): Promise<ConnectorResult<IssueRecord>> {
    return await this.#answer('issues', request, async () => ok<IssueRecord>([]));
  }

  async fetchIssueTransitions(request: ConnectorRequest): Promise<ConnectorResult<IssueTransitionRecord>> {
    return await this.#answer('issue_transitions', request, async () => ok<IssueTransitionRecord>([]));
  }

  async fetchSprints(request: ConnectorRequest): Promise<ConnectorResult<SprintRecord>> {
    return await this.#answer('sprints', request, async () => ok<SprintRecord>([]));
  }

  async fetchSprintScopeChanges(request: ConnectorRequest): Promise<ConnectorResult<SprintScopeChangeRecord>> {
    return await this.#answer('sprint_scope_changes', request, async () => ok<SprintScopeChangeRecord>([]));
  }

  async fetchMessages(request: ConnectorRequest): Promise<ConnectorResult<MessageRecord>> {
    return await this.#answer('messages', request, async () => ok<MessageRecord>([]));
  }

  /**
   * Per-source health for the freshness indicator.
   *
   * Derived from the same reads the report is built from — one probe per artifact family the host
   * supports — so the panel cannot claim a source is healthy while the report it sits beside was
   * generated from a rate-limited window.
   */
  async reportSourceHealth(request: ConnectorRequest): Promise<SourceHealthReport> {
    const probes = await Promise.all(
      ARTIFACT_KINDS.filter((artifact) => SUPPORTED[artifact]).map(async (artifact) => {
        const result = await this.#answer(artifact, request, async (repository) => {
          const probe = await this.#get(`/repos/${repository.owner}/${repository.name}`);
          const failure = this.#failureFor(probe);
          return failure === null ? ok<never>([]) : { records: [], failure };
        });
        return result.coverage;
      }),
    );

    const coverage: readonly SourceCoverage[] = probes.flat();
    const status = worstCoverageStatus(coverage.map((entry) => entry.status));
    const degraded = coverage.find((entry) => entry.status !== 'complete');

    const entry: SourceHealthEntry = {
      sourceKey: this.#config.sourceKey,
      sourceKind: 'code',
      status,
      reason: degraded?.reason ?? 'ok',
      detail:
        degraded?.detail ??
        `${this.#config.sourceKey} answered for ${this.#config.repositories.length} configured ` +
          `${this.#config.repositories.length === 1 ? 'repository' : 'repositories'}.`,
      // Null rather than `now`: this connector holds no journal, and stamping the request instant here
      // would tell a manager the data is fresh when what is fresh is the page.
      lastObservedAt: null,
    };

    return {
      connectorId: this.connectorId,
      window: request.window,
      observedAt: request.now,
      overall: status,
      sources: [entry],
    };
  }
}

/** Pages of 100 is the provider's maximum; a smaller page only means more round trips. */
const PAGE_SIZE = 100;

/**
 * The pagination stop. 20 pages of 100 is 2,000 records for one artifact in one window.
 *
 * A bound rather than an unbounded loop because a paginating client with an off-by-one in its
 * termination check does not fail, it hangs — and a connector that hangs takes the whole ingest tick
 * with it. Reaching this limit in a one-day window means something is wrong with the query, not with
 * the limit.
 */
const MAX_PAGES = 20;
