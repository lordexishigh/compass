# Build Plan

## MVP — A cold checkout renders a genuine, deterministic, source-linked daily report for the seeded org — including alignment verdicts with evidence — through the real pipeline.

**Success criteria:**

- `npm run seed && npm run dev` then opening `/` renders a fully generated six-section daily report for the seeded org in under 60 seconds with no login wall and no empty state
- Generating the report twice for the same (org, team, instant) yields byte-identical structured JSON excluding the documented non-semantic allowlist
- Re-ingesting the same window three times produces zero new entity versions and zero duplicate blockers/risks
- Alignment verdicts resolve structurally, then inferred, then semantically; OFF-GOAL only above the documented threshold with positive attribution, everything else in an `unattributed` bucket rendered as a question
- Every blocker, risk, win, recommendation, progress number and alignment verdict in the web view carries a clickable evidence affordance

### mvp-foundations-clock-and-connector-port — Monorepo, clock port, connector port and scoped schema base

Set up the pnpm workspace monorepo with layer-scoped packages (clock, connector-port, ingest, knowledge-model, analysis, pipeline, renderers), PostgreSQL 17 + Drizzle, and the two foundational ports: a Clock port that is the only source of time, and a time-windowed connector query port that the pipeline cannot distinguish from a live API. Includes the build-failing check for forbidden clock reads, the architecture test scaffolding, and the org-scoped query layer.

- **mvp-foundations-clock-and-connector-port-001** pnpm workspace monorepo with layer-scoped packages
  - [ ] `pnpm install && pnpm build` succeeds from a clean checkout with zero type errors
  - [ ] Each package under packages/ has its own package.json, tsconfig and test script
  - [ ] WHEN `pnpm test` is run THE SYSTEM SHALL execute every package's test suite and report per-package results
- **mvp-foundations-clock-and-connector-port-002** Clock port and no-system-clock build gate
  - [ ] WHEN `new Date()`, `Date.now()`, or `performance.now()` appears in any source file under clock/ingest/knowledge-model/analysis/pipeline THE SYSTEM SHALL fail lint with the offending file:line
  - [ ] FixedClock returns the exact instant it was constructed with on every call
  - [ ] No pipeline stage constructs a clock internally; `now` is passed explicitly as a parameter
- **mvp-foundations-clock-and-connector-port-003** Time-windowed connector query port
  - [ ] Every port method takes an explicit half-open time window and returns provider-neutral DTOs with no GitHub/Jira/Slack-specific field names
  - [ ] A contract test suite runs against any ConnectorPort implementation and asserts window semantics, ordering and idempotency of results
  - [ ] WHEN a source is unavailable THE SYSTEM SHALL return a coverage record naming the source and reason rather than throwing
- **mvp-foundations-clock-and-connector-port-004** Postgres + Drizzle base schema and scoped-query layer
  - [ ] Every table defined in the schema has a non-null organization_id column; a test enumerates tables and fails on any that lacks it
  - [ ] WHEN a query is constructed without an org scope THE SYSTEM SHALL throw at call time rather than returning unscoped rows
  - [ ] `pnpm db:migrate` applies cleanly to an empty database and is idempotent on re-run

### mvp-seed-dataset — Declarative seed dataset with documented manifest _(depends on: mvp-foundations-clock-and-connector-port)_

Author the checked-in, human-readable declarative seed fixtures and a regenerable generator plus manifest: 3+ projects, 12 developers each with multiple git emails + Jira accountId + Slack userId, 4 completed sprints + 1 in-flight, ≥600 commits, ≥120 PRs, ≥300 Jira issues, ≥800 Slack messages, one Kanban team with no sprints, plus the planted pathologies named by ID and documented messy traceability proportions. Includes the seed connector implementing the port over the fixtures.

- **mvp-seed-dataset-001** Declarative fixture format and seed generator
  - [ ] Seed fixtures are checked in as human-readable text files; a test asserts no binary or minified blob exists under seed/
  - [ ] Running the generator twice produces byte-identical output files
  - [ ] The dataset contains ≥3 projects, ≥12 developers, ≥4 completed sprints plus 1 in-flight, ≥600 commits, ≥120 PRs, ≥300 issues, ≥800 messages across ≥3 channels — asserted by a manifest test
- **mvp-seed-dataset-002** Fragmented identities and one Kanban team
  - [ ] Every seeded developer holds ≥2 distinct git emails plus one Jira accountId plus one Slack userId
  - [ ] ≥5 commits use git emails intentionally not mapped to any developer, listed by address in the manifest
  - [ ] One seeded team has zero Sprint rows and its tickets carry no story points
- **mvp-seed-dataset-003** Planted pathologies named by ID in the manifest
  - [ ] seed/MANIFEST.md names each pathology with the exact entity IDs involved (ticket keys, PR numbers, reviewer name, release tag, date window)
  - [ ] A test loads the manifest and asserts every named ID resolves to a real row in the generated dataset
  - [ ] The blocked-then-merged ticket has a Jira blocked flag on day N and a merge event at a documented timestamp on day N
- **mvp-seed-dataset-004** Deliberately messy traceability in documented proportions
  - [ ] seed/MANIFEST.md documents the count and percentage of commits in each of the four traceability classes
  - [ ] A test asserts every class is non-empty and the observed counts match the manifest exactly
  - [ ] A single generated report over the seeded window exercises all four resolution paths, asserted by a test on the alignment result distribution
- **mvp-seed-dataset-005** Seed connector implementing the port over the fixtures
  - [ ] SeedConnector passes the full ConnectorPort contract test suite unmodified
  - [ ] WHEN queried for a window THE SYSTEM SHALL return only artifacts whose event time falls inside that half-open window
  - [ ] No ingest, knowledge-model or analysis module imports anything from the seed-connector package; asserted by an architecture test

### mvp-knowledge-model-and-ingest — Versioned knowledge model with idempotent ingest and corrections _(depends on: mvp-seed-dataset)_

Persist Company, Objective, Project, Team, Developer, IdentityLink, Feature, Ticket, Sprint, PullRequest, Review, Commit, BranchRef, ReleaseTag, Blocker, Risk, Recommendation, Win as first-class rows with first_seen_at, last_seen_at and append-only transition history. Build incremental idempotent ingest with reconciliation that writes non-destructive Correction records on contradiction, identity resolution with an unmatched-identity capture, and a materialized snapshot builder that hands the analysis layer a pure data structure.

- **mvp-knowledge-model-and-ingest-001** Named entity tables with first_seen_at/last_seen_at and append-only history
  - [ ] A schema test enumerates the required tables by name — Company, Objective, Project, Team, Developer, IdentityLink, Feature, Ticket, Sprint, Blocker, Risk, Recommendation — and fails if any is absent or lacks organization_id, first_seen_at, last_seen_at and an associated append-only history table
  - [ ] WHEN an entity's tracked fields change THE SYSTEM SHALL append a new history row and never UPDATE or DELETE an existing history row
  - [ ] A test asserts Feature rows persist with their parent Project and child Tickets, and that elapsed facts are computable: given a blocker first seen 6 days before the instant, the store returns age_days = 6
- **mvp-knowledge-model-and-ingest-002** Incremental idempotent ingest with IngestRun records
  - [ ] WHEN the same window is ingested three times THE SYSTEM SHALL produce identical full DB snapshots after runs 2 and 3 with zero new entity versions and zero duplicate blockers/risks
  - [ ] Overlapping and out-of-order windows are covered by tests asserting no duplicate rows and correct last_seen_at advancement
  - [ ] Each ingest writes one IngestRun row recording window start/end, source, artifact counts and coverage status
- **mvp-knowledge-model-and-ingest-003** Contradiction reconciliation and Correction records
  - [ ] WHEN a ticket stored as blocked is observed merged THE SYSTEM SHALL write a Correction row capturing prior belief, new belief, evidence artifact and detected_at
  - [ ] No prior belief row is mutated or deleted when a Correction is written; asserted by a history-count test
  - [ ] The seeded blocked-then-merged ticket produces exactly one Correction visible to the report layer
- **mvp-knowledge-model-and-ingest-004** Identity resolution and unmatched-identity capture
  - [ ] WHEN a commit author email matches an IdentityLink THE SYSTEM SHALL attribute the commit to that Developer
  - [ ] WHEN no link matches THE SYSTEM SHALL create or increment an UnmatchedIdentity row and attribute the artifact to no person
  - [ ] A test asserts no artifact is ever attributed to a Developer by name similarity alone
- **mvp-knowledge-model-and-ingest-005** Materialized snapshot builder
  - [ ] The snapshot is a plain serializable structure with no database handles, promises or clock references
  - [ ] WHEN built twice for the same (org, team, instant) THE SYSTEM SHALL produce byte-identical JSON
  - [ ] All collections in the snapshot are sorted by a documented stable key so ordering never depends on database row order

### mvp-analysis-core — Pure deterministic analysis core producing the structured six-section report _(depends on: mvp-knowledge-model-and-ingest)_

A pure package with no HTTP, DB, filesystem, clock or randomness that takes (snapshot, instant) and returns the structured six-section report object: Yesterday-item detection with dedup and stable ordering, sprint completion math reconcilable against the board, velocity over trailing sprints, blocker detection wired to concrete signals, review-queue aggregation with named PRs/reviewers/ages, workload distribution, risk detection with severity and trend, wins detection with a numbered threshold, technical-debt growth signal, Kanban/no-sprint semantics, insufficient-history degradation, elapsed-fact generation, recommendation engine with actor+object+one-step actions, and a confidence-qualified projected completion date with stated reasoning. Enforces the no-individual-ranking stance in code.

