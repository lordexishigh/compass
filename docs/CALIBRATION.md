# The Process Calibration Audit and the Completion Ladder

Two differentiators, one shared premise: **a number is worthless until you know what it is
made of.**

Every tracker on the market will compute a velocity from estimates that have never
predicted anything, a burn-down from a scope that was rewritten three times, and a cycle
time from statuses nobody moves. Each figure is arithmetically correct and epistemically
empty, and the tool that produced it says nothing about the difference. Compass says it
out loud, in the prose, above the number.

Both live in `packages/analysis` — the pure layer — so both are deterministic, take the
instant they reason about as a parameter, and can be re-run for a past day to the byte.

- Statistics and verdicts: `packages/analysis/src/calibration.ts`
- Rung detectors: `packages/analysis/src/ladder.ts`
- Every threshold as a number: `packages/analysis/src/thresholds.ts`
- Tests: `packages/analysis/tests/calibration.test.ts`,
  `packages/analysis/tests/completion-ladder.test.ts`

---

## Part 1 — The Process Calibration Audit

### Seven statistics

Each is computed from the snapshot alone and carries **its own sample size** into the
output. That is not a nicety: a correlation of 0.82 over four tickets is noise wearing a
statistic's clothes, and a reader shown only `0.82` cannot tell.

| Statistic | What it measures | Emitted with |
| --- | --- | --- |
| `point_to_elapsed_working_days` | Do story points track measured elapsed **working** days, first move into an in-progress status to last move into done? | The coefficient, `sampleSize`, and a four-number spread (min / max / spread / median) for both columns. **There is no field named `r` anywhere in the package** — the coefficient cannot be destructured away from its `n`. |
| `estimate_coverage` | Share of work items raised in the trailing window carrying a point estimate | Both counts, the window length, and every unestimated key |
| `carryover_rate` | Share of each trailing sprint's committed baseline still unfinished when the sprint closed | Per-sprint rows naming the carried keys, plus the mean of the rates |
| `status_dwell_consistency` | Spread of how long items actually sit in each workflow status, in whole hours | Per-status `n`, spread, median and the spread-over-median ratio |
| `scope_churn` | Items added **and** removed after the sprint started, over the committed baseline | Both key lists and the baseline count |
| `sub_task_double_count` | Parent items whose sub-tasks also carry points | Count, share, and the parent keys by name |
| `stale_status_incidence` | Items in an in-progress status for `T23` working days **and** with no commit or pull-request activity for `T23` working days | Every stale key, its dwell, and its working days since activity |

Two documented windows:

- **`CALIBRATION_TRAILING_SPRINTS = 5`** — matching `VELOCITY_TRAILING_SPRINTS`, so a
  carryover rate and a velocity measured over different histories cannot let two sections
  of one report disagree about the same quarter.
- **`ESTIMATE_COVERAGE_TRAILING_DAYS = 28`** — two sprints of the seeded fortnightly
  cadence, so the figure is not decided by whichever sprint happens to be in flight.

Carryover is decided by **replaying each item's transition history to the sprint's own
`completedAt`**, never by reading its status today. Half of a sprint's carryover finishes
the following week, and a rate computed from current belief would report a team that
habitually overcommits as one that never does.

`sub_task_double_count` is reported as a **measurement, not a verdict**. Estimating both
levels is a modelling choice some teams make deliberately; Compass states the consequence
without deciding it is wrong.

### Six verdicts, and nothing else

The vocabulary is closed. A statistic either crosses a numbered threshold and produces one
of these six, or it is reported as a measurement and produces nothing. There is no seventh
verdict, no free-text finding, and no severity assigned by hand.

| Verdict | Fires when | Thresholds |
| --- | --- | --- |
| `points_uninformative` | `\|r\| < 0.30` with `n ≥ 10` | **T12** = 3 000 basis points (0.30), **T13** = 10 completed, estimated items |
| `estimates_sparse` | Estimate coverage `< 60%` in the trailing 28 days | **T18** = 6 000 basis points (60%) |
| `scope_is_fiction` | Carryover `≥ 30%` in `≥ 3` of the trailing 5 sprints, **or** churn `≥ 25%` of a committed baseline | **T19** = 3 000 basis points (30%), **T20** = 3 sprints, **T21** = 2 500 basis points (25%) |
| `workflow_inconsistent` | A status with `n ≥ 10` dwell observations whose spread reaches `1.5×` its own median | **T22** = 15 000 basis points (1.5×), **T13** = 10 observations |
| `statuses_stale` | `≥ 20%` of in-progress items stale by T23 | **T23** = 3 working days, **T24** = 2 000 basis points (20%) |
| `insufficient_history` | Fewer than 2 completed sprints | **T7** = 2 completed sprints |

