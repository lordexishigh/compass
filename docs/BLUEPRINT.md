# Product blueprint — AI engineering-management assistant / engineering intelligence & daily reporting for eng managers (GitHub + Jira + Slack)

_The complete definition of this product, researched before the build (live web research)._

## Vision

Compass is the one thing an engineering manager of one to three teams reads on their phone before standup, and it ends with them doing something: adding a second reviewer to PR #883, splitting DEV-501, resequencing a ticket out of this sprint, or telling their skip-level that Release 2 is now projected to land four days late with a named reason. It is a decision product, not a measurement product. The finished system has four layers and each is architecturally real. (1) A stateful, versioned knowledge model of the org: Company, Objective, Project, Team, Developer, Feature, Ticket, Sprint, Blocker, Risk and Recommendation persist as first-class rows with first_seen_at, last_seen_at, append-only status-transition history, and non-destructive Correction records when new data contradicts a stored belief. This is what lets Compass write the sentences that no summarizer can write: 'still blocked on the same dependency, day 6', 'this ticket has been resequenced twice', 'reported blocked yesterday, actually merged at 18:40 - correction recorded'. (2) A pure, unit-tested deterministic analysis core that decides everything a manager could argue with: sprint completion math reconcilable line-

## Positioning

For a manager of one to three teams: Compass is the only daily engineering report you can correct — tell it "Priya is interviewing all week" or "the PM descoped that epic" once and it stops being wrong — and the only one that audits your own Jira before it forecasts from it, saying "your points haven't tracked elapsed days for four sprints, so this date is a cycle-time guess" and "DEV-402 is merge

## Who it is for

- First-time visitor / evaluating reviewer — no account, no credentials, no data; opens the app cold and must see a real report inside 30 seconds
- Engineering manager, single team — the primary daily reader; owns one board, one sprint cadence, 5–8 engineers
- Engineering manager, two–three teams — reads the merged cross-team report and drills into per-team detail; teams run different cadences (two Scrum, one Kanban)
- Workspace owner / administrator — installs the GitHub/Jira/Slack apps, manages seats and billing, controls data retention, export and deletion
- Delegated co-manager / interim cover — a tech lead or peer manager temporarily receiving another manager's reports during leave
- Skip-level / director recipient — opens a shared permalink read-only, has no account and will not create one
- Engineer (IC) named in report objects — subject of the data; may see the team-shared report and may contest a flag against their work
- Returning manager after extended absence — two to five weeks away, needs catch-up rather than one day's report

## Journeys that must work

- **First-time visitor / evaluating reviewer — See a genuine, believable daily report with zero configuration, and confirm it was generated rather than mocked**
  1. Open the app root URL with no account and no credentials
  2. Land directly on 'Today' — a fully generated daily report for the seeded org, not a marketing page, not a sign-up wall, not an empty state
  3. Read the six fixed sections in order: Yesterday, Progress, Blockers, Risks, Recommendations, Wins
  4. Note the coverage banner at the top: 'Ingested GitHub, Jira, Slack through Tue 14:02 (simulated). 3 sources connected, 0 degraded.'
  5. Click any Jira key, PR number or commit SHA in the prose and see the underlying artifact detail panel open with title, author, status, timestamps
  6. Open the 'How this was generated' drawer and see the structured report object (JSON) that the prose was rendered from, with generation duration and the pipeline stages that ran
  7. Click 'Regenerate this report' and observe that the blockers, alignment verdicts, projected completion date and confidence band are byte-identical to the previous run
  8. Scroll to the Recommendations section and confirm each one names a person, an object and a single next step (e.g. 'Add Priya as second reviewer on PR #883')
  - Done when: Within 30 seconds of first load, with zero clicks of configuration, the reviewer is reading a report that contains named people, real ticket keys, a sprint completion percentage, at least one blocker, at least one off-goal flag and at least one recommendation — and re-running it produces an identical structured object.
- **First-time visitor / evaluating reviewer — Prove the memory thesis by advancing the simulated clock and watching a release slip develop across successive daily reports**
  1. From 'Today', open the 'Time Machine' control in the header showing the current simulated date and the sprint it falls in
  2. Click 'Advance one day'; the pipeline re-ingests the next window from the seed provider and regenerates the report
  3. Observe on day N that the payments release appears in Risks only: 'Release 2.4 has 34 of 55 points remaining with 4 days left — at current velocity this is at risk'
  4. Advance again; on day N+2 the Progress section changes to a projected completion date past the sprint end with a stated confidence band and stated reason
  5. Advance again; on day N+4 a Recommendation appears naming what to cut or resequence, and the Risks entry now reads 'flagged Tuesday, worse today — remaining points up 8 from scope added mid-sprint'
  6. Click the risk's title to open its item history timeline: first flagged, each day it recurred, each change in its evidence
  7. Use 'Jump to date' to skip back to the first day and confirm the earlier report is unchanged and still says what it said
  8. Advance across a sprint boundary and see the Progress section switch to the new sprint with carryover tickets explicitly listed
  - Done when: Successive reports reference their own prior statements ('I flagged this Tuesday'), the same risk carries one stable ID and a visible day count across all of them, and no report on an earlier date has been rewritten by a later run.
- **First-time visitor / evaluating reviewer — Diff two days' structured reports to see exactly what changed and verify nothing was fabricated**
  1. Open 'Archive' and select two report dates using the compare checkboxes
  2. Click 'Compare' to open a side-by-side structured diff of the two report objects
  3. See items grouped as Added / Removed / Changed / Unchanged, keyed by stable item ID rather than by position in the report
  4. Expand a 'Changed' risk and see field-level differences: severity, day count, evidence artifact list, confidence
  5. Toggle 'Prose view' to read both narratives side by side with every number in the prose highlighted and linked to its field in the structure
  6. Click any highlighted number and see it resolve to a structure field path (e.g. progress.projected_completion.date)
  7. Confirm the diff shows zero prose numbers with no structural source
  - Done when: Every numeric value, date, name and ticket key in both prose reports resolves to a field in the corresponding structured object; the diff makes the day-over-day delta readable in under a minute without reading either report in full.
