# Architecture

Compass is a single TypeScript monorepo deployed as two processes (a Next.js web/API app and a pg-boss worker) over one PostgreSQL database, organised as a strictly layered pipeline: connectors → ingest/reconciliation → versioned knowledge model → a pure analysis core → a structured report object → renderers (web, email, Slack). Every layer boundary is a package boundary enforced by dependency-cruiser architecture tests and an ESLint rule banning direct time access, so the analysis core is pure and deterministic and the seeded connector is indistinguishable from a live GitHub/Jira/Slack connector. The Anthropic Claude API is used only for narrating an already-computed structured report and for extracting Manager Memos into a closed five-kind schema, with a grounding validator and a deterministic template renderer that makes narration fail closed.

## Tech stack

- **Language:** TypeScript
- **Backend:** Node.js 22 / TypeScript — Next.js 15 App Router route handlers for the HTTP surface plus a pg-boss worker process, over a pnpm workspace monorepo of layer-scoped packages (connector-port, ingest, knowledge-model, analysis, pipeline, renderers, clock)
- **Frontend:** React 19 / Next.js 15 (Server Components) with TypeScript and Tailwind CSS, prose-only (no charting dependency)
- **Database:** PostgreSQL 17 with Drizzle ORM (append-only history tables, Correction records, effective-dated rows, pg-boss queue in the same database)
- **Deployment:** Docker + docker compose as the canonical one-command cold start and CI smoke target; Fly.io (or Railway) for the hosted deployment — one image run as two processes (web, worker) plus managed Postgres
- **External services:** Anthropic Claude API (report narration and Manager Memo extraction only), Resend (transactional email send + inbound reply-to parsing for memos, SPF/DKIM/DMARC, RFC 8058 one-click unsubscribe), Slack API (app install, Web API for DM/channel delivery, Events API + Block Kit interactivity for memos and one-click feedback), Sentry (error tracking, PII scrubbing on), GitHub App + OAuth read-only (post-MVP live connector, designed against the connector port now), Jira Cloud OAuth 3LO (post-MVP live connector, designed against the connector port now), Stripe (post-MVP billing/subscription lifecycle; adapter boundary only in the MVP)

## Components

### web-app (frontend)

