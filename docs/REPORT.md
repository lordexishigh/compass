# Build report — Compass

[![nous score](https://img.shields.io/badge/nous%20score-55%2F100-red)](#) ![readiness](https://img.shields.io/badge/readiness-blocked-red)

**Overall: 55/100** · readiness: **blocked**

**Live:** https://compass-in1avxuv1-lordexishighs-projects.vercel.app

## Quality dimensions

| Dimension | Score | |
|---|---:|---|
| Spec coverage | 88 | `██████████████████░░` |
| Code quality | 88 | `██████████████████░░` |
| Robustness & error handling | 80 | `████████████████░░░░` |
| Builds & tests | 35 | `███████░░░░░░░░░░░░░` |
| UX & design | 86 | `█████████████████░░░` |

## Readiness checks

**Security**
- ⚠️ No hardcoded secrets — 16 in test fixtures only (not shipped code): hardcoded secret in apps/web/tests/demo-credentials.test.tsx; hardcoded secret in apps/web/tests/sso-routes.test.ts; hardcoded secret in apps/worker/tests/first-run.test.ts
- ✅ Secrets file ignored — .env present but gitignored
- ✅ Row-Level Security — RLS enabled on the schema

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
- ⚠️ SEO & discoverability — missing: robots.txt, sitemap

## Strengths

- Provider neutrality is structural, not aspirational: `packages/connector-port` defines the time-windowed query port, the 85KB `seed-connector` generator implements it deterministically (self-checking, no host clock, no `Math.random`), and the `app/api/connect/[provider]/{install,callback,scope,disconnect}` route family plus `api/webhooks/[provider]` lets live sources drop in as configuration.
- Authorization is one enumerable table (`packages/auth/src/matrix.ts`) including `public` and `demoOnlyPublic` as first-class principals, with `tests/authz-matrix.test.ts` walking every role×route×action triple and failing the build when a new route handler has no entry — the zero-config public report is expressed *in* the matrix instead of bypassing it.
- Privacy and observability are wired to each other rather than bolted on: `lib/error-reporting.ts` exposes `sentryOptions()` so `tests/error-reporting.test.ts` pushes a worst-case event (bearer token, session cookie, commit message, ticket comment) through the real `beforeSend`, and `packages/db/src/repositories/privacy.ts` (53KB) enumerates every entity table for retention purge, anonymization and deletion.
- The no-individual-ranking stance is enforced by a source scan, not a convention: `tests/privacy.test.ts` greps the transparency page's own source for ranking/comparison/score language precisely because no rendering test would catch a future "compared to the team average" line.

## To improve

- Builds & tests pass: final product smoke test did not pass
- The final smoke test fails, which means the headline zero-config promise is unproven end to end: harden and prove the cold-start chain `apps/web/app/page.tsx` → `lib/first-run-source.ts` → `packages/db/src/first-run.ts` by adding a CI job that boots the compose stack against an empty volume and asserts `/` returns 200 with all six section headings inside 60s, and make any failure in that chain render `components/stated-failure.tsx` with the actual cause instead of throwing.
- `apps/web/app/` has `error.tsx` and `not-found.tsx` but no `global-error.tsx`, and no segment-level `error.tsx`/`loading.tsx` under `/archive`, `/merged`, `/weekly` or `/roster` — a throw inside the Server Component loaders (`lib/archive-source.ts`, `lib/view-model.ts` at 38KB, `lib/roster-source.ts`) escapes to a generic full-page replacement or a broken root render; add the root `global-error.tsx` plus per-segment boundaries that degrade to the honest-degradation copy in `lib/empty-states.ts`.
- No `robots.txt` or sitemap exists, and this app publishes tokenized share permalinks — add `apps/web/app/robots.ts` and `apps/web/app/sitemap.ts` that allow only the marketing/legal surfaces (`/pricing`, `/legal/[slug]`, `/trust/subprocessors`) and emit `X-Robots-Tag: noindex, nofollow` from `lib/security-headers.ts` for `/api/share/[token]`, `/archive/**` and `/api/feedback/link/[token]` so org report content cannot be indexed.
- Sixteen credential literals remain in test files (`apps/web/tests/demo-credentials.test.tsx`, `apps/web/tests/sso-routes.test.ts`, `apps/worker/tests/first-run.test.ts`) even though `apps/web/tests/helpers/fixture-credentials.ts` already exists as the factory for exactly this — route those tests through the helper and add the corresponding scoped allowlist paths to `.gitleaks.toml` so the scanner reports clean instead of WARN.

## Summary

An unusually complete and architecturally disciplined build — layer-scoped packages with enforced boundaries, a deterministic seed and pure analysis core, a single enumerable authz matrix, and privacy/observability held to source-scanning tests — but the assembled product's smoke test fails, so the one claim that matters most (a clean checkout renders a real report) is currently unverified. Fix the cold-start path and its boundaries, and this grades far higher.

---
_Scored 2026-08-06 13:08 by [nous](https://github.com/lordexishigh/nous) — an LLM judge anchored by deterministic readiness checks; regenerated on every re-score._
