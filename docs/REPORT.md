# Build report — Compass

[![nous score](https://img.shields.io/badge/nous%20score-25%2F100-red)](#) ![readiness](https://img.shields.io/badge/readiness-blocked-red)

**Overall: 25/100** · readiness: **blocked** · build verified ✓

**Live:** https://compass-7xzuh9wj8-lordexishighs-projects.vercel.app

## Quality dimensions

| Dimension | Score | |
|---|---:|---|
| Spec coverage | 74 | `███████████████░░░░░` |
| Code quality | 87 | `█████████████████░░░` |
| Robustness & error handling | 80 | `████████████████░░░░` |
| Builds & tests | 76 | `███████████████░░░░░` |
| UX & design | 71 | `██████████████░░░░░░` |

## Readiness checks

**Security**
- ⚠️ No hardcoded secrets — 15 in test fixtures only (not shipped code): hardcoded secret in apps/web/tests/demo-credentials.test.tsx; hardcoded secret in apps/web/tests/sso-routes.test.ts; hardcoded secret in apps/worker/tests/first-run.test.ts
- ✅ Secrets file ignored — no .env present
- ✅ Row-Level Security — RLS enabled on the schema
- ✅ Dependency vulnerabilities — no critical/high vulnerabilities in the last audit

**Quality**
- ✅ Automated tests — test files present
- ✅ No stub/placeholder code — no stub markers found
- ✅ Dependencies pinned — lockfile/requirements present
- ✅ License declared — license present
- ✅ Builds & tests pass — final smoke test passed
- ❌ App works at runtime — the product walkthrough could not be repeated (No page could be loaded.), so nothing about this app's behaviour has been verified — an unproven app is not a working one
- ✅ Accessibility basics — images have alt text

**Compliance**
- ✅ Dependency licenses — no copyleft conflicts found
- ✅ Privacy policy & terms — legal page present
- ✅ Cookie consent — consent mechanism present

**Growth**
- ✅ SEO & discoverability — meta tags, robots.txt and sitemap present

## Strengths

- The core value claim actually works at runtime: / opens cold with no login into a complete six-section report whose sprint math reconciles line-by-line (/artifact/sprint/sprint-PLAT-6 shows 19%, 4 of 21, 0 added, denominator 21) and whose every claim links to a live evidence page — all five executed journeys passed.
- Authorization is expressed as data, not scattered conditionals: packages/auth/src/matrix.ts holds the whole (principal × route × action) table including a `public` principal for the demo tenant, and tests/authz-matrix.test.ts enumerates app/api/**/route.ts from disk so a new endpoint fails the build until it declares who may call it.
- Determinism is engineered rather than asserted: packages/seed-connector/src/generator.ts expands checked-in fixtures with no host clock, no Math.random and no locale-sensitive comparison, verified by regenerate-and-git-diff, and tests inject now/sleep/fetch (tools/smoke/tests/probe.test.ts) so a 60-second budget is tested in milliseconds.
- The Process Calibration Audit is real and deep — packages/analysis/src/calibration.ts (53KB) computes its statistics against named thresholds from thresholds.js and emits evidence refs, so projections can be qualified by whether the underlying data carries information.

## To improve

- App works at runtime: the product walkthrough could not be repeated (No page could be loaded.), so nothing about this app's behaviour has been verified — an unproven app is not a working one
- apps/web/app/layout.tsx renders no navigation, so the substantial pages that exist on disk — app/archive/page.tsx, app/archive/[reportId], app/merged, app/weekly, app/goals, app/roster, app/settings/members, app/corrections — are unreachable from the report a user lands on; add a persistent header nav (plus links from report-document.tsx into archive/merged/weekly) so the built surfaces are actually navigable.
- components/time-travel-scrubber.tsx and the app/api/time-travel/route.ts handler exist but nothing mounts the scrubber on apps/web/app/page.tsx, leaving the report frozen at 2026-07-31; render it in the report header with day-step controls and a jump-to-date input bound to that route so the Release 2 slip can be watched developing across instants.
- components/memo-form.tsx and app/api/memos/route.ts exist yet the report page shipped 0 forms and 0 inputs; mount the memo form on apps/web/app/page.tsx and render its three response states — the typed assertion with its five-kind label, the 'I can't represent that yet' refusal for out-of-schema text, and the 2–3 candidate subject picker — plus the memo citation link in the sections it affects.
- The alignment tier is computed but has no rendered surface: report-document.tsx/report-section.tsx show no OFF-GOAL verdict, no confidence score, no link-tier label and no 'N commits could not be tied to a sprint objective' question, while components/alignment-evidence.tsx sits unused by the report view; add an alignment block to report-section.tsx that names the tier (structural | inferred | semantic) with its confidence and opens alignment-evidence.tsx for the matched link or text.
- Correction records are persisted (packages/db schema/history corrections, app/corrections/page.tsx) but never appear inline where the belief changed — the seeded 'reported blocked, actually merged' pathology surfaces nowhere in the report; emit the correction sentence inside the affected Blockers/Yesterday item in lib/view-model.ts with a link to /corrections, so the non-destructive reconciliation is visible in the report itself.

## Summary

A technically strong build — enforced module boundaries, a table-driven authz matrix with build-failing coverage tests, a deterministic seed generator, and a report whose arithmetic reconciles and whose claims cite real evidence pages — held back by a wiring problem rather than missing engineering: most of the spec exists in packages and components that the running app gives no route to, and the runtime readiness check could not reproduce the walkthrough at all. Ship the navigation, mount the scrubber, memo form and alignment/correction surfaces, and this moves from an impressive single page t

---
_Scored 2026-08-20 16:50 by [nous](https://github.com/lordexishigh/nous) — an LLM judge anchored by deterministic readiness checks; regenerated on every re-score._