- **Tech:** React 19 + Next.js 15 App Router (Server Components), TypeScript, Tailwind CSS, no charting library in package.json
- Manager-facing web UI: the six-section daily report, permalinked archive, per-claim source links to commit SHA / PR number / Jira key, alignment evidence panel, data-freshness/coverage indicator, simulated-clock time-travel control, one-click feedback, Manager Memo form, and configuration (teams, repos, goal hierarchy, identity roster, unmatched-identity queue). Prose-first: renders markdown-with-allowlist, no chart/svg/canvas primitives are available to it, and a render test asserts their absence.
- **Exposes:** / (zero-config seeded report, no login wall), /r/:reportId (permalink), /s/:token (shared read-only permalink), /teams/:teamId/reports?at=<instant> (time travel), /settings/* (roster, goals, repos, subscriptions)
- **Depends on:** app-server
### app-server (backend)

- **Tech:** Node.js 22 + Next.js 15 route handlers, Zod request validation, iron-session-style httpOnly+Secure+SameSite=Lax cookies, @node-rs/argon2, Slack signature + GitHub HMAC verifiers with constant-time compare
- HTTP surface colocated with the web app as Next.js route handlers and server actions: session auth (email+password with Argon2id, magic link, password reset), the four-role (owner/manager/member/viewer) authorization matrix as one table in code checked server-side per route, share-link issue/revoke/expiry/access-logging, feedback writes, memo intake from the web form, inbound Slack Events/interactivity and email inbound/bounce webhooks with signature verification, and on-demand report generation for a requested instant. All database access goes through the scoped-query layer; no route may construct a query without an organization_id.
- **Exposes:** REST/JSON under /api/*, signed single-purpose email feedback links, POST /api/slack/events, /api/slack/interactivity, POST /api/email/inbound, /api/email/webhooks
- **Depends on:** persistence-and-scoped-query-layer, report-pipeline-orchestrator, renderers, memo-intake
### connector-port (backend)

- **Tech:** TypeScript interface package (@compass/connector-port) with Zod-validated normalised event schemas and a shared provider conformance test suite
- The time-windowed query port every data source implements: given (organization, source config, window start, window end, Clock instant) it returns normalised provider events (commits, branches, PRs, reviews, review comments, tickets, changelog entries, sprints, boards, tags/releases, opted-in Slack messages). Downstream layers receive only this normalised shape and cannot detect whether a provider is seeded or live, so live connectors are a configuration change with no change to the knowledge model, analysis or report generation.
- **Exposes:** ConnectorPort.fetchWindow(), ConnectorPort.capabilities(), provider conformance test kit
- **Depends on:** clock-port
### seed-connector (service)

- **Tech:** TypeScript + YAML fixture loader, passes the same conformance suite as live providers
- The MVP runtime substrate: a full ConnectorPort implementation reading the checked-in declarative seed fixtures and answering any time window against them, including honest capability reporting (no deploy signal, Slack limited to opted-in channels) and simulated rate-limit/disconnected states so degradation paths are exercisable without credentials.
- **Exposes:** ConnectorPort implementation 'seed'
- **Depends on:** connector-port, seed-dataset
### seed-dataset (infrastructure)

- **Tech:** YAML + Markdown manifest under /seed, schema-validated in CI (no generated binary blob)
- Version-controlled, human-readable seed: 3+ projects, 12 developers each with multiple git emails plus a Jira accountId plus a Slack userId, 4 completed sprints plus 1 in-flight, branch topology and tags for the Completion Ladder, and a documented manifest naming each planted pathology by ID (off-goal work stream, single-reviewer review bottleneck, multi-day release slip, ticket reported blocked but actually merged, estimation noise) plus documented traceability proportions (clean structural chains, branch-name-only hints, semantic-only matches, unattributable commits). Includes manifest variants (e.g. estimation-noise-removed) used by calibration tests.
- **Exposes:** /seed/manifest.md, /seed/**/*.yaml, seed schema validator
### ingest-and-reconciliation (backend)

- **Tech:** TypeScript (@compass/ingest), Drizzle transactions, deterministic upsert-by-natural-key, unmatched-identity queue writer
- Pulls a window through a ConnectorPort and writes it into the knowledge model incrementally and idempotently: entity resolution via the IdentityLink roster, deterministic natural keys so re-ingesting the same window is a no-op, append-only status-transition history, and non-destructive Correction rows when new data contradicts a stored belief ('reported blocked yesterday; actually merged at 18:40'). Records an IngestRun with per-source coverage, freshness and degradation state. Time comes only from the injected Clock.
- **Exposes:** ingestWindow(org, sourceConfig, window, clock), IngestRun coverage record
- **Depends on:** connector-port, persistence-and-scoped-query-layer, clock-port
### knowledge-model-and-snapshot (backend)

- **Tech:** TypeScript (@compass/knowledge-model) over Drizzle ORM + PostgreSQL, canonical ordering by stable natural keys
- The stateful, versioned org model as first-class rows with first_seen_at / last_seen_at and append-only history, plus the effective-dated goal hierarchy and ObjectiveLink store, Manager Memo assertions, Feedback records keyed to stable entity-derived IDs, and Corrections. Exposes one operation to the pure layer: materializeSnapshot(org, team|merged, instant) — a fully denormalised, deterministically ordered, serialisable snapshot with no lazy loading, which is the only input analysis ever sees.
- **Exposes:** materializeSnapshot(), goal-hierarchy CRUD with effective dating, identity merge/un-merge, correction writer
- **Depends on:** persistence-and-scoped-query-layer, clock-port
### analysis-core (backend)

