import {
  instantFromEpochMillis,
  toEpochMillis,
  windowContains,
  type Instant,
  type TimeWindow,
} from '@compass/clock';
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
  type WorkItemStatusCategory,
} from '@compass/connector-port';

/**
 * A live tracker connector, behind the port every other provider implements.
 *
 * ## The whole point of this file
 *
 * It passes `describeConnectorContract` **unmodified** — the same function the seeded provider and the
 * code host run. That is the architectural claim the port was built to make good on: the layers above
 * cannot tell this from the seeded provider, so swapping one for the other is configuration and nothing
 * else. Everything awkward in here exists to keep that true rather than to make the code shorter.
 *
 * ## Three properties the contract demands that a naive live client would fail
 *
 * 1. **Idempotence, including across fresh instances.** The suite calls the same fetch twice and demands
 *    deeply-equal results. So this class holds *no* cursor, no cache and no mutable state: every call
 *    re-derives its answer from the request, and pagination is followed to exhaustion inside a single
 *    call rather than remembered between them.
 * 2. **Half-open `[start, end)` windowing, partitioning exactly.** JQL is *far* vaguer about time than a
 *    code host is — see `#searchJql` — so the server-side bound is only ever a coarse prefilter and the
 *    authoritative filter is `windowContains` applied here.
 * 3. **Unavailability as coverage, never a throw.** A 429 becomes an `unavailable` coverage record naming
 *    the source and the reason, so the report states a gap rather than presenting the remainder as a
 *    complete picture.
 *
 * ## Provider vocabulary stops at this file
 *
 * The suite runs `findProviderVocabularyViolations` over every record, and the banned token list
 * includes `jira`, `atlassian`, `accountid`, `customfield`, `issuekey`, `storypoints` and `boardid`. So
 * a work item's key is `itemKey`, its estimate is `estimatePoints`, and Atlassian's own words appear
 * only as *values*, as URL fragments and as local variables — never as a field name that could reach the
 * knowledge model.
 */

/** One configured project, as a manager selected it on the connect screen. */
export interface JiraProject {
  /** The project key as the tracker knows it, e.g. `DEV`. This is what every JQL query is built from. */
  readonly projectKey: string;
}

export interface JiraConnectorConfig {
  /** The configured source this connector answers as, e.g. `primary-tracker`. */
  readonly sourceKey: string;
  /**
   * The projects to read, and the only ones that will ever be requested.
   *
   * An empty list is a configuration error rather than "read everything": the whole point of per-project
   * scoping is that Compass reads what it was pointed at. See `EmptyProjectSelectionError`.
   */
  readonly projects: readonly JiraProject[];
  /** The OAuth access token. Resolved by the composition root; never read from env here. */
  readonly accessToken: string;
  /**
   * The Atlassian cloud id for the site, which is how a 3LO token addresses one tenant.
   *
   * Part of the base URL rather than a header, because that is how `api.atlassian.com` routes: a token
   * is valid for several sites and the id is what says which one this source is.
   */
  readonly cloudId: string;
  readonly http: HttpClient;
  /** Overridable so a test can point at a recorded host. */
  readonly apiBaseUrl?: string;
  /**
   * Site-specific custom field ids.
   *
   * These are genuinely per-site — Jira allocates a numbered custom field for story points, sprint
   * membership and the flag, and the numbers differ between two sites of the same product. Defaulted to
   * the ids a standard Jira Software site allocates, and overridable because a site that was configured
   * by a human will not match. A wrong id here reads as an absent value rather than as a wrong one: the
   * field is missing, so the estimate is `null` and the flag is `false`, which is the safe direction.
   */
  readonly estimateFieldId?: string;
  readonly sprintFieldId?: string;
  readonly flaggedFieldId?: string;
}

export class EmptyProjectSelectionError extends Error {
  constructor() {
    super(
      'The tracker connector was configured with no projects. That is refused rather than treated as ' +
        '"every project the token can see": an unscoped read would put another team\'s issues in this ' +
        "team's Progress, and a manager who selected nothing has not consented to anything.",
    );
    this.name = 'EmptyProjectSelectionError';
  }
}

export const JIRA_CONNECTOR_ID = 'tracker:jira-cloud-v3';
const DEFAULT_API_BASE_URL = 'https://api.atlassian.com';

const DEFAULT_ESTIMATE_FIELD = 'customfield_10016';
const DEFAULT_SPRINT_FIELD = 'customfield_10020';
const DEFAULT_FLAGGED_FIELD = 'customfield_10021';

/** The artifacts a tracker can answer. The six it cannot are reported as absent capability. */
const SUPPORTED: Readonly<Record<ArtifactKind, boolean>> = Object.freeze({
  commits: false,
  pull_requests: false,
  reviews: false,
  branch_refs: false,
  release_tags: false,
  issues: true,
  issue_transitions: true,
  sprints: true,
  sprint_scope_changes: true,
  messages: false,
});