- **mvp-analysis-core-001** Purity enforcement and architecture test
  - [ ] WHEN an analysis module imports node:fs, node:http, a database client, a clock, or Math.random THE SYSTEM SHALL fail the architecture test naming the module and import
  - [ ] The analysis package's package.json declares no runtime dependency on any database, HTTP or clock package
  - [ ] Every exported analysis function takes an explicit instant parameter
- **mvp-analysis-core-002** Sprint math, velocity, Kanban semantics and insufficient-history degradation
  - [ ] Sprint completion output includes committed scope, completed, remaining, scope added mid-sprint and completion %, each with the contributing ticket keys so a manager can reconcile line by line
  - [ ] WHEN a team has no sprints THE SYSTEM SHALL emit Kanban progress semantics and SHALL NOT emit completion %, story points or a sprint goal
  - [ ] WHEN fewer than two completed sprints exist THE SYSTEM SHALL mark velocity, projection and trend as undefined with reason `insufficient_history` rather than emitting a number
- **mvp-analysis-core-003** Yesterday-item detection with dedup and stable ordering
  - [ ] The qualifying-transition set and the dedup key are documented in code, and a test asserts only events inside the half-open report window qualify
  - [ ] WHEN a ticket and its merged PR both close inside the window THE SYSTEM SHALL emit exactly one Yesterday item naming both artifacts (ticket key and PR number)
  - [ ] Yesterday items are ordered by the documented stable key (completion instant, then ticket key) so two runs over the same snapshot emit an identical sequence
- **mvp-analysis-core-004** Blocker, review-queue, workload, risk, win and technical-debt detection
  - [ ] Every emitted blocker names its triggering signal, the numbered threshold applied and the evidence artifact (Jira key or PR number)
  - [ ] Review-queue output lists PR number, title, author, reviewer, age in days and time-in-review — never only an aggregate average; each risk carries severity and one of new | worsened | unchanged | improving with the prior value compared against
  - [ ] A win is emitted only when a ticket crossed completion rung R2 or higher inside the window AND its story points ≥ 3 or its age ≥ 5 working days (thresholds documented in code); a test asserts the seeded dataset yields ≥2 wins each naming a ticket key and the crossed rung
  - [ ] The technical-debt-growth signal is computed from a documented named signal set (count and net change of tickets labelled tech-debt, mean age of open tech-debt tickets, and share of merged PRs touching files with ≥3 changes-requested cycles) with a numbered growth threshold; a test asserts the seeded debt pathology produces a non-empty debt signal with its inputs
- **mvp-analysis-core-005** Elapsed facts, projected completion date and recommendation engine
  - [ ] Elapsed facts are computed from stored history and each carries the entity id and the day count it asserts
  - [ ] The projected completion date is emitted with a confidence band and a machine-readable reasoning structure naming the method and its inputs
  - [ ] Every recommendation contains an actor (person), an object (PR/ticket) and a single next step; a test rejects any recommendation lacking one of the three
- **mvp-analysis-core-006** No-individual-ranking enforcement and determinism gate
  - [ ] A test asserts no analysis output type contains a per-developer ranked list, commit count comparison or LOC metric across people
  - [ ] WHEN the report is generated twice for the same (org, team, instant) THE SYSTEM SHALL produce byte-identical structured JSON after excluding the documented non-semantic allowlist (generation timestamp, run id)
  - [ ] The allowlist of non-semantic excluded fields is documented in the repo and referenced by the test

### mvp-report-pipeline-and-web-view — Report pipeline, template renderer and zero-config web report view _(depends on: mvp-analysis-core)_

Orchestrate seed-connector → ingest → snapshot → analysis → persisted Report/ReportSection/ReportItem rows, render the six fixed sections through a deterministic prose template renderer (no LLM yet), and serve a Server-Component web report view with per-claim source links, a data-freshness/coverage indicator and no charts. Includes the zero-config cold start so `/` renders a real report with no login wall.

- **mvp-report-pipeline-and-web-view-001** Pipeline orchestrator and report persistence
  - [ ] WHEN the pipeline runs for (org, team, instant) THE SYSTEM SHALL persist one Report row with exactly six ReportSection rows in the fixed order Yesterday, Progress, Blockers, Risks, Recommendations, Wins
  - [ ] The structured section payload is stored verbatim alongside the rendered prose
  - [ ] The pipeline accepts `now` as an explicit parameter and never reads the system clock
- **mvp-report-pipeline-and-web-view-002** Deterministic template prose renderer
  - [ ] WHEN given the same structured payload THE SYSTEM SHALL emit byte-identical prose
  - [ ] Rendered output contains exactly six sections in the fixed order with no chart, canvas, svg chart or table-of-metrics
  - [ ] The interpretation-template set is documented in code, and a test using the same numeric-token extractor as the grounding validator asserts every numeric token in rendered prose sits within the same sentence as a clause instantiated from that documented set
- **mvp-report-pipeline-and-web-view-003** Web report view with per-claim source links
  - [ ] Every claim in the rendered view carries a clickable link resolving to an artifact page showing the underlying commit SHA, PR number or Jira key
  - [ ] A test asserts the rendered HTML contains no <canvas>, no chart <svg> and no charting library bundle
  - [ ] The page renders as Server Components with the six sections in fixed order and is readable on a 375px-wide viewport
- **mvp-report-pipeline-and-web-view-004** Data-freshness and coverage indicator
  - [ ] The report view states, per source, the last ingest time and the window covered, sourced from IngestRun rows
  - [ ] WHEN a source produced no data or reported unavailable THE SYSTEM SHALL state that source is missing and SHALL NOT present the report as complete
  - [ ] No fabricated freshness value is displayed when IngestRun data is absent
- **mvp-report-pipeline-and-web-view-005** Zero-config cold start
  - [ ] WHEN a clean checkout runs `docker compose up` and `/` is fetched THE SYSTEM SHALL return a fully rendered six-section report within 60 seconds
  - [ ] No authentication redirect, setup wizard or empty state is shown on the first request to `/`
  - [ ] A CI smoke test boots a clean container, fetches `/`, and asserts all six section headings and at least one source link are present

### mvp-goals-and-alignment — Goal hierarchy store and three-tier alignment with evidence _(depends on: mvp-report-pipeline-and-web-view)_

Store the goal hierarchy (company objective → quarter → sprint goal → epic/Feature → ticket) with effective dating, plus ObjectiveLink records carrying source (configured | inferred | semantic). Implement three-tier alignment resolution — structural, then inferred from branch names and commit messages, then semantic with a confidence score — with an explicit confidence threshold, an `unattributed` bucket rendered as a question, OFF-GOAL only at high confidence with positive attribution to a non-current objective, and a one-click evidence panel on the report view showing exactly what matched. Objective/goal editing here is API-level plus a minimal read/edit surface; the full configuration UI for teams, projects and repos is owned by alpha-configuration-and-identity-roster.

- **mvp-goals-and-alignment-001** Goal hierarchy store with effective dating
  - [ ] WHEN an objective is edited THE SYSTEM SHALL create a new effective-dated version and SHALL NOT mutate the prior row
  - [ ] Alignment for a past instant resolves against the objective version effective at that instant; the freeze-vs-re-evaluate rule is documented in the repo and asserted by a test
  - [ ] Create, read, update and archive endpoints exist for objectives and sprint goals, reachable from a minimal in-app editing surface, and each write appends an effective-dated version
- **mvp-goals-and-alignment-002** Structural and inferred alignment resolution
  - [ ] WHEN a structural chain exists THE SYSTEM SHALL use it and persist an ObjectiveLink with source = configured and the full chain node ids
  - [ ] WHEN only a branch name or commit message contains a ticket key THE SYSTEM SHALL persist an ObjectiveLink with source = inferred, the exact matched substring and its offset
  - [ ] A test over the seeded traceability classes asserts each commit resolves through the expected tier
- **mvp-goals-and-alignment-003** Semantic matching, threshold and unattributed bucket
  - [ ] WHEN a semantic match is accepted THE SYSTEM SHALL persist an ObjectiveLink with source = semantic, the numeric score and the two compared texts
  - [ ] WHEN semantic confidence is below the configured threshold THE SYSTEM SHALL place the item in `unattributed`, render it as a question (e.g. '3 commits could not be tied to a sprint objective') with no developer name as the subject of judgement, and SHALL NOT emit any verdict about it
  - [ ] Semantic scoring is deterministic: the same text pair yields the same score on every run
- **mvp-goals-and-alignment-004** OFF-GOAL gating and property test
  - [ ] WHEN confidence is below threshold OR no non-current objective is positively attributed THE SYSTEM SHALL NOT emit an OFF-GOAL label
  - [ ] A property/unit test generates low-confidence and unattributed inputs and asserts no OFF-GOAL label can be produced from any of them
  - [ ] The seeded off-goal work stream produces exactly one OFF-GOAL verdict naming the non-current objective it serves
- **mvp-goals-and-alignment-005** One-click alignment evidence panel
  - [ ] WHEN an alignment verdict is clicked THE SYSTEM SHALL show which tier resolved it and the exact evidence (chain node ids, matched substring highlighted, or compared texts with score and threshold)
  - [ ] The panel states the confidence value and the threshold it was compared against
  - [ ] Every alignment verdict in the report, including unattributed items, has an evidence affordance reachable in one click from the report view