- **First-time visitor / evaluating reviewer — Interrogate an alignment verdict to decide whether the goal-alignment feature can be trusted**
  1. In the report, find the off-goal callout: 'DEV-412 (refactoring the billing client) does not contribute to Sprint 14 objective "Ship guest checkout"'
  2. Click 'Why?' beside the verdict
  3. See the resolution path that produced it: structural link found (DEV-412 → epic BILL-9 → Q3 objective 'Reduce payment ops cost'), which is a real objective but not one in the current sprint
  4. See the classification rule stated plainly: 'High confidence, confidently attributable to an objective outside the current sprint → OFF-GOAL'
  5. Scroll to the 'Unattributed' line: '3 commits could not be tied to a sprint objective' — phrased as a question, with the three SHAs listed and each one's failed resolution attempt shown (no ticket key in message, branch name 'fix/stuff', semantic match 0.31 below threshold)
  6. Find a third example resolved by branch-name inference ('feature/DEV-388-guest-address') and see it marked as inferred, not structural
  7. Confirm no commit in the unattributed bucket is worded as a criticism of any developer anywhere in the prose
  - Done when: All three resolution paths (structural, inferred, semantic) plus the unattributed bucket are visibly exercised on the seeded data; every verdict shows its evidence in one click; and low-confidence items appear only as questions, never as verdicts.
- **First-time visitor / evaluating reviewer — Understand what a projected completion date is based on before believing it**
  1. In Progress, read: 'Projected completion Thu Aug 14 — low confidence'
  2. Click the confidence label
  3. See the inputs: committed points, completed points, points added mid-sprint, trailing three-sprint velocity, working days remaining, team members marked out
  4. See the stated reason for the low band: '40% of remaining points sit on DEV-501, which is unestimated'
  5. Click DEV-501 and confirm it opens the ticket with no story-point value and 9 days in progress
  6. Click 'Show the arithmetic' and see the formula, the substituted numbers and the result
  7. Re-run the report and confirm the same date and the same band
  - Done when: The projected date is reproducible, its arithmetic is inspectable in two clicks, and the confidence band has a named cause tied to a specific ticket rather than a generic hedge.
- **Engineering manager, single team — Create an account and get from sign-up to a real report on their own data**
  1. From the demo report, click 'Use this on my team'
  2. Sign up with work email + magic link, or Google/Microsoft SSO; no credit card
  3. Land in a new empty workspace that still shows the seeded demo report behind a clearly-labelled 'Demo data' banner and a 'Connect your tools' panel
  4. Click 'Connect GitHub', complete the GitHub App install, select the org, and pick repos individually or by pattern (not all-org by default)
  5. Click 'Connect Jira', authorise via Atlassian OAuth, and select one project and its board
  6. Click 'Connect Slack', install to the workspace, and choose DM delivery to self
  7. Watch the ingest progress panel: per source, window ingested, entity counts (tickets, PRs, commits, people)
  8. Review the auto-proposed team roster and confirm or correct the identity matches
  9. Click 'Generate my first report'; the demo banner is replaced by a real report on real data
  - Done when: Elapsed time from account creation to a real report on the manager's own data is under 10 minutes with no CSV upload, no YAML, no admin-only step and no implementation call; the demo data is gone from the workspace and is never mixed with real data in any report.
- **Engineering manager, single team — Map fragmented identities so one human is one person across GitHub, Jira and Slack**
  1. Open 'Team' → 'People'
  2. See auto-matched identities grouped by person with the match reason shown (same verified email, same display name, same Slack profile email)
  3. See an 'Unmatched identities' section listing a GitHub noreply address, a bot account and a second work email
  4. Drag or use 'Merge into' to attach the second email and the noreply handle to the correct person
  5. Mark the CI account as 'Bot — exclude from all reports and from workload counts'
  6. Set a person's status to 'Out' with a date range for their upcoming leave
  7. Click 'Recompute affected reports' and confirm the current report no longer lists that person's tickets as stalled and no longer counts the bot's commits
  - Done when: Every ingested identity is either attached to a person, marked as a bot, or explicitly listed as unattributed in the coverage panel; nobody appears twice in workload or review-load aggregation; people marked Out are excluded from stall detection for their date range.
- **Engineering manager, single team — Configure the goal hierarchy that alignment checks depend on, without a taxonomy project**
  1. Open 'Goals'
  2. See the hierarchy pre-populated from Jira where possible: sprint goals from the board's sprint goal field, epics as the level below, and a placeholder for company/quarter objectives
  3. Type two company objectives and three quarter objectives in a plain text form (title + one-line description each)
  4. Drag epics under quarter objectives; unassigned epics stay in an explicit 'Not mapped' tray rather than being silently guessed
  5. See a live coverage readout: '78% of open points map to an objective; 9 tickets and 4 epics are unmapped'
  6. Click 'Preview alignment' to see how the current sprint's work would be classified before committing the change
  7. Save; the next report's alignment section reflects the new hierarchy and a note records the hierarchy version used
  - Done when: Alignment output is produced with partial mapping (unmapped work lands in 'unattributed', never in 'off-goal'), the coverage percentage is stated in the report itself, and the manager reaches usable alignment output in one sitting without a mapping wizard or an onboarding call.

## Must have — the product is pointless without these

- **Seat management: invite, revoke, resend, role change** _(admin)_ — The workspace-owner persona is defined as managing seats, and multi-user access is impossible without an invite lifecycle.
  - Evidence it's done: `/settings/members` listing pending and active members with invite, resend, revoke, role change, and last-active; expired invites (14 days) cannot be redeemed; removing the last owner is blocked.
