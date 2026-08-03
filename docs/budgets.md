# Budgets

Every number Compass holds itself to, each stated once, each with the test that owns it.

Compass is a document, not a dashboard, and the two things that decide whether a manager reads it
tomorrow are its **length** and how fast it **arrives**. So the limits are numbers enforced in code,
not intentions stated here — and this document quotes those numbers rather than defining them.
`tools/quality-gates/tests/budgets.test.ts` fails the build if the two stop agreeing. A number
written in prose beside a number written in code is two sources of truth, and the one that drifts is
always the prose.

## The table

| Budget | Number | Constant | Owning test |
| --- | --- | --- | --- |
| Report render, Largest Contentful Paint | 2000 ms | `REPORT_LCP_BUDGET_MILLIS` | `tools/perf-budget/tests/budget.test.ts` |
| Time-travel regeneration | 5000 ms | `TIME_TRAVEL_BUDGET_MILLIS` | `tools/perf-budget/tests/budget.test.ts` |
| Cold start to a rendered report | 60000 ms | `COLD_START_BUDGET_MILLIS` | `tools/smoke/tests/probe.test.ts` |
| Merged cross-team report prose | 400 words | `MERGED_REPORT_WORD_BUDGET` | `packages/renderers/tests/merged.test.ts` |
| One team's daily report prose | 900 words | `DAILY_REPORT_WORD_BUDGET` | `packages/narrator/tests/narrate.test.ts` |
| One team's daily report, ~90-second read | 450 words | `DAILY_REPORT_READING_BUDGET` | `tools/quality-gates/tests/budgets.test.ts` |
| Narration-fallback alert rate | 0.20 | `NARRATION_FALLBACK_ALERT_RATE` | `packages/analysis/tests/budgets.test.ts` |

### Which of these are gates, and which are targets

The table says what each number *is* and which test owns the constant. It does not say whether a
failing **measurement** fails a build, and those are different claims — so, plainly, before the
sections that go into each one:

- **Gated end to end.** The two performance budgets, by the `perf` job in
  `.github/workflows/ci.yml`, against a running container. The merged 400-word ceiling, by the
  renderer refusing to emit prose over it.
- **Gated end to end**, also: cold start, by the `cold-start` job, at 60000 ms. The image build runs
  in its own step so it is outside the measured window — see below for why that is the difference
  between a gate and a formality.
- **Gated on one path only.** The 900-word daily ceiling fails closed on the *narrated* path; the
  seeded corpus renders 1,400–2,000 words through the template renderer and is over it today. See
  below.
- **A target, not yet met.** The 450-word ninety-second read. Its own section says so at length.

Three of seven are therefore not what a reader would assume from the table alone, and each one says
where its gap is rather than leaving the number to be read as a promise.

The word and rate constants live in `packages/analysis/src/budgets.ts`. The two performance
constants live in `tools/perf-budget/src/index.ts`, beside the runner that measures them, and the
cold-start constant in `tools/smoke/src/probe.ts`, beside the probe that measures it.

---

## Report render — 2000 ms Largest Contentful Paint

**The LCP budget is 2000 ms**, on a throttled mid-tier mobile profile: **4x CPU throttling** and a
**Slow 4G** network, applied over the Chrome DevTools Protocol.

The profile is the point. Compass's reading surface is prose with no charting dependency, so on a
developer's laptop it paints in a few hundred milliseconds and a budget measured there would prove
nothing. The report is read on a phone, on a train, before standup.

LCP is the right metric because the report *is* its largest text block. There is no hero image and no
above-the-fold skeleton to game: the moment the prose paints is the moment the product has delivered
what a manager came for. A budget on `DOMContentLoaded` would pass on a page that showed nothing.

Measured against `/` on the seeded organization, which is the one page guaranteed to exist on a cold
container with no configuration.

## Time-travel regeneration — 5000 ms

**The time-travel budget is 5000 ms** from selecting a date to a regenerated report, measured against
the seeded organization on the same throttled profile.

This is a whole pipeline run — ingest window, snapshot, goal hierarchy, analysis, render, persist —
so it is an order of magnitude more work than a page render, and the number reflects that.

Above the budget the requirement is **honest progress rather than hanging**. The scrubber states what
it is doing while it waits; it does not present a frozen page, and it does not show the previous day's
report while a new one is computed. A regeneration that genuinely takes longer than five seconds is a
slow regeneration, which is a fact a manager can see and act on. One that *appears* to have finished
when it has not is a lie about which day they are reading.