/** Pages of 100 is the API's maximum for a search; a smaller page only means more round trips. */
const SEARCH_PAGE_SIZE = 100;
/** The agile and changelog endpoints cap lower. */
const AGILE_PAGE_SIZE = 50;

/**
 * The pagination stop.
 *
 * A bound rather than an unbounded loop because a paginating client with an off-by-one in its
 * termination check does not fail, it hangs — and a connector that hangs takes the whole ingest tick
 * with it. Reaching this limit in a one-day window means something is wrong with the query, not with the
 * limit.
 */
const MAX_PAGES = 20;

/**
 * How far *before* the window the coarse JQL bound is set.
 *
 * A day, and the margin is not padding for its own sake. JQL compares timestamps at minute precision
 * and interprets a bare timestamp in the *authenticated user's own profile timezone* — neither of which
 * this connector can control, and both of which could otherwise exclude a record that belongs in the
 * window. A prefilter that is too narrow silently loses data; one that is too wide costs a slightly
 * larger response and is then corrected exactly by `windowContains`. A day comfortably covers the ±14
 * hours of timezone range plus the minute rounding.
 */
const PREFILTER_MARGIN_MS = 24 * 60 * 60 * 1000;

/**
 * `yyyy-MM-dd HH:mm` in UTC, which is the only absolute timestamp shape JQL accepts.
 *
 * Not ISO 8601: JQL rejects the `T` separator and the `Z` suffix outright, so a connector that sent
 * `toIso()` would get a 400 on every query.
 */
const jqlTimestamp = (instant: Instant): string =>
  new Date(toEpochMillis(instant)).toISOString().slice(0, 16).replace('T', ' ');

/**
 * Everything a window could have touched in one project, ordered so pagination is stable.
 *
 * The lower bound is `window.start` less `PREFILTER_MARGIN_MS` and there is deliberately no upper bound:
 * a record whose event time falls inside the window always has `updated` at or after that time, so a
 * lower bound alone is a *sound* prefilter for issues and for changelog entries alike. `windowContains`
 * downstream is what makes it exact.
 */
export const updatedSinceJql = (projectKey: string, window: TimeWindow): string => {
  const since = jqlTimestamp(instantFromEpochMillis(toEpochMillis(window.start) - PREFILTER_MARGIN_MS));
  return `project = "${projectKey}" AND updated >= "${since}" ORDER BY updated ASC`;
};

/**
 * Which of a selected project's issues are in one sprint.
 *
 * Carries **no** time bound, unlike every other query here, and that is the point: a sprint's
 * commitment includes the item nobody has touched since Monday. Filtering this by the report window
 * would quietly shrink `committedItemKeys` to "items that moved today", turning every reconciliation
 * against the commitment into a comparison with itself.
 */
export const sprintMembershipJql = (projectKey: string, sprintId: number): string =>
  `project = "${projectKey}" AND sprint = ${sprintId} ORDER BY key ASC`;

/** The issue fields the report needs, and nothing else — a narrower response is a faster one. */
const BASE_ISSUE_FIELDS: readonly string[] = [
  'summary',
  'description',
  'status',
  'issuetype',
  'priority',
  'labels',
  'assignee',
  'reporter',
  'created',
  'updated',
  'resolutiondate',
  'parent',
];

/** Atlassian's three status-category keys, mapped to the port's three. */
const STATUS_CATEGORIES: Readonly<Record<string, WorkItemStatusCategory>> = Object.freeze({
  new: 'todo',
  indeterminate: 'in_progress',
  done: 'done',
});

const instantFromIsoOrNull = (value: unknown): Instant | null =>
  typeof value === 'string' && value.length > 0 ? instantFromEpochMillis(Date.parse(value)) : null;

/**
 * A person as the tracker knows them.
 *
 * An address when the site publishes one and the opaque account id otherwise — Jira hides
 * `emailAddress` whenever a user's profile visibility says to, which is the common case on a site with
 * any privacy configuration at all. Never resolved to a Compass developer here: identity resolution is
 * the roster's job, and a connector that guessed would attribute one person's work to another.
 */
const identityFrom = (value: unknown): ExternalIdentity | null => {
  if (value === null || typeof value !== 'object') return null;
  const person = value as { emailAddress?: unknown; accountId?: unknown; displayName?: unknown };

  const displayName = typeof person.displayName === 'string' && person.displayName.length > 0 ? person.displayName : null;
  const email =
    typeof person.emailAddress === 'string' && person.emailAddress.includes('@') ? person.emailAddress : null;
  if (email !== null) return { kind: 'email', value: email, displayName };

  const account = typeof person.accountId === 'string' && person.accountId.length > 0 ? person.accountId : null;
  if (account !== null) return { kind: 'account', value: account, displayName };

  return null;
};