## Alpha — The full must-have and table-stakes feature set works: narration with grounding, the three differentiators, memory across days, auth/tenancy/seats, configuration, feedback, delivery, scheduling and time travel.

**Success criteria:**

- A Slack DM memo 'Marcus is out Jul 27–Aug 2' drops Marcus's stalled-work finding from the next report and cites the memo
- Every Yesterday item carries its furthest crossed completion rung; R5 renders 'no deploy signal available'
- Every calibration statistic and every named verdict is computed and asserted against a documented threshold
- Stepping the simulated clock day by day across the Release 2 window shows the same stable item ID move risk → projected slip → recommendation
- Reports arrive inline on a per-user schedule and timezone by email and Slack with per-channel per-team/merged/both choice, produced by a scheduled generation job that runs ahead of delivery

### alpha-narration-and-grounding — LLM narration with prose-grounding validator and fail-closed fallback _(depends on: mvp-report-pipeline-and-web-view)_

Narrate the six fixed sections with the Anthropic Claude API, passing only the structured section payload and never raw events. Build the automated grounding extractor that pulls every number, percentage, date, PR number, commit SHA, Jira key and person name from the prose and asserts each exists in that section's structured payload; on rejection retry a bounded number of times, then fall back to the deterministic template renderer and record the fallback on the report row. Includes prompt-injection containment and web-render sanitization.

- **alpha-narration-and-grounding-001** Section narrator over structured payload only
  - [ ] WHEN narration runs THE SYSTEM SHALL send only the structured section payload; a test asserts no raw commit message, PR body, Jira comment or Slack text is present in the request
  - [ ] The narrator is configured with no tools and no ability to fetch external content
  - [ ] Each narration writes a NarrationTrace row recording model, prompt hash, attempt count and outcome
- **alpha-narration-and-grounding-002** Prose-grounding extractor and build-failing test
  - [ ] WHEN any extracted token has no match in the section's structured payload THE SYSTEM SHALL reject the narration and the CI test SHALL fail naming the token
  - [ ] The extractor is covered by at least 20 adversarial fixture cases including invented PR numbers, off-by-one percentages and misspelled names
  - [ ] Grounding runs over the full golden corpus in CI and reports zero untraceable tokens
- **alpha-narration-and-grounding-003** Bounded retries and fail-closed template fallback
  - [ ] WHEN grounding rejects narration N times (N documented in the repo) THE SYSTEM SHALL render via the template renderer and set a fallback flag with a reason on the Report row
  - [ ] No report is ever delivered with ungrounded prose; asserted by a test using a stubbed narrator that always fabricates
  - [ ] The web view indicates when a report was rendered by the fallback renderer
- **alpha-narration-and-grounding-004** Prompt-injection containment and web-render sanitization
  - [ ] Untrusted ingested text is wrapped in explicit delimiters with a data-not-instructions instruction; asserted by a prompt-construction test
  - [ ] WHEN a ticket titled with a script tag and an email-header injection payload is ingested THE SYSTEM SHALL render it as literal text in the web view with no script execution
  - [ ] Markdown rendering uses an allowlist; raw HTML in any field is escaped, asserted by a renderer test

### alpha-auth-tenancy-and-seats — Auth, tenancy, four-role matrix, team scoping and seat management _(depends on: mvp-report-pipeline-and-web-view)_

Email+password with Argon2id plus email magic link, password reset, sessions as httpOnly+Secure+SameSite=Lax cookies with rotation on privilege change and absolute/idle expiry, an organization_id enforced through the single scoped-query layer, a four-role matrix (owner, manager, member, viewer) expressed as one table in code and checked server-side on every route, team-scoped authorization inside an org, and the full seat lifecycle: invite, revoke, resend, role change. The seeded demo org's report route stays publicly readable with an explicit public matrix entry.

- **alpha-auth-tenancy-and-seats-001** Email+password, magic link and password reset
  - [ ] WHEN valid credentials are POSTed to /api/auth/login THE SYSTEM SHALL set an httpOnly, Secure, SameSite=Lax session cookie and return 200
  - [ ] Password hashes use Argon2id with documented parameters; no plaintext or reversible password is ever stored or logged
  - [ ] WHEN a password-reset link is used twice THE SYSTEM SHALL reject the second use, and the link SHALL expire after a documented interval
- **alpha-auth-tenancy-and-seats-002** Sessions with rotation and expiry
  - [ ] WHEN a user's role changes THE SYSTEM SHALL rotate the session identifier and invalidate the prior one
  - [ ] Sessions expire 30 days after creation and 14 days after last use; asserted by tests using the injected clock
  - [ ] 'Sign out all devices' invalidates every session for that user and is covered by a test
- **alpha-auth-tenancy-and-seats-003** Four-role matrix, team scoping and preserved public demo route
  - [ ] The role matrix exists as one exported table in code; a parametrized test iterates every (role × route) pair and asserts the expected allow/deny
  - [ ] WHEN a manager scoped to team A requests team B's report THE SYSTEM SHALL return 403
  - [ ] WHEN the app boots with the seed dataset THE SYSTEM SHALL serve `/` with a full six-section report and no session, and the role matrix SHALL carry an explicit public entry for that route; a test asserts both the unauthenticated 200 and the presence of the public matrix entry
  - [ ] A test enumerates all API routes and fails if any route has no entry in the matrix
- **alpha-auth-tenancy-and-seats-004** Seat lifecycle: invite, revoke, resend, role change
  - [ ] WHEN an owner invites an email THE SYSTEM SHALL create a pending Membership and send an invite email with an expiring single-use token
  - [ ] Revoking a pending invite makes its token unusable; asserted by a test
  - [ ] WHEN a member's role is changed THE SYSTEM SHALL apply the new role on the next request and rotate that user's session
- **alpha-auth-tenancy-and-seats-005** Org-scoped query enforcement and audit log
  - [ ] A test enumerates every repository/query function and asserts each requires an org scope parameter
  - [ ] Privileged actions (role change, seat revoke, config change, share-link revoke, export, delete) each write an immutable AuditLogEntry with actor, action, target id, before/after diff and timestamp
  - [ ] Audit rows are append-only; a test asserts no update or delete path exists

### alpha-calibration-and-completion-ladder — DIFFERENTIATORS — Process Calibration Audit and Completion Ladder _(depends on: mvp-analysis-core)_

In the pure layer, compute the fixed calibration statistic set over trailing sprints (point-to-elapsed-working-days correlation per ticket reported with n and spread and never a bare r, estimate coverage %, carryover rate, status-dwell consistency, scope-churn rate, sub-task double-count risk, stale-status incidence), map each to a named verdict against a documented numbered threshold (points_uninformative, estimates_sparse, scope_is_fiction, workflow_inconsistent, statuses_stale, insufficient_history), and feed verdicts into the projection method and confidence with the report stating plainly when its own numbers cannot support the claim. Separately, compute the Completion Ladder rungs R1–R5 with deterministic detectors, suffix every Yesterday item with its furthest crossed rung, and turn ladder mismatches into hygiene findings and risks naming the oldest item.

- **alpha-calibration-and-completion-ladder-001** Correlation, estimate coverage and carryover statistics
  - [ ] The correlation output always carries n and a spread measure; a test asserts no code path emits a bare r value, and a hand-computed check on the seeded slipping-release sprint matches the computed n and spread exactly
  - [ ] Estimate coverage % is emitted as estimated_tickets / total_tickets over the documented trailing window with both counts included; a test asserts the seeded value matches a hand-computed figure
  - [ ] Carryover rate is emitted per trailing sprint plus a mean, each naming the carried ticket keys; a test asserts the seeded carryover set matches the manifest
  - [ ] Each statistic is computed from the snapshot only, with no I/O, and is deterministic across runs
- **alpha-calibration-and-completion-ladder-002** Dwell, churn, double-count and stale-status statistics
  - [ ] Status-dwell consistency is emitted per workflow status with n and spread; a test asserts the seeded workflow produces the hand-computed spread for at least one status
  - [ ] Scope-churn rate is emitted with the added and removed ticket keys and the committed baseline; a test asserts the seeded mid-sprint scope change is reflected in the rate
  - [ ] Sub-task double-count risk is emitted as the count and share of parent tickets whose sub-tasks also carry points, naming those parents; a test asserts the seeded double-counted parent is named
  - [ ] Stale-status incidence uses the documented threshold of 3 working days with zero commit or PR activity and names every stale ticket; a test asserts the seeded stale ticket is named and a freshly-active ticket is not
- **alpha-calibration-and-completion-ladder-003** Named verdicts against documented numbered thresholds
  - [ ] Every verdict names the statistic, its value and the documented numeric threshold it was compared against; a test enumerates the six verdicts and fails if any lacks a documented threshold constant
  - [ ] The seeded dataset yields points_uninformative (|r| < 0.3 with n ≥ 10) whose stated n and spread match a hand-computed check, and a seed-manifest variant with the estimation noise removed clears it
  - [ ] estimates_sparse (coverage < 60%), scope_is_fiction (carryover ≥ 30% in ≥ 3 of the trailing 5 sprints or churn ≥ 25%), workflow_inconsistent (dwell spread above the documented multiple of the median) and statuses_stale (≥ 20% of in-progress tickets stale) are each asserted against a seeded condition that triggers them and a variant that does not
  - [ ] insufficient_history (fewer than two completed sprints) is asserted against the seeded Kanban/new-team case and suppresses the other verdicts that need trailing sprints
