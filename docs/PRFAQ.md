# PR-FAQ — Compass: the daily engineering report that tells you what to do — and that you can correct in one sentence

_One page of prose every morning: what happened, what's at risk, what to do today, and which work isn't serving the goal._

> Written **before** building (Amazon "Working Backwards") to lock the customer outcome.

## Press release

Compass is for the engineering manager who owns one to three delivery teams and is accountable upward for a date. Today that manager spends the first hour of the day rebuilding reality by hand — scanning the Jira board, chasing PRs that went quiet, guessing whether the sprint lands, and finding out on Thursday that someone spent three days on work nobody asked for. The tools built for this problem hand back dashboards: cycle time is 2.1 days, here is your DORA panel. The reasoning is still the manager's job, which is why those tabs get opened during the trial and never again.

With Compass, a manager opens one report on their phone before standup and reads six sections in fixed order — Yesterday, Progress, Blockers, Risks, Recommendations, Wins. No charts. Every claim links to the commit, PR, or Jira key it came from. Because Compass keeps a running model of the org rather than re-summarizing each morning, it writes sentences a summarizer cannot: "still blocked on the same dependency, day 6," "this ticket has been resequenced twice," "reported blocked yesterday; actually merged at 18:40 — correction recorded." Every Yesterday item says how far it actually got: ticket moved, PR merged, on the release branch, tagged — so "we shipped it" never means code sitting on an unreleased branch.

Two things make it usable rather than merely impressive. First, the manager can write back. Reply to the email or DM the bot — "Marcus is out Jul 27–Aug 2," "the PM descoped EPIC-12 Friday" — and the next report reflects it, cites the memo, and stops reflecting it when it expires. No more defending a report that calls someone stalled while they're on holiday. Second, Compass audits your tracker before forecasting from it. If story points haven't tracked elapsed days for four sprints, it says so and tells you the date below is a cycle-time guess, not a velocity forecast. Off-goal work is flagged only at high confidence with one-click evidence; anything weaker is a question — "3 commits could not be tied to a sprint objective" — never an accusation. There is no per-developer leaderboard and no LOC comparison anywhere, enforced by a test, so this is a report a manager can share with their team instead of hiding from it.

> “"I told it once that Priya was interviewing all week and it stopped calling her work stalled — that was the moment I trusted it. Then it told me my story points have been meaningless for four sprints and the date it gave me was a cycle-time guess. Nothing else I've used has been willing to say that." — Engineering manager, two Scrum teams and one Kanban team”

## How it works

Compass ingests GitHub, Jira, and Slack activity into a versioned knowledge model where every entity carries first_seen_at, last_seen_at, and an append-only history; a pure deterministic core then computes everything arguable — sprint math, blockers, review queues, alignment verdicts, the projected date and its confidence band — from that snapshot plus a single injected instant. An LLM only narrates the resulting structured sections and may not add a number, name, date, or recommendation: an automated validator extracts every token from the prose and fails the build if it isn't in the payload, and if narration can't be grounded the report falls back to a deterministic template.

## FAQ

**Q: Does the MVP actually connect to my GitHub, Jira, and Slack?**

No, and we won't pretend otherwise. The MVP ships the connector interface — a time-windowed query port — with a seeded provider that implements it fully, plus a realistic multi-sprint dataset with planted pathologies. The pipeline cannot tell whether data came from a seed or a live API, so real connectors land later as a configuration change with no changes to the knowledge model, analysis, or report generation. OAuth install flows, webhook receivers, and token encryption are explicitly out of scope for this release. What you can evaluate today is whether the report is worth reading; what you can't do today is point it at your own org.

**Q: What's the riskiest assumption here?**

That a manager will actually write memos back to it. Compass's two strongest claims — that it stops being wrong once you correct it, and that its off-goal flags are trustworthy — both depend on a habit that doesn't exist yet in this category, because no competing product accepts input at all. We've made the cost as close to zero as we can (reply to the email, DM the bot, one sentence, no form fields) and made the payoff visible the very next morning with a citation to the memo. But if managers read and never write, Compass degrades to a very good read-only report — better than a dashboard, short of the pitch.

**Q: Every AI product claims it doesn't hallucinate. Why is yours different?**