- **'Unattributed' bucket rendered as a question, never an accusation** _(alignment)_ — Low-confidence attribution phrased as a verdict against a named developer is the one mistake that ends adoption.
  - Evidence it's done: Seeded data includes commits with no ticket reference; the report reads '3 commits could not be tied to a sprint objective' with the SHAs listed and a 'tell us what these were for' action — and no developer is named as off-goal.
- **Explicit confidence threshold and 'unattributed' bucket** _(alignment)_ — One wrong off-goal flag against a developer destroys trust in the whole report.
  - Evidence it's done: OFF_GOAL is emitted only when confidence >= configured threshold AND the work resolves to a named non-current objective; everything else lands in `unattributed`, rendered as 'the question: 3 commits could not be tied to a sprint objective' with a list — never as an accusation. A test asserts no OFF_
- **Goal hierarchy store: company objective → quarter → sprint goal → epic → ticket** _(alignment)_ — Alignment checks have nothing to resolve against without a stored, editable chain.
  - Evidence it's done: `/settings/goals` renders the tree with each node's linked epics and ticket counts; deleting a link changes the next report's alignment verdicts.
- **Inferred alignment from branch names and commit messages** _(alignment)_ — Most real commits reference a ticket only in a branch name.
  - Evidence it's done: Verdict with `method: INFERRED` and `matched_text: "feature/DEV-412-billing-client"` highlighted; a unit test covers key-in-message, key-in-branch, key-in-PR-title and no-key cases.
- **One-click evidence for every alignment verdict** _(alignment)_ — A manager must be able to check a flag before repeating it to a person.
  - Evidence it's done: Every verdict in web/email/Slack links to a detail page showing the resolution method, the exact matched link or text, the objective compared against, the confidence, and the source artifact URL.
- **Semantic alignment matching with a confidence score** _(alignment)_ — The fallback path for work with no ticket reference at all.
  - Evidence it's done: Verdict with `method: SEMANTIC`, `confidence: 0.42`, the objective text and the commit text that were compared; the same input always yields the same score (embedding cache keyed by content hash, asserted by a determinism test).
- **Structural alignment resolution** _(alignment)_ — The highest-confidence path and the one a manager can check instantly.
  - Evidence it's done: Verdict objects with `method: STRUCTURAL` and a `path` array of node IDs; the UI renders the chain ticket → epic → sprint goal → company objective as clickable breadcrumbs.
- **Blocker detection wired to concrete signals** _(analysis)_ — Blockers are the section a manager acts on first; heuristics must be nameable and auditable.
  - Evidence it's done: Named rules for Jira blocked status/flag, ticket stalled in status past threshold, PR with no reviewer, PR with changes-requested and no follow-up commit, PR blocked on a failing required check; each blocker names the rule that fired and links the artifact.
- **Confidence-qualified projected completion date with stated reasoning** _(analysis)_ — A date without a confidence band and a reason is a guess a manager cannot defend upward.
  - Evidence it's done: Structured fields `projected_date`, `confidence_band`, `reasons[]`; prose reads 'Thu 14 Aug, low confidence — 40% of remaining points sit on one unestimated ticket (DEV-501)'; running twice yields the identical date and band.
- **Elapsed-fact generation in the structured report** _(analysis)_ — These are the highest-value sentences in the product and must be computed, not narrated.
  - Evidence it's done: Structured blocker objects carry `days_in_state`, `recurrence_count`, `trend`; a golden report fixture contains `"days_blocked": 6` and the prose says 'day 6', with the grounding test proving the number came from the structure.
- **Insufficient-history degradation** _(analysis)_ — A new team has fewer than two completed sprints, so velocity, projection, and trend outputs are undefined rather than merely uncertain.
  - Evidence it's done: Progress section renders 'not enough history to project (1 of 3 sprints needed)' instead of a number; a unit test asserts no projected date is emitted below the configured minimum sample.
- **Kanban / no-sprint progress semantics** _(analysis)_ — The two–three-team persona explicitly runs one Kanban team, and sprint completion %, story points, and sprint goals do not exist for it.
  - Evidence it's done: A Kanban team's Progress section renders flow metrics (WIP by column, cycle-time trend, aging items past P85) and alignment resolves against quarter goals; a golden fixture for the Kanban team exists alongside the Scrum ones.
- **Recommendation engine producing actor + object + one-step actions** _(analysis)_ — Recommendations without a name and an object are the generic-AI-slop failure the category is full of.
  - Evidence it's done: Every recommendation carries `actor`, `object`, `action_type`, `justification_facts[]`; a schema test rejects any recommendation lacking a named person or artifact; the golden report contains 'Add Priya as second reviewer on PR #883' and 'Split DEV-501 (13 pts, 9 days in progress)'.
- **Review-queue aggregation with named PRs and reviewers** _(analysis)_ — 'Review time is 2.1 days' is unactionable; 'PR #883, open 4 days, Marcus is the only reviewer with 6 open' is a decision.
  - Evidence it's done: Structured `review_queue` entries with PR number, title, author, reviewer, age, time-in-review; the report never states an aggregate review metric without at least one named PR beneath it.
- **Risk detection with severity and trend** _(analysis)_ — 'New', 'worse', 'unchanged', 'improving' is what makes a daily worth reading twice.
  - Evidence it's done: Risk objects carry `severity`, `trend`, `first_reported_at`, `previous_severity`; prose reads 'flagged Tuesday, now worse: the review queue on payments-api grew from 4 to 7'.
- **Sprint completion math reconcilable against the Jira board** _(analysis)_ — If the percentage cannot be reconciled the manager stops trusting everything else.
  - Evidence it's done: Progress section states completed/committed points and tickets with both counts; a documented reconciliation test compares against Jira's own sprint report numbers for the same sprint and asserts equality.
- **Velocity computation over trailing sprints** _(analysis)_ — The projection has no basis without it.
  - Evidence it's done: Pure function over completed sprints with a documented outlier policy; unit tests cover fewer-than-three sprints, a zero-velocity sprint and a partially completed current sprint.
