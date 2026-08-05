# Build report — Compass

[![nous score](https://img.shields.io/badge/nous%20score-55%2F100-red)](#) ![readiness](https://img.shields.io/badge/readiness-blocked-red)

**Overall: 55/100** · readiness: **blocked** · build verified ✓

**Live:** https://compass-in1avxuv1-lordexishighs-projects.vercel.app

## Quality dimensions

| Dimension | Score | |
|---|---:|---|
| Spec coverage | 88 | `██████████████████░░` |
| Code quality | 87 | `█████████████████░░░` |
| Robustness & error handling | 82 | `████████████████░░░░` |
| Builds & tests | 92 | `██████████████████░░` |
| UX & design | 85 | `█████████████████░░░` |

## Readiness checks

**Security**
- ❌ No hardcoded secrets — hardcoded secret in apps/web/tests/edge-failure.test.ts; hardcoded secret in apps/web/tests/feedback-loop.test.ts; hardcoded secret in apps/web/tests/feedback-routes.test.ts; hardcoded secret in apps/web/tests/login-path.test.ts; hardcoded secret in apps/web/tests/login-route.test.ts
- ✅ Secrets file ignored — .env present but gitignored
- ❌ Row-Level Security — Supabase tables created but no 'enable row level security' — data may be public

**Quality**
- ✅ Automated tests — test files present
- ✅ No stub/placeholder code — no stub markers found
- ✅ Dependencies pinned — lockfile/requirements present
- ⚠️ License declared — no LICENSE file or declared license — ownership/reuse terms are ambiguous
- ✅ Builds & tests pass — final smoke test passed
- ✅ Accessibility basics — images have alt text

**Compliance**
- ✅ Dependency licenses — no copyleft conflicts found
- ✅ Privacy policy & terms — legal page present
- ⚠️ Cookie consent — analytics/trackers present but no cookie-consent mechanism found

**Growth**
- ⚠️ SEO & discoverability — missing: robots.txt, sitemap

## Strengths

- The determinism and purity promises are enforced mechanically, not asserted in prose: dependency-cruiser architecture rules, an arch test failing on I/O or time imports inside `packages/analysis`, byte-identical regeneration checked across processes, and 40 golden fixtures with a reviewable `golden:update` diff.
- The hard differentiators are real implementations, not sketches — `packages/analysis/src/calibration.ts` computes the full statistic set against named thresholds in `thresholds.ts` and feeds projection confidence, and the completion ladder, memos, and report-diff engine each have their own module plus UI component.
- Tenancy and authorization are tested at the boundary that matters: `tests/authz-matrix.test.ts` and `tests/two-org-isolation.test.ts` exercise the four-role matrix and cross-org isolation per route rather than trusting a middleware comment.
- Security posture is documented and diffed against the code — middleware owns all six response headers with a per-response nonce, `next.config.ts` is asserted to declare none, and `security-posture.test.ts` fails when `docs/ENGINEERING.md` drifts from the module.

## To improve

- Row-Level Security: Supabase tables created but no 'enable row level security' — data may be public
- No hardcoded secrets: hardcoded secret in apps/web/tests/edge-failure.test.ts; hardcoded secret in apps/web/tests/feedback-loop.test.ts; hardcoded secret in apps/web/tests/feedback-routes.test.ts; hardcoded secret in apps/web/tests/login-path.test.ts; hardcoded secret in apps/web/tests/login-route.test.ts
- No Jira self-serve connect exists: add `apps/web/app/api/connect/jira/{install,callback,disconnect}/route.ts` mirroring the GitHub triple, a per-project/board scoping selector in `apps/web/app/connect/page.tsx`, and a `JiraConnector` implementing the `@compass/connector-port` query port so the ticket, sprint and transition records the report already cites can come from a manager's own board.
- No Slack workspace install flow exists — only `api/slack/actions/route.ts` and the generic `api/webhooks/[provider]` receiver — so the Block Kit feedback and DM delivery paths cannot be authorized by a manager; add a Slack OAuth install/callback route pair plus channel and DM selection persisted alongside the delivery subscription rows in `apps/worker/src/delivery.ts`.
- Add PostgreSQL row-level security to the Drizzle migrations as defense in depth behind the scoped-query layer: enable RLS on every `organization_id`-bearing table with a policy bound to a per-connection `app.current_org` setting, and have the scoped-query layer set it, so an unscoped query added later returns zero rows instead of another org's.
- Remove the credential literals the secret scan still flags in `apps/web/tests/{edge-failure,feedback-loop,feedback-routes,login-path,login-route}.test.ts` — hoist them into a single `tests/helpers/test-secrets.ts` that derives values at runtime, so gitleaks passes without an allowlist entry per file.
- Break up the three modules that have outgrown review: split `packages/seed-connector/src/generator.ts` (84KB) into per-record-family generators behind the existing self-check, split `packages/analysis/src/calibration.ts` (54KB) one file per statistic with the verdict mapping kept in a thin composer, and decompose `apps/web/components/roster-screen.tsx` (44KB) into identity-queue, merge/un-merge and absence panels.
- Close the remaining launch-hygiene gaps the checks name: add a top-level LICENSE (and a `license` field in the workspace `package.json`), a cookie-consent gate for the analytics path, and `robots.txt` plus a sitemap route for the public `/pricing`, `/legal` and `/trust` pages.

## Summary

A genuinely strong, verifiable build: the layered monorepo, injected clock, pure analysis layer, determinism gate and golden fixtures are enforced by the build rather than claimed, and the differentiators (calibration audit, completion ladder, manager memos, report diff) exist as real tested modules behind a coherent prose-document UI. The gaps are the failed live-connector work — no Jira or Slack self-serve install, so the product cannot yet leave the seeded org — plus a few hardening items: application-only org scoping with no RLS backstop, test-file secret literals, and three oversized modu

---
_Scored 2026-08-05 17:46 by [nous](https://github.com/lordexishigh/nous) — an LLM judge anchored by deterministic readiness checks; regenerated on every re-score._
