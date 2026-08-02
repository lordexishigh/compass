# Prose budgets

Compass is a document, not a dashboard, and the one thing that decides whether a manager reads it
tomorrow is its length. So the limits are numbers enforced in code, not intentions stated here.

## The merged cross-team report: 400 words

**The budget is 400.** It lives in `MERGED_REPORT_WORD_BUDGET` in
`packages/analysis/src/budgets.ts`, and this document quotes it rather than defining it —
`tools/quality-gates/tests/budgets.test.ts` fails if the two stop agreeing. A number written in prose
beside a number written in code is two sources of truth, and the one that drifts is always the prose.

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

## The weekly digest: no word budget

Deliberately unbudgeted, and that is not an oversight. The weekly is read once a week at a desk rather
than once a day on a phone, and its six topics are fixed: it cannot grow with the number of teams or the
number of findings, because it always says exactly six things. What bounds it is the topic list, which
is a stronger constraint than a word count.

## Per-team daily reports: bounded by construction

`MAX_SENTENCES_PER_ITEM` (3) in `packages/renderers/src/prose.ts` and `maxItemsPerSection` (12) in
`AnalysisConfig` bound the daily without a word count. The claim, the change clause and the evidence
chain are the three sentences an item may have; the structured payload keeps every detail the prose
leaves out.