Stepping to a day that has already been generated is a **read**, not a regeneration, and is not
measured against this budget: the report id is derived from `(organization, scope, instant)`, so the
row already is the answer. `reportAlreadyGenerated` in `apps/web/lib/archive-source.ts` tells the two
apart, and it is also what stops a manager scrubbing back through last week from spending the
five-per-hour regeneration allowance.

## Cold start — 60000 ms

**The cold-start budget is 60000 ms** from `docker compose up` to a rendered six-section report at
`/`, with no configuration and no account.

Measured by `@compass/smoke`, which polls `/` until it returns a report the cold-start inspector
accepts — six headings, six sections rendered, at least one source link. The elapsed time is taken
from the caller's own `now` at the first attempt rather than from a per-attempt clock, so a slow
container cannot report four seconds after a five-minute wait.

### What the 60 seconds is measured over

**From `docker compose up` to a rendered report**, and CI asserts exactly that number — 60000 ms, no
override.

The distinction that makes it a real gate is what sits *outside* the window: the image build. The
`cold-start` job runs `docker compose build` as its own step and only then `docker compose up -d`, so
compiling the application is not charged to the budget. Everything inside the window is Compass
starting — PostgreSQL's first-boot `initdb`, migrations, the seed load, the first ingest, the first
generation, the first render — which is what a person running `docker compose up` on a released image
actually waits for.

That split is the whole reason the number can be enforced. Folded together as
`docker compose up -d --build`, the measurement included a cost no user ever pays, and the gate had
been loosened to 180000 ms to accommodate it — a step passing at three times its published budget,
which is a gate in name only. Two assertions hold the number now:

- `tools/smoke/tests/probe.test.ts` asserts the constant and the probe's behaviour at it — a report
  at 59 s passes, one at 61 s fails, and elapsed time is measured from the first attempt rather than
  per-attempt. That runs in `pnpm test` on every push.
- The `cold-start` job asserts it against a real container.

`pnpm smoke` prints the measured elapsed time either way, so a regression that stays under the budget
is still visible in the log.

## The merged cross-team report — 400 words

**The budget is 400.** It lives in `MERGED_REPORT_WORD_BUDGET` in
`packages/analysis/src/budgets.ts`.

### Why 400

- At an unhurried 200 words a minute it is **two minutes** — the length of a coffee queue, which is
  where this is read.
- It is about the point at which a single reading measure stops fitting one thumb-scroll on a phone.
- The merged report exists to be read *instead of* three per-team reports, not as well as them. A
  budget that grew with the number of teams would make it the fourth thing to read.

### How it is enforced

Three things, in this order:

1. **The ranking chooses.** `mergeTeamReports` in `packages/analysis/src/merged-report.ts` sorts every
   team's items by action impact and keeps the top `MAX_MERGED_ITEMS`. Choosing happens where the
   ranking is known, so the item that gets left out is the least actionable one.
2. **The renderer counts.** `renderMergedReport` in `packages/renderers/src/merged.ts` calls
   `assertWithinWordBudget` over the finished prose. The count runs **after rendering**, never on the
   structured payload: a word budget is a fact about the sentences a manager reads, and the payload has
   no sentences.
3. **It fails closed.** Over budget throws `WordBudgetExceededError`; it does not truncate. A report cut
   off at word 400 ends mid-sentence and reads as a bug in Compass rather than as a budget. If that
   error ever fires, the fix is `MAX_MERGED_ITEMS`, not a larger budget.

What does not fit is not lost. Every merged item carries the per-team item's own stable id and links
down into the report that holds its evidence, and the merged prose states how many findings ranked
below the cut: *"6 further findings ranked below these and stayed in the per-team reports."*

### What counts as a word

Whitespace-separated tokens of the rendered prose, with no exclusions — `01`, `PLAT-742` and `#9201`
are each a word on the page, so each is a word to `countWords`. Any rule that discounted numerals or
mono tokens would make the enforced budget larger than the budget a reader experiences, which is the
only budget that matters.

The count covers `prose` — every sentence — and not `text`, whose extra tokens are the page's own
furniture: a fixed `01` section numeral is not a measurement and has nothing to say.

### Why the merged report is never narrated

Per-team reports are narrated; the merged one is not. A model asked to phrase a page with a hard word
ceiling can only make it longer or less accurate, and the merged report has no prose of its own to
improve — every sentence in it is a headline the per-team analysis already wrote plus a count the
renderer computed. Keeping a model out of it is what makes the budget a guarantee rather than a hope,
and what makes the merged report byte-identical for the same `(organization, instant)`.

## One team's daily report — 900 words