- **Wins detection and selection criteria** _(analysis)_ — Wins is one of the six fixed sections, yet the blueprint specifies no detector, ranking, or threshold for it — so the section will silently render empty or filler.
  - Evidence it's done: A `wins` analyzer with documented rules (shipped ticket closing an epic, PR merged after long review, first green build after a red streak, goal-advancing completion) and a golden fixture day where 3 wins appear with evidence links, plus a day where 0 qualify and the section says so.
- **Deterministic report core: same inputs produce an identical structured report** _(architecture)_ — The user's hard requirement, and the precondition for regression-testable report quality.
  - Evidence it's done: CI job generates the report for a fixed `as_of` twice in separate processes and byte-compares the canonical JSON; iteration order, dict ordering, tie-breaks and float formatting are pinned; the job is a required merge check.
- **Injected clock: 'now' is a parameter everywhere in the pipeline** _(architecture)_ — Determinism, time travel and testability all collapse if any stage reads the system clock.
  - Evidence it's done: A lint/AST test fails the build on `datetime.now`, `date.today` or `time.time` inside the ingest, knowledge-model, analysis and report packages; every entry point takes an explicit `as_of` timestamp.
- **Pure, unit-tested analysis layer with no I/O** _(architecture)_ — Sprint math, blocker graphs, projections and alignment are the product; they must be testable in isolation.
  - Evidence it's done: Analysis package has no database or network imports (enforced by an import-linter contract); >=90% line coverage on the analysis package reported in CI.
- **Authentication with email magic link and password** _(auth)_ — Reports contain organisational data; anonymous access is not an option beyond the local demo.
  - Evidence it's done: Sign-up, sign-in, sign-out, password reset with expiring single-use tokens, verified email change; rate-limited login with lockout; session cookies HttpOnly/Secure/SameSite.
- **Password reset / forgot-password flow** _(auth)_ — Password auth is offered but there is no recovery path, so any forgotten password is a permanent lockout.
  - Evidence it's done: `/auth/forgot` → single-use signed token, 60-minute expiry, invalidates all sessions and pending resets on use, non-enumerating response text, rate-limited, and an audit record.
- **Team-scoped authorization inside an org** _(auth)_ — The role matrix is org-wide; a manager of team A must not be able to read team B's report, and 'manager' as a single org role makes that impossible to express.
  - Evidence it's done: A team_membership/grant table with (user, team, role); a parametrized test where manager A gets 403 on team B's report, permalink, export, and diff endpoints while the org owner gets 200.
- **Billing and subscription lifecycle** _(billing)_ — Plans, seats, and a 'business plan' are referenced throughout, but there is no pricing, checkout, trial expiry, invoice, dunning, or downgrade behaviour anywhere.
  - Evidence it's done: Plan page, checkout, trial countdown banner, invoice history, card-failure dunning emails, and a defined read-only/degraded state on non-payment (reports stop generating but data is retained for 30 days).
- **Full CRUD and effective-dating on goals, teams and projects** _(configuration)_ — Configuration is listed as create-only; objectives get reworded mid-quarter, sprint goals change, teams split, repos are archived — and the blueprint never says whether past alignment verdicts are re-evaluated or frozen.
  - Evidence it's done: Edit/archive/delete for every configured record with a confirm dialog naming downstream impact, plus a documented and tested rule that historical reports keep the objective version in force at generation time while future reports use the new one.
- **Team membership configuration** _(configuration)_ — Team scoping is the basis of every aggregate and every report.
  - Evidence it's done: `/settings/teams` create/rename/archive teams, add and remove people, set a team's board and repos; changes take effect on the next generation with an effective-from date recorded.
- **Tracked repos and projects configuration** _(configuration)_ — Alignment and progress are only meaningful over a defined scope.
  - Evidence it's done: Mapping screen linking projects to one or more repos and one or more Jira boards, with validation warnings for a project with no repo or a board with no team.
- **Unmatched-identity queue with merge and un-merge** _(configuration)_ — IdentityLink stores merge history but there is no surface to resolve the long tail of unknown git emails or to undo a wrong merge, and every bad merge corrupts attribution in every downstream report.
  - Evidence it's done: `/settings/people` listing unlinked identities by activity volume with suggested matches, bulk link, and an un-merge that restores prior links and writes a Correction; a test un-merges and asserts historical reports re-render consistently.
- **Email delivery with the full report inline** _(delivery)_ — The manager's existing channel is where the product lives or dies.
  - Evidence it's done: Received email renders all six sections with working source links in Gmail, Outlook and Apple Mail (screenshots in the test artifacts); no truncation, no 'view online to read'.
- **Per-channel subscription choice: per-team, merged, or both** _(delivery)_ — The user's explicit requirement that the subscriber chooses, per channel.
  - Evidence it's done: `/settings/subscriptions` matrix of (channel × scope) toggles per user; a test configures merged-to-email and per-team-to-Slack and asserts exactly that is sent.
- **Per-user schedule and timezone** _(delivery)_ — A daily that arrives at 03:00 local is not a daily.
  - Evidence it's done: Subscription stores cron-like local time plus IANA timezone; a DST-crossing test asserts the 08:00 local send stays at 08:00 local; the send log shows the resolved UTC time.
- **Slack delivery to DM or channel** _(delivery)_ — Same reason as email, and it is where the team already is.
  - Evidence it's done: Block Kit message with the six sections, source links, and per-item action buttons; configurable target (DM or named channel) per subscription; verified against a real workspace in an integration test.
- **Seed dataset generator with a documented manifest** _(demo)_ — The seed must be regenerable and its planted pathologies verifiable, not a hand-written blob nobody dares change.
  - Evidence it's done: `compass seed --scenario baseline` regenerates the dataset deterministically from a fixed seed value; a manifest file lists every planted pathology and the assertion that proves it fires.
