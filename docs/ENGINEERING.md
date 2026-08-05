# Engineering — How this project is built

This project was built by **nous**, an autonomous development pipeline modelled on how
the best-run engineering organisations operate. These are the principles its agents work
under — and a good baseline for anyone continuing the project.

## Operating principles

- **Work backwards from the user.** Start from the outcome and who it's for (Amazon's
  working-backwards). Features exist to serve a real user need, stated plainly.
- **Design before code.** Architecture and (for anything user-facing) a design brief are
  written and agreed before implementation — decisions are made on purpose, not by accident.
- **One owner per piece.** Every task has a single directly-responsible agent; reviews are
  done by a *different* agent than the author (separation of build and check).
- **Improvement over perfection.** Code review approves work that genuinely improves the
  product and meets the task's acceptance criteria; it flags real bugs, not stylistic nits or
  speculative future-proofing. Solve today's known problem, not an imagined one.
- **Current and non-deprecated.** Use the modern, recommended APIs for each library's current
  major version — never legacy "old way" patterns.
- **Ship real, working software.** No stubs, TODOs, or mocked returns standing in for the
  implementation the acceptance criteria require. The code runs.
- **Craft is part of the spec.** For user-facing work, "beautiful and polished" is a
  requirement, not a nice-to-have. Consistency comes from shared design tokens, not ad-hoc styles.
- **Make assumptions visible.** When the spec leaves a decision open, pick the most reasonable
  option that fits existing conventions and state the assumption — never silently guess.
- **Verify, then trust.** The assembled product is installed, built, and tested before it's
  considered done; failures are fixed, not papered over.

## Security posture

Every value in this section is quoted from a constant in the code, and
`tools/quality-gates/tests/security-posture.test.ts` diffs this prose against those constants.
If the two disagree the build fails — so this is a specification, not a description that can
drift.

### The six response headers

Set by `apps/web/middleware.ts` from `apps/web/lib/security-headers.ts`, on every response to
every path except immutable build output (`_next/static`, `_next/image`, `favicon.ico`).
`next.config.ts` deliberately declares no `headers()`: a header declared in both places is
emitted twice, and browsers intersect the two policies.

| Header | Value |
| --- | --- |
| `Content-Security-Policy` | see below — includes `frame-ancestors 'none'`, no `unsafe-inline` in `script-src` |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |
| `X-Frame-Options` | `DENY` |

`preload` is a commitment as well as a protection: it asks browser vendors to ship the domain
in a preload list so the *first* request is HTTPS, and it means the domain cannot serve plain
HTTP again without waiting out that list.

The CSP is nonce-based. The middleware generates 16 bytes of `crypto.getRandomValues` per
response, sets it on the response CSP *and* on the request's `Content-Security-Policy` header —
which is how Next.js finds it and stamps the same nonce onto its own inline bootstrap and
chunk-loading scripts. `script-src` is `'self' 'nonce-…' 'strict-dynamic'` with no
`unsafe-inline` and no `unsafe-eval`.

One relaxation, stated rather than hidden: `style-src` keeps `'unsafe-inline'`. React sets
`style` attributes for its own layout work and Next inlines a critical-CSS block with no nonce,
so a nonce-only `style-src` breaks the page. `connect-src`, `img-src` and `object-src` are
closed in compensation.

`frame-ancestors 'none'` can only be a real response header — every browser ignores it in a
`<meta>` CSP — so the test that verifies it reads the header, not the markup.

### Rate limits

Held in `RATE_LIMIT_POLICIES` (`packages/auth/src/rate-limit.ts`), enforced at the request edge
by `apps/web/lib/rate-limit.ts`. Exceeding one returns **429** with a `Retry-After` in whole
seconds — never zero, always rounded up — and performs nothing.

| Surface | Limit | Counted against |
| --- | --- | --- |
| Sign-in, magic link, password reset | 10 per 15 minutes | IP **and** account |
| Manual report regeneration | 5 per hour | organization |
| Feedback writes | 60 per minute | user |
| Share-link reads | 120 per minute | token |

Both auth subjects are counted on every request even when one has already refused: with an
early exit, an attacker could hold an IP at its limit and keep the per-account counter frozen
just below its own, so the lockout would never fire.