- **Tech:** Zero-dependency TypeScript package (@compass/analysis) enforced by dependency-cruiser and a null-import allowlist; property tests via fast-check with fixed seeds
- Pure deterministic function (snapshot, instant, config) → StructuredReport. Contains sprint completion math reconcilable line-by-line against the board, trailing-sprint velocity, Kanban/no-sprint semantics, blocker detection from concrete signals, review-queue aggregation with named PRs/reviewers/ages, workload distribution, risk detection with severity and trend, wins detection with documented criteria, three-tier alignment resolution (structural → inferred from branch/commit text → deterministic lexical semantic match with confidence threshold and an 'unattributed' bucket phrased as a question), the Process Calibration Audit statistic set and named verdicts, the Completion Ladder rung detectors R1–R5, the confidence-qualified projected completion date with stated reasoning, the recommendation engine (actor + object + one-step action), change-awareness diffing against prior reports, feedback suppression rules, and the merged cross-team prioritiser with a hard prose budget. No HTTP, database, filesystem, clock, randomness or process env; integer/scaled-decimal math with a documented rounding helper. Contains no per-developer ranking construct by design.
- **Exposes:** generateStructuredReport(snapshot, instant, config), StructuredReport JSON schema, calibration verdicts, ladder rungs
### narration-and-grounding (service)

- **Tech:** TypeScript + @anthropic-ai/sdk (claude-sonnet-5 for narration, claude-opus-5 optional for merged reports), deterministic Handlebars-style template fallback renderer, prompt/response trace rows
- Renders the six fixed sections into prose from the structured section payload only — never raw events — using Claude with ingested text passed as clearly delimited untrusted data, no tool access and no network egress from the prompt. A grounding extractor pulls every number, percentage, date, PR number, commit SHA, Jira key and person name out of the prose and asserts each exists in that section's payload; on failure it retries a bounded number of times and then falls back to the deterministic template renderer, recording narration_fallback and the prompt/response trace on the report row. Narration output is never an input to any decision.
- **Exposes:** narrateReport(structuredReport), groundingValidator(prose, payload), templateRender(structuredReport)
- **Depends on:** analysis-core, persistence-and-scoped-query-layer, anthropic-claude-api
### report-pipeline-orchestrator (backend)

- **Tech:** TypeScript (@compass/pipeline), canonical JSON serializer, content-hashed report rows
- The only place the layers are wired together: resolve instant from the Clock port (real or simulated), ingest the window if needed, materialize the snapshot, run analysis, persist the structured report plus its canonical JSON hash, then narrate. Enforces the determinism gate by canonicalising JSON (sorted keys, stable array ordering) and excluding a documented allowlist of non-semantic fields (generated_at, run_id) from the hash, and serves the time-travel endpoint by re-running the identical path for any past instant.
- **Exposes:** generateReport(org, teamOrMerged, instant), reportHash(), time-travel generation
- **Depends on:** ingest-and-reconciliation, knowledge-model-and-snapshot, analysis-core, narration-and-grounding
### renderers (backend)

- **Tech:** TypeScript; react-markdown with an allowlist schema, MJML/react-email for HTML+text email, Slack Block Kit builders
- Three renderers over one structured report and one prose set, all emitting exactly six sections in fixed order with per-claim source links and no chart/sparkline/gauge: web (markdown-with-allowlist to React), email (full report inline, no click-to-view stub, RFC 8058 one-click unsubscribe, signed single-purpose feedback links), and Slack (Block Kit with interactive feedback actions). Shared sanitizer asserts ingested text renders as literal text in all three channels.
- **Exposes:** renderWeb(), renderEmail(), renderSlackBlocks()
- **Depends on:** analysis-core, narration-and-grounding
### worker (service)

- **Tech:** Node.js 22 + pg-boss (Postgres-backed queue and cron), same Docker image as the web app
- Background process for everything not request-scoped: scheduled per-user, per-timezone delivery with per-channel subscription choice (per-team, merged, or both), scheduled ingest windows, weekly digest generation, memo extraction jobs, share-link expiry, and retention purges. Jobs are queued in Postgres so there is no extra infrastructure, and every job takes its instant from the Clock port.
- **Exposes:** job queue: report.generate, report.deliver, ingest.window, memo.extract, digest.weekly, retention.purge
- **Depends on:** report-pipeline-orchestrator, renderers, delivery-channels, persistence-and-scoped-query-layer
### memo-intake (service)

