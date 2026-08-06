# Build report — Compass

[![nous score](https://img.shields.io/badge/nous%20score-77%2F100-yellow)](#) ![readiness](https://img.shields.io/badge/readiness-caution-yellow)

**Overall: 77/100** · readiness: **caution** · **launch-ready** 🚀 · build verified ✓

**Live:** https://compass-in1avxuv1-lordexishighs-projects.vercel.app

## Quality dimensions

| Dimension | Score | |
|---|---:|---|
| Spec coverage | 72 | `██████████████░░░░░░` |
| Code quality | 88 | `██████████████████░░` |
| Robustness & error handling | 76 | `███████████████░░░░░` |
| Builds & tests | 90 | `██████████████████░░` |
| UX & design | 60 | `████████████░░░░░░░░` |

## Readiness checks

**Security**
- ⚠️ No hardcoded secrets — 15 in test fixtures only (not shipped code): hardcoded secret in apps/web/tests/demo-credentials.test.tsx; hardcoded secret in apps/web/tests/sso-routes.test.ts; hardcoded secret in apps/worker/tests/first-run.test.ts
- ✅ Secrets file ignored — .env present but gitignored
- ✅ Row-Level Security — RLS enabled on the schema

**Quality**
- ✅ Automated tests — test files present
- ✅ No stub/placeholder code — no stub markers found
- ✅ Dependencies pinned — lockfile/requirements present
- ✅ License declared — license present
- ✅ Builds & tests pass — final smoke test passed
- ✅ Accessibility basics — images have alt text

**Compliance**
- ✅ Dependency licenses — no copyleft conflicts found
- ✅ Privacy policy & terms — legal page present
- ✅ Cookie consent — consent mechanism present

**Growth**
- ✅ SEO & discoverability — meta tags, robots.txt and sitemap present

## Strengths

- The determinism story is real, not claimed: packages/seed-connector/src/generator.ts expands checked-in fixtures with no host clock, Math.random or locale-sensitive comparison, and byte-identical output is enforced by seed:generate followed by git diff --exit-code, backed by 40 golden report fixtures.
- Authorization is one enumerable table (packages/auth/src/matrix.ts) with 'public' modelled as a fifth principal rather than a bypass, and apps/web/tests/authz-matrix.test.ts reads route files off disk so a new endpoint is a build failure until it declares who may call it.
- The Manager Memo differentiator is now reachable end to end — memo-form.tsx renders the extracted assertion as typed fields, the REFUSAL_SENTENCE comes from @compass/memos rather than a literal, and memo-window.test.ts pins the civil-date formatting at the route boundary.
- The rendered report tells the truth about its own data: the freshness panel states the exact ingest window and explains that the seeded history ends 2026-07-31, instead of silently presenting stale data as current.

## To improve

- Rendering / takes over 45 seconds because apps/web/app/page.tsx runs the full pipeline through lib/report-source.ts on every request — persist the generated report row and serve it from packages/db/src/repositories/reports.ts, regenerating only on a cache miss, and add an app/loading.tsx streaming boundary so the six-spine shell paints before the analysis completes.
- apps/web/app/artifact/[kind]/[artifactId]/page.tsx exists but every one of the 43 cited targets (/artifact/issue/PLAT-754, /artifact/pull_request/pull-request-883, /artifact/sprint/sprint-PLAT-6) times out — lib/artifact-source.ts is resolving artifacts by rebuilding the whole seeded run instead of a keyed lookup; index the artifacts by id at ingest and fetch one row, so evidence pages open in under a second.
- apps/web/app/layout.tsx renders no navigation, so /archive, /weekly, /merged and /roster are unreachable from the report even though the pages are built — add a persistent header linking the archive, weekly digest, merged cross-team report and roster, and put the team switcher in it so a manager can leave the single day they land on.
- The time-travel control in components/time-travel-scrubber.tsx mutates state in place with no addressable URL — make day-step and jump-to-date push a /?at=YYYY-MM-DD (or /archive/[reportDate]) route that regenerates through the pipeline server-side, so a reviewer can link to, share and step through the Release 2 slip.
- Nothing bounds the cost of report generation when a request is slow: add a deadline to the pipeline call in lib/report-source.ts that falls back to the last persisted report with a visible 'showing the last completed run' notice, so a slow or failed regeneration degrades honestly instead of hanging the navigation.

## Summary

Engineering-wise this is a genuinely strong build — layered packages under an enforced architecture gate, a deterministic seed and golden-fixture suite, a table-driven authz matrix, and a green verification across ~2.5k tests — but it is not usable: the single page a manager can reach takes longer than the cold-start promise allows, and every evidence link and secondary page behind it is unreachable in practice. The remaining gap is delivery and performance, not features.

---
_Scored 2026-08-06 20:31 by [nous](https://github.com/lordexishigh/nous) — an LLM judge anchored by deterministic readiness checks; regenerated on every re-score._
