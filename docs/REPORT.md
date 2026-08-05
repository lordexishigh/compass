# Build report — Compass

[![nous score](https://img.shields.io/badge/nous%20score-55%2F100-red)](#) ![readiness](https://img.shields.io/badge/readiness-blocked-red)

**Overall: 55/100** · readiness: **blocked** · build verified ✓

**Live:** https://compass-in1avxuv1-lordexishighs-projects.vercel.app

## Quality dimensions

| Dimension | Score | |
|---|---:|---|
| Spec coverage | 89 | `██████████████████░░` |
| Code quality | 88 | `██████████████████░░` |
| Robustness & error handling | 85 | `█████████████████░░░` |
| Builds & tests | 93 | `███████████████████░` |
| UX & design | 84 | `█████████████████░░░` |

## Readiness checks

**Security**
- ❌ No hardcoded secrets — hardcoded secret in tools/eslint-plugin-compass/rules/no-credential-literal.js
- ✅ Secrets file ignored — .env present but gitignored
- ✅ Row-Level Security — RLS enabled on the schema

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

- The architecture guarantees are executable, not aspirational: `pnpm verify` runs dependency-cruiser before typecheck, the authz matrix test enumerates route files from disk so a new endpoint is a build failure until it declares who may call it, and the seed generator is checked for byte-identical regeneration via `seed:generate && git diff --exit-code`.
- The differentiators are genuinely built rather than gestured at — `packages/analysis/src/calibration.ts` computes the full statistic set against named thresholds and feeds projection confidence, and the completion ladder, report diff, and time-travel scrubber all exist as real components with tests.
- Tests exercise the production path at the HTTP surface against a real migrated database (PGlite) rather than mocking the guard, and several files exist specifically to keep a previously-shipped UI-reachability bug fixed (`second-factor-panel.test.tsx` covers a green endpoint suite over an unreachable 2FA flow).
- Auth and tenancy are broad and coherent: password + magic link + reset + 2FA with recovery codes, SSO/SAML/SCIM, session rotation on privilege change, org-scoped queries, and RLS enabled on the schema.

## To improve

- No hardcoded secrets: hardcoded secret in tools/eslint-plugin-compass/rules/no-credential-literal.js
- `tools/eslint-plugin-compass/rules/no-credential-literal.js` still trips the secret scanner on its own detection patterns — rebuild those literals from concatenated fragments or character classes and add a scoped `.gitleaks.toml` allowlist path entry for `tools/eslint-plugin-compass/rules/`, so the repo's own credential-hygiene gate stops being the one file that fails it.
- There is no LICENSE file at the repo root and `package.json` declares no `license` field, leaving reuse and ownership terms of a commercial product ambiguous — add the license file and the matching SPDX identifier to the root and every `packages/*/package.json`.
- Analytics/telemetry ship (`apps/web/instrumentation.ts`, `lib/error-reporting.ts`) with no consent gate, while `app/privacy/page.tsx` and `components/privacy-controls.tsx` already model per-channel privacy settings — add a consent banner rendered from `app/layout.tsx` that defers instrumentation initialisation until a stored choice exists, and wire it to the existing privacy settings route rather than a separate cookie.
- The web app has no `robots.txt` or sitemap, so the public marketing and legal surfaces (`/pricing`, `/legal/[slug]`, `/trust/subprocessors`) are undiscoverable while shared report permalinks (`/api/share/[token]`) and the archive have no crawl directive at all — add `apps/web/app/robots.ts` and `apps/web/app/sitemap.ts` that allow the marketing routes and explicitly disallow `/archive`, `/api`, and share-token paths.
- `apps/web/app/error.tsx` (1.4KB) is the only route-level error boundary in the app tree — add `error.tsx` boundaries under the data-heavy segments (`app/archive`, `app/merged`, `app/weekly`, `app/roster`, `app/connect`) so a failed server fetch degrades to a stated, section-scoped failure via `components/stated-failure.tsx` instead of blanking the whole page.

## Summary

A genuinely strong, unusually complete build: the promised connector port, deterministic seed, pure analysis layer, calibration audit, completion ladder, golden fixtures and full auth/tenancy stack all exist as real, tested code, and the verification and architecture gates are enforced in CI rather than claimed. What is left is perimeter polish — the self-tripping secret scan on its own lint rule, a missing license, no consent gate for shipped telemetry, absent crawl directives, and thin per-segment error boundaries.

---
_Scored 2026-08-06 00:43 by [nous](https://github.com/lordexishigh/nous) — an LLM judge anchored by deterministic readiness checks; regenerated on every re-score._