- **alpha-calibration-and-completion-ladder-004** Verdicts drive projection method and confidence, stated in prose
  - [ ] WHEN points_uninformative is active THE SYSTEM SHALL produce the projected date by the cycle-time method and SHALL state that it is a cycle-time guess, not a velocity forecast
  - [ ] WHEN insufficient_history is active THE SYSTEM SHALL emit no projected date and SHALL state why
  - [ ] The projection's reasoning structure names the method, the verdicts that selected it and the confidence band
- **alpha-calibration-and-completion-ladder-005** Completion Ladder detectors R1–R5
  - [ ] Each rung is decided by a documented deterministic detector over ingested data with no inference beyond the stated rule
  - [ ] R3 uses branch topology reachability, not merge state alone; a test with a merged-but-unreachable commit asserts R3 is not awarded
  - [ ] R5 is never inferred and always renders as 'no deploy signal available' in the absence of a CI/CD connector
- **alpha-calibration-and-completion-ladder-006** Ladder suffixes, hygiene findings and merged-not-released risk
  - [ ] Every Yesterday item carries a rung suffix; a test asserts no Yesterday line is emitted without one
  - [ ] WHEN a ticket is Done with no PR THE SYSTEM SHALL emit a hygiene finding naming that ticket
  - [ ] WHEN merged commits sit ahead of the latest release THE SYSTEM SHALL emit a merged-not-released risk naming the oldest such item and its age

### alpha-configuration-and-identity-roster — Configuration: teams, repos/projects, identity roster, unmatched-identity queue and absences _(depends on: alpha-auth-tenancy-and-seats, mvp-goals-and-alignment)_

Manager-facing configuration UI: team membership, tracked repos and projects with full CRUD and archival reusing the effective-dating semantics defined in mvp-goals-and-alignment-001, a working calendar, and an identity roster mapping multiple git emails plus a Jira accountId plus a Slack userId to one person — with an unmatched-identity queue supporting merge and un-merge. This task is the single owner of the Absence table and the stalled-work suppression rule, including manual out/inactive marking.

- **alpha-configuration-and-identity-roster-001** Team, project and repository configuration CRUD
  - [ ] A manager can add and remove team members, add and archive tracked repos and projects entirely through the UI with no YAML or CSV, and each write appends an effective-dated version using the shared helper rather than mutating the prior row
  - [ ] WHEN a repo is archived THE SYSTEM SHALL exclude it from future ingest windows and SHALL keep prior data and reports intact
  - [ ] Team working calendar (working days, holidays) is configurable and feeds working-day calculations in analysis
  - [ ] A test asserts a report generated for a past instant resolves team membership and tracked repos as they were effective at that instant
- **alpha-configuration-and-identity-roster-002** Identity roster mapping
  - [ ] WHEN an identity link is added THE SYSTEM SHALL re-attribute matching artifacts on the next ingest and state how many artifacts were affected
  - [ ] Each developer row shows every linked git email, Jira accountId and Slack userId
  - [ ] Removing a link never deletes the underlying artifacts; they revert to unattributed
- **alpha-configuration-and-identity-roster-003** Unmatched-identity queue with merge and un-merge
  - [ ] The queue lists every unmatched identity with artifact count and a sample artifact link
  - [ ] WHEN a merge is undone THE SYSTEM SHALL restore the prior attribution exactly and write an audit record of both the merge and the un-merge
  - [ ] Merges and un-merges take effect in the next generated report without re-ingesting from scratch
- **alpha-configuration-and-identity-roster-004** Absence table, manual marking and the suppression rule
  - [ ] WHEN a developer has an active Absence covering the instant THE SYSTEM SHALL suppress stalled-work findings naming them and state the reason with a link to the Absence source
  - [ ] Absences are created only through the roster API; a test asserts the suppression rule is implemented in exactly one module and the API is the sole write path
  - [ ] Absences appear in the roster UI with their date range and source (manual or memo)

### alpha-manager-memos — DIFFERENTIATOR — Manager Memos (write access to the org model) _(depends on: alpha-narration-and-grounding, alpha-auth-tenancy-and-seats, alpha-configuration-and-identity-roster)_

One-line prose in via email reply-to (Resend inbound), Slack DM/thread reply, or web form. An extraction pass converts it to a typed assertion with the closed five-kind schema {unavailable | descoped | reprioritized | external_blocker | context_note} carrying subject entity id, effective_from, effective_until|open_ended, source and raw_text. Anything outside those kinds is refused with a plain "I can't represent that yet". Subject resolution runs against the identity/entity store; below threshold the bot replies with 2–3 candidates. The next and subsequent reports reflect the memo, cite it with a link, and stop reflecting it when it expires.

- **alpha-manager-memos-001** ManagerMemo model and closed five-kind assertion schema
  - [ ] The kind column accepts exactly unavailable, descoped, reprioritized, external_blocker, context_note; a test asserts any other value is rejected at the database and application layers
  - [ ] Every memo stores effective_from and either effective_until or an open_ended flag, plus verbatim raw_text and its source channel
  - [ ] Memos are org-scoped and appear in the audit log when created or expired
- **alpha-manager-memos-002** Extraction pass with explicit refusal
  - [ ] WHEN input maps to none of the five kinds THE SYSTEM SHALL reply 'I can't represent that yet' and SHALL NOT persist a memo
  - [ ] Extraction output is validated against the closed schema before persistence; invalid output is rejected, not coerced
  - [ ] A fixture suite of ≥15 phrasings per kind plus ≥10 out-of-schema inputs asserts correct classification or refusal
- **alpha-manager-memos-003** Subject resolution with candidate disambiguation
  - [ ] WHEN subject confidence is below the threshold THE SYSTEM SHALL reply with 2–3 named candidates and SHALL NOT persist an assertion until one is chosen
  - [ ] WHEN a candidate is selected THE SYSTEM SHALL persist the memo bound to that entity id and record the disambiguation
  - [ ] Resolution never guesses a subject by first-name similarity alone; asserted by a test with two developers sharing a first name
- **alpha-manager-memos-004** Three intake channels: email reply, Slack DM/thread, web form
  - [ ] A memo submitted through each of the three channels produces an identical ManagerMemo row apart from the source field
  - [ ] Inbound Slack and Resend webhooks verify provider signatures with constant-time comparison and reject-and-log on failure
  - [ ] WHEN an inbound webhook signature is tampered with THE SYSTEM SHALL return 401 and write a log entry
- **alpha-manager-memos-005** Memo effects in the snapshot and report, with expiry
  - [ ] WHEN an `unavailable` memo is accepted THE SYSTEM SHALL write an Absence row through the roster API with the named person and date range, and a test asserts the memo path performs no direct Absence table write and no second copy of the suppression rule
  - [ ] WHEN a memo 'Marcus is out Jul 27–Aug 2' is active THE SYSTEM SHALL omit Marcus's stalled-work finding from the next report and state the reason with a link to the memo
  - [ ] WHEN a descoped memo is active THE SYSTEM SHALL recompute sprint completion excluding the descoped scope and annotate the change in the Progress section, and an `external_blocker` memo attributes the blocker to the named outside counterparty
  - [ ] WHEN the instant is after effective_until THE SYSTEM SHALL stop applying the memo and the finding SHALL return without an error

### alpha-stable-identity-change-awareness-and-feedback — Stable item identity, change-awareness and the full feedback loop _(depends on: mvp-goals-and-alignment, alpha-auth-tenancy-and-seats, alpha-delivery-email-and-slack)_

Derive every risk, blocker, off-goal flag and recommendation ID deterministically from the underlying entity and cause (not the report run) so the same condition across days is one item with a history. Tag each item NEW / UNCHANGED (with age) / WORSENED / IMPROVED / RESOLVED relative to the prior report for that subscription, and never repeat an item unchanged without saying so. Build the feedback loop: dismiss a risk with an optional reason, mark an off-goal flag wrong, accept or reject a recommendation, mark a blocker already resolved, snooze N days — stored against the entity and changing future reports, with a dismissed risk resurfacing only on material worsening and saying why, and one-click actions from web, email and Slack.

- **alpha-stable-identity-change-awareness-and-feedback-001** Deterministic stable item IDs
  - [ ] WHEN the same condition holds on consecutive simulated days THE SYSTEM SHALL emit the same item ID in both reports
  - [ ] Item IDs contain no report id, run id or timestamp component; asserted by a test on the derivation function
  - [ ] A test generates reports for 10 consecutive simulated days and asserts the persistent risk keeps one ID across all of them
- **alpha-stable-identity-change-awareness-and-feedback-002** Change-awareness tagging and 'nothing material changed'
  - [ ] Every report item carries exactly one change tag computed against the prior report for that subscription
  - [ ] WHEN no item changed tag since the prior report THE SYSTEM SHALL state 'nothing material changed since yesterday' rather than re-listing items as if new
  - [ ] UNCHANGED items render with their age in days from first_seen_at
- **alpha-stable-identity-change-awareness-and-feedback-003** Feedback model and effects on future reports
  - [ ] WHEN a recommendation is rejected THE SYSTEM SHALL never re-suggest that recommendation for that entity and cause
  - [ ] WHEN a recommendation is accepted THE SYSTEM SHALL render it as accepted with the acceptance date on subsequent reports and SHALL NOT re-suggest it unless the triggering condition recurs after the accepted item resolves; asserted by a test over three consecutive simulated days
  - [ ] WHEN a blocker is marked already resolved THE SYSTEM SHALL omit it from subsequent reports unless a new triggering signal appears
  - [ ] WHEN an item is snoozed for N days THE SYSTEM SHALL suppress it until the instant passes the snooze end, using the injected clock