- **Simulated-clock time-travel control with day-by-day stepping** _(demo)_ — The memory thesis is only demonstrable by watching a release slip develop across successive daily reports.
  - Evidence it's done: A date control on the report page; stepping from sprint day 6 to day 11 produces five distinct stored reports where the release appears first as a risk, then a projected slip, then a recommendation — and the archive lists all five.
- **Accept or reject a recommendation** _(feedback)_ — A rejected recommendation must never be re-suggested.
  - Evidence it's done: Reject suppresses that recommendation identity indefinitely; accept marks it in-flight and the next report follows up ('you accepted adding Priya to #883; it was reviewed 6 hours later'); both covered by two-day tests.
- **Dismiss a risk with an optional reason** _(feedback)_ — The same already-considered risk reappearing every morning is how the product dies.
  - Evidence it's done: Dismiss action stores a `FeedbackEvent` against the entity with reason text; the item is absent from the next report; the item page shows who dismissed it and when.
- **Dismissed risk resurfaces only on material worsening, and says why** _(feedback)_ — Permanent suppression hides real deterioration; silent resurfacing feels broken.
  - Evidence it's done: Each dismissal records the evidence snapshot; a documented materiality rule (severity increase or a named metric crossing a threshold) triggers return, and the prose reads 'you dismissed this Tuesday; returning because the review queue grew from 4 to 9'. Unit-tested at just-below and just-above the
- **Mark a blocker as already resolved** _(feedback)_ — Reporting a handled blocker back at the manager is the classic noise complaint.
  - Evidence it's done: Action records a manual resolution with the manager as source; the blocker leaves the open set; if source data later contradicts it, a correction is recorded and stated rather than silently reverting.

## The professional bar

