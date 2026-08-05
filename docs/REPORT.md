# Build report — Compass

[![nous score](https://img.shields.io/badge/nous%20score-55%2F100-red)](#) ![readiness](https://img.shields.io/badge/readiness-blocked-red)

**Overall: 55/100** · readiness: **blocked**

**Live:** https://compass-in1avxuv1-lordexishighs-projects.vercel.app

## Quality dimensions

| Dimension | Score | |
|---|---:|---|
| Spec coverage | 84 | `█████████████████░░░` |
| Code quality | 87 | `█████████████████░░░` |
| Robustness & error handling | 76 | `███████████████░░░░░` |
| Builds & tests | 26 | `█████░░░░░░░░░░░░░░░` |
| UX & design | 82 | `████████████████░░░░` |

## Readiness checks

**Security**
- ❌ No hardcoded secrets — GitHub token in apps/web/tests/token-storage.test.ts; hardcoded secret in apps/worker/tests/cold-start.test.ts; hardcoded secret in packages/auth/src/bootstrap.ts; GitHub token in packages/auth/tests/integration-tokens.test.ts; hardcoded secret in packages/auth/tests/password.test.ts
- ✅ Secrets file ignored — .env present but gitignored
- ✅ Row-Level Security — RLS enabled on the schema

**Quality**
- ✅ Automated tests — test files present
- ✅ No stub/placeholder code — no stub markers found
- ✅ Dependencies pinned — lockfile/requirements present
- ⚠️ License declared — no LICENSE file or declared license — ownership/reuse terms are ambiguous
- ❌ Builds & tests pass — final product smoke test did not pass
- ✅ Accessibility basics — images have alt text

**Compliance**
- ✅ Dependency licenses — no copyleft conflicts found
- ✅ Privacy policy & terms — legal page present
- ⚠️ Cookie consent — analytics/trackers present but no cookie-consent mechanism found

**Growth**
- ⚠️ SEO & discoverability — missing: robots.txt, sitemap

## Strengths

- The pure/impure boundary is real and mechanically defended: `packages/analysis` takes a snapshot plus an instant (its own `instant.js`, no clock import), `packages/seed-snapshot` exists specifically so the golden-fixture and determinism gates can project the seeded org without a forbidden cross-package test import, and dependency-cruiser plus `workspace-layout.test.ts`/`provider-neutrality.test.ts` fail the build on violations.
- Tenancy is enforced at one chokepoint rather than per-route: `ScopedInsert` structurally removes `organizationId` from caller-supplied values, `insertInto` re-checks at runtime with `CrossOrgWriteError`, `ScopedSelect.toSQL()` is exposed so tests can assert the org predicate is present, and append-only history tables reject updates via `AppendOnlyTableError`.
- The Process Calibration Audit is fully implemented rather than gestured at — 53KB computing the trailing-sprint statistic set with evidence refs (`ticketEvidence`, `sprintEvidence`) and named threshold IDs, so projection confidence is derived from documented verdicts instead of asserted.
- The seed dataset is a checked-in deterministic generator with a self-check: no host clock, no `Math.random`, no locale-sensitive comparison, and `pnpm seed:generate` followed by `git diff --exit-code` as the property test, with commit traceability deliberately classified into clean/branch-hint/semantic/untraceable classes.

## To improve

- Builds & tests pass: final product smoke test did not pass
- No hardcoded secrets: GitHub token in apps/web/tests/token-storage.test.ts; hardcoded secret in apps/worker/tests/cold-start.test.ts; hardcoded secret in packages/auth/src/bootstrap.ts; GitHub token in packages/auth/tests/integration-tokens.test.ts; hardcoded secret in packages/auth/tests/password.test.ts
- Move the hardcoded secret out of `packages/auth/src/bootstrap.ts` — it is production source, not a fixture — into a required environment variable that fails fast with a named-variable error at startup (mirroring the `RESEND_API_KEY` pattern in `packages/delivery/src/transport.ts`), and add a lint/test rule over `packages/*/src/**` so a literal credential in shipped source fails the build the way the architecture rules already fail a bad import.
- The final smoke test is still red while `pnpm verify` is reported green, which means the gates do not cover the assembled artifact: add a smoke job that runs the documented cold-start path end to end (`apps/worker/src/cold-start.ts` → `packages/db/src/first-run.ts` → `next build` → GET `/` asserting a rendered six-section report) and make it a required check, so the build-versus-product gap cannot recur silently. Delete the committed `apps/web/tsconfig.tsbuildinfo` and gitignore it, since a stale incremental-build artifact in the tree can make a local typecheck disagree with a clean checkout.
- Jira self-serve connect is still absent in the current tree — there is no `apps/web/app/api/connect/jira/` directory at all, only the GitHub triple. Add `install`/`callback`/`disconnect` routes for Atlassian 3LO with Cloud site selection, a board/project scoping selector in `apps/web/app/connect/page.tsx`, and a `JiraConnector` implementing the `@compass/connector-port` time-windowed query port so ticket ingest can come from a live board without touching the knowledge model.
- Slack workspace install is still missing: `api/slack/actions/route.ts` handles interactions and `packages/delivery/src/slack.ts` renders Block Kit, but with no OAuth install/callback pair a manager cannot authorize the workspace, so DM delivery and Block Kit feedback are unreachable in a real deployment. Add `api/connect/slack/{install,callback}` with signed-state verification, store the bot token per organization, and add a channel/DM picker persisted alongside the delivery subscription.
- Add per-repository scoping after GitHub install — nothing beyond `install`/`callback`/`disconnect` selects repos — so ingest can be restricted to the repos a team owns rather than the whole installation; persist the selection on `trackedRepositories` (already in the schema) and surface it in the connect page.
- Close the two remaining launch-readiness gaps that are one file each: add a `LICENSE` file and a `license` field in the root `package.json` (ownership terms are currently ambiguous), and add `apps/web/app/robots.ts` plus `apps/web/app/sitemap.ts` covering `/pricing`, `/legal/*` and `/trust/subprocessors` so the public marketing surface is indexable.

## Summary

A genuinely deep, architecturally disciplined build — the pure analysis layer, calibration audit, deterministic seed generator, scoped-query tenancy layer and golden-fixture suite are all real, substantial code rather than scaffolding — but it cannot be called shippable while the final product smoke test fails and a hardcoded secret sits in `packages/auth/src/bootstrap.ts`. The largest functional gap against its own pitch is connectivity: two of the three named sources (Jira, Slack) have no self-serve connect path, so the live-data story remains unbuilt.

---
_Scored 2026-08-05 19:56 by [nous](https://github.com/lordexishigh/nous) — an LLM judge anchored by deterministic readiness checks; regenerated on every re-score._