- **alpha-stable-identity-change-awareness-and-feedback-004** Dismissed-risk resurfacing on material worsening
  - [ ] WHEN a dismissed risk's severity crosses the documented material-worsening threshold THE SYSTEM SHALL resurface it with a sentence naming what worsened and by how much
  - [ ] WHEN evidence has not materially worsened THE SYSTEM SHALL keep the risk suppressed indefinitely
  - [ ] The material-worsening threshold is documented in the repo as a number and referenced by a test
- **alpha-stable-identity-change-awareness-and-feedback-005** Corrected alignment flag as a correction signal
  - [ ] WHEN an off-goal flag is marked wrong THE SYSTEM SHALL suppress that flag on all future reports for the same entity and cause
  - [ ] A Correction row is written recording the manager's verdict, the original verdict and the evidence
  - [ ] Suppressed flags are visible in an admin view so a manager can see what they corrected
- **alpha-stable-identity-change-awareness-and-feedback-006** One-click feedback from web, email and Slack
  - [ ] Email feedback links are signed, scoped to one item id and one action, expire after 30 days, are single-use for state-changing actions and never authenticate a session
  - [ ] WHEN a Slack feedback action arrives THE SYSTEM SHALL verify the Slack v0 signature within a 5-minute timestamp window and map the Slack user to a Compass identity with permission on that report before mutating state
  - [ ] WHEN an unmapped or unauthorized Slack user clicks a feedback button THE SYSTEM SHALL post an ephemeral 'you don't have access' message and mutate nothing

### alpha-delivery-email-and-slack — Email and Slack delivery with subscriptions and share links _(depends on: alpha-narration-and-grounding, alpha-auth-tenancy-and-seats, alpha-configuration-and-identity-roster)_

Deliver the full report inline (no click-to-view stub) by email via Resend and to Slack DM or channel via the Web API, on a per-user schedule and timezone, with per-channel subscription choice of per-team, merged, or both — defaulting a single-team manager to the team report and a multi-team manager to the merged report. Run delivery on the pg-boss worker with DeliveryLog records. Includes shared report permalinks with unguessable 128-bit tokens, revocation, expiry options and access logging, org-members-only by default, plus environment-variable key handling with graceful degradation.

- **alpha-delivery-email-and-slack-001** Subscription model, schedule and timezone
  - [ ] WHEN a user is a member of one team THE SYSTEM SHALL default their subscription scope to the team report; with two or more teams it SHALL default to merged, reading membership from the configuration roster
  - [ ] Send time is stored with an IANA timezone and the worker schedules against the injected clock in that timezone, including DST transitions
  - [ ] Each channel carries its own independent scope choice
- **alpha-delivery-email-and-slack-002** Email delivery with full report inline
  - [ ] The email body contains all six sections in fixed order in full; a test asserts no 'click here to view the report' stub and no truncation
  - [ ] Emails include RFC 8058 List-Unsubscribe and List-Unsubscribe-Post headers and a working one-click unsubscribe
  - [ ] WHEN a ticket titled with a script tag and an email-header injection payload is rendered into an email THE SYSTEM SHALL emit it as literal text through the sanitized markdown allowlist with no executable markup and no injected header; asserted by a renderer test
- **alpha-delivery-email-and-slack-003** Slack delivery to DM or channel
  - [ ] The Slack message contains all six sections in fixed order with no click-to-view stub and no chart image
  - [ ] Delivery targets either a DM or a named channel per the subscription and records a DeliveryLog row with outcome
  - [ ] WHEN a ticket titled with a script tag and markup is rendered into Slack Block Kit THE SYSTEM SHALL emit it as literal text through the sanitizer; asserted by a renderer test
- **alpha-delivery-email-and-slack-004** pg-boss worker, retries and DeliveryLog
  - [ ] WHEN the same scheduled delivery job is enqueued twice for the same (subscription, date) THE SYSTEM SHALL send exactly one message
  - [ ] Failed deliveries retry with backoff up to a documented limit and each attempt writes a DeliveryLog row with status and error
  - [ ] WHEN no report exists yet for the (org, team, date) THE SYSTEM SHALL defer rather than sending an empty message, and WHEN a provider key is missing THE SYSTEM SHALL log a clear message and skip delivery rather than crashing the worker
- **alpha-delivery-email-and-slack-005** Share links with tokens, expiry, revocation and access logging
  - [ ] Share tokens are 128 bits from a CSPRNG; a test asserts token entropy and that tokens are not derived from report ids
  - [ ] WHEN a share link is revoked or expired THE SYSTEM SHALL return 404/410 for that token on the next request
  - [ ] Every access writes a ShareLinkAccess row with timestamp, IP prefix and user agent, and links default to org-members-only rather than public
- **alpha-delivery-email-and-slack-006** External-service key handling and graceful degradation
  - [ ] .env.example documents every environment variable the product reads, with a comment describing each
  - [ ] WHEN an integration key is absent THE SYSTEM SHALL show a clear in-app message naming the missing capability and SHALL NOT crash or 500
  - [ ] A test boots the app with no third-party keys set and asserts `/` still renders the seeded report

### alpha-scheduled-pipeline-execution — Scheduled incremental ingest and per-team report generation _(depends on: alpha-delivery-email-and-slack, alpha-configuration-and-identity-roster)_

Recurring jobs that keep a live org's data and reports current: an incremental ingest window per (org, source) advancing from the last IngestRun, and a per-team daily report generation job that runs on that team's configured cadence and timezone — both driven by the injected clock, idempotent per (org, team, date), and ordered ahead of the delivery job so a report always exists before delivery attempts to send it.

- **alpha-scheduled-pipeline-execution-001** Recurring incremental ingest windows per org and source
  - [ ] WHEN the ingest job runs THE SYSTEM SHALL derive the window start from the last successful IngestRun for that (org, source) and the window end from the injected clock, leaving no gap between consecutive windows
  - [ ] WHEN the same window is processed twice THE SYSTEM SHALL produce zero new entity versions and zero duplicate rows
  - [ ] WHEN a source errors or rate-limits THE SYSTEM SHALL record a coverage gap on the IngestRun, retry with backoff, and not advance the window past the unfetched range
- **alpha-scheduled-pipeline-execution-002** Per-team daily report generation on the team's cadence
  - [ ] WHEN the daily job runs twice for the same (org, team, date) THE SYSTEM SHALL produce one Report row
  - [ ] Generation honours the team's configured cadence and timezone including DST transitions, asserted by tests using the injected clock
  - [ ] WHEN generation fails THE SYSTEM SHALL record the failure with org, team and instant and retry within the documented limit rather than leaving a partial Report
- **alpha-scheduled-pipeline-execution-003** Job ordering ahead of delivery
  - [ ] WHEN a delivery is scheduled for (subscription, date) THE SYSTEM SHALL only send after the corresponding generation job for that (org, team, date) has succeeded
  - [ ] WHEN generation has not completed by the delivery time THE SYSTEM SHALL defer delivery within the documented window and log the deferral rather than sending a stale report
  - [ ] A test enqueues delivery before generation and asserts exactly one message is sent, after generation completes

### alpha-merged-weekly-and-time-travel — Merged cross-team report, weekly digest, report archive and simulated-clock time travel _(depends on: alpha-stable-identity-change-awareness-and-feedback, alpha-calibration-and-completion-ladder)_

Per-team daily reports remain the unit of record; add a genuine merged manager-level report that ranks what changes the manager's actions today, obeys a hard numbered prose budget and links down into per-team detail. Add the weekly digest (velocity trends, workload distribution, review bottlenecks, technical debt growth, upcoming risks, suggested priorities), a permalinked archive of every past report, and the simulated-clock control on the report view that steps `now` day by day or jumps to any date in the seeded history, regenerating through the real pipeline.

- **alpha-merged-weekly-and-time-travel-001** Merged cross-team report with a numbered prose budget
  - [ ] The merged report never exceeds 400 words, the number documented in docs/budgets.md; a test asserts the budget on the seeded three-team org
  - [ ] Items are ranked by a documented action-impact score, not by team order or concatenation; asserted by a test with a low-impact team listed first
  - [ ] Every merged item links to the corresponding per-team report item by its stable item ID
- **alpha-merged-weekly-and-time-travel-002** Weekly digest
  - [ ] The weekly digest contains all six documented topics, each with a named producer in the structured payload, and renders as prose with no chart, canvas or svg chart
  - [ ] Weekly digest generation is deterministic for the same (org, team, instant)
  - [ ] WHEN insufficient history exists THE SYSTEM SHALL state which weekly topics are undefined rather than emitting a number
- **alpha-merged-weekly-and-time-travel-003** Permalinked report archive
  - [ ] Every generated report has a stable permalink URL that renders the exact stored report, not a regenerated one
  - [ ] The archive lists reports by team and date with the six sections intact
  - [ ] WHEN an archived report is opened THE SYSTEM SHALL render the prose and structured payload as stored, including any fallback-renderer flag
- **alpha-merged-weekly-and-time-travel-004** Simulated-clock time-travel control
  - [ ] WHEN a date is selected THE SYSTEM SHALL regenerate the report through the real pipeline for that instant, not serve a precomputed mock
  - [ ] Stepping day by day across the Release 2 window produces the sequence risk → projected slip → recommendation under one stable item ID; asserted by an end-to-end test
  - [ ] The control is only available in the simulated-clock mode and cannot alter production `now` for a live org

