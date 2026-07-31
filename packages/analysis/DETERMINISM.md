# The determinism gate

Generating a report twice for the same `(organization, team, instant)` must produce **byte-identical**
structured JSON.

That is not a nice-to-have. It is the precondition for three things the product claims:

- **Time travel.** The scrubber re-runs the identical path for a past instant. If the path is not
  deterministic, "what did Tuesday look like" has no answer.
- **Golden fixtures.** `fixtures/reports/<team>/<date>.json` is only a regression test if a re-run
  reproduces it.
- **Trust.** A manager who reloads the page and sees a different number has no reason to believe
  either version.

The gate is `packages/analysis/tests/determinism.test.ts`, which calls `generateStructuredReport`
twice over one snapshot and compares `canonicalReportJson` of both. `packages/pipeline` runs the same
comparison across the full pipeline.

## The non-semantic allowlist

Exactly three fields are excluded from the comparison. They are excluded because they describe the
*run* rather than the *organization*, so two runs that differ only in these are the same report.

| Field | Why it is non-semantic |
| --- | --- |
| `generatedAt` | When generation happened. The report is *about* `instant`, which is compared. |
| `narrationTraceId` | Identifies the prompt/response trace row for this run's narration. |
| `runId` | Identifies the job that produced this row. |

Everything else is semantic: every count, every date, every ordering, every statement.

The list has exactly one definition in code — `NON_SEMANTIC_REPORT_FIELDS` in
`packages/analysis/src/determinism.ts` — which `packages/pipeline` re-exports as `NON_SEMANTIC_FIELDS`
rather than declaring its own. `tests/determinism.test.ts` parses the table above and fails if it and
the constant disagree, so this document cannot rot.

## The stable ordering keys

Every collection a report emits is sorted by an explicit total order that ends in a tie-break on a
unique key, so no sequence depends on the order the snapshot happened to be walked in. The keys are
declared next to the code that applies them; this is the index.

| Collection | Ordering key | Declared in |
| --- | --- | --- |
| Yesterday items | completion instant ascending, then unit-of-work key | `YESTERDAY_ORDER_KEY` in `src/yesterday.ts` |
| Blockers | age in days descending, then stable id | `detectBlockers` in `src/blockers.ts` |
| Risks | severity, then measured value descending, then stable id | `detectRisks` in `src/risks.ts` |
| Review queue | time in review descending, then age, then pull request key | `aggregateReviewQueue` in `src/review-queue.ts` |
| Per-reviewer depth | developer key ascending — never by depth | `aggregateReviewQueue` in `src/review-queue.ts` |
| Workload | developer key ascending — never by load | `assessWorkload` in `src/workload.ts` |
| Wins | completion instant ascending, then ticket key | `detectWins` in `src/wins.ts` |
| Recommendations | urgency, then source order, then stable id | `generateRecommendations` in `src/recommendations.ts` |
| Debt per sprint | sprint start ascending, then sprint key | `assessTechnicalDebt` in `src/technical-debt.ts` |
| Elapsed facts | day count descending, then stable id | `computeElapsedFacts` in `src/elapsed.ts` |

The two per-person orderings are alphabetical on purpose and enforced by `src/ranking-guard.ts`:
ordering people by a magnitude is what turns a distribution into a leaderboard.

The Yesterday section additionally has a **dedup key** — the unit of work, so a ticket and its merged
pull request collapse into one item naming both — declared as `YESTERDAY_DEDUP_KEY`, and a
**qualifying-event set** declared as `QUALIFYING_YESTERDAY_EVENTS`, both in `src/yesterday.ts`.

## What breaks byte-identity, in practice

`Math.random` is the obvious one and the least likely. These are the ones that actually happen:

- **`Map`, `Set` and `Object.keys` insertion order.** Anything built by iterating a map inherits the
  order rows were inserted, which is the order the loop happened to visit them. Every collection in a
  report is therefore sorted by an explicit total-order comparator before it is emitted.
- **`Array.prototype.sort` with no comparator.** It compares stringified values, so `[2, 10]` sorts to
  `[10, 2]`. Never used here; `compareNumbers` and `compareStable` are.
- **Unstable ties.** A comparator that returns `0` for two rows leaves their relative order to the
  engine. Every comparator in this package ends in a tie-break on a unique key.
- **`localeCompare` and `Intl`.** Locale-sensitive, and the ICU data ships with the container. Never
  used; `compareStable` compares code units.
- **`Date` parsing of unzoned strings.** Never used; instants are epoch millis throughout, and
  `utcCivilDate` formats by arithmetic rather than through `Date`.
- **`-0`.** Arithmetically equal to `0` but serialises as `-0`. Normalised by the serialiser.
- **Floating-point drift.** Every ratio in the output goes through `percent`, `basisPoints` or
  `scaled`, so what lands in the JSON is an integer or a fixed-scale decimal.

## Array order is never repaired

`canonicalReportJson` sorts object keys but leaves arrays alone, deliberately. If two runs disagree
about the order of the Yesterday items, that is a defect in the ordering key — the gate's job is to
fail on it, not to sort it away and hide it.