`T12` is compared against the **absolute** coefficient. A correlation of −0.7 is a strong
relationship pointing the wrong way — bigger estimates finishing faster — which is a real
finding about the team's estimating, not an uninformative one. An unsigned comparison would
file it under "your points mean nothing" and lose it.

Every emitted verdict carries `{ statistic, value, sampleSize, threshold, supportingThresholds,
subjects, statement, evidence }`. `PROCESS_VERDICT_RULES` states the same mapping as data,
and `tests/calibration.test.ts` enumerates it and fails if any entry cites a constant
`thresholds.ts` does not declare.

### `insufficient_history` suppresses, and says so

It is computed **first**, and it withholds exactly the two verdicts that are meaningless
without trailing sprints: `scope_is_fiction` and `workflow_inconsistent`. A new team told
both "scope is fiction" and "Compass has no history for you" would be reading two sentences
that contradict each other, and the second one is the true one.

It does **not** suppress `estimates_sparse` or `statuses_stale`. Both are visible without any
sprint at all, and withholding them would be Compass hiding a finding it had already made.
The withheld names are listed in `audit.suppressed` and stated in the prose, so the reader
knows a verdict was refused rather than simply absent.

### Verdicts drive the projection

| Active verdict | Effect on the projected date |
| --- | --- |
| `points_uninformative` | The date comes from **measured cycle time** and states, in these words, that it *is a cycle-time guess, not a velocity forecast*. This overrides the item-count velocity path too — see the note in `projection.ts`. |
| `estimates_sparse` | Points are not used to forecast |
| `insufficient_history` | **No date at all**, with the reason stated — for a team that runs sprints. A Kanban team is exempt; see below. |
| any verdict | Costs the confidence band one level, so `high` is unreachable while the audit has anything to say |

#### `insufficient_history` does not refuse a Kanban team's date

The verdict counts **completed sprints** (`completed_sprint_count` against T7). That is the
right sufficiency test for a velocity forecast and the wrong one for a Kanban team, whose
completed-sprint count is zero permanently and by design. Applied unconditionally it made the
cycle-time arm — the only method a Kanban team has — unreachable code, and produced the
sentence *"Compass needs 2 completed sprints before it will give you a date, and it has 0"*,
which reports a deliberate methodology choice as thin data and contradicts the Progress
section directly above it.

So `projectCompletion` consults `progress.mode` first: a `kanban` team skips the T7 refusal
and projects from measured cycle time. The verdict is **not** suppressed — it is still emitted,
still stated, and still costs the band a confidence level. It simply no longer decides a
question it does not measure.

Flow keeps its own sufficiency tests, which are the ones that apply: `no_flow_history` when
nothing has been observed finishing, and `confidenceFor`, which cannot reach better than `low`
on a sample under twenty before the per-verdict demotion. A thin flow sample therefore degrades
to a low-confidence band set in lighter type, which is this product's stated answer to thin
data. `no_signal` keeps the T7 refusal: a team Compass has no tracker signal for may well run
sprints, and assuming otherwise would be the same error in the other direction.

The projection's `reasoning` names the method, the formula, the inputs, the assumptions,
`selectedByVerdicts`, and the confidence band. Both arms of the union carry
`selectedByVerdicts`, so a renderer cannot drop the caveat by forgetting to narrow the type.

### On tone

The wording is about the **instrument, never the team**. "Your points have not tracked
elapsed working days across 118 completed items" is a statement about a measurement;
"your team estimates badly" is an insult, and Compass does not make it. At one to three
teams the samples are small, which is exactly why every verdict carries its `n` and why
`T13` refuses a verdict below ten observations.

---

## Part 2 — The Completion Ladder

"Done" is the most overloaded word in engineering management, so Compass refuses to use it
as a single bit. Every Yesterday item ends with five notches and a rung label.