## Beta — Production-ready: proven determinism and grounding, the professional security/privacy/accessibility bar, and honest degradation everywhere.

**Success criteria:**

- `npm run test:golden` diffs live output against ≥10 consecutive simulated days per team plus the merged report; `npm run golden:update` produces a reviewable diff
- A two-org test asserts no route, permalink, export or email link leaks data across orgs, and a parametrized (role × route) test covers the four-role matrix while preserving the public seeded-demo route
- A ticket titled with a script tag and an email-header injection payload renders as literal text in web, email and Slack with no execution
- Prose grounding extractor finds zero untraceable tokens across the golden corpus; narration fail-closed fallback is recorded on the report row
- Report view meets WCAG 2.1 AA and renders within the numbered budget on a throttled mid-tier mobile profile

### beta-first-run-experience — First-run experience: demo data, demo account and designed empty states _(depends on: alpha-configuration-and-identity-roster, alpha-merged-weekly-and-time-travel)_

Guarantee the product opens onto something real: seed data loaded automatically on first run (with a documented one-command seed script in the README), a demo account with documented credentials written machine-readably to `.nous/demo_account.json`, designed empty states with a clear call-to-action on every list/table screen, and a guided first-report path for a real org.

- **beta-first-run-experience-001** Automatic seed on first run and documented seed script
  - [ ] WHEN the application boots against an empty database THE SYSTEM SHALL load the seed dataset and generate the current report without any user action
  - [ ] The README documents a single seed command and the expected cold-start time under 60 seconds
  - [ ] Re-running the seed against an already-seeded database is idempotent and does not duplicate rows
- **beta-first-run-experience-002** Demo account with machine-readable credentials
  - [ ] `.nous/demo_account.json` exists after seeding and contains {"email": "...", "password": "...", "login_path": "/login"}
  - [ ] WHEN those credentials are POSTed to the login path THE SYSTEM SHALL authenticate successfully and land on the seeded org's report
  - [ ] The demo credentials are documented in the README and the account has the owner role on the seeded org only
- **beta-first-run-experience-003** Designed empty states with calls to action
  - [ ] Every list or table screen renders a designed empty state with explanatory copy and a primary call-to-action when it has no rows
  - [ ] No screen renders a bare empty table, a spinner that never resolves, or a blank panel
  - [ ] A test enumerates list routes and asserts each renders its empty-state copy against an empty org
- **beta-first-run-experience-004** Guided first-report path for a real org
  - [ ] A new org can reach a generated report in under 10 minutes of in-app steps with no external assistance; documented as a numbered path
  - [ ] WHEN a new org has no data yet THE SYSTEM SHALL explain what is missing and what to do next rather than rendering an empty report
  - [ ] Goal hierarchy quick entry accepts a company objective and a sprint goal in one screen with sensible defaults

### beta-golden-fixtures-and-spec-qa — Golden-fixture regression suite and spec-driven black-box QA _(depends on: alpha-merged-weekly-and-time-travel, alpha-manager-memos, beta-first-run-experience)_

Check in `fixtures/reports/<team>/<date>.json` for at least 10 consecutive simulated days per team plus the merged report, with `npm run test:golden` diffing live output and `npm run golden:update` regenerating a reviewable diff. Alongside it, write black-box automated tests derived only from the spec's core features and success criteria — HTTP endpoints and rendered UI, not implementation internals — at least one per core feature, each written so it would fail if the feature were stubbed, faked or half-wired.

- **beta-golden-fixtures-and-spec-qa-001** Golden fixtures and diff tooling
  - [ ] `fixtures/reports/<team>/<date>.json` exists for ≥10 consecutive simulated days per seeded team plus the merged report
  - [ ] `npm run test:golden` fails with a readable per-field diff when live output differs from the fixture
  - [ ] `npm run golden:update` regenerates fixtures and leaves a reviewable git diff, never an opaque blob
- **beta-golden-fixtures-and-spec-qa-002** Determinism and clock gates in CI
  - [ ] CI runs the pipeline twice in-process and in a separate process for the same (org, team, instant) and asserts byte-identical structured JSON after the documented allowlist
  - [ ] CI fails if any forbidden clock call appears under the guarded packages
  - [ ] The architecture test asserting analysis purity runs in CI and fails the build on violation
- **beta-golden-fixtures-and-spec-qa-003** Spec-driven black-box tests per core feature
  - [ ] At least one black-box test exists per core feature, asserting observable behaviour only (HTTP response or rendered output), with no import of internal modules
  - [ ] Each test is written so it fails if the feature is stubbed; a mutation check disables one feature at a time and asserts the corresponding test fails
  - [ ] The suite runs against a seeded instance in CI and logs in with the credentials in `.nous/demo_account.json` for authenticated flows
- **beta-golden-fixtures-and-spec-qa-004** Idempotency, correction and stable-identity regression tests
  - [ ] Running the same window three times yields identical DB snapshots after runs 2 and 3, including overlapping and out-of-order windows
  - [ ] The seeded blocked-then-merged ticket produces exactly one Correction and the next report states 'reported blocked yesterday; actually merged at 18:40 — correction recorded'
  - [ ] Reports across 10 consecutive simulated days keep one stable ID per persistent item, asserted by a test
- **beta-golden-fixtures-and-spec-qa-005** No-charts, no-ranking and prose-budget assertions
  - [ ] A test asserts rendered web, email and Slack output contain no <canvas>, no chart <svg>, no charting bundle and no image chart, and that the script-tag/header-injection seeded title renders as literal text in all three channels
  - [ ] A test scans routes and rendered output and fails on any per-developer leaderboard, commit-count or LOC comparison
  - [ ] A word-count test asserts the daily report fits the documented ~90-second reading budget (≤ 450 words, docs/budgets.md) and the merged report fits its 400-word budget

### beta-security-hardening — Security hardening: isolation proof, headers, rate limiting, webhooks and secrets _(depends on: alpha-auth-tenancy-and-seats, alpha-delivery-email-and-slack)_

Prove and enforce the professional security bar: a two-org test asserting no route, permalink, export or email link leaks across orgs; the parametrized (role × route) matrix test that also preserves the public seeded-demo route; strict CSP with nonce-based scripts and frame-ancestors none, HSTS with preload, X-Content-Type-Options, Referrer-Policy and Permissions-Policy on every response; per-IP and per-account rate limiting with 429 + Retry-After; inbound webhook signature verification with constant-time comparison; and encrypted-at-rest, never-logged, never-returned integration tokens with a grep-based CI check.

- **beta-security-hardening-001** Two-org isolation test suite
  - [ ] A parametrized test iterates every API route with org A's session and org B's identifiers and asserts 403 or 404 with no data disclosure
  - [ ] Report permalinks, share tokens, export downloads and email feedback links from org B are inaccessible to org A users
  - [ ] A query-layer test asserts no SQL is emitted without an organization_id predicate
- **beta-security-hardening-002** Role matrix parametrized test with the public demo route preserved
  - [ ] The test enumerates all routes at runtime and fails if any lacks a matrix entry
  - [ ] Every (role × route) pair is asserted allow or deny according to the matrix, including viewer read-only, member self-scope and the `public` principal
  - [ ] WHEN a route is added without a matrix entry THE SYSTEM SHALL fail the build; the seeded demo report route's public entry satisfies this rule and a test asserts `/` still returns a full six-section report with no session
  - [ ] A route may be marked public only via the explicit public entry, and a test asserts exactly the documented set of public routes exists
- **beta-security-hardening-003** Security headers and CSP
  - [ ] An automated test fetches a sample of every route class and asserts all six headers are present with the documented values
  - [ ] The CSP contains no unsafe-inline and scripts carry a per-response nonce
  - [ ] frame-ancestors 'none' is set and verified
- **beta-security-hardening-004** Rate limiting with 429 and Retry-After
  - [ ] WHEN a limit is exceeded THE SYSTEM SHALL return 429 with a Retry-After header and SHALL NOT perform the action
  - [ ] Auth lockout escalates exponentially and sends a notification email to the account owner
  - [ ] Each documented limit has a test asserting the threshold and the reset behaviour using the injected clock
- **beta-security-hardening-005** Webhook signature verification
  - [ ] WHEN a valid body arrives with a tampered signature THE SYSTEM SHALL return 401 and write a log entry naming the provider
  - [ ] Slack requests older than 5 minutes are rejected regardless of signature validity
  - [ ] All comparisons use a constant-time function; asserted by a code test on the verification helper
- **beta-security-hardening-006** Encrypted token storage and secret-leak CI check
  - [ ] Token columns are encrypted at rest with a per-org data key; a test asserts the raw column value is not the plaintext token
  - [ ] No API response contains a token field, masked or otherwise; asserted by a response-schema test
  - [ ] A CI check fails the build if a token field name appears in any log statement or serializer

### beta-privacy-and-transparency — Privacy: retention, anonymization, deletion, transparency page and LLM data minimization _(depends on: alpha-configuration-and-identity-roster, alpha-narration-and-grounding)_

Ship the privacy bar as working product: configurable per-org retention with real deletion and an admin retention page; per-person anonymization so a departed developer's name disappears from future reports and past reports render 'a former team member' while keeping structural facts and the audit trail; self-serve account and org deletion with a 7-day grace period, emailed undo link, pre-purge export and hard deletion within 30 days; a self-serve 'what does Compass say about me' page; opt-in per-channel Slack ingestion with a visible statement and bot-posted notice; and LLM data-minimization modes (full text / pseudonymized / no-LLM deterministic rendering).