- **Tech:** TypeScript + Claude structured extraction (tool-schema-constrained, Zod-validated, refusal on schema miss), deterministic candidate resolver over the identity store
- Manager Memos write path: accepts one-line prose from the email reply-to address, a Slack DM/thread reply, or the web form; an extraction pass converts it to a typed assertion in the closed five-kind schema {unavailable | descoped | reprioritized | external_blocker | context_note} with subject entity id, effective_from, effective_until|open_ended, source and raw_text. Anything outside those kinds is refused with 'I can't represent that yet'; below the subject-resolution confidence threshold the bot replies with 2–3 candidates from the identity/entity store. Stored assertions are snapshot inputs, so subsequent reports reflect and cite the memo and stop reflecting it at expiry.
- **Exposes:** extractMemo(rawText, org, actor), resolveSubject(), memo confirmation/refusal replies
- **Depends on:** knowledge-model-and-snapshot, anthropic-claude-api, delivery-channels
### delivery-channels (service)

- **Tech:** Resend (transactional + inbound), Slack Web API via @slack/web-api and @slack/bolt handlers mounted in app-server
- Outbound adapters: transactional email (with SPF/DKIM/DMARC on the sending domain, inbound reply-to parsing for memos, and delivery/bounce/complaint webhooks) and Slack chat.postMessage for DM or channel with in-place message updates for feedback actions. Both accept only rendered output; neither can reach the analysis layer.
- **Exposes:** sendEmail(), postSlackMessage(), updateSlackMessage()
- **Depends on:** renderers
### persistence-and-scoped-query-layer (backend)

- **Tech:** Drizzle ORM + drizzle-kit migrations on PostgreSQL 17; per-org data keys wrapped by a KMS/master key; grep-based CI check on token field names in logs
- The single data-access chokepoint: every query is constructed through a repository API that requires an organization_id (plus role check context), so no route, permalink, export or email link can read across orgs. Also owns migrations, append-only history tables, Correction tables, audit log, and envelope-encrypted credential columns for future live connectors.
- **Exposes:** scoped repositories, migration runner, audit writer
- **Depends on:** postgres
### postgres (database)

- **Tech:** PostgreSQL 17 (docker compose locally; managed Postgres in production)
- Single relational store for the knowledge model, append-only status-transition history, Corrections, reports and their canonical hashes, memos, feedback, share links, audit log, and the pg-boss job queue. Relational because the entire product is append-only history plus effective-dated relationships plus strict tenant scoping.
- **Exposes:** SQL/5432
### clock-port (infrastructure)

- **Tech:** TypeScript (@compass/clock) + custom ESLint no-restricted-globals/no-restricted-syntax rule
- The only source of time in the pipeline: a Clock interface with SystemClock (edges only — HTTP handlers, worker triggers) and FixedClock/SimulatedClock (tests, golden fixtures, the time-travel control). An ESLint rule fails the build if new Date(), Date.now() or an equivalent appears under the ingest, knowledge-model, analysis or report packages.
- **Exposes:** Clock.now(), FixedClock, SimulatedClock
### quality-gates (infrastructure)

- **Tech:** Vitest + Playwright + dependency-cruiser + ESLint + GitHub Actions (SCA, secret scan, base-image scan)
- Build-time enforcement of the product's hard constraints: dependency-cruiser architecture test forbidding I/O or time imports inside analysis, the clock lint rule, the determinism gate (in-process and cross-process double generation diffed on canonical JSON minus the allowlist), the prose grounding test with adversarial cases, the no-chart render assertion, the no-individual-ranking assertion, the two-org isolation suite, golden fixtures at fixtures/reports/<team>/<date>.json for 10+ consecutive simulated days per team plus the merged report with test:golden and golden:update, and a CI smoke test booting a clean container and fetching / under 60 seconds.
- **Exposes:** npm run test:golden, npm run golden:update, npm run test:determinism, npm run test:arch, CI cold-start smoke test
- **Depends on:** report-pipeline-orchestrator, seed-dataset, quality-gates

## Data models