**Auth lockout.** Exhausting the auth allowance starts an exponential lockout — 1, 2, 4, 8, 16…
minutes, capped at one hour, served *after* the exhausted window ends so each strike waits
strictly longer than the last. The cap is policy: uncapped doubling reaches days, which stops
being a rate limit and becomes an account state only an operator with database access can undo.
Every active **owner** of the organization is emailed on the transition into a lockout, once per
lockout rather than once per request. The mail names the account and the duration and carries no
link that would unlock anything — an "unlock" link in an inbox is a bypass worth exactly as much
as that inbox.

A **correct credential clears the counters** for that IP and account. The limit is on
unsuccessful pressure; somebody who knows the password was never the threat, and counting
successes locks out the verification harness and anybody signing in on a third device.

The counters are held **in this process**. Compass runs as two processes and only the web app
serves requests, so that is the whole truth for this deployment — but a horizontally scaled
deployment needs a shared store, because two replicas would each grant the full allowance. The
seam for that is `store()` in `apps/web/lib/rate-limit.ts` and nothing else.

### Public routes

`public` is a principal in `ROLE_MATRIX` (`packages/auth/src/matrix.ts`), never a default and
never inferred: `authorize` admits an anonymous caller through exactly one branch, the route's
own `allow` map naming `public`. `apps/web/tests/authz-matrix.test.ts` asserts the set of such
routes is exactly the documented one, and that every other route refuses an anonymous caller.

Four groups, and each is public for a different reason:

- **The report and its receipts** — `/`, `/goals`, `/merged`, `/weekly`, `/archive`,
  `/archive/[reportId]`, `/archive/diff`, `/archive/merged/[reportDate]`,
  `/artifact/[kind]/[artifactId]`, `/api/reports/[teamKey]`, `/api/goals`, `/api/goals/[nodeId]`,
  `/api/feedback/app`. All carry `demoOnlyPublic`, so the grant applies to the seeded demonstration
  tenant and to nothing else: a real customer's blockers and risks are not a landing page.
- **The price list** — `/pricing`, and it is the one group that is public in *every* tenant rather
  than only the demonstration one. It carries no organizational data at all: it reads the plan table
  out of `@compass/billing` and nothing else, so there is nothing for `demoOnlyPublic` to confine. A
  pricing page that required a session would be a pricing page nobody could read before signing up.

  Every *other* billing surface — the billing page itself and its three write endpoints, for
  checkout, plan changes and cancellation — is **owner only**, and is deliberately not enumerated
  here: this section is the documented set of *public* routes, and the gate above holds it to exactly
  the matrix's. Naming a non-public route in it would be a claim the matrix contradicts.
- **How a session is obtained** — `/account`, `/account/invite`, `/account/reset`,
  `/account/deletion`, `/login`, `/api/auth/register`, `/api/auth/login`, `/api/auth/logout`,
  `/api/auth/session`, `/api/auth/magic-link`, `/api/auth/magic-link/consume`,
  `/api/auth/password-reset`, `/api/auth/password-reset/consume` and `/api/seats/accept`. Public
  by definition; requiring a session to sign in would be circular. Enumerated rather than written
  as a wildcard, because a wildcard here would mean the documented set is not the set the gate can
  check, and a future auth route would inherit the grant silently.
- **Token-authorised, with no session involved** — `/api/share/[token]`,
  `/api/delivery/unsubscribe`, `/api/feedback/link/[token]`, `/api/privacy/deletion/undo`,
  `/api/slack/actions`, `/api/webhooks/[provider]`, `/api/stripe/webhook`. Each token is *narrower*
  than a session: one shared report, one person's daily switched off, one verdict on one item, one
  deletion undone, one signed provider delivery, one signed billing event.

  `/api/stripe/webhook` is the clearest case of why `public` does not mean open. Stripe posts from
  its own infrastructure with no cookie it could possibly send, so a session requirement would mean
  the feature cannot exist. What authorises it instead is an HMAC-SHA256 over the **raw bytes** under
  a secret only Compass and Stripe hold, compared in constant time, inside a five-minute window — and
  with no `STRIPE_WEBHOOK_SECRET` set every delivery is refused rather than trusted. It answers
  "accepted" or "not verified" and discloses nothing about the organization.

`/api/health` is public in every tenant, because the container's own `HEALTHCHECK` calls it and
it never carries organization data.

Every route on disk — endpoint *and* rendered screen — must have a matrix entry or the build
fails. That rule found `/artifact/[kind]/[artifactId]` serving one organization's commits and
tickets with no entry at all, because the enumeration had only ever walked `app/api`.

