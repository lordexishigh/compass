# Build report — Compass

[![nous score](https://img.shields.io/badge/nous%20score-74%2F100-yellow)](#) ![readiness](https://img.shields.io/badge/readiness-caution-yellow)

**Overall: 74/100** · readiness: **caution** · **launch-ready** 🚀 · build verified ✓

**Live:** https://compass-in1avxuv1-lordexishighs-projects.vercel.app

## Quality dimensions

| Dimension | Score | |
|---|---:|---|
| Spec coverage | 66 | `█████████████░░░░░░░` |
| Code quality | 88 | `██████████████████░░` |
| Robustness & error handling | 70 | `██████████████░░░░░░` |
| Builds & tests | 90 | `██████████████████░░` |
| UX & design | 58 | `████████████░░░░░░░░` |

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

- The cold-open promise is delivered: `/` renders a fully narrated six-section report for the seeded org with no login, with a Data-freshness panel stating the real ingest window (2026-07-30 → 2026-07-31) and concrete per-section counts tied to named artifacts (PLAT-529, PLAT-754/755, pull-request-883) — the freshness and named-artifact journeys passed 7/7 and 8/8.
- Authorization is a single enumerable table (`packages/auth/src/matrix.ts`) with `public` modelled as a fifth principal and `demoOnlyPublic` scoping the zero-config page, held in place by a test that fails the build when any `app/api/**/route.ts` lacks an entry — the correct shape for 'checked server-side on every route'.
- The seed layer is genuinely deterministic and provider-neutral: `packages/seed-connector/src/generator.ts` expands checked-in fixtures with no host clock, no `Math.random`, and no locale-sensitive comparison, verified by regenerate-then-`git diff --exit-code`.
- Comments encode invariants and the reasoning behind rejected alternatives (why crawlability is editorial rather than derived from the matrix; why Sentry init is an exported options function), which makes the boundaries maintainable rather than merely present.

## To improve

- `apps/web/app/artifact/[kind]/[artifactId]/page.tsx` (1.4KB) and `apps/web/lib/artifact-source.ts` never complete — all 43 evidence targets fail to reach domcontentloaded in 45s. Give the lookup a bounded, indexed query keyed on (org, kind, artifactId) instead of materializing a snapshot per request, wrap it in an explicit timeout that renders the existing `StatedFailure` component on expiry, and make the page's own render path independent of report generation so it returns in under a second.
- `apps/web/app/layout.tsx` renders no navigation, which is why the crawl found exactly one reachable page while `app/archive/page.tsx`, `app/archive/merged/[reportDate]`, `app/weekly/page.tsx`, `app/merged/page.tsx`, `app/roster/page.tsx`, `app/goals/page.tsx` and `app/connect/page.tsx` all exist on disk. Add a persistent header linking the archive, merged report, weekly digest, goals, roster and connect screens, plus a team switcher, so the built surfaces are reachable from the front door.
- `components/time-travel-scrubber.tsx` and `app/api/time-travel/route.ts` are implemented but not mounted on the report view — `app/page.tsx` is 1.4KB and the crawl found 0 forms and 0 inputs, leaving the report frozen at 2026-07-31. Mount the scrubber in `app/page.tsx` (day-step buttons plus a date jump posting to the existing route) so the Release 2 slip can actually be walked through.
- The report body renders the literal string 'No data', failing the cold-read journey at step 12. Trace the empty branch in `apps/web/lib/view-model.ts` / `components/report-section.tsx` and replace it with either the real value or one of the authored sentences in `lib/empty-states.ts` — the app already has an honest-degradation vocabulary and this path bypasses it.
- The Manager Memos differentiator has no entry point in the web app: there is no memo route under `apps/web/app/api/` and no form component. Add the memo submission route plus a form on the report page that shows the typed assertion for confirmation, returns the plain 'I can't represent that yet' refusal for out-of-schema text, offers 2–3 candidates on low-confidence subject resolution, and renders the memo citation on the next report.

## Summary

A codebase of real engineering quality — enumerable authorization, a deterministic seed generator, and tests that assert invariants rather than restate constants — wired into an app that a user can barely traverse: one reachable page, 43 hanging evidence links, and a dozen implemented surfaces with no route into them. The work needed is integration and performance, not construction.

---
_Scored 2026-08-06 16:38 by [nous](https://github.com/lordexishigh/nous) — an LLM judge anchored by deterministic readiness checks; regenerated on every re-score._