- Organization
- User
- Session
- Membership (role: owner | manager | member | viewer)
- AuditLogEntry
- Company
- Objective
- ObjectiveLink
- Team
- TeamMembership
- WorkingCalendar
- Project
- Repository
- Developer
- IdentityLink
- UnmatchedIdentity
- Absence
- Feature
- Ticket
- TicketStatusTransition
- Sprint
- SprintScopeChange
- PullRequest
- Review
- Commit
- BranchRef
- ReleaseTag
- Blocker
- Risk
- Recommendation
- Win
- Correction
- CompletionLadderResult
- CalibrationVerdict
- ManagerMemo
- Report
- ReportSection
- ReportItem
- Feedback
- ShareLink
- ShareLinkAccess
- Subscription (delivery schedule/timezone/channel)
- DeliveryLog
- IngestRun
- SourceConfig
- NarrationTrace

## API design

REST/JSON over Next.js route handlers, typed end-to-end with Zod schemas shared between server and client; every handler resolves (organization_id, role) first and calls only scoped repositories. Reports: GET /api/teams/:teamId/report?at=<ISO instant> and GET /api/orgs/:orgId/report/merged?at=<instant> (both regenerate through the real pipeline for that instant — this is the time-travel control), GET /api/reports/:id, GET /api/reports?team=&from=&to= (archive), POST /api/reports/:id/regenerate (rate-limited 5/hour/org), GET /api/reports/:id/evidence/:itemId (alignment link or matched text). Feedback: POST /api/items/:stableItemId/feedback {action: dismiss_risk | reject_recommendation | accept_recommendation | flag_alignment_wrong | blocker_resolved | snooze, reason?, days?} — keyed to the entity-derived stable ID, reachable identically from web, from signed single-purpose email links (GET+POST /f/:signedToken, one item, one action, 30-day expiry, single use, never a session), and from Slack Block Kit actions (signature verified, Slack user mapped to a Compass identity with permission on that report). Memos: POST /api/memos {raw_text, source} → 201 typed assertion, 409 with 2–3 candidates when subject resolution is below threshold, 422 {refusal: "I can't represent that yet"} when outside the five kinds; same code path serves POST /api/email/inbound and Slack DM/thread events. Config CRUD: /api/teams, /api/projects, /api/repositories, /api/objectives (effective-dated), /api/developers, /api/identity-links (merge/un-merge), /api/absences, /api/subscriptions. Sharing: POST /api/reports/:id/share {expiry: 7|30|90|never, audience: org|anyone} → 128-bit token, DELETE to revoke, GET /s/:token public read-only render with access logging. Auth: POST /api/auth/signup|login|logout|magic-link|reset, session cookie rotated on privilege change. Ops: GET /api/freshness (per-source ingested-at, coverage, degradation), POST /api/ingest/run. Structured reports are the versioned contract (report_schema_version on every row) and renderers/consumers read only that object.

## Effective dating and the freeze rule

The goal hierarchy — Company → Objective → Sprint goal, plus the links from work to the goal it
serves — is **effective-dated**, and a report resolves it *as it stood at the report's own instant*.

**A stated revision is never rewritten.** Editing a goal appends a new revision with a new
`effective_from`; archiving one appends a revision that closes it. The rows a past report resolved
against are still there afterwards, unchanged, which is what makes an archived report readable six
weeks later as the document a manager actually read rather than as today's beliefs projected
backwards.

The rule has two halves, and which is which is the thing to be precise about:

- **Frozen: the revision that was effective at that instant.** `goalHierarchyAt(nodes, revisions,
  instant)` selects the revision whose effective window contains the instant, so re-running a past
  report resolves the same chain it resolved the first time. A manager who renamed an objective last
  Thursday has not changed what Tuesday's report said about it.
- **Re-evaluated: the alignment verdict.** The *matching* — which commits serve which goal, and at
  what confidence — is recomputed from the snapshot every run, because that is analysis rather than
  record. So a manager's edit to the hierarchy takes effect on the next report without rewriting any
  earlier one.

An observed sync never supersedes a declared revision: `syncGoalHierarchy` projects what the
connector saw, and a manager's own edit outranks it, because the edit is the more recent statement of
intent by a human about their own organization.