### Inbound webhooks

`POST /api/webhooks/<provider>` for `github`, `slack` and `jira`. The body is read as text and
**verified before it is parsed** — all three schemes sign the raw bytes, so a handler that
parsed and re-serialised would hash something the provider never sent.

| Provider | Verified by | Secret |
| --- | --- | --- |
| GitHub | `X-Hub-Signature-256`, HMAC-SHA256 over the raw body | `GITHUB_WEBHOOK_SECRET` |
| Slack | v0 signature over `v0:<timestamp>:<body>`, 5-minute absolute window | `SLACK_SIGNING_SECRET` |
| Jira | `X-Atlassian-Webhook-Signature` HMAC, or an Atlassian Connect HS256 JWT | `JIRA_WEBHOOK_SECRET` |

Every comparison goes through `digestsMatch` — the single `timingSafeEqual` wrapper in the
repository, exported as `constantTimeEqual`. `===` returns on the first differing byte, which
lets an attacker with a timing oracle recover a valid signature one byte at a time.

Slack requests outside the **5-minute** window are refused whatever their signature says: the
signature never expires on its own, so a captured request would otherwise be replayable forever.
Jira's JWT is held to the same 5 minutes on its `iat` rather than to its own `exp`, because a
token minted with a distant expiry is replayable until then and the receiver is the only party
who can refuse that. `alg: none` is refused.

A failure returns **401** and logs a line naming the provider and the environment variable to
check. The response says only that the signature did not verify — which check failed is a tuning
signal. An unset secret is `unconfigured`, which also refuses: a security control must never
fail open on a misconfiguration.

A verified delivery is **acknowledged with 202 and nothing more**. Compass reads its sources by
pulling a half-open window through the connector port on a schedule (`ingest.tick`, every 15
minutes), so a webhook is a hint that something changed rather than a record to be trusted.
Acting on the payload would let whoever holds the signing secret write the knowledge model, and
would make ingest non-replayable.

### Integration tokens

OAuth access and refresh tokens are the only secrets Compass must be able to *use* rather than
merely recognise, so they are encrypted rather than hashed. Envelope encryption, in
`packages/auth/src/envelope.ts`:

```
COMPASS_KMS_MASTER_KEY (32 bytes, base64)
  └── wraps a per-organization data key      → organization_data_keys.wrapped_data_key
        └── encrypts each token, AES-256-GCM → integration_tokens.sealed_value
```

A database dump therefore contains wrapped keys and ciphertext and nothing that opens either,
and one organization's data key opens that organization's tokens only. Each ciphertext is bound
by GCM additional authenticated data to `(organization, source, field)`, so a row copied between
tenants or between columns fails authentication instead of decrypting into somebody else's
credential. There is **no default master key** — `resolveMasterKey` throws when the variable is
unset, because a fallback key in the repository is indistinguishable from plaintext storage.

A CHECK constraint (`integration_tokens_sealed`) requires the scheme prefix, so a bare token
cannot be written by a script, a migration or a psql session.

Rotation comes in two costs. `rewrapOrganizationDataKey` rewraps the data key under a new master
key and touches no ciphertext — the one that runs on a schedule.
`rotateOrganizationDataKey` replaces the data key and re-encrypts every token, writing the key
row *last* so an interrupted rotation is still readable at both versions.

**No API returns a token, masked or otherwise.** A mask still confirms existence, length and
provider prefix. What the API returns is `IntegrationTokenDescription`: `present`, `sourceKey`,
`tokenKind`, `expiresAt`, `keyVersion`. The ESLint rule `compass/no-secret-disclosure` fails the
build if a credential-named field appears inside a `console.*` argument or a response body
anywhere in the workspace.

## Roles in the build

- **Discovery / PM** — turns the idea into a precise spec and a phased plan.
- **Architect** — designs the system and picks the (current, proven) tech stack.
- **Designer** — for user-facing products, authors the design brief (see `docs/DESIGN.md`).
- **Coders** — fixed general coder + per-domain specialists, each with project context.
- **Reviewer** — an independent, skeptical check on every task (anti-hallucination).
- **Verifier / QA** — runs tests, linting and builds across the assembled product.
- **Team Lead** — unblocks stuck loops and decides strategy before escalating.