- **security** — Every report, entity, feedback record and configuration row carries an organization_id, and every data-access path goes through a single scoped-query layer that requires it; a test suite creates two orgs with identical-looking data and asserts that no API route, report permalink, export, email link
- **security** — Authorization is enforced by a role matrix with at least four roles — owner, manager, member (subject of reports), viewer (read-only shared link) — checked server-side on every route; the matrix is expressed as a single table in code and covered by a parametrized test that iterates every (role × rou
- **security** — Shared report permalinks use unguessable 128-bit tokens, are revocable from the report page, can be set to expire (7/30/90 days/never), record every access (timestamp, IP prefix, user agent) in the audit log, and default to org-members-only rather than public-link.
- **security** — GitHub/Jira/Slack OAuth tokens and refresh tokens are stored encrypted at rest with envelope encryption (per-org data key wrapped by a KMS master key), never logged, never returned by any API (not even masked-to-the-owner), and rotatable; a grep-based CI check fails the build if a token field name a
- **security** — Integrations request least-privilege scopes and the scope list is displayed verbatim on the connect screen before consent: GitHub read-only (contents:read, pull_requests:read, issues:read, metadata:read — no write, no admin), Jira read-only, Slack channels:history/users:read for named channels only.
- **security** — All inbound integration webhooks verify provider signatures (GitHub X-Hub-Signature-256 HMAC, Slack v0 signing secret with a 5-minute timestamp window, Jira JWT/secret) using constant-time comparison, and reject-and-log on failure; a test posts a valid body with a tampered signature and asserts 401
- **security** — Slack interactive feedback actions (dismiss/accept/reject/snooze buttons in the delivered message) verify the Slack signature AND map the Slack user ID to a Compass identity with permission on that report before mutating state; an unmapped or unauthorized Slack user gets an ephemeral 'you don't have
- **security** — Email one-click feedback links are single-purpose, signed, scoped to one item ID and one action, expire after 30 days, and are single-use for state-changing actions; they never authenticate a full session, so following a leaked link cannot read the report archive.
- **security** — Authentication supports email+password with Argon2id hashing, TOTP 2FA, and Google/GitHub SSO on all plans, plus SAML/SCIM on the business plan; sessions are httpOnly+Secure+SameSite=Lax cookies with rotation on privilege change, absolute expiry of 30 days, idle expiry of 14 days, and a 'sign out al
- **security** — The LLM narration step runs with prompt-injection containment: ingested content (commit messages, PR descriptions, Jira comments, Slack text) is passed as clearly delimited untrusted data with an explicit instruction that it is data not instructions, the narration model has no tool access and no net
- **security** — Rendered report prose is sanitized and rendered as text/markdown-with-allowlist, never as raw HTML, in web, email and Slack; a test ingests a ticket titled with a script tag and an email-header injection payload and asserts it appears as literal text in all three channels with no execution and no he
- **security** — A strict Content-Security-Policy (no unsafe-inline, nonce-based scripts, frame-ancestors 'none'), HSTS with preload, X-Content-Type-Options, Referrer-Policy strict-origin-when-cross-origin and a Permissions-Policy denying camera/mic/geolocation are set on every response and asserted by an automated
- **security** — Dependency and secret scanning run on every PR and nightly (SCA for known CVEs, secret scanning, and a container base-image scan); a critical vulnerability with a fix available blocks release, and the dependency inventory is published as an SBOM available on request.
- **security** — Rate limiting is applied per-IP and per-account on auth (10 attempts / 15 min, then exponential lockout with email notification), on report generation (manual regenerate: 5/hour/org), on feedback writes (60/min/user), and on public share links (120/min/token), returning 429 with Retry-After.
- **security** — Every privileged or destructive action — connect/disconnect integration, change goal hierarchy, change roster mapping, change report recipients, view another user's report, revoke a share link, export data, delete account — writes an immutable audit record (actor, action, target ID, before/after dif
- **privacy** — The product ships an explicit no-individual-ranking stance enforced in code, not policy prose: there is no per-developer leaderboard, no commit-count or LOC comparison across people, and no 'top/bottom performer' surface anywhere. Individual names appear only attached to a specific, actionable, veri
- **privacy** — Every developer named in reports can be given access to see exactly what Compass stores about them and every report line that names them, via a self-serve 'what does Compass say about me' page, with no manager approval required once the org enables member accounts.
- **privacy** — Slack ingestion is opt-in per channel with the channel list shown explicitly, never workspace-wide; DMs and private channels are never ingested; a visible in-product statement and a bot-posted notice in each ingested channel state that Compass reads that channel; message bodies are retained no longe
- **privacy** — A published data-processing page names every subprocessor (cloud host, LLM provider, email sender, error tracker), the data category each receives, and its region; changes are announced by email 30 days in advance with a subscribe link.
- **privacy** — Data sent to the LLM narration provider is minimized and configurable: an org setting selects (a) full text, (b) redacted mode where developer names are replaced with stable pseudonyms and re-substituted locally after generation, or (c) no-LLM mode which renders the structured report through determi
- **privacy** — Retention is configurable per org (raw ingested events 30/90/180/365 days; derived entities and reports 1/3/7 years/indefinite) with a documented default, and deletion actually removes rows plus backups within the stated window; an admin-visible retention page shows the current setting, the next pur
- **privacy** — A completed DPIA template and a GDPR Article 22 position statement ship as product documentation, stating plainly that Compass produces no automated decision with legal or similarly significant effect, that alignment flags are advisory, correctable by the manager, and never routed to HR systems; the
- **privacy** — Personal data is removable per-person: when a developer leaves or requests erasure, an admin can anonymize them — their identity mappings collapse to a pseudonym, their name disappears from future reports, and past reports render 'a former team member' while keeping the structural facts and the audi
- **privacy** — Self-serve account and organization deletion exists in-app with a 7-day grace period, an emailed confirmation containing an undo link, a full data export offered before the purge, and hard deletion (including backups) completed within 30 days with a confirmation email stating what was deleted.

## Data

- Account (workspace, plan, region, retention policy), User (authentication identity, role, timezone, notification preferences), Person / Developer (canonical human, versioned, with activity status), IdentityLink (git email, GitHub handle, Jira accountId, Slack userId → Person, with confidence and merge history), Absence / OutOfOffice (person, range, reason category), WorkingCalendar (team, working days, holidays, timezone), Company, Objective (level: company | quarter | sprint_goal, parent, description, active window), ObjectiveLink (objective ↔ epic/ticket/project, source: configured | inferred | semantic), Team (board, cadence, repos, members, effective-dated), Project (repos, boards, owning team), Repository (provider, name, default branch, tracked flag)

## Integrations

- GitHub (GitHub App install + OAuth, REST + GraphQL: commits, branches, PRs, reviews, review comments, issues, check runs
- GitHub webhooks (push, pull_request, pull_request_review, issues, check_suite) with signature verification
- GitHub Enterprise Server (self-hosted base URL support)
- Jira Cloud (OAuth 3LO: issues, epics, sprints, boards, story points, issue links, changelog, custom fields)
- Jira webhooks / Automation for near-real-time issue updates
- Jira Data Center (on-premise base URL + PAT auth)
- Slack (app install, channels:history, conversations, permalinks, users.list for identity mapping)
- Slack Block Kit interactive components + Events API for one-click feedback from the message
- Slack DM and channel delivery via chat.postMessage with in-place message updates
- Transactional email provider (Postmark / SES / Resend) with webhooks for delivery, bounce and complaint events
- Sending-domain email authentication (SPF, DKIM, DMARC) and RFC 8058 one-click unsubscribe
- Anthropic Claude API for report narration (with prompt/response tracing and a deterministic fallback renderer)

## Launch checklist

- [ ] Zero-config first run: a cold `docker compose up` (or a single `npm run seed && npm run dev`) followed by opening `/` renders a fully generated daily report for the seeded org within 60 seconds, with no login wall, no connector wizard, and no empty state — verified by a CI smoke test that boots a cl
- [ ] Seeded dataset is checked into the repo as declarative fixtures (not a generated blob): ≥3 projects, ≥12 developers with multiple Git emails / Jira accountIds / Slack user IDs each, ≥4 completed sprints plus one in-flight sprint, ≥600 commits, ≥120 PRs, ≥300 Jira issues, ≥800 Slack messages across ≥
- [ ] Simulated-clock control in the UI: a date scrubber/stepper on the report view that advances `now` across the seeded multi-sprint history and regenerates the report through the real pipeline for that instant; stepping day-by-day across the Release 2 window visibly produces the sequence risk → project
- [ ] `now` is injected everywhere: a lint rule or unit test fails the build if `new Date()`, `Date.now()`, `datetime.now()`, or equivalent appears anywhere under the ingest, knowledge-model, analysis, or report-generation packages — a `Clock` port is the only source of time.
- [ ] Determinism gate in CI: generating the report twice for the same `(org, team, instant)` produces byte-identical structured JSON after excluding a documented allowlist of non-semantic fields (generation timestamp, run id) — asserted by a test that runs the pipeline twice in-process and diffs, plus a
- [ ] Checked-in golden fixtures: `fixtures/reports/<team>/<date>.json` for at least 10 consecutive simulated days per team plus the merged manager report; `npm run test:golden` diffs live output against them and `npm run golden:update` regenerates with a reviewable diff, so any change in analysis logic s
- [ ] Prose-grounding test: an automated extractor pulls every number, percentage, date, PR number, commit SHA, Jira key, and person name out of the generated prose and asserts each one exists in the structured report object for that section; the test fails the build on any token not traceable to the stru
- [ ] LLM narration is constrained and fails closed: the generator receives only the structured section payload (no raw events), and if the grounding validator rejects the output after N bounded retries the report renders from a deterministic template renderer instead of shipping ungrounded prose — the re
- [ ] Every claim is source-linked: each blocker, risk, win, off-goal flag, recommendation, and progress number in the web view carries a clickable evidence affordance resolving to the underlying artifact (commit SHA, PR number, Jira key, Slack permalink) or, on seeded data, to an in-app artifact detail p
- [ ] Alignment verdict explainability: clicking any alignment result opens an evidence panel showing the resolution path actually used (structural chain ticket → epic → sprint goal → quarter goal → company objective; or the inferred branch/commit-message ticket key with the matched string highlighted; or
- [ ] OFF-GOAL is only emitted above a configured confidence threshold AND with positive attribution to a non-current objective; everything else lands in `unattributed` and is rendered as a question, never a verdict — enforced by a property/unit test asserting no OFF-GOAL label can be produced from a low-
- [ ] Versioned entity store, not derived views: Company, Objective, Project, Team, Developer, Feature, Ticket, Blocker, Risk, Recommendation, Sprint each persist as first-class rows with `first_seen_at`, `last_seen_at`, and an append-only transition/version history; a test asserts the report can state el
- [ ] Idempotent incremental ingest: re-ingesting the same time window twice produces zero new entity versions and zero duplicate blockers/risks — asserted by a test that runs the same window three times and compares full DB snapshots; overlapping and out-of-order windows are also covered.
- [ ] Contradiction handling is explicit and non-destructive: when new data contradicts a stored belief the system writes a `Correction` record (prior belief, new belief, evidence, detected-at) and the affected item is never silently overwritten; the seeded data contains a ticket reported blocked one day
- [ ] Stable item identity: every risk, blocker, off-goal flag, and recommendation has an ID derived deterministically from the underlying entity and cause (not from the report run), so the same condition on Tuesday and Wednesday is one item with a history; a test generates reports for consecutive simulat
- [ ] Change-awareness in the report: each item is tagged NEW / UNCHANGED (with age) / WORSENED / IMPROVED / RESOLVED relative to the prior report for that subscription, and the web view offers a "what changed since yesterday" diff of two structured reports side by side (item-level added/removed/changed)

## Definition of done

- [ ] Cold start: on a clean checkout, `docker compose up` (or `npm run seed && npm run dev`) followed by opening `/` renders a fully generated daily report for the seeded org in under 60 seconds with no login wall, no connector wizard and no empty state; a CI smoke test boots a clean container, fetches `
- [ ] The report has exactly six sections in fixed order - Yesterday, Progress, Blockers, Risks, Recommendations, Wins - in web, email and Slack, and no chart, sparkline, gauge or graph appears anywhere in the daily or weekly output; a test asserts the rendered report contains no <canvas>, no <svg> chart 
- [ ] Seed fixtures are checked into the repo as declarative, human-readable files (not a generated binary blob) with a documented manifest, and contain at least 3 projects, 12 developers each holding multiple git emails plus a Jira accountId plus a Slack userId, 4 completed sprints plus 1 in-flight sprin
- [ ] The seed contains, and the manifest names by ID, at least: one off-goal work stream attributable to a non-current objective, one review bottleneck concentrated on a single named reviewer, one release slipping across a multi-day window, one ticket reported blocked that turns out to have been merged (
- [ ] Traceability in the seed is deliberately messy in documented proportions: some commits with a clean structural chain to a sprint goal, some with only a branch-name or commit-message ticket hint, some matched only semantically, and some with nothing at all; a test asserts that a single generated repo
- [ ] A simulated-clock control on the report view steps `now` day by day and jumps to any date across the seeded history, regenerating through the real pipeline for that instant; an end-to-end test walks the Release 2 window day by day and asserts the same stable item ID appears first as a risk, later as
- [ ] `now` is injected everywhere: a lint rule or unit test fails the build if `new Date()`, `Date.now()`, `datetime.now()` or an equivalent appears anywhere under the ingest, knowledge-model, analysis or report-generation packages; a `Clock` port is the only source of time and is passed explicitly.
- [ ] Determinism gate: generating the report twice for the same (org, team, instant) produces byte-identical structured JSON after excluding a documented allowlist of non-semantic fields (generation timestamp, run id); the test runs the pipeline twice in-process and diffs, and a second variant runs it in
- [ ] The analysis layer is pure: no HTTP, no database, no filesystem, no clock and no randomness inside it - it takes a materialized snapshot plus an instant and returns a structured report object; an architecture test fails the build if an analysis module imports an I/O or time module.
- [ ] Golden fixtures `fixtures/reports/<team>/<date>.json` exist for at least 10 consecutive simulated days per team plus the merged manager report; `npm run test:golden` diffs live output against them and `npm run golden:update` regenerates with a reviewable diff, so any change in analysis logic shows u
- [ ] Prose grounding: an automated extractor pulls every number, percentage, date, PR number, commit SHA, Jira key and person name out of the generated prose and asserts each exists in the structured payload for that section; the build fails on any untraceable token, and the test suite includes at least 
- [ ] LLM narration fails closed: the narrator receives only the structured section payload and never raw events; if the grounding validator rejects output after a bounded number of retries the report renders through the deterministic template renderer, the fallback is recorded on the report row, and the 

## Success metrics

- Time to first real report on a cold clean machine is under 60 seconds, measured by the CI smoke test on every commit, and under 10 minutes from OAuth consent to first live report once real connectors exist.
- Zero ungrounded tokens: the prose-grounding test reports 0 untraceable numbers, dates, keys, SHAs or names across all golden fixtures on every CI run; any regression is a release blocker.
- Determinism: 100 percent byte-identical structured reports across double generation for the same (org, team, instant) over the full 10-day fixture set, in-process and cross-process.
- Evidence coverage: 100 percent of blockers, risks, wins, off-goal flags, recommendations and progress numbers resolve to a source artifact, measured by an automated crawl of every generated report, not by sampling.
- Alignment precision measured by the feedback loop: fewer than 2 percent of emitted OFF-GOAL flags are marked wrong by managers over a trailing 30 days, tracked on the in-app alignment-accuracy page broken down by resolution path.
- Unattributed honesty: 0 occurrences of an accusatory phrasing template in unattributed output, asserted by copy tests, and the unattributed count is stated in every report where it is non-zero.
- Repeat rate: fewer than 10 percent of items in a given daily report are UNCHANGED and untagged-as-such versus the prior day; every UNCHANGED item carries an age, so nothing is ever repeated as if new.
- Recommendation acceptance: at least 40 percent of recommendations receive an explicit accept or reject within 48 hours, and at least 25 percent are accepted - measured per team, as the primary signal that output is actionable rather than decorative.

## Why products like this get abandoned (designed out)

- The same three items appear every morning with no change markers, so within two weeks the daily reads as a template and the manager stops opening it — the report never says "nothing material changed since yesterday" or leads with what moved.
- One wrong off-goal flag against a named developer. The manager either has to defend it to their team or quietly stops trusting the alignment section, and once alignment is untrusted the differentiator is gone and the rest reads as filler.
- A fabricated or misattributed detail — a PR number that doesn't exist, a commit credited to the wrong person, a blocker that was merged yesterday. A single instance costs more trust than months of correct output earns, and managers do not give a second chance to a tool that invents.
- It reads as surveillance. An engineer sees per-person material, the team pushes back, and the manager drops the tool rather than fight for it — adoption in this category is decided by whether the manager can show the report to their team.
- Jira hygiene is imperfect (statuses stale, estimates missing, epics unlinked) and the numbers therefore disagree with the board. The manager reconciles once, finds the tool wrong, and never reconciles again — especially fatal if the product blames the data instead of naming the hygiene gap itself.
- Recommendations are unactionable: "consider improving review turnaround" with no name, no PR, no next step. The manager already knows the problem; what they needed was the specific move, and generic advice signals the tool doesn't actually understand their org.
- It drifts into a dashboard. Charts accumulate, prose thins, and the product becomes something the manager could approximate with a free Jira board — trial-opened, then silently churned.
- The already-handled item problem: the blocker the manager cleared at 9am is still in tomorrow's report, or a risk they explicitly dismissed returns unexplained. Feedback that visibly doesn't stick teaches the manager the tool isn't listening.

## Deliberate non-goals

- The multi-panel dashboard: no chart grid, no metric explorer, no DORA panel, no drilldown analytics UI. Prose sections and evidence panels only. This is the single hardest line to hold and it is deliberate.
- Role-specific views for CTO, CEO, QA lead and UI lead. One audience at MVP: the manager of one to three teams, plus a read-only shared permalink for a skip-level.
- Natural-language chat or Q and A over the accumulated history. The memory is architecturally real at MVP; querying it conversationally is a later surface.
- Release-date prediction as a product feature beyond the sprint-scoped projected completion date with a confidence band. No multi-release roadmap forecasting, no Monte Carlo delivery simulation.
- Burnout, wellbeing, sentiment or morale detection of any kind. Out on both product and ethical grounds at MVP.
- Architecture drift detection, code-quality scoring, complexity or churn analysis, and test-coverage tracking.
- Any integration beyond GitHub, Jira and Slack: no GitLab, Bitbucket, Azure DevOps, Linear, Asana, Notion, Microsoft Teams, PagerDuty, Sentry, CI providers as data sources, or calendar ingestion.
- Live GitHub, Jira and Slack connectors at MVP. The connector interface is real and documented and the seeded provider implements it fully; the live implementations are the next milestone, and the app says so plainly rather than implying production data.
- Per-developer productivity metrics, leaderboards, commit or LOC counting as output, and anything usable as performance-review input. Excluded permanently, not deferred.
- Write-back to GitHub, Jira or Slack: Compass never assigns a reviewer, moves a ticket, comments on a PR, or edits a sprint. Recommendations are for a human to execute; the only writes are Compass's own Slack messages and emails.
- DORA metrics, industry benchmarking and cohort comparison.
- Software capitalization, R and D tax reporting, cost-per-feature and finance-facing allocation output.

## Risks

- One wrong OFF-GOAL flag against a named developer permanently destroys the manager's trust in every other sentence, and the confidence threshold is a tuning parameter chosen against seeded data that may not match a real org's messiness. Mitigation: positive-attribution requirement, the unattributed 
- The product is read as surveillance. Even with no per-developer ranking, a report that names an individual next to a blocker or an off-goal commit can be screenshotted into a performance conversation. Mitigation: enforced-in-code no-ranking stance, the 'what Compass says about me' page, team-level f
- Determinism and LLM narration are in tension. The structured core is deterministic by construction, but prose varies with temperature, provider-side model updates and prompt changes, so 'the same report' can read differently day to day and a model deprecation can silently change tone or trip the gro
- The grounding validator is the entire defence against fabrication and it is a token extractor, so it catches invented numbers, dates, keys and names but not invented causality - prose can be fully grounded token-wise and still assert a wrong reason ('blocked because Priya is on leave' when nothing i
- Goal alignment depends on a goal hierarchy someone has to enter, and the honest failure mode is that nobody does. Then the sharpest differentiator degrades to a large unattributed bucket and the product looks like every other summarizer. Mitigation: the seed ships it complete, alignment states plain
- The seeded dataset can flatter the product. Analysis, thresholds and prose get tuned until the planted pathologies read beautifully, and real data - inconsistent workflows, six-month-old tickets, bot commits, squash merges, monorepos, reverts, forks, sub-tasks, mid-sprint board reconfiguration - pro
- The connector interface may be the wrong shape, discovered only when the first live connector is written. Real APIs bring pagination, cursors, eventual consistency, webhook-versus-poll divergence, rate limits and partial windows that a synchronous seeded time-window query never exercises, and the pr
- The feedback loop can suppress something that mattered. A dismissed risk that genuinely worsens must return, and the material-worsening rule is a heuristic; too strict and Compass stays quiet about a real slip the manager dismissed a week ago, too loose and it nags and gets muted. Mitigation: the wo