When new data contradicts a belief Compass has already stated, the contradiction is recorded as a
**Correction** row rather than by editing the belief. `corrections` is append-only — the scoped-query
layer refuses an update or a delete on it — so "reported blocked yesterday, actually merged" is a
fact the product can state, with the prior belief quoted verbatim beside the new one.

## Key decisions

- One language (TypeScript) across web, worker, analysis and fixtures: a solo/small team cannot afford two toolchains, and the purity/determinism gates (dependency-cruiser, custom ESLint clock rule, shared Zod schemas) are cheapest to enforce inside one type system and one CI.
- Layers are pnpm workspace packages, not folders: @compass/analysis declares zero dependencies in its own package.json, so 'analysis imports I/O or time' becomes a build error rather than a code-review habit. dependency-cruiser encodes the allowed edges connectors → ingest → knowledge-model → analysis → renderers.
- The ConnectorPort is time-windowed and returns normalised events with a shared conformance test suite that both the seed provider and future GitHub/Jira providers must pass — this is what makes 'no code path knows whether data is seeded' a mechanically checked property instead of an aspiration.
- PostgreSQL rather than SQLite even at MVP scale: the product is fundamentally append-only history plus effective-dated relationships plus multi-tenant scoping, and it needs row-level constraints, partial indexes, JSONB payloads and a job queue. Switching later would touch every layer; starting on Postgres costs one docker compose service.
- pg-boss on the same Postgres instead of Redis/BullMQ or a hosted scheduler: scheduled per-timezone delivery, ingest windows and memo extraction are low-volume, and keeping the queue in the database preserves the one-command cold start and gives transactional enqueue-with-write.
- Drizzle ORM over a heavier ORM: the schema is history-table-shaped and the scoped-query layer must control every query, so explicit SQL-shaped queries with generated types fit better than lazy relations that could bypass organization_id or produce nondeterministic ordering.
- Semantic alignment matching is deterministic local text similarity (normalised token/TF-IDF cosine with a documented threshold), not an LLM or a hosted embedding call — determinism is a hard requirement and a model-version bump must not change an alignment verdict. The LLM's only jobs are prose narration and memo extraction, neither of which feeds a decision.
- Analysis is a pure function of (materialized snapshot, instant, config), and the snapshot is fully materialized before the call — no lazy loading — so determinism only requires canonical ordering at snapshot boundaries and a canonical JSON serializer at the hash boundary.
- All money-like and ratio math uses integers/scaled decimals with one documented rounding helper; no floating-point accumulation, so byte-identical JSON survives across Node versions and machines.
- Narration fails closed by construction: the deterministic template renderer is the primary renderer during cold start and whenever ANTHROPIC_API_KEY is absent or grounding fails after bounded retries, and the fallback is recorded on the report row. This is also what keeps the 60-second no-configuration cold start achievable without a network call.
- Reports are persisted with a canonical content hash computed over the structured JSON minus a documented non-semantic allowlist (generated_at, run_id) — the determinism gate, change-awareness diffing and golden fixtures all read the same hash/serializer, so there is one definition of 'the same report'.
- Stable item IDs are derived from the underlying entity (e.g. hash of org + entity kind + entity natural key + finding kind), never from the report, so feedback, dismissals and the time-travel demo (risk → projected slip → recommendation) all attach to one continuous item across days.
- Manager Memo extraction is constrained by a tool/JSON schema of exactly five kinds and validated with Zod; a schema miss is an explicit refusal path, not a retry-until-something-fits loop — the closed schema is enforced in code, not in the prompt.
- The Completion Ladder computes R3 from stored branch topology (merge commit reachability from the default/release ref) rather than PR merge state, so branch refs and release tags are ingested as first-class rows; R5 has no detector and renders as 'no deploy signal available' rather than being inferred.
- No-individual-ranking is a code-level absence: there is no per-developer aggregate model, no commit-count or LOC field on the developer entity, and workload distribution returns team-level buckets with named actionable objects only. A test greps the report schema and renderers for ranking-shaped fields.
- Web UI is server-rendered React with markdown-with-allowlist and no charting dependency at all, which makes the prose-first/no-chart constraint a dependency fact plus a render assertion rather than a design guideline.
- One Docker image run as two processes (web, worker) and one docker compose file used identically by developers and CI: the cold-start smoke test exercises the same artifact that ships.