- **beta-privacy-and-transparency-001** Configurable retention with real purges
  - [ ] WHEN raw events pass the configured retention window THE SYSTEM SHALL delete those rows and record the purge count and timestamp
  - [ ] The admin retention page shows the current setting, next scheduled purge and last purge outcome
  - [ ] Retention defaults are documented in the repo and applied to new orgs
- **beta-privacy-and-transparency-002** Per-person anonymization
  - [ ] WHEN a developer is anonymized THE SYSTEM SHALL replace their name with a stable pseudonym in all future reports
  - [ ] Previously generated reports render 'a former team member' in place of the name while keeping ticket keys, PR numbers and counts intact
  - [ ] The anonymization action writes an audit record and cannot be silently reversed
- **beta-privacy-and-transparency-003** Self-serve account and organization deletion
  - [ ] WHEN deletion is requested THE SYSTEM SHALL enter a 7-day grace period, email an undo link and offer a full data export before purge
  - [ ] WHEN the undo link is used inside the grace period THE SYSTEM SHALL fully restore access
  - [ ] Hard deletion completes within 30 days and sends a confirmation email enumerating the data categories deleted
- **beta-privacy-and-transparency-004** 'What does Compass say about me' page
  - [ ] WHEN a member opens the page THE SYSTEM SHALL list every stored field about them and every report line naming them, with links to those reports
  - [ ] No manager approval or admin action is needed once the org enables member accounts
  - [ ] The page contains no ranking, no comparison to other developers and no productivity score
- **beta-privacy-and-transparency-005** Opt-in Slack channel ingestion with visible notice
  - [ ] WHEN a channel is enabled for ingestion THE SYSTEM SHALL post a notice in that channel stating Compass reads it
  - [ ] DMs and private channels are never ingested; a test asserts the ingest path filters them out unconditionally
  - [ ] The settings page lists exactly which channels are ingested and when each was enabled
- **beta-privacy-and-transparency-006** LLM data-minimization modes
  - [ ] WHEN redacted mode is on THE SYSTEM SHALL send only pseudonyms to the LLM and SHALL re-substitute real names locally; a test asserts no real name appears in the outbound request
  - [ ] WHEN no-LLM mode is on THE SYSTEM SHALL render every report through the template renderer and make zero LLM calls
  - [ ] All three modes produce a grounded, six-section report that passes the grounding validator

### beta-accessibility-performance-and-observability — Accessibility, numbered performance budgets and observability _(depends on: beta-first-run-experience)_

Bring the web surface to WCAG 2.1 AA (keyboard operability, focus management, contrast, screen-reader semantics for the report and evidence panels), meet numbered performance budgets for the report view and time-travel regeneration on a throttled mid-tier mobile profile, and instrument the system with Sentry (PII scrubbing on), structured logs and health checks covering pipeline runs, narration fallbacks, ingest coverage and delivery outcomes. Establishes docs/budgets.md as the single home for every numbered budget and threshold.

- **beta-accessibility-performance-and-observability-001** WCAG 2.1 AA on the report and configuration surfaces
  - [ ] Every interactive element is reachable and operable by keyboard with a visible focus indicator
  - [ ] Automated axe checks report zero critical or serious violations on the report view, archive, evidence panel and configuration screens
  - [ ] The six sections use a correct heading hierarchy and the evidence panel is announced and dismissible by screen reader
- **beta-accessibility-performance-and-observability-002** Numbered report-view and time-travel performance budgets
  - [ ] docs/budgets.md lists each budget as a single number with its owning test; the report view renders within 2000 ms Largest Contentful Paint on the throttled mid-tier mobile profile, asserted by a CI performance check
  - [ ] WHEN a time-travel date is selected THE SYSTEM SHALL return a regenerated report within 5000 ms or show honest progress rather than hanging; asserted by a CI check against the seeded org
  - [ ] Cold start from `docker compose up` to a rendered report stays under 60 seconds; asserted by the CI smoke test
- **beta-accessibility-performance-and-observability-003** Sentry, structured logging and health checks
  - [ ] Sentry is initialized with PII scrubbing enabled; a test asserts no email address, token or raw ingested text is sent in an event payload
  - [ ] Pipeline runs, narration fallbacks, ingest coverage gaps and delivery failures each emit a structured log event with the org, team and instant
  - [ ] A health endpoint reports queue depth, last successful ingest and last successful delivery per org
- **beta-accessibility-performance-and-observability-004** Honest degradation surfaces
  - [ ] WHEN a configured source produced no data for the window THE SYSTEM SHALL state in the report which source is missing and what it would have contributed
  - [ ] WHEN a source is rate-limited THE SYSTEM SHALL say so with the time of the last successful fetch
  - [ ] No report presents itself as complete when a configured source is missing; asserted by a test disabling one source

### beta-in-app-feedback-channel — In-app user feedback control and feedback API _(depends on: alpha-auth-tenancy-and-seats)_

A lightweight in-app feedback control (small button and form) available from the report view that stores submissions in Compass's own database and exposes them at GET /api/feedback as a JSON array of {id, message, created_at}, most recent first — distinct from the report-item feedback loop and read by the owner and automated maintenance.

- **beta-in-app-feedback-channel-001** Feedback control and storage
  - [ ] WHEN a message is submitted through the in-app control THE SYSTEM SHALL persist it with an id, message body and created_at timestamp
  - [ ] The control is reachable from the report view and does not obscure report content on a 375px viewport
  - [ ] Submission shows a clear confirmation and never loses the typed message on error
- **beta-in-app-feedback-channel-002** GET /api/feedback endpoint
  - [ ] GET /api/feedback returns a JSON array of objects with exactly id, message and created_at, ordered most recent first
  - [ ] WHEN a non-owner requests the endpoint THE SYSTEM SHALL return 403
  - [ ] A test submits three messages and asserts the endpoint returns them newest first

## Launch — Ready to put in front of real users: live connectors, billing, enterprise auth, delight items, docs, legal and monitoring.

**Success criteria:**

- A manager connects GitHub, Jira and Slack alone in under 10 minutes with per-repo/per-project scoping and sees a report on their own data
- Swapping the seeded provider for live connectors requires configuration only — zero changes to knowledge-model, analysis or report generation
- Stripe test-mode checkout, trial expiry, seat changes, invoices, dunning and downgrade all behave correctly and degrade gracefully with no key configured
- Docs, DPIA, GDPR Art. 22 statement and the subprocessor page are published and linked in-app, and the pricing page matches the implemented plans
- Dependency/secret/base-image scanning runs on every PR and nightly; a critical fixable CVE blocks release

### launch-live-connectors — Live GitHub, Jira and Slack connectors behind the existing port _(depends on: beta-security-hardening, beta-golden-fixtures-and-spec-qa, alpha-scheduled-pipeline-execution)_

Implement GitHub App + OAuth read-only, Jira Cloud OAuth 3LO and Slack app install as ConnectorPort implementations, so swapping from the seeded provider is a configuration change with zero changes to the knowledge model, analysis or report generation. Includes a self-serve connect flow a manager completes alone in under 10 minutes with per-repo and per-project scoping, least-privilege scopes displayed verbatim before consent, and honest handling of rate limits and disconnection.

- **launch-live-connectors-001** GitHub App and OAuth read-only connector
  - [ ] The GitHub connector passes the ConnectorPort contract test suite unchanged
  - [ ] Requested scopes are exactly the documented read-only set and are displayed verbatim on the connect screen before consent
  - [ ] WHEN the API rate-limits THE SYSTEM SHALL record a coverage gap on the IngestRun and surface it in the freshness indicator rather than reporting on partial data as complete
- **launch-live-connectors-002** Jira Cloud OAuth 3LO connector
  - [ ] The Jira connector passes the ConnectorPort contract test suite unchanged
  - [ ] A manager can select specific Jira projects during connect; unselected projects are never queried
  - [ ] Sprint completion computed from live Jira reconciles line-by-line with the Jira board for a test project
- **launch-live-connectors-003** Slack app install and channel-scoped connector
  - [ ] The Slack connector passes the ConnectorPort contract test suite unchanged
  - [ ] Only explicitly named channels are queried; a test asserts no workspace-wide history call is ever made
  - [ ] Installation displays the requested scopes verbatim before consent
- **launch-live-connectors-004** Self-serve connect flow under 10 minutes
  - [ ] A manager completes GitHub, Jira and Slack connect alone in under 10 minutes with per-repo and per-project scoping; measured by a scripted walkthrough
  - [ ] Disconnecting a source keeps prior data, states the source is disconnected in the freshness indicator and writes an audit record
  - [ ] No step requires an org admin, a CSV upload or a hand-edited config file
- **launch-live-connectors-005** Zero-change swap proof
  - [ ] A test asserts the ingest, knowledge-model, analysis and report packages contain no provider-specific identifier (github, jira, slack) in any module
  - [ ] Provider selection happens through configuration resolved at composition root only
  - [ ] The same analysis test suite passes against a recorded live-provider fixture and the seeded provider

### launch-billing-and-subscription-lifecycle — Stripe billing and subscription lifecycle _(depends on: alpha-auth-tenancy-and-seats)_

Plans and pricing, seat-based checkout, trial and trial expiry, invoices, dunning, upgrade/downgrade and cancellation. Keys come from environment variables, Stripe runs in TEST mode by default, and the product degrades gracefully with a clear in-app message when no key is configured.

