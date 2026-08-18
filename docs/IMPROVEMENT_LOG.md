# Improvement log

What each autonomous improvement session did, what it cost, and what it changed — written by nous after every session.

## 2026-08-06 20:34 — auto session

- Rounds: 3 (3 approved, 0 rejected) · 1188.3 min · subscription (unmetered)
- Score: 55 → 77
- Effort mix: judge ×17, product ×7
- Round(s) 1 made the product WORSE and were auto-reverted — that work had negative value; their items need a different approach.
- Churn: "No hardcoded secrets: hardcoded secret in tools/eslint-plugin-compass/rules/no-credential-literal.js" was attacked in multiple rounds without being resolved — it needs a different approach (or a human).
- Churn: "Blueprint feature missing — the product is not complete without 'Seat management: invite, revoke, resend, role change' (done when: `/settings/members` listing pending and active members with invite, r" was attacked in multiple rounds without being resolved — it needs a different approach (or a human).
- Churn: "Blueprint feature missing — the product is not complete without ''Unattributed' bucket rendered as a question, never an accusation' (done when: Seeded data includes commits with no ticket reference; t" was attacked in multiple rounds without being resolved — it needs a different approach (or a human).
- Pipeline suggestion: Promote deploy-freshness from a scored work item to a hard precondition — auto-push and redeploy before any scoring runs, since the 'commits never pushed, every check judges the OLD version' item surfaced in both round 1 and round 3, meaning two of three rounds graded a stale build.
- Pipeline suggestion: Cap round wall-clock and require per-item commit+verify checkpoints: round 1 consumed 745 of 1188 minutes (63% of the session) for zero score movement and was auto-reverted, so a 2-3 hour ceiling with incremental verification would have surfaced the regression hours earlier instead of discarding a f
- Pipeline suggestion: Add a churn breaker that quarantines any item after its second unresolved attempt and forces a different approach — the eslint no-credential-literal hit is a scanner false positive that should be fixed in the scanner's allowlist rather than re-edited each round, and the two blueprint features (seat 
- Pipeline suggestion: Rebalance targeting away from the judge and toward real usage: the mix was 17 judge to 7 product while only 4.2 minutes went to recon and 54.6 to verify, yet product-usage probing found the session's most severe defects (43 dead /artifact/* routes, 'No data' on cold load, broken skip link) — run jou