## Assumptions

- Scale for the MVP and the year after it: tens of organizations, each with 1–3 teams, 5–8 engineers per team, tens of repos and a few thousand tickets — a single Postgres instance and one small app instance are sufficient, and no load-testing infrastructure is in scope.
- Team is 1–2 developers; the design deliberately excludes microservices, Kubernetes, a separate API gateway, a message broker and a separate analytics store.
- No GitHub/Jira/Slack credentials exist at build time, so the seed connector is the runtime substrate for the whole MVP and every path — including rate-limited and disconnected degradation — is exercisable against fixtures.
- BOOTSTRAP / FIRST ACCOUNT: the app has no login wall on '/' — a clean checkout seeds a demo organization plus a demo owner user, and '/' renders that org's latest report anonymously in read-only mode. Real accounts come from two explicit bootstrap paths: (a) `npm run seed` creates the demo org and prints the demo owner's email and a one-time magic-link URL to stdout; (b) `npm run bootstrap:owner -- --email=<x> --org=<name>` creates the first real organization and its owner, and the first signup on an empty deployment is promoted to owner of a new org. There is no state in which an authenticated surface exists with no way to reach its first owner.
- Anonymous access to '/' is limited to the seeded demo organization and is a read-only render — it is not a tenancy hole: the scoped-query layer still requires an organization_id, and the demo org id is supplied by an explicit demo-mode resolver.
- MANAGED POSTGRES / POOLER: the runtime connection goes through a transaction-mode connection pooler, but migrations run over a separate DIRECT session connection (DATABASE_URL_DIRECT) because role/session DDL (CREATE ROLE, GRANT, SET ROLE), advisory locks and some pg-boss setup cannot run through the pooler. Migrations and the pg-boss maintenance connection are configured to use the direct URL; application queries use the pooled URL and avoid session-scoped state (no prepared-statement caching, no SET LOCAL ROLE).
- Tenant isolation is enforced in application code through the scoped-query layer rather than Postgres RLS, because the connection pooler makes per-request session roles unreliable; the two-org leakage suite is therefore the primary guarantee and is treated as a release blocker.
- The daily report generation for one team over the seeded dataset completes in well under a second in the pure layer, so on-demand generation for arbitrary instants (the time-travel control) is acceptable without pre-computation or caching beyond the persisted report rows.
- Report windows are computed in the team's WorkingCalendar timezone from the injected instant; 'yesterday' means the team's previous working day, not a UTC day boundary.
- The Anthropic API is optional at runtime: absent or failing, the product still renders complete, correct, six-section reports via the template renderer, and memo intake degrades to an explicit refusal asking the manager to use the structured web form.
- A pinned Claude model id plus pinned prompt version is recorded on every NarrationTrace and MemoExtraction row; narration output is never compared for equality in tests, only validated for grounding, so a model change cannot break the determinism gate.
- Slack ingestion is opt-in per named channel and never workspace-wide; DMs and private channels are never ingested (the memo path reads only DMs addressed to the bot, which is inbound user input, not ingestion).
- Billing (Stripe), TOTP 2FA, SSO/SAML/SCIM, GitHub Enterprise/Jira Data Center base URLs, per-person self-serve 'what Compass says about me', retention purge scheduling and anonymisation are post-MVP but have their seams in this design (Subscription/plan on Organization, an auth-factor table, provider base_url on SourceConfig, Developer.pseudonym, RetentionPolicy on Organization) and require no re-layering.
- Golden fixtures are regenerated only through `npm run golden:update`, which produces a reviewable text diff; a golden change is expected to be read as a report diff during review.
- Secrets (Anthropic key, Resend key, Slack signing secret, session secret, KMS master key) come from environment variables in the hosted deployment and from a checked-in .env.example with non-secret defaults locally, so the cold start needs no secret at all.

