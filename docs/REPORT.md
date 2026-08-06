# Build report — Compass

[![nous score](https://img.shields.io/badge/nous%20score-76%2F100-yellow)](#) ![readiness](https://img.shields.io/badge/readiness-caution-yellow)

**Overall: 76/100** · readiness: **caution** · **launch-ready** 🚀 · build verified ✓

**Live:** https://compass-in1avxuv1-lordexishighs-projects.vercel.app

## Quality dimensions

| Dimension | Score | |
|---|---:|---|
| Spec coverage | 76 | `███████████████░░░░░` |
| Code quality | 87 | `█████████████████░░░` |
| Robustness & error handling | 68 | `██████████████░░░░░░` |
| Builds & tests | 89 | `██████████████████░░` |
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

- The determinism and purity constraints are enforced by the build, not by convention: an injected `Clock` port (`instantFromIso`, `Instant` as epoch millis) threaded through generation, a dependency-cruiser gate over 362 modules, and a seed generator that is byte-reproducible under `pnpm seed:generate && git diff --exit-code`.
- Authorization is expressed as one enumerable table (`packages/auth/src/matrix.ts`) with `public` modelled as a fifth principal scoped by `demoOnlyPublic`, and `tests/authz-matrix.test.ts` walks every role × route × action triple and fails the build for any `app/api/**/route.ts` with no entry — new endpoints cannot ship unguarded.
- The Manager Memo differentiator is fully wired end to end: `POST /api/memos` delegates all decisions to `@compass/memos` (`extractMemo`, `resolveSubject`, `submitMemo`), the refusal comes from the shared `REFUSAL_SENTENCE` constant so email and web cannot diverge, and `memo-form.tsx` renders the typed assertion back as fields plus the candidate picker.
- Test quality goes beyond coverage counting — `tests/memo-window.test.ts` exists specifically because a hand-written fixture masked raw epoch millis leaking to the screen, and it pins the formatting at the boundary while the component test pins the rendering, so no pairing of the two can regress.

## To improve

- `/` regenerates the report through the live pipeline on every request and blows past 45s, failing all five user journeys — precompute and persist the rendered report per (org, team, instant) at ingest/schedule time in `apps/worker`, have `apps/web/lib/report-source.ts` read that stored row instead of materializing a snapshot and re-running analysis on the request path, and add an explicit server-side deadline that returns the last stored report with a staleness note rather than hanging.
- Every cited evidence link is dead: all 43 `/artifact/{kind}/{id}` URLs (e.g. `/artifact/issue/PLAT-754`, `/artifact/pull_request/pull-request-883`, `/artifact/sprint/sprint-PLAT-6`) never render. `apps/web/app/artifact/[kind]/[artifactId]/page.tsx` is only 1.4KB against a 4.7KB `lib/artifact-source.ts`, so fix the lookup to query the artifact by id directly (indexed, org-scoped) instead of loading or replaying the surrounding dataset, and add a route-level test that asserts a rendered artifact page for each kind the report links to.
- Nothing on the report page links to the pages that already exist — `/archive`, `/merged`, `/weekly`, `/goals`, `/roster`, `/settings/members` were all unreachable in the crawl. Add persistent navigation in `apps/web/app/layout.tsx` (and a team switcher wired to `components/team-switcher.tsx` on the report itself) so the archive, merged cross-team report, weekly digest and configuration surfaces are reachable from `/` in one click.
- The time-travel control produces no addressable second report: `components/time-travel-scrubber.tsx` posts to `/api/time-travel` but no date-parameterized report URL was ever reached. Make day-step and jump-to-date navigate to a distinct linkable route (e.g. `/reports/[teamKey]/[date]`) rendered by the same pipeline, so the Release 2 slip can be walked day by day and each instant shared.
- There is no end-to-end proof that the 57 buttons on `/` do anything: the feedback loop and memo form are only covered by unit/route tests. Add a Playwright-level test that dismisses a risk with a reason, rejects a recommendation and snoozes a blocker, reloads, and asserts the change persists and the next generated report reflects it — the entity-keyed suppression logic is the product's stickiness claim and is currently unexercised against the running app.

## Summary

Compass is an unusually well-engineered codebase — pure layered packages, an injected clock, a build-enforced permission matrix, golden fixtures and ~2,500 passing tests — whose runtime is a single page that takes longer than 45 seconds to open and whose every cited evidence link is dead. The spec is largely implemented in code but only a fraction of it is reachable by a user, so the gap to shippable is performance and navigation, not features.

---
_Scored 2026-08-06 20:32 by [nous](https://github.com/lordexishigh/nous) — an LLM judge anchored by deterministic readiness checks; regenerated on every re-score._
