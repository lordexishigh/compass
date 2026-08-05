# Compass

[![nous score](https://img.shields.io/badge/nous%20score-55%2F100-red)](docs/REPORT.md) <!-- nous-score-badge -->

> Compass is an AI Engineering Manager that maintains a stateful knowledge model of an engineering org and delivers one prose daily report — Yesterday, Progress, Blockers, Risks, Recommendations, Wins — that tells a manager of one to three teams what happened, what matters, what to do next, and which work does not serve the current objective.

Engineering managers running one to three teams spend their morning reconstructing reality by hand: scanning the Jira board, chasing stale PRs, guessing whether the sprint will land, and noticing too late that a developer spent three days on work nobody asked for. The existing category (LinearB, Swarmia, Jellyfish, Pluralsight Flow) answers this with dashboards — cycle time is 2.1 days, here is your DORA panel — leaving the manager to do the reasoning, which is why the standard outcome is dashboard fatigue: opened during the trial, never again. Standup bots (Geekbot) only echo what humans typed, with no ground truth from Git or Jira. Meanwhile every product in the category is pull-only and read-only: the manager cannot tell it that Priya is interviewing all week or that the PM descoped an epic on Friday, so it confidently asserts things the manager knows are false and there is no way to correct it once and have it stick. And none of them audit whether the team's own tracker data can support the forecasts being drawn from it, so a velocity projection built on four sprints of meaningless story points is presented with the same authority as a good one. Compass replaces measurement with decisions: a deterministic analysis core computes everything arguable, a stateful org memory lets it say 'still blocked on the same dependency, day 6', a goal chain flags off-objective work with evidence, and the manager can correct it in one click or one sentence.

## Tech stack

- **Language:** TypeScript
- **Backend:** Node.js 22 / TypeScript — Next.js 15 App Router route handlers for the HTTP surface plus a pg-boss worker process, over a pnpm workspace monorepo of layer-scoped packages (connector-port, ingest, knowledge-model, analysis, pipeline, renderers, clock)
- **Frontend:** React 19 / Next.js 15 (Server Components) with TypeScript and Tailwind CSS, prose-only (no charting dependency)
- **Database:** PostgreSQL 17 with Drizzle ORM (append-only history tables, Correction records, effective-dated rows, pg-boss queue in the same database)
- **Deployment:** Docker + docker compose as the canonical one-command cold start and CI smoke target; Fly.io (or Railway) for the hosted deployment — one image run as two processes (web, worker) plus managed Postgres
- **External services:** Anthropic Claude API (report narration and Manager Memo extraction only), Resend (transactional email send + inbound reply-to parsing for memos, SPF/DKIM/DMARC, RFC 8058 one-click unsubscribe), Slack API (app install, Web API for DM/channel delivery, Events API + Block Kit interactivity for memos and one-click feedback), Sentry (error tracking, PII scrubbing on), GitHub App + OAuth read-only (post-MVP live connector, designed against the connector port now), Jira Cloud OAuth 3LO (post-MVP live connector, designed against the connector port now), Stripe (post-MVP billing/subscription lifecycle; adapter boundary only in the MVP)

## Core features

- Connector interface (time-windowed query port) with a seeded provider implementing it fully; the pipeline cannot detect whether data came from a seed or a live API, so real GitHub/Jira/Slack connectors drop in as a configuration change with zero changes to the knowledge model, analysis or report generation.
- Checked-in, declarative, human-readable seed dataset with a documented manifest: 3+ projects, 12 developers each holding multiple git emails plus a Jira accountId plus a Slack userId, 4 completed sprints plus 1 in-flight sprint, and planted pathologies named by ID in the manifest — one off-goal work stream, one review bottleneck on a single named reviewer, one release slipping across a multi-day window, one ticket reported blocked that was actually merged, and deliberately messy traceability (clean structural chains, branch-name-only hints, semantic-only matches, and commits with nothing at all).
- Stateful, versioned knowledge model as first-class persisted rows — Company, Objective, Project, Team, Developer, IdentityLink, Feature, Ticket, Sprint, Blocker, Risk, Recommendation — each with first_seen_at, last_seen_at and append-only status-transition history, so the report can state elapsed facts directly ('still blocked on the same dependency, day 6', 'this ticket has been resequenced twice').
- Incremental, idempotent ingest with reconciliation: re-ingesting the same window changes nothing, and when new data contradicts a stored belief a non-destructive Correction record is written and surfaced ('reported blocked yesterday; actually merged at 18:40 — correction recorded'). History is never silently rewritten.
- Injected clock: 'now' is a Clock port parameter threaded through ingest, knowledge model, sprint math and report scoping. A lint rule or test fails the build if new Date()/Date.now()/datetime.now() appears anywhere in those packages.
- Pure, unit-tested deterministic analysis layer with no HTTP, database, filesystem, clock or randomness: it takes a materialized snapshot plus an instant and returns a structured report object. An architecture test fails the build if an analysis module imports an I/O or time module.
- Deterministic analysis content: sprint completion math reconcilable line-by-line against the Jira board (committed scope, completed vs remaining, mid-sprint scope added, completion %), velocity over trailing sprints, blocker detection wired to concrete signals (Jira blocked status/flag, status dwell past threshold, PR with no reviewer, changes-requested with no follow-up), review-queue aggregation with named PRs/reviewers/ages, workload distribution, risk detection with severity and trend, wins detection with documented selection criteria, Kanban/no-sprint progress semantics, and a confidence-qualified projected completion date with its reasoning stated.
- Determinism gate: generating a report twice for the same (org, team, instant) produces byte-identical structured JSON excluding a documented allowlist of non-semantic fields (generation timestamp, run id). Same blockers, same alignment verdicts, same projected date, same confidence band — always.
- Goal hierarchy store and CRUD with effective dating: company objective → quarter → sprint goal → epic → ticket, plus ObjectiveLink records carrying source (configured | inferred | semantic).
- Three-tier alignment resolution — structural links first, then inferred links from branch names and commit messages, then semantic text matching with a confidence score — with an explicit confidence threshold, an 'unattributed' bucket rendered as a question ('3 commits could not be tied to a sprint objective') never an accusation, an OFF-GOAL verdict only at high confidence and confident attribution outside current objectives, and one-click evidence showing exactly which link or which text matched.
- LLM narration of the six fixed sections that renders the structured report and nothing else: it may choose emphasis, intra-section ordering and wording, and may not invent a blocker, risk, number, date, name or recommendation. It receives only the structured section payload, never raw events.
- Prose grounding validator: an automated extractor pulls every number, percentage, date, PR number, commit SHA, Jira key and person name from generated prose and asserts each exists in that section's structured payload; the build fails on any untraceable token. Narration fails closed — after bounded retries the report renders through a deterministic template renderer and the fallback is recorded on the report row.
- Recommendation engine producing actor + object + one-step actions ('assign Priya as second reviewer on PR #883 — open 4 days, Marcus is sole reviewer with 6 open reviews'; 'split DEV-501, 13 points, 9 days in progress').
- Per-team daily reports as the unit of record (scoped to that team's board and cadence) plus a genuine merged manager-level cross-team report that ranks what changes the manager's actions today, obeys a hard prose budget, and links down into per-team detail.
- Weekly digest: velocity trends, workload distribution, review bottlenecks, technical debt growth, upcoming risks, suggested priorities.
- Change-awareness: nothing is repeated unchanged day over day; recurring items are reported as the same item with its history and what changed.
- DIFFERENTIATOR — Manager Memos (write access to the org model): one-line prose in via email reply-to address, Slack DM/thread reply, or web form; an extraction pass converts it to a typed assertion with a closed five-kind schema {unavailable | descoped | reprioritized | external_blocker | context_note} carrying subject entity id, effective_from, effective_until|open_ended, source, raw_text; anything outside those kinds is refused with a plain 'I can't represent that yet' rather than silently swallowed; subject resolution runs against the identity/entity store and below threshold the bot replies with 2–3 candidates; the next and subsequent reports reflect the memo, cite it with a link, and stop reflecting it when it expires.
- DIFFERENTIATOR — Process Calibration Audit: the pure layer computes a fixed statistic set over trailing sprints (point-to-elapsed-working-days correlation per ticket reported with n and spread and never as a bare r, estimate coverage %, carryover rate, status-dwell consistency, scope-churn rate, sub-task double-count risk, stale-status incidence), each mapping to a named verdict against a documented threshold (points_uninformative, estimates_sparse, scope_is_fiction, workflow_inconsistent, statuses_stale, insufficient_history); verdicts are inputs to the projection method and confidence, and the report states plainly when its own numbers cannot support the claim ('your points haven't tracked elapsed days for four sprints, so this date is a cycle-time guess').
- DIFFERENTIATOR — Completion Ladder: every Yesterday item is suffixed with the furthest threshold it actually crossed, via deterministic detectors — R1 ticket in a done-category status, R2 PR merged, R3 merge commit reachable from default/release branch by branch topology, R4 a git tag or GitHub release contains the merge commit, R5 deploy-confirmed which is explicitly not inferable and renders as 'no deploy signal available'; ladder mismatches (Done with no PR, merged-not-released ahead of a release) become hygiene findings and risks naming the oldest item.
- Full feedback loop with stable item IDs derived from the underlying entity, not the report: dismiss a risk with optional reason, mark an off-goal flag wrong, accept or reject a recommendation, mark a blocker already resolved, snooze N days. Feedback is stored against the entity and changes future reports — a dismissed risk stays dismissed unless its evidence materially worsens and says why it returned; a rejected recommendation is not re-suggested; a corrected alignment flag suppresses the flag and is recorded as a correction signal against objective matching. Feedback is one click from the report in the web view, from email via signed single-purpose links, and from Slack via Block Kit actions.
- Manager-facing web view: current report, permalinked archive of every past report, per-claim source links to commit SHA / PR number / Jira key, evidence panel for alignment verdicts, and a data-freshness/coverage indicator that states what was ingested and when and degrades honestly when a source is disconnected or rate-limited.
- Simulated-clock time-travel control on the report view: step 'now' day by day or jump to any date in the seeded history, regenerating through the real pipeline for that instant, so a reviewer watches the Release 2 slip develop as the same stable item ID appears first as a risk, then as a projected slip, then as a recommendation.
- Scheduled delivery to email and Slack (DM or channel) with the full report inline and no click-to-view stub, on a per-user schedule and timezone, with per-channel subscription choice of per-team, merged, or both — defaulting a single-team manager to the team report and a multi-team manager to the merged report.
- Configuration: team membership, tracked repos and projects, goal hierarchy CRUD, and an identity roster that maps multiple git emails plus a Jira accountId plus a Slack userId to one person, with an unmatched-identity queue supporting merge and un-merge, and marking people out/inactive so they don't read as stalled.
- Auth and tenancy: email+password with Argon2id and email magic link, password reset, sessions as httpOnly+Secure+SameSite=Lax cookies with rotation on privilege change, an organization_id on every row enforced through a single scoped-query layer, and a four-role matrix (owner, manager, member, viewer) expressed as one table in code and checked server-side on every route.
- Shared report permalinks with unguessable 128-bit tokens, revocable from the report page, expiry options (7/30/90 days/never), access logging, and org-members-only by default.
- No-individual-ranking stance enforced in code: no per-developer leaderboard, no commit-count or LOC comparison across people, no top/bottom performer surface anywhere; names appear only attached to a specific, actionable, verifiable object.
- Prompt-injection containment and output sanitization: ingested text is passed as clearly delimited untrusted data to a narration model with no tool access, and rendered prose is emitted as text/markdown-with-allowlist — never raw HTML — in web, email and Slack.
- Zero-configuration cold start: a clean checkout, docker compose up (or npm run seed && npm run dev), then opening / renders a fully generated daily report for the seeded org in under 60 seconds with no login wall, no connector wizard and no empty state.
- Golden-fixture regression suite: fixtures/reports/<team>/<date>.json for at least 10 consecutive simulated days per team plus the merged report, with test:golden diffing live output and golden:update regenerating a reviewable diff, so any analysis change surfaces as a report diff.

The complete product this is being built toward — every feature tier, the quality bar, the launch checklist and the definition of done — is in [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md).

## Getting started

Either of these ends with a fully generated six-section report at
[`http://localhost:3000`](http://localhost:3000). There is no login wall on it, no connector
wizard and no empty state.

```bash
docker compose up            # the canonical cold start: database, seed, web, worker
```

```bash
pnpm install                 # or, without Docker
pnpm run seed                # generate the dataset, load it, write the first report
pnpm run dev
```

**`pnpm run seed` is the one seed command.** It generates the declared dataset, applies
migrations, provisions the roster, creates the first owner and runs the real pipeline to leave
today's report in the database. **Expect it to finish in under 60 seconds** on a laptop — the
generated report is the substrate for everything else, so the first page load after it is a read
rather than a generation.

It is **idempotent**. Running it against an already-seeded database appends no rows: applied
migrations are recorded, the organization and roster are found rather than recreated, an
unchanged roster produces no new entity versions, a password an operator has changed is never
reset, and the day's report is found rather than written twice. Add `--force` to regenerate
today's report into the same row. The worker also performs this seed **automatically on first
boot** if it finds a database with no report in it, under a Postgres advisory lock so two
containers starting together cannot both do it.

### Signing in

The seed provisions one owner seat. **Its password is not published in this repository**, and
there is no default for it: a working owner password committed here would be no password at all
on every deployment that never overrode it. What the seat gets instead depends on whether the
deployment configured anything.

| | |
|---|---|
| Email | `COMPASS_OWNER_EMAIL`, or `owner@compass.demo` when that is unset |
| Password | `COMPASS_OWNER_PASSWORD`, or 18 random bytes minted by the boot that creates the seat |
| Login | `POST /login` with `{"email": "...", "password": "..."}` |

A **generated** password is readable in exactly two places, because the database keeps only an
Argon2id digest of it and nothing that can be read back:

- it is **printed once**, in the log of the seed or cold start that created the seat; and
- it is written to **`.nous/demo_account.json`** as `{email, password, login_path}` at mode
  `0600` — gitignored and excluded from the Docker image — which is the copy an automated
  harness reads, so a script never has to parse a page to sign in.

That digest is also why a *later* boot of an unconfigured deployment leaves the file alone rather
than rewriting it: this process cannot learn the password the earlier one minted, and a file
silently holding the wrong password is worse than one holding a real one.

[`/account`](http://localhost:3000/account) states the owner address and whether a password is
set. It never shows the value, because the web app genuinely does not have it — the worker mints
it, hashes it and prints it.

Set `COMPASS_OWNER_EMAIL` and `COMPASS_OWNER_PASSWORD` before this deployment holds real data.
Set **both or neither**: the two used to be filled in independently, so setting the email and
forgetting the password gave you an owner seat at your real address protected by a password
published in this file. The boot script now refuses that combination and names the variable you
are missing, and `/api/health` reports it ahead of every other check.

### A new organization: from nothing to a first report

For an org that is *not* the seeded demonstration tenant, [`/start`](http://localhost:3000/start)
is the whole path. Roughly nine minutes of typing, and no step needs anybody from Compass:

1. **Choose where the facts come from** (~1 min) — read the seeded dataset, or name your own
   repositories and projects. Both go through the same connector port, so nothing downstream can
   tell which answered.
2. **Declare the team the report is about** (~3 min) — name, cadence, timezone and tracker
   project. Compass will not infer a team from who commits together; that would put somebody
   else's merge in this team's Yesterday.
3. **Enter the objective the work is measured against** (~3 min) — a company objective and the
   current sprint goal, on one screen. The quarter between them is filled in for you, because
   alignment resolves through parents and a chain with a hole in it produces unattributed
   verdicts rather than aligned ones.
4. **Match the people to their identifiers** (~2 min) — one person, several git addresses, one
   tracker account, one chat handle. Unclaimed identifiers wait in a queue instead of being
   guessed at.

Until a team and at least one person exist, `/` says which of those four things are missing
rather than rendering six empty headings — an empty report about an unconfigured organization
would imply a quiet team where there is none. A team that genuinely shipped nothing yesterday
still gets all six sections, with the absences stated in prose.

### What is in the seed, and where it is written down

[`seed/MANIFEST.md`](seed/MANIFEST.md) is the dataset's inventory: volumes against the required
minimums, the objective chain, every developer's fragmented identifiers, the addresses that must
land in the unmatched queue, the Kanban team with no sprints, the traceability mix, and every
planted pathology with the entity identifiers it names.

**It is generated, never hand-written**, from the five hand-edited fixtures under
[`seed/fixtures/`](seed/fixtures/) — `organization.json`, `people.json`, `projects.json`,
`narrative.json` and `pathologies.json`. Everything under `seed/generated/` and the manifest itself
are output. Run `pnpm seed:generate` after editing a fixture.

A hand-written manifest drifts from the data the first time a volume changes and then quietly lies,
which is worse than having none: a reviewer checking whether a detector fires reads the manifest and
concludes the pathology is missing when the numbers are simply stale. So two tests in
[`packages/seed-connector/tests/manifest.test.ts`](packages/seed-connector/tests/manifest.test.ts)
hold it honest — one recomputes every count from the generated dataset and compares it against the
numbers printed in the file, and one pulls every identifier out of the prose and resolves it against
a real row. A pathology that names `PLAT-742` fails the build if no such issue exists.

The generator is deterministic: no clock read, no `Math.random`, no locale-sensitive comparison
anywhere in the expansion. `pnpm seed:generate` followed by `git diff --exit-code` is therefore a
determinism check on the dataset itself, and the suite runs the equivalent in memory.

The pathologies are the point of the whole dataset. Each is planted deliberately so that a detector
has something true to find — an off-goal work stream, every platform review queued behind one
person, a release slipping across a multi-day window, a ticket reported blocked that was merged the
same evening, story points that stopped tracking elapsed days, work marked Done with nothing in
version control, merged work sitting ahead of the newest release tag, and a ticket that entered In
Progress and was never touched again. They are named in the manifest with their identifiers so a
reviewer can check a report against the thing it was supposed to notice, rather than against their
own reading of the data.

### The three guarantees, and where each is written down

| Guarantee | Documented in | Enforced by |
| --- | --- | --- |
| **Determinism** — the same `(org, team, instant)` produces byte-identical structured JSON, excluding the non-semantic allowlist: `generatedAt`, `narrationTraceId`, `runId`, declared once as `NON_SEMANTIC_REPORT_FIELDS` in `packages/analysis/src/determinism.ts` and re-exported rather than redeclared by the pipeline's canonical serializer | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | `packages/analysis/tests/determinism.test.ts` |
| **Prose grounding** — every number, date, PR number, commit SHA, tracker key and person name in narrated prose exists in that section's structured payload, or narration fails closed to the template renderer | [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | `tools/quality-gates/tests/grounding-corpus.test.ts` |
| **Budgets** — the render, regeneration, cold-start and word ceilings | [`docs/budgets.md`](docs/budgets.md) | `tools/perf-budget`, and the budget-table gate that diffs the prose against the constants |

The golden-fixture workflow is the fourth mechanism and the one a change to analysis will meet first:
`pnpm test:golden` diffs live output against the checked-in fixtures for ten consecutive simulated
days per team plus the merged report, and `pnpm golden:update` regenerates them as a reviewable text
diff. Fixtures are only ever rewritten through that command, so a report change is something a
reviewer reads rather than something that happens silently. The step-by-step review workflow for a
golden diff — read the failing path, regenerate, read `git diff -- fixtures/`, check the blast
radius, and commit the regeneration separately from the logic change — is in
[**Golden fixtures**](docs/DEVELOPMENT.md#golden-fixtures).

See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) for how to install dependencies, run, and verify the
project. Architecture is documented in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); the build plan
is in [`docs/PLAN.md`](docs/PLAN.md). What Compass commits to publicly — terms, the privacy policy,
the impact assessment, the Article 22 position and the subprocessor list — is at
[`/legal`](http://localhost:3000/legal), and the SBOM retrieval process is in
[`docs/SBOM.md`](docs/SBOM.md).

Every number Compass holds itself to — the 2000 ms report render, the 5000 ms time-travel
regeneration, the 60-second cold start, the word ceilings and the narration-fallback alert rate — is
stated once in [`docs/budgets.md`](docs/budgets.md), beside the test that owns it. That file quotes
the constants rather than restating them, so the prose cannot drift from the code.

---
_Generated by [nous](https://github.com/) — autonomous development pipeline._