- **launch-billing-and-subscription-lifecycle-001** Plans, pricing and seat-based checkout
  - [ ] WHEN an owner completes test-mode checkout THE SYSTEM SHALL activate the plan and set the org's seat allowance
  - [ ] Seat count changes propagate to Stripe and are reflected on the billing page within one webhook cycle
  - [ ] Stripe defaults to TEST mode and the mode is displayed on the billing page
  - [ ] The plan and seat-price definitions live in one documented module that the pricing page also reads
- **launch-billing-and-subscription-lifecycle-002** Trials, expiry, invoices and dunning
  - [ ] WHEN a trial expires without payment THE SYSTEM SHALL restrict to a documented read-only state and explain what is limited and how to restore it
  - [ ] Invoices are listed and downloadable for the org's billing period history
  - [ ] WHEN a payment fails THE SYSTEM SHALL enter dunning, notify the owner by email and state the deadline in-app
- **launch-billing-and-subscription-lifecycle-003** Upgrade, downgrade, cancellation and webhook handling
  - [ ] WHEN a plan is downgraded below the current seat count THE SYSTEM SHALL block the change and name which seats must be removed first
  - [ ] Stripe webhooks verify the signature and are idempotent on redelivery; a test replays the same event twice and asserts one state change
  - [ ] Cancellation retains access until the end of the paid period and then applies the documented restricted state
- **launch-billing-and-subscription-lifecycle-004** Missing-key graceful degradation
  - [ ] WHEN STRIPE_SECRET_KEY is absent THE SYSTEM SHALL show 'billing is not configured' on billing screens and SHALL NOT crash or 500 anywhere
  - [ ] All Stripe environment variables are documented in .env.example
  - [ ] A test boots with no Stripe key and asserts report generation, delivery and configuration all still function

### launch-sso-2fa-and-enterprise-auth — SSO, TOTP 2FA and business-plan SAML/SCIM _(depends on: alpha-auth-tenancy-and-seats, launch-billing-and-subscription-lifecycle)_

Extend authentication with Google and GitHub SSO on all plans, TOTP 2FA with recovery codes, and SAML plus SCIM provisioning on the business plan, integrated with the existing session, role matrix and seat lifecycle.

- **launch-sso-2fa-and-enterprise-auth-001** Google and GitHub SSO
  - [ ] WHEN a user signs in with a Google or GitHub account whose verified email matches an existing user THE SYSTEM SHALL link the identity rather than creating a duplicate account
  - [ ] Unverified provider emails never auto-link; the user must confirm ownership
  - [ ] SSO sessions obey the same rotation and expiry rules as password sessions
- **launch-sso-2fa-and-enterprise-auth-002** TOTP 2FA with recovery codes
  - [ ] WHEN 2FA is enabled THE SYSTEM SHALL require a valid TOTP code at login and reject reused codes within the same time step
  - [ ] Recovery codes are single-use, hashed at rest and regenerable
  - [ ] Disabling 2FA requires re-authentication and writes an audit record
- **launch-sso-2fa-and-enterprise-auth-003** SAML and SCIM on the business plan
  - [ ] WHEN SCIM deprovisions a user THE SYSTEM SHALL revoke their sessions and free their seat within one sync cycle
  - [ ] SAML and SCIM endpoints are available only to orgs on the business plan and return a clear message otherwise
  - [ ] SAML assertions are signature-verified and replay-protected; asserted by a test with a replayed assertion

### launch-report-diff-view — Side-by-side report diff — 'what changed since yesterday' _(depends on: alpha-stable-identity-change-awareness-and-feedback, alpha-merged-weekly-and-time-travel)_

A web view that diffs two structured reports item by item (added, removed, changed) so an evaluating reviewer can see exactly what changed between two days and verify nothing was fabricated, built on the stable item IDs and change tags.

- **launch-report-diff-view-001** Structured report diff engine
  - [ ] WHEN two reports are diffed THE SYSTEM SHALL key items by stable ID and classify each as added, removed or changed with the changed fields listed
  - [ ] Non-semantic fields on the documented allowlist are excluded from the diff
  - [ ] Diffing a report against itself yields zero differences
- **launch-report-diff-view-002** Side-by-side diff UI
  - [ ] The diff view shows both days side by side with added/removed/changed markers and remains readable at 375px width
  - [ ] Every changed item links to its evidence affordance in both reports
  - [ ] WHEN nothing changed THE SYSTEM SHALL state 'nothing material changed' rather than rendering two identical columns without explanation
- **launch-report-diff-view-003** Fabrication-check affordance
  - [ ] WHEN a claim is expanded THE SYSTEM SHALL show the structured payload fields backing it alongside the rendered prose
  - [ ] Every token in the prose is traceable from this view to a payload field or source artifact
  - [ ] A reviewer can reach the underlying commit SHA, PR number or Jira key in one click from the diff

### launch-docs-legal-and-onboarding-content — Documentation, legal pages and public-facing content _(depends on: beta-privacy-and-transparency, launch-billing-and-subscription-lifecycle)_

Publish the README and product documentation (architecture, seed manifest, determinism and grounding guarantees, docs/budgets.md, how to run and update goldens), the completed DPIA template and GDPR Article 22 position statement, the data-processing page naming every subprocessor with data category and region plus a 30-day change-notice subscribe link, an SBOM available on request, plus pricing, terms and privacy pages.

- **launch-docs-legal-and-onboarding-content-001** README and engineering documentation
  - [ ] The README documents cold start in one command with the expected under-60-second result and the demo credentials location
  - [ ] The determinism allowlist, grounding rules and docs/budgets.md numbers are documented with links to the tests that enforce them
  - [ ] `npm run test:golden` and `npm run golden:update` are documented with the review workflow for a golden diff
- **launch-docs-legal-and-onboarding-content-002** DPIA, GDPR Article 22 statement and no-ranking stance
  - [ ] The DPIA and Article 22 statement are published in-product and linked from the privacy page
  - [ ] The statement explicitly says alignment flags are advisory, manager-correctable and not routed to HR systems
  - [ ] The no-individual-ranking stance is published and links to the test that enforces it in code
- **launch-docs-legal-and-onboarding-content-003** Subprocessor and data-processing page
  - [ ] The page names every subprocessor with data category and region and is reachable without an account
  - [ ] A subscribe control exists for change notices and confirms subscription by email
  - [ ] Changes to the subprocessor list trigger a 30-day advance notice to subscribers; documented and covered by a test on the notice job
- **launch-docs-legal-and-onboarding-content-004** Pricing, terms, privacy and SBOM
  - [ ] The pricing page renders plan names and seat prices from the billing plan-definition module; a test asserts the rendered pricing values equal the module's values with no hard-coded duplicates
  - [ ] Terms and privacy pages are published and linked from the footer and sign-up flow
  - [ ] An SBOM is generated in CI and its retrieval process is documented

### launch-release-engineering-and-monitoring — CI/CD, dependency scanning and production monitoring _(depends on: beta-golden-fixtures-and-spec-qa, beta-security-hardening, beta-accessibility-performance-and-observability)_

Wire the full CI/CD pipeline running every gate (determinism, clock lint, purity, grounding, golden diff, isolation, role matrix, headers, no-charts, no-ranking, cold-start smoke), plus SCA/secret/base-image scanning on every PR and nightly with a critical fixable CVE blocking release, deployment with migrations, and production monitoring and alerting on pipeline failures, narration fallbacks, delivery failures and ingest coverage gaps.

- **launch-release-engineering-and-monitoring-001** CI pipeline running every quality gate
  - [ ] Every documented gate runs on every pull request and the build fails on any gate failure
    - **Amended 2026-08-18 (issue #12).** Two exceptions, deliberate and recorded rather than
      silently taken: `cold-start` and `perf` run on `master` pushes and `workflow_dispatch`, not on
      pull requests. They build and boot containers, and paying that on every pull request was a
      material part of exhausting the account's entire Actions allowance — which took CI down for
      every repository, so the fan-out was costing more coverage than it bought. Every other gate,
      including base-image scanning and the secret scan, still runs on every pull request. The
      criterion is otherwise unchanged, and `docs/budgets.md` records the same exception beside the
      numbers it affects.
  - [ ] The cold-start smoke test boots a clean container, fetches `/` and asserts a full six-section report within 60 seconds
  - [ ] Gate failures report a readable message naming the gate and the offending artifact
- **launch-release-engineering-and-monitoring-002** Dependency, secret and image scanning
  - [ ] WHEN a critical vulnerability with an available fix is detected THE SYSTEM SHALL block the release and name the package and fixed version
  - [ ] Secret scanning runs on every PR and fails the build on a detected credential
  - [ ] Nightly scans run on the default branch and report results to the maintainers
- **launch-release-engineering-and-monitoring-003** Deployment with migrations and rollback
  - [ ] Deployment applies migrations before serving traffic and aborts the rollout if a migration fails
  - [ ] A documented rollback procedure restores the prior release and is exercised once in a staging run
  - [ ] The worker and web process are deployed and health-checked independently
- **launch-release-engineering-and-monitoring-004** Production alerting on quality-degrading paths
  - [ ] WHEN narration fallbacks exceed 2% of generated reports over a rolling 24-hour window (the rate documented in docs/budgets.md) THE SYSTEM SHALL raise an alert naming the affected orgs
  - [ ] Delivery failures and pipeline generation failures raise alerts with the org, team and instant
  - [ ] Ingest coverage gaps produce an alert and are reflected in the in-product freshness indicator