## Risks

- Determinism leaks through incidental ordering: unordered SQL results, Object.keys iteration over maps built in insertion order, Set/Map serialisation, or locale-dependent string comparison. Mitigation: canonical ordering at every snapshot boundary, a single canonical JSON serializer, explicit locale-independent collation in sorts, and a cross-process determinism variant of the gate (not just in-process double-run).
- Migrations through the connection pooler: role/session DDL and advisory-lock-based migration runners fail or silently misbehave on a transaction-mode pooler. Mitigation: a separate direct/session DATABASE_URL_DIRECT for drizzle-kit and pg-boss maintenance, asserted at boot; documented as a deployment prerequisite.
- The 60-second cold-start budget is easy to lose to migrations plus seed load plus first ingest plus a narration round-trip. Mitigation: template renderer as the cold-start narrator, seed load as bulk COPY-style inserts, ingest scoped to the report window, and a CI smoke test that fails on the budget rather than a manual check.
- The grounding validator is the single point of trust for 'the LLM invented nothing', and naive extraction over-matches (version numbers, ordinals) or under-matches (names in possessive form, dates written in prose). Mitigation: an adversarial fixture set including planted fabrications, normalisation rules documented alongside the extractor, and fail-closed to the template renderer rather than loosening the extractor.
- Three-tier alignment resolution can drift into accusatory output if thresholds are mis-set; an OFF-GOAL verdict on work the PM asked for is the reputational failure mode of the whole product. Mitigation: OFF-GOAL only at high confidence with confident attribution outside current objectives, an 'unattributed' bucket phrased as a question, one-click evidence, and Manager Memo/feedback suppression recorded as a correction signal.
- Idempotent ingest depends on genuinely stable natural keys; if a provider's identifiers or the identity roster change shape, re-ingest could duplicate entities or emit spurious Corrections that show up as noisy report churn. Mitigation: natural keys documented per entity, a re-ingest no-op test on every seeded window, and Correction writes gated on semantic change rather than row inequality.
- Memo extraction is an LLM boundary on the write path into the org model; a mis-extracted subject or effective window silently changes report content. Mitigation: closed five-kind schema, subject-resolution threshold with 2–3 candidate reply, an explicit confirmation echo of the typed assertion back to the manager, memos always cited with a link in the report, and a full audit record.
- Change-awareness and dismissal rules interact subtly: a dismissed risk must resurface only on material worsening and must say why. A weak 'material worsening' definition produces either a permanently silenced real risk or the notification-noise failure that kills daily bots. Mitigation: worsening defined as a documented monotonic evidence delta in the pure layer, unit-tested at the boundary, and the resurface reason is a required field.
- Multi-tenant isolation enforced in application code can be bypassed by one direct Drizzle call outside the scoped layer. Mitigation: a lint rule banning direct db import outside the persistence package, and the two-org suite covering every route, permalink, export and email link as a release gate.
- Prompt injection from ingested text (a ticket title containing instructions or an email-header payload) reaching narration or a renderer. Mitigation: untrusted-data delimiting with an explicit data-not-instructions instruction, no tool access for the narrator, markdown-with-allowlist rendering in all three channels, and a test asserting a script-tag ticket title renders as literal text in web, email and Slack.
- Per-user, per-timezone scheduled delivery over DST boundaries can double-send or skip a day; the injected Clock makes this testable but does not solve it. Mitigation: schedules stored as local time plus IANA zone, delivery idempotency keyed on (subscription, local report date), and DST-boundary fixtures.
- Golden fixtures across 10+ days per team plus the merged report can become a wall of churn that reviewers rubber-stamp, defeating their purpose. Mitigation: fixtures pretty-printed with stable key order so diffs are line-readable, and golden:update required to be a separate commit from the logic change.
- Calibration statistics reported on small samples (a 1–3 team org has few tickets per sprint) risk stating a confident verdict from n=6. Mitigation: every statistic reported with n and spread, never a bare correlation, and an insufficient_history verdict that takes precedence and is wired into projection confidence.