**The daily budget is 900.** It lives in `DAILY_REPORT_WORD_BUDGET` beside the merged one.

Larger than the merged ceiling, and for the opposite reason. The merged report is a ranking that
deliberately leaves work out and links down to the report holding it; the per-team daily is the thing
being linked to, so it has to be able to say everything about one team's day. Six sections at roughly
150 words each is that, and at 200 words a minute it is four and a half minutes.

### Why there is now a number where there was not

This section used to say the daily was *bounded by construction* and needed no word count, and on the
templated path that is still true: `MAX_SENTENCES_PER_ITEM` (3) in `packages/renderers/src/prose.ts`
and `maxItemsPerSection` (12) in `AnalysisConfig` bound the length without counting anything. Read as
a complete account of the daily, though, it was wrong in one direction that matters — **narration is
not bounded by construction.** A model asked for six sections has no notion of a global ceiling, and
"the report got gradually longer" is exactly the regression nobody notices in review, because every
individual report looks fine.

So the construction bounds stay, and the count is added behind them. On the narrated path it fails
closed into the deterministic renderer — the treatment a grounding failure already gets, and for the
same reason: a report that is complete and templated beats one that is well-written and unreadably
long.

## One team's daily report, the ninety-second read — 450 words, **not yet met**

**The reading target is 450.** It lives in `DAILY_REPORT_READING_BUDGET` beside the other two, and
`tools/quality-gates/tests/budgets.test.ts` owns it.

Ninety seconds is the walk from a desk to a standup, which is when this is read. At the same unhurried
200 words a minute the merged budget is set against, that is 300 words; 450 is that with the headroom a
per-team report needs, because unlike the merged digest it carries the evidence chain a manager acts on
rather than a ranked list of headlines.

### The gap, stated

The seeded reports currently render **between roughly 1,400 and 2,000 words** — three to four times the
target, and above even the 900-word fail-closed ceiling on the templated path. The claim in the section
above that 900 "is a tripwire that should never fire" is therefore true of the narrated path and *not*
true of the seeded corpus today.

This is written down rather than fixed by moving the number, because a budget raised to whatever the
code happens to emit has stopped being a budget — the same argument the merged report's section makes
about `MAX_MERGED_ITEMS`. What is enforced in the meantime is a **ratchet**: the gate records the
measured ceiling and fails if the daily gets *longer*, so the gradual drift a target exists to prevent
is prevented while the gap is open. A second assertion fails the day the gap closes, so the ratchet
cannot outlive its usefulness quietly.

Closing it is a product decision about what to cut, and the knob is the same one the merged report
turns: `maxItemsPerSection` in `AnalysisConfig`, or `MAX_SENTENCES_PER_ITEM` in
`packages/renderers/src/prose.ts`. It will move every golden fixture under `fixtures/reports/`, and
that diff is the review.

## Narration-fallback alert rate — 0.20

**The alert rate is 0.20**: the share of a day's generated reports that may fall back to the
deterministic renderer before the condition stops being noise and becomes an incident.

Above one report in five, the likely cause is not a model having an odd day — it is a prompt, a schema
or a grounding rule that has broken for *every* report and is being masked by the fallback working
correctly. That masking is the whole reason there is a number here: fail-closed narration degrades so
gracefully that a total narration outage looks, from outside, like a product that has quietly decided
to be templated.

A rate rather than a count, so a deployment with three teams and one with thirty do not need different
thresholds. Evaluated per day rather than per report, because a single fallback is an expected event
that must never page anybody. `narrationFallbackAlert` decides it and returns `alerting: false` for a
day with no reports at all — that is a different condition, with its own signal, and dividing by zero
would fold it into this one.

## The weekly digest: no word budget

Deliberately unbudgeted, and that is not an oversight. The weekly is read once a week at a desk rather
than once a day on a phone, and its six topics are fixed: it cannot grow with the number of teams or
the number of findings, because it always says exactly six things. What bounds it is the topic list,
which is a stronger constraint than a word count.

---

## Running the checks

```bash
pnpm test          # every threshold assertion, including this document's agreement with the code
pnpm smoke         # cold start, against a running container
pnpm perf          # LCP and time-travel, against a running deployment, on the throttled profile
```

`pnpm perf` needs a browser and a running server, so it is not part of `pnpm test`: a unit-test runner
cannot measure a paint. It is a separate CI job for the same reason `pnpm smoke` is, and it **fails
rather than skips** when no browser is available — a performance gate that quietly passes when it
could not measure anything is worse than no gate, because it reports a number nobody took.