/**
 * Plain text out of an Atlassian Document Format body.
 *
 * The v3 API returns a description as a document tree, not a string. The alternative to walking it was
 * to ask for the v2 representation, which returns wiki markup — a different markup language rather than
 * no markup. Only the text nodes are kept: the narration model is given prose, and passing it a JSON
 * tree would be handing it something to hallucinate structure from.
 */
const plainTextFrom = (value: unknown): string | null => {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (value === null || typeof value !== 'object') return null;

  const collect = (node: unknown, into: string[]): void => {
    if (Array.isArray(node)) {
      for (const entry of node) collect(entry, into);
      return;
    }
    if (node === null || typeof node !== 'object') return;

    const shaped = node as { type?: unknown; text?: unknown; content?: unknown };
    if (typeof shaped.text === 'string') into.push(shaped.text);
    // A paragraph break is meaningful prose structure; everything else is styling Compass discards.
    if (shaped.type === 'paragraph' && into.length > 0) into.push('\n');
    if (shaped.content !== undefined) collect(shaped.content, into);
  };

  const parts: string[] = [];
  collect((value as { content?: unknown }).content, parts);
  const text = parts.join('').trim();
  return text.length > 0 ? text : null;
};

/** What one project read produced, plus whether it was complete. */
interface ProjectOutcome<TRecord> {
  readonly records: readonly TRecord[];
  readonly failure: { readonly reason: CoverageReason; readonly detail: string } | null;
}

const ok = <TRecord>(records: readonly TRecord[]): ProjectOutcome<TRecord> => ({ records, failure: null });

/** A changelog entry, already narrowed to the parts this connector reads. */
interface ChangeGroup {
  readonly id: string;
  readonly at: Instant;
  readonly actorIdentity: ExternalIdentity | null;
  readonly items: readonly {
    readonly field: string;
    readonly from: string | null;
    readonly fromString: string | null;
    readonly to: string | null;
    readonly toString: string | null;
  }[];
}

export class JiraConnector implements ConnectorPort {
  readonly connectorId = JIRA_CONNECTOR_ID;
  readonly #config: JiraConnectorConfig;
  readonly #baseUrl: string;

  constructor(config: JiraConnectorConfig) {
    if (config.projects.length === 0) throw new EmptyProjectSelectionError();
    this.#config = config;
    this.#baseUrl = `${(config.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, '')}/ex/jira/${config.cloudId}`;
  }

  capabilities(): ConnectorCapabilities {
    return {
      connectorId: this.connectorId,
      artifacts: SUPPORTED,
      // R5 of the ladder. A tracker knows an issue reached a column called "Done"; it does not know
      // anything was deployed, and inferring a deploy from a status would be the single most damaging
      // claim this product could make.
      deploySignal: false,
      chatScope: 'none',
      sources: [{ sourceKey: this.#config.sourceKey, sourceKind: 'tracker' }],
    };
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  async #get(path: string): Promise<HttpResponse> {
    return await this.#config.http.send({
      method: 'GET',
      url: `${this.#baseUrl}${path}`,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${this.#config.accessToken}`,
      },
    });
  }

  /**
   * Turns a non-200 into the coverage reason a manager will read, or null when the response is fine.
   *
   * This is the single place an HTTP status becomes a *stated* condition. Every caller funnels through
   * it so that no endpoint can grow its own idea of what a 429 means.
   */
  #failureFor(response: HttpResponse): ProjectOutcome<never>['failure'] {
    if (response.status === 200) return null;

    if (isRateLimited(response)) {
      const retryAfter = response.headers['retry-after'];
      return {
        reason: 'rate_limited',
        detail:
          `${this.#config.sourceKey} was rate limited by the tracker, so none of this window was read` +
          (retryAfter === undefined ? '.' : `; it asked Compass to wait ${retryAfter} seconds.`),
      };
    }

    if (isAuthFailure(response)) {
      return {
        reason: response.status === 401 ? 'authentication_failed' : 'permission_denied',
        detail:
          `${this.#config.sourceKey} refused the stored credential (HTTP ${response.status}). Reconnect the ` +
          'tracker; Compass will not report on a partial read as though it were complete.',
      };
    }