Because the model isn't doing the reasoning. Every arguable claim — sprint completion, blockers, the projected date, alignment verdicts — is computed by a pure analysis layer with no HTTP, database, filesystem, clock, or randomness; an architecture test fails the build if that layer imports one. The LLM receives only the finished structured payload, never raw events, and may choose emphasis and wording only. A validator extracts every number, percentage, date, PR number, commit SHA, Jira key, and person name from the prose and asserts each exists in that section's payload; the build fails on any untraceable token, and the suite includes cases designed to tempt the narrator into embellishing. If grounding fails after bounded retries, the report renders through a deterministic template and the fallback is recorded on the report row. Generating the same report twice for the same team and instant is byte-identical.

**Q: What is explicitly NOT in this release?**

No dashboard — no chart, graph, sparkline, or gauge anywhere, by design and asserted by test. No live integrations, no GitHub Enterprise or Jira Data Center, no integrations beyond GitHub/Jira/Slack. No chat or Q&A over report history. No deploy-confirmed completion — the top rung of the ladder renders as "no deploy signal available" rather than being guessed. No per-person 1:1 view or weekly per-person agenda; we know that's the biggest unserved need in the category and we're deliberately deferring it rather than doing it badly. No burnout detection, no billing, no SSO or 2FA, no catch-up mode for a manager returning from leave, no delegated cover routing. And we've decided against Right of Reply for engineers on off-goal verdicts — mitigated instead by a high confidence bar, a question-not-accusation unattributed bucket, one-click evidence, and a one-click "this flag is wrong" that suppresses it and feeds back into matching.

**Q: How is this not Swarmia or LinearB with prose instead of charts?**

Three mechanisms none of them have. (1) Write access: their model is pull-only, so the facts that live only in your head never enter it and there's no way to correct a wrong assertion and have it stick. (2) A process calibration audit: they can't tell you your points are noise without invalidating their own velocity charts. We compute point-to-elapsed-days correlation with n and spread, estimate coverage, carryover rate, scope churn, and stale-status incidence, map each to a named verdict, and feed those verdicts into which projection method is used and what confidence it carries. (3) A completion ladder that distinguishes "ticket moved" from "on the release branch" from "tagged." Swarmia's anti-ranking stance is the healthiest in the category and we've matched it in code rather than in policy prose.

**Q: What if my Jira is a mess? Every tool in this space produces garbage and blames my data.**

Detecting that mess is a feature, not a caveat. Bad hygiene produces named verdicts — points_uninformative, estimates_sparse, scope_is_fiction, workflow_inconsistent, statuses_stale, insufficient_history — that change how the projection is computed and are stated in plain prose in the report. A Kanban team with no sprints gets coherent no-sprint progress semantics, not a broken completion percentage. Tickets sitting In Progress for days with no commits are surfaced as likely-stale status rather than reported as work in flight. The honest limit: if your data can't support a forecast, Compass tells you that instead of producing a confident one — some managers will find that less satisfying than a number.

**Q: My engineers will see this as surveillance. How do I defend it?**

There is nothing to defend on the individual-metrics front, because those surfaces don't exist. No per-developer leaderboard, no commit-count or LOC comparison, no top/bottom performer view anywhere in any renderer or API response — asserted by a codebase test. Names appear only attached to a specific, actionable, verifiable object: "Marcus is sole reviewer on PR #883 with 6 open reviews." Reports are team-scoped and shareable with the team. Where we're honest about tension: off-goal verdicts are rendered about named people's work and delivered to their manager, and we decided not to build a right of reply for engineers in this release. Our mitigation is a high confidence threshold, evidence in one click, and a manager who can mark the flag wrong immediately.

**Q: How will you know if this worked?**

The launch gate is behavioral, not a metric dashboard. First: a manager reading the seeded daily report can name — without opening Jira or GitHub — the sprint completion percentage, the projected date and the stated reason for its confidence band, the top blocker with its age, the review bottleneck's reviewer and queue depth, one off-goal or unattributed item with its evidence, and one recommendation they could execute that morning. Second: cold start under 60 seconds on a clean checkout with no login, wizard, or empty state. Third, the survival test this category fails at week three: change-awareness, verified by a test asserting no item is delivered with identical prose and no stated change two days running. The real signal after that is memos written per manager per week and recommendations accepted — if those are zero, the report is being read and not used, and that's a failure regardless of how correct it is.