| Rung | Label | Detector — deterministic, over ingested data, no inference beyond the stated rule |
| --- | --- | --- |
| **R1** | `accepted` | `ticket.statusCategory === "done"`, or an observed transition into a done category |
| **R2** | `merged` | A pull request whose `linkedItemKeys` names this item carries a non-null `mergedAt` |
| **R3** | `integrated` | The pull request's `mergeRevisionId` is **reachable from the repository's default `branch_ref` revision by `commit.parentRevisionIds` edges** |
| **R4** | `released` | A `release_tag` revision reaches the merge commit by the same edges; the **earliest** qualifying tag is cited |
| **R5** | `deployed` | A deploy record from a CI/CD connector. **Never inferred** |

`RUNG_DETECTORS` states this table in code, and a test asserts every rung has a detector and
that R5 is the only one marked non-inferable.

### R3 is the rung that cannot be faked

Merge state is **explicitly not sufficient**. A pull request can be merged into a release
branch, into a fork, or onto a line that was later rewritten, and in each of those cases the
forge says merged while the topology says the code is not on the branch everyone builds
from. "This is on the trunk" is the claim a manager acts on when they decide work is
finished, so it is decided by walking parent edges and nothing else.

The trunk tip comes from the default `branch_ref` a connector reported. With no ref for a
repository the fallback is the newest observed commit whose `branchName` equals the
repository's declared default branch — weaker, and stated as such, but still topology rather
than a timestamp comparison. A repository with **neither** has no tip, and then **R3 is not
awarded**: Compass does not know where that trunk is, and awarding integration on a guess is
precisely what the rung exists to refuse.

`tests/completion-ladder.test.ts` asserts this against `mergedButUnreachableSnapshot()` — a
fix merged to `release/2.1` while `main` points elsewhere. R1 and R2 are crossed, R3 is not,
and the notch states *why* rather than rendering as an ordinary empty mark.

### R4 is decided independently of R3

A fix merged to a release branch and tagged there really **is** released; it is simply not on
the trunk. Gating R4 on R3 would report that item as neither integrated nor released, which
is false. So the notches come out `R2 · R4` with a hole at R3, `highestCrossed` is R4 and
`highestContiguous` is R2 — and the win rule reads the contiguous value, so it still refuses
to call it an achievement. The gap is the finding; hiding it would defeat the object.

### R5 says what it does not know

With no CI/CD connector the fifth notch renders **hollow** and the label reads, literally,
`no deploy signal available`. Inventing a deploy from a merge would be the single most
damaging claim this product could make. When a connector *does* report the capability the
notch becomes reachable and the sentence goes away — but nothing is crossed until an actual
deploy record arrives, because a capability is not an event.

The words are asserted three times over: in the analysis tests, in
`tools/smoke/src/report-html.ts` against the real rendered page, and in the web view's own
test. A correct detector whose honest sentence a component quietly dropped because it looked
like clutter is the realistic way this regresses.

### Rung suffixes, and the two ladder-mismatch findings

Every Yesterday line ends in its furthest reached rung **and the next one it has not**:
`DEV-402 via #9201 — merged, not yet integrated`. The suffix is appended in the pure layer by
`yesterdayHeadline`, not by each renderer, so the web view, the email and the plain-text form
cannot disagree about it — and `tests/report-invariants.test.ts` asserts no Yesterday line
exists without one.

Two mismatches become findings in the Risks section (the Six Spine never grows a seventh
heading):

- **R1 crossed with R2 empty** → a `done_without_pull_request` hygiene finding, one per item,
  **naming the ticket**. It carries `T0`: the rule applies no threshold because the sources
  state the condition outright. An aggregate count is something a manager can read and do
  nothing about; the fix here is always "go and ask about this specific item".
- **Merged commits ahead of the newest release tag** → the `unreleased_merged_work` risk,
  naming the **oldest** such pull request, its linked tracker keys and its age in days.

---

## Where the numbers came from, and how to change one

Every threshold above is declared once in `packages/analysis/src/thresholds.ts` with an id, a
value, a unit and a statement in the product's own voice. Nothing in the analysis package may
compare against a bare literal.

To change one: edit the constant, run `pnpm --filter @compass/analysis test`, and expect the
seeded assertions to move. That is the point — the seeded organization is deliberately
pathological so every detector fires, and `wellRunTeamSnapshot()` is the constructed negative
control that must produce **no verdicts at all**. A comparison written `<=` where it should be
`<` turns that clean team into a team with four findings, and there is no real dataset in
which that mistake is visible.
