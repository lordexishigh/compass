# Build report — Compass

[![nous score](https://img.shields.io/badge/nous%20score-55%2F100-red)](#) ![readiness](https://img.shields.io/badge/readiness-blocked-red)

**Overall: 55/100** · readiness: **blocked**

**Live:** https://compass-7xzuh9wj8-lordexishighs-projects.vercel.app

## Quality dimensions

| Dimension | Score | |
|---|---:|---|
| Spec coverage | 64 | `█████████████░░░░░░░` |
| Code quality | 86 | `█████████████████░░░` |
| Robustness & error handling | 68 | `██████████████░░░░░░` |
| Builds & tests | 24 | `█████░░░░░░░░░░░░░░░` |
| UX & design | 58 | `████████████░░░░░░░░` |

## Readiness checks

**Security**
- ⚠️ No hardcoded secrets — 15 in test fixtures only (not shipped code): hardcoded secret in apps/web/tests/demo-credentials.test.tsx; hardcoded secret in apps/web/tests/sso-routes.test.ts; hardcoded secret in apps/worker/tests/first-run.test.ts
- ✅ Secrets file ignored — .env present but gitignored
- ✅ Row-Level Security — RLS enabled on the schema
- ✅ Dependency vulnerabilities — no critical/high vulnerabilities in the last audit

**Quality**
- ✅ Automated tests — test files present
- ✅ No stub/placeholder code — no stub markers found
- ✅ Dependencies pinned — lockfile/requirements present
- ✅ License declared — license present
- ❌ Builds & tests pass — final product smoke test did not pass
- ✅ Accessibility basics — images have alt text

**Compliance**
- ✅ Dependency licenses — no copyleft conflicts found
- ✅ Privacy policy & terms — legal page present
- ✅ Cookie consent — consent mechanism present

**Growth**
- ✅ SEO & discoverability — meta tags, robots.txt and sitemap present

## Strengths

- The deterministic core is real, not narrated: `packages/seed-connector/src/generator.ts` expands checked-in fixtures into ~3,000 records with no host clock, no Math.random and no locale-sensitive ordering, self-checking so `pnpm seed:generate && git diff --exit-code` is the determinism proof.
- Authorization is expressed as one enumerable table (`packages/auth/src/matrix.ts`) with `public` modelled as a fifth principal confined to the demo tenant, and `tests/authz-matrix.test.ts` walks every role × route × action triple and fails the build for any `app/api/**/route.ts` with no entry.
- The Manager Memo differentiator is properly layered: `app/api/memos/route.ts` decides nothing, delegating extraction, refusal and subject resolution to `@compass/memos` so the web form and the inbound email path cannot disagree about what Compass will represent.
- The rendered report is honest about its own limits — the data-freshness panel states its ingest window and explains the seeded history ends 2026-07-31 rather than silently showing stale data as current.

## To improve

- Builds & tests pass: final product smoke test did not pass
- `/` server-renders by regenerating the report through the live pipeline on every request, which blows past a 45s navigation timeout and fails all five journeys — materialize the seeded org's report into the `reports` table at seed time (`packages/db/src/first-run.ts`) and have `apps/web/lib/report-source.ts` read the persisted row, regenerating only on cache miss, so the cold-start page is a database read.
- `apps/web/app/artifact/[kind]/[artifactId]/page.tsx` is 1.4KB over `lib/artifact-source.ts` and never renders — all 43 cited Jira keys, PR numbers and sprint links time out. Make artifact lookup a single indexed query against the knowledge-model rows for that entity id instead of building or scanning a snapshot per request, and add a `notFound()` path so an unknown id returns 404 fast rather than hanging.
- `apps/web/app/layout.tsx` renders no navigation, so the archive, weekly, merged and roster pages that exist on disk are unreachable from the product — add a header linking `/archive`, `/weekly`, `/merged`, `/roster`, `/goals`, and a team switcher wired to `components/team-switcher.tsx` so a manager can leave the single report page.
- `components/time-travel-scrubber.tsx` posts to `/api/time-travel` but never yields a second, linkable page — give the report a date-parameterized route (e.g. `/report/[teamKey]/[date]`) that the scrubber navigates to, so stepping days produces distinct permalinks and the Release 2 slip is observable as one stable item ID across dates.
- Nothing in the repo gates the runtime budget the spec promises — add a test that boots the built app and asserts `/` and a sample `/artifact/...` respond under a fixed threshold, wired into `.github/workflows/ci.yml`, so a regression that makes the page unopenable fails the build instead of passing 2,496 unit tests.

## Summary

An unusually well-architected codebase — pure analysis layer, deterministic seed generator, one enumerable permission matrix, the memo differentiator properly packaged — undermined by a runtime that fails everything: the smoke test does not pass, `/` times out at 45s, every evidence link is dead, and the dozens of pages present on disk are unreachable. This is a strong engine behind a door that will not open; the fix is performance and navigation, not more features.

---
_Scored 2026-08-07 18:20 by [nous](https://github.com/lordexishigh/nous) — an LLM judge anchored by deterministic readiness checks; regenerated on every re-score._