    return {
      reason: 'provider_error',
      detail: `${this.#config.sourceKey} answered HTTP ${response.status}, so this window was not read.`,
    };
  }

  /**
   * A JQL search, followed to exhaustion.
   *
   * ## Why the JQL travels in the URL rather than in a POST body
   *
   * The search endpoint accepts either. It is sent as a query parameter here because the acceptance
   * criterion — "no unselected project is ever queried" — is an assertion about *which requests left the
   * process*, and the test watches request URLs. A body-encoded JQL would slip past a URL-only
   * assertion, which would leave the scoping guarantee untested while looking tested. The scope is
   * observable at the seam, on purpose.
   *
   * ## The coarse bound
   *
   * See `PREFILTER_MARGIN_MS`. The lower bound is `window.start` less a day and there is deliberately no
   * upper bound: a record whose event time is inside the window always has `updated` at or after that
   * time, so a lower bound alone is a *sound* prefilter for both issues and changelog entries, while an
   * upper bound would have to be widened too and would then exclude nothing. Correctness comes from
   * `windowContains` downstream; this only keeps the response small.
   */
  async #searchJql(
    jql: string,
    fields: readonly string[],
  ): Promise<{ readonly rows: readonly unknown[]; readonly failure: ProjectOutcome<never>['failure'] }> {
    const rows: unknown[] = [];
    let pageToken: string | null = null;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query = new URLSearchParams({
        jql,
        fields: fields.join(','),
        maxResults: String(SEARCH_PAGE_SIZE),
      });
      if (pageToken !== null) query.set('nextPageToken', pageToken);

      const response = await this.#get(`/rest/api/3/search/jql?${query.toString()}`);
      const failure = this.#failureFor(response);
      if (failure !== null) return { rows, failure };

      const parsed = JSON.parse(response.body) as { issues?: unknown; nextPageToken?: unknown };
      if (Array.isArray(parsed.issues)) rows.push(...parsed.issues);

      // The token-based cursor: its absence is the end of the result set. There is no total to compare
      // against and no `startAt` to advance, which is the current search API's contract.
      pageToken = typeof parsed.nextPageToken === 'string' && parsed.nextPageToken.length > 0 ? parsed.nextPageToken : null;
      if (pageToken === null) break;
    }

    return { rows, failure: null };
  }

  /**
   * A `startAt`-paginated collection — the agile endpoints and the per-issue changelog.
   *
   * The second pagination style in one connector is not an accident of the code: the search API moved to
   * an opaque page token while the agile and changelog endpoints still page by offset. Pretending they
   * were the same would mean one of the two loops never terminating correctly.
   */
  async #collectPaged(
    pathWithQuery: string,
  ): Promise<{ readonly rows: readonly unknown[]; readonly failure: ProjectOutcome<never>['failure'] }> {
    const rows: unknown[] = [];
    const separator = pathWithQuery.includes('?') ? '&' : '?';

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const startAt = page * AGILE_PAGE_SIZE;
      const response = await this.#get(
        `${pathWithQuery}${separator}startAt=${startAt}&maxResults=${AGILE_PAGE_SIZE}`,
      );

      const failure = this.#failureFor(response);
      if (failure !== null) return { rows, failure };

      const parsed = JSON.parse(response.body) as { values?: unknown; isLast?: unknown };
      const values = Array.isArray(parsed.values) ? parsed.values : [];
      rows.push(...values);

      if (parsed.isLast === true || values.length < AGILE_PAGE_SIZE) break;
    }

    return { rows, failure: null };
  }

  // -------------------------------------------------------------------------
  // The shared shape of every fetch method
  // -------------------------------------------------------------------------

  /**
   * Runs a per-project read and assembles the one coverage record the contract requires.
   *
   * Coverage is per *source*, not per project: a manager configures "the tracker" and wants to know
   * whether to trust it today, not which of four projects answered. So the worst outcome across the
   * selected projects decides the source's status, and the failing project's own sentence is what gets
   * shown.
   */
  async #answer<TRecord>(
    artifact: ArtifactKind,
    request: ConnectorRequest,
    read: (project: JiraProject) => Promise<ProjectOutcome<TRecord>>,
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
            `${sourceKey} is a tracker and cannot answer for ${artifact.replace(/_/g, ' ')}. This is an ` +
            'absent capability, not an empty day — the report says so rather than implying nothing happened.',
        }),
      ]);
    }

    const collected: TRecord[] = [];
    let failure: ProjectOutcome<never>['failure'] = null;

    for (const project of this.#config.projects) {
      const outcome = await read(project);
      collected.push(...outcome.records);
      // First failure wins the sentence: a manager needs one actionable reason, not four.
      if (outcome.failure !== null && failure === null) failure = outcome.failure;
    }

    if (failure !== null) {
      // Records already read are deliberately discarded. A partial read presented with a `complete`
      // count is exactly the "reporting on partial data as complete" the criterion forbids.
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

    /**
     * De-duplicated by the source's own id, because one board can be shared by two selected projects.
     *
     * That is a real Jira configuration rather than a hypothetical: a board's filter can span projects,
     * so a sprint reached through project A and again through project B is the same sprint and must be
     * one record. The contract's "returns each record once" assertion is what would catch this, and
     * emitting it twice would also double every count computed from it.
     */
    const seen = new Set<string>();
    const unique = collected.filter((record) => {
      const id = (record as { readonly sourceRecordId: string }).sourceRecordId;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    // The authoritative window filter, applied here rather than trusted from the API. See `#searchJql`:
    // the JQL bound is minute-precision, timezone-dependent and deliberately widened.
    const inWindow = unique.filter((record) =>
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
  // Shared reads
  // -------------------------------------------------------------------------

  /** The issue fields this connector asks for, including the three site-specific custom ones. */
  #issueFields(): readonly string[] {
    return [
      ...BASE_ISSUE_FIELDS,
      this.#config.estimateFieldId ?? DEFAULT_ESTIMATE_FIELD,
      this.#config.sprintFieldId ?? DEFAULT_SPRINT_FIELD,
      this.#config.flaggedFieldId ?? DEFAULT_FLAGGED_FIELD,
    ];
  }

  /**
   * Status name to status category, for one project.
   *
   * The changelog records a transition as two status *names* and nothing else, so the category — which is
   * what the report actually reasons about — has to come from somewhere. This is that somewhere: the
   * project's own status list, which carries each status's category. Read per project because two
   * projects can legitimately give the same status name different categories.
   */
  async #statusCategories(
    projectKey: string,
  ): Promise<{ readonly map: ReadonlyMap<string, WorkItemStatusCategory>; readonly failure: ProjectOutcome<never>['failure'] }> {
    const response = await this.#get(`/rest/api/3/project/${encodeURIComponent(projectKey)}/statuses`);
    const failure = this.#failureFor(response);
    if (failure !== null) return { map: new Map(), failure };

    const parsed = JSON.parse(response.body) as unknown;
    const map = new Map<string, WorkItemStatusCategory>();

    for (const typeEntry of Array.isArray(parsed) ? parsed : []) {
      const statuses = (typeEntry as { statuses?: unknown }).statuses;
      for (const statusEntry of Array.isArray(statuses) ? statuses : []) {
        const status = statusEntry as { name?: unknown; statusCategory?: { key?: unknown } };
        const key = status.statusCategory?.key;
        if (typeof status.name !== 'string' || typeof key !== 'string') continue;
        const category = STATUS_CATEGORIES[key];
        if (category !== undefined) map.set(status.name, category);
      }
    }

    return { map, failure: null };
  }

  /**
   * Every change group on one issue, narrowed to the fields this connector reads.
   *
   * Both `fetchIssueTransitions` and `fetchSprintScopeChanges` are built from this, because Jira records
   * both in the same changelog — a status move and a sprint move are two `items` on the same entry, made
   * by the same person at the same instant.
   */
  async #changeGroups(
    itemKey: string,
  ): Promise<{ readonly groups: readonly ChangeGroup[]; readonly failure: ProjectOutcome<never>['failure'] }> {
    const collected = await this.#collectPaged(`/rest/api/3/issue/${encodeURIComponent(itemKey)}/changelog`);
    if (collected.failure !== null) return { groups: [], failure: collected.failure };

    const groups: ChangeGroup[] = [];
    for (const row of collected.rows) {
      const entry = row as { id?: unknown; created?: unknown; author?: unknown; items?: unknown };
      const at = instantFromIsoOrNull(entry.created);
      if (at === null || (typeof entry.id !== 'string' && typeof entry.id !== 'number')) continue;

      const items = (Array.isArray(entry.items) ? entry.items : []).flatMap((itemRow) => {
        const item = itemRow as {
          field?: unknown;
          from?: unknown;
          fromString?: unknown;
          to?: unknown;
          toString?: unknown;
        };
        if (typeof item.field !== 'string') return [];
        const asText = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
        return [
          {
            field: item.field,
            from: asText(item.from),
            fromString: asText(item.fromString),
            to: asText(item.to),
            toString: asText(item.toString),
          },
        ];
      });

      groups.push({ id: String(entry.id), at, actorIdentity: identityFrom(entry.author), items });
    }

    return { groups, failure: null };
  }

  /** The issue keys a window's changelog read has to consider. See `#searchJql` on why this is sound. */
  async #issueKeysFor(
    project: JiraProject,
    window: TimeWindow,
  ): Promise<{ readonly keys: readonly string[]; readonly failure: ProjectOutcome<never>['failure'] }> {
    // Only the key is needed, so only the key is requested.
    const searched = await this.#searchJql(updatedSinceJql(project.projectKey, window), ['key']);
    if (searched.failure !== null) return { keys: [], failure: searched.failure };

    const keys = searched.rows
      .map((row) => (row as { key?: unknown }).key)
      .filter((key): key is string => typeof key === 'string' && key.length > 0);

    return { keys, failure: null };
  }

  // -------------------------------------------------------------------------
  // The four a tracker can answer
  // -------------------------------------------------------------------------

  async fetchIssues(request: ConnectorRequest): Promise<ConnectorResult<IssueRecord>> {
    return await this.#answer('issues', request, async (project) => {
      const searched = await this.#searchJql(
        updatedSinceJql(project.projectKey, request.window),
        this.#issueFields(),
      );
      if (searched.failure !== null) return { records: [], failure: searched.failure };

      const estimateField = this.#config.estimateFieldId ?? DEFAULT_ESTIMATE_FIELD;
      const sprintField = this.#config.sprintFieldId ?? DEFAULT_SPRINT_FIELD;
      const flaggedField = this.#config.flaggedFieldId ?? DEFAULT_FLAGGED_FIELD;

      const records: IssueRecord[] = [];
      for (const row of searched.rows) {
        const issue = row as { id?: unknown; key?: unknown; fields?: Record<string, unknown> };
        const fields = issue.fields ?? {};
        const itemKey = issue.key;
        const identifier = issue.id;
        if (typeof itemKey !== 'string' || (typeof identifier !== 'string' && typeof identifier !== 'number')) continue;

        const createdAt = instantFromIsoOrNull(fields['created']);
        const updatedAt = instantFromIsoOrNull(fields['updated']);
        if (createdAt === null || updatedAt === null) continue;

        const status = fields['status'] as { name?: unknown; statusCategory?: { key?: unknown } } | undefined;
        const statusName = typeof status?.name === 'string' && status.name.length > 0 ? status.name : null;
        const categoryKey = status?.statusCategory?.key;
        const statusCategory =
          typeof categoryKey === 'string' ? STATUS_CATEGORIES[categoryKey] : undefined;
        // A status with no name or no recognised category is a record Compass cannot describe honestly,
        // and inventing either would put a wrong word in the report rather than one fewer row.
        if (statusName === null || statusCategory === undefined) continue;

        const itemType = (fields['issuetype'] as { name?: unknown } | undefined)?.name;
        if (typeof itemType !== 'string' || itemType.length === 0) continue;

        const estimate = fields[estimateField];
        const flagged = fields[flaggedField];
        const priorityName = (fields['priority'] as { name?: unknown } | null | undefined)?.name;
        const parentKey = (fields['parent'] as { key?: unknown } | null | undefined)?.key;

        records.push({
          sourceKey: this.#config.sourceKey,
          sourceKind: 'tracker',
          sourceRecordId: String(identifier),
          // When the item last moved, which is what makes it part of a day's report.
          occurredAt: updatedAt,
          projectKey: project.projectKey,
          itemKey,
          title: typeof fields['summary'] === 'string' ? fields['summary'] : '',
          description: plainTextFrom(fields['description']),
          status: statusName,
          statusCategory,
          itemType,
          priority: typeof priorityName === 'string' && priorityName.length > 0 ? priorityName : null,
          estimatePoints: typeof estimate === 'number' ? estimate : null,
          labels: Array.isArray(fields['labels'])
            ? (fields['labels'] as unknown[]).filter((label): label is string => typeof label === 'string')
            : [],
          assigneeIdentity: identityFrom(fields['assignee']),
          reporterIdentity: identityFrom(fields['reporter']),
          createdAt,
          updatedAt,
          resolvedAt: instantFromIsoOrNull(fields['resolutiondate']),
          parentItemKey: typeof parentKey === 'string' && parentKey.length > 0 ? parentKey : null,
          sprintRefs: sprintRefsFrom(fields[sprintField]),
          // Jira's flag is a custom field holding a single-value list. Its absence is `false`, which is
          // also what a wrong configured field id produces — the safe direction.
          flaggedBlocked: Array.isArray(flagged) ? flagged.length > 0 : flagged !== null && flagged !== undefined,
        });
      }

      return ok(records);
    });
  }

  /**
   * Status transitions, out of each issue's changelog.
   *
   * The categories on both sides come from the project's status list rather than from the changelog,
   * which carries only names. See `#statusCategories`.
   */
  async fetchIssueTransitions(request: ConnectorRequest): Promise<ConnectorResult<IssueTransitionRecord>> {
    return await this.#answer('issue_transitions', request, async (project) => {
      const listed = await this.#issueKeysFor(project, request.window);
      if (listed.failure !== null) return { records: [], failure: listed.failure };
      if (listed.keys.length === 0) return ok<IssueTransitionRecord>([]);

      const categories = await this.#statusCategories(project.projectKey);
      if (categories.failure !== null) return { records: [], failure: categories.failure };

      /**
       * A status Compass has never seen in this project's configuration.
       *
       * `toStatusCategory` is required, so something has to be produced. `in_progress` is the only
       * defensible answer: `todo` would assert "this has not been started" and `done` would assert "this
       * is finished", and both are claims about somebody's work that Compass would be making up.
       * `in_progress` claims only "somewhere in the middle", which is the weakest available statement.
       */
      const categoryOf = (name: string | null): WorkItemStatusCategory =>
        (name === null ? undefined : categories.map.get(name)) ?? 'in_progress';

      const records: IssueTransitionRecord[] = [];
      for (const itemKey of listed.keys) {
        const changed = await this.#changeGroups(itemKey);
        if (changed.failure !== null) return { records: [], failure: changed.failure };

        for (const group of changed.groups) {
          for (const item of group.items) {
            if (item.field !== 'status') continue;
            const toStatus = item.toString;
            if (toStatus === null) continue;

            records.push({
              sourceKey: this.#config.sourceKey,
              sourceKind: 'tracker',
              // The change group's id plus the item key: one group can carry a status change for one
              // issue only, but the id alone is not unique across a re-imported project.
              sourceRecordId: `${itemKey}:${group.id}`,
              occurredAt: group.at,
              itemKey,
              fromStatus: item.fromString,
              toStatus,
              // Null rather than a guess when there was no previous status at all — a created issue's
              // first transition genuinely has no "from".
              fromStatusCategory: item.fromString === null ? null : categoryOf(item.fromString),
              toStatusCategory: categoryOf(toStatus),
              actorIdentity: group.actorIdentity,
              transitionedAt: group.at,
            });
          }
        }
      }

      return ok(records);
    });
  }

  /**
   * Sprints, reached through the selected project's own boards.
   *
   * ## Why the committed items come from a project-scoped query
   *
   * A board's filter can span several projects, so the agile "issues in this sprint" endpoint can return
   * issues from a project the manager never selected. Asking instead for `project = X AND sprint = N`
   * makes the scoping structural: there is no code path by which an unselected project's issue can enter
   * a committed list, rather than a promise that the board was configured tidily.
   */
  async fetchSprints(request: ConnectorRequest): Promise<ConnectorResult<SprintRecord>> {
    return await this.#answer('sprints', request, async (project) => {
      const boards = await this.#collectPaged(
        `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(project.projectKey)}`,
      );
      if (boards.failure !== null) return { records: [], failure: boards.failure };

      const records: SprintRecord[] = [];
      for (const boardRow of boards.rows) {
        const boardIdentifier = (boardRow as { id?: unknown }).id;
        if (typeof boardIdentifier !== 'number') continue;

        const sprints = await this.#collectPaged(`/rest/agile/1.0/board/${boardIdentifier}/sprint`);
        if (sprints.failure !== null) return { records: [], failure: sprints.failure };

        for (const sprintRow of sprints.rows) {
          const sprint = sprintRow as Record<string, unknown>;
          const identifier = sprint['id'];
          const name = sprint['name'];
          const state = sprint['state'];
          if (typeof identifier !== 'number' || typeof name !== 'string' || typeof state !== 'string') continue;

          const startAt = instantFromIsoOrNull(sprint['startDate']);
          const endAt = instantFromIsoOrNull(sprint['endDate']);
          // A sprint somebody created but never scheduled has no dates. Both are required, and a
          // fabricated range would put an invented commitment window in the report.
          if (startAt === null || endAt === null) continue;
          if (state !== 'future' && state !== 'active' && state !== 'closed') continue;

          const completedAt = instantFromIsoOrNull(sprint['completeDate']);

          const committed = await this.#searchJql(sprintMembershipJql(project.projectKey, identifier), ['key']);
          if (committed.failure !== null) return { records: [], failure: committed.failure };

          records.push({
            sourceKey: this.#config.sourceKey,
            sourceKind: 'tracker',
            sourceRecordId: String(identifier),
            /**
             * The sprint's own most recent movement: when it closed, or when it started.
             *
             * A sprint is not an event, so `occurredAt` has to be chosen. These two are the only
             * instants at which a sprint changes in a way a daily report should mention, and dating it
             * `now` instead would put every sprint in every window and break the partition property.
             */
            occurredAt: completedAt ?? startAt,
            projectKey: project.projectKey,
            name,
            goal: typeof sprint['goal'] === 'string' && sprint['goal'].length > 0 ? (sprint['goal'] as string) : null,
            state,
            startAt,
            endAt,
            completedAt,
            committedItemKeys: committed.rows
              .map((row) => (row as { key?: unknown }).key)
              .filter((key): key is string => typeof key === 'string')
              .slice()
              .sort(),
          });
        }
      }

      return ok(records);
    });
  }

  /**
   * Scope added to or removed from a sprint, out of the same changelog as the transitions.
   *
   * This is what makes sprint reconciliation possible: Jira exposes what a sprint contains *now*, never
   * what it contained when it started, so the only honest route to "this was added on Wednesday" is the
   * change history. The `Sprint` field's `from`/`to` carry comma-separated sprint ids, which is why the
   * reference is an id and the names in `fromString`/`toString` are ignored — a renamed sprint would
   * otherwise silently become a different one.
   */
  async fetchSprintScopeChanges(request: ConnectorRequest): Promise<ConnectorResult<SprintScopeChangeRecord>> {
    return await this.#answer('sprint_scope_changes', request, async (project) => {
      const listed = await this.#issueKeysFor(project, request.window);
      if (listed.failure !== null) return { records: [], failure: listed.failure };

      const records: SprintScopeChangeRecord[] = [];
      for (const itemKey of listed.keys) {
        const changed = await this.#changeGroups(itemKey);
        if (changed.failure !== null) return { records: [], failure: changed.failure };

        for (const group of changed.groups) {
          for (const item of group.items) {
            if (item.field !== 'Sprint') continue;

            const before = sprintIdList(item.from);
            const after = sprintIdList(item.to);

            for (const sprintRef of after.filter((identifier) => !before.includes(identifier))) {
              records.push({
                sourceKey: this.#config.sourceKey,
                sourceKind: 'tracker',
                sourceRecordId: `${itemKey}:${group.id}:${sprintRef}:added`,
                occurredAt: group.at,
                sprintRef,
                itemKey,
                change: 'added',
                actorIdentity: group.actorIdentity,
                changedAt: group.at,
              });
            }

            for (const sprintRef of before.filter((identifier) => !after.includes(identifier))) {
              records.push({
                sourceKey: this.#config.sourceKey,
                sourceKind: 'tracker',
                sourceRecordId: `${itemKey}:${group.id}:${sprintRef}:removed`,
                occurredAt: group.at,
                sprintRef,
                itemKey,
                change: 'removed',
                actorIdentity: group.actorIdentity,
                changedAt: group.at,
              });
            }
          }
        }
      }

      return ok(records);
    });
  }

  // The six a tracker cannot answer. Each reports absent capability rather than an empty day; the shared
  // `#answer` does that from the `SUPPORTED` table, so there is one statement of it, not six.
  async fetchCommits(request: ConnectorRequest): Promise<ConnectorResult<CommitRecord>> {
    return await this.#answer('commits', request, async () => ok<CommitRecord>([]));
  }

  async fetchPullRequests(request: ConnectorRequest): Promise<ConnectorResult<PullRequestRecord>> {
    return await this.#answer('pull_requests', request, async () => ok<PullRequestRecord>([]));
  }

  async fetchReviews(request: ConnectorRequest): Promise<ConnectorResult<ReviewRecord>> {
    return await this.#answer('reviews', request, async () => ok<ReviewRecord>([]));
  }

  async fetchBranchRefs(request: ConnectorRequest): Promise<ConnectorResult<BranchRefRecord>> {
    return await this.#answer('branch_refs', request, async () => ok<BranchRefRecord>([]));
  }

  async fetchReleaseTags(request: ConnectorRequest): Promise<ConnectorResult<ReleaseTagRecord>> {
    return await this.#answer('release_tags', request, async () => ok<ReleaseTagRecord>([]));
  }

  async fetchMessages(request: ConnectorRequest): Promise<ConnectorResult<MessageRecord>> {
    return await this.#answer('messages', request, async () => ok<MessageRecord>([]));
  }

  /**
   * Per-source health for the freshness indicator.
   *
   * One probe per artifact family the tracker supports, through the same `#answer` path the reads use, so
   * the panel cannot claim a source is healthy while the report beside it was generated from a
   * rate-limited window.
   */
  async reportSourceHealth(request: ConnectorRequest): Promise<SourceHealthReport> {
    const probes = await Promise.all(
      ARTIFACT_KINDS.filter((artifact) => SUPPORTED[artifact]).map(async (artifact) => {
        const result = await this.#answer(artifact, request, async (project) => {
          const probe = await this.#get(`/rest/api/3/project/${encodeURIComponent(project.projectKey)}`);
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
      sourceKind: 'tracker',
      status,
      reason: degraded?.reason ?? 'ok',
      detail:
        degraded?.detail ??
        `${this.#config.sourceKey} answered for ${this.#config.projects.length} configured ` +
          `${this.#config.projects.length === 1 ? 'project' : 'projects'}.`,
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

/**
 * The sprint ids on an issue's sprint field.
 *
 * Sorted and de-duplicated so two runs over the same issue produce the same list, which the contract's
 * idempotence assertion requires. Handles both shapes the field takes: a list of sprint objects on a
 * modern site, and a list of bare ids on one where the field was configured differently.
 */
const sprintRefsFrom = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.flatMap((entry) => {
        if (typeof entry === 'number' || typeof entry === 'string') return [String(entry)];
        const identifier = (entry as { id?: unknown } | null)?.id;
        return typeof identifier === 'number' || typeof identifier === 'string' ? [String(identifier)] : [];
      }),
    ),
  ].sort();
};

/** The comma-separated sprint ids a changelog entry carries, e.g. `"42, 43"`. */
const sprintIdList = (value: string | null): readonly string[] =>
  value === null
    ? []
    : value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
