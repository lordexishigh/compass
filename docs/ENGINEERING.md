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

**Under `next dev`, and only there, `script-src` also carries `'unsafe-eval'`.** Not a preference:
`next dev` compiles with webpack's `eval-source-map` devtool, so every module in the development
bundle arrives inside an `eval("…")` call and React Refresh's runtime is the first to run one.
Without the directive that module throws `EvalError`, which takes the entire client bundle with it —
the server-rendered prose still paints, so the page looks correct while hydration, every interactive
control and Fast Refresh are silently dead. `next build` emits no `eval` and no `new Function` in
any chunk, so **the deployed policy is the strict one**; the branch is `currentBuildMode()` in
`apps/web/lib/security-headers.ts`, keyed on `NODE_ENV === 'development'`, and
`apps/web/tests/security-headers.test.ts` asserts both policies rather than whichever one the test
process happens to be running under.

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

Five groups, and each is public for a different reason:

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
- **What Compass commits to in writing** — `/legal`, `/legal/[slug]`, `/trust/subprocessors`,
  `/api/trust/subprocessor-notices` and `/api/trust/subprocessor-notices/confirm`. Public in *every*
  tenant, like the price list and for the same reason: the content is `@compass/trust`, a module of
  frozen constants, and it holds no organizational data for `demoOnlyPublic` to confine.

  The grant is load-bearing rather than convenient. The people these documents are written for — a
  buyer's data protection officer reading the DPIA, a subject reading the Article 22 position, a
  controller checking which subprocessor sees what — are precisely the people who do not have an
  account and will not be given one to read a policy. A terms page behind a session is not published.

  The two write endpoints are the 30-day subprocessor-change notice subscription, and being public is
  what makes them the awkward pair in this list: anybody can POST any address to
  `/api/trust/subprocessor-notices`. Three things contain that. The subscription is inert until
  confirmed, and `apps/worker/src/trust-notices.ts` mails only confirmed rows, so typing a stranger's
  address into the form causes them to receive one confirmation request and nothing further. The
  confirm endpoint is token-authorised and the same token unsubscribes, so no session is needed to
  undo it. And both replies are identical whether the address was already subscribed, never
  subscribed or unsubscribed — an endpoint that distinguished them would answer "does this person use
  Compass" to anybody who asked, which is a membership oracle on a public route.
- **How a session is obtained** — `/account`, `/account/invite`, `/account/reset`,
  `/account/deletion`, `/login`, `/api/auth/register`, `/api/auth/login`, `/api/auth/logout`,
  `/api/auth/session`, `/api/auth/magic-link`, `/api/auth/magic-link/consume`,
  `/api/auth/password-reset`, `/api/auth/password-reset/consume`, `/api/auth/2fa/challenge`,
  `/api/auth/sso/[provider]`, `/api/auth/sso/[provider]/callback`, `/api/auth/saml/metadata`,
  `/api/auth/saml/acs` and
  `/api/seats/accept`. Public
  by definition; requiring a session to sign in would be circular. Enumerated rather than written
  as a wildcard, because a wildcard here would mean the documented set is not the set the gate can
  check, and a future auth route would inherit the grant silently.
  `/api/auth/2fa/challenge` is the one worth spelling out: it is the *code* step of a two-factor
  sign-in, and it is public precisely because the password step before it deliberately mints no
  session — a second factor that ran after a working cookie had been issued would be advisory. It is
  not unauthorised: it demands an HMAC-signed challenge naming one user plus a valid TOTP or recovery
  code, which together are strictly stronger than the cookie it declines to require.
- **Token-authorised, with no session involved** — `/api/share/[token]`,
  `/api/delivery/unsubscribe`, `/api/feedback/link/[token]`, `/api/privacy/deletion/undo`,
  `/api/slack/actions`, `/api/webhooks/[provider]`, `/api/stripe/webhook`,
  `/api/connect/[provider]/callback`, `/api/scim/v2/Users`, `/api/scim/v2/Users/[scimUserId]`. Each
  token is *narrower* than a session: one shared report, one
  person's daily switched off, one verdict on one item, one deletion undone, one signed provider
  delivery, one signed billing event, one signed install return, one organization's provisioning
  client.

  The two SCIM rows are the sharpest case in this list of `public` meaning "no *session* needed" rather
  than "no proof needed". A SCIM client is an identity provider's backend service: there is no browser
  and no person in the loop, so it holds no cookie and could not obtain one. What admits it is a
  256-bit bearer token compared by SHA-256 digest in constant time against a row an owner created and
  can revoke — plus the Business-plan gate, which is checked *before* the token, so an organization
  that has not bought the feature never reaches the credential comparison at all. Only the digest is
  stored, so a database dump yields no working provisioning credential.

  `/api/auth/saml/acs` is authorised by an assertion rather than a token, and by four checks a
  signature alone does not supply. A signature proves the identity provider said it; it does not prove
  the provider said it **to Compass** (the audience restriction, whose absence is refused rather than
  tolerated — otherwise an assertion minted for any other application federated to the same IdP would
  be accepted here), **at this address** (the recipient), **recently** (the validity window, with sixty
  seconds of clock skew), or **only once** (the replay ledger, whose unique index on
  `(organization_id, assertion_id)` makes acceptance an INSERT rather than a check somebody could
  race). Compass requires *assertion* signing rather than response signing, refuses SHA-1 and inclusive
  canonicalisation, and refuses encrypted assertions outright.

  `/api/auth/sso/[provider]` and its callback carry no token and no assertion, and the pair is
  authorised by two things together: an HMAC-signed `state` naming the one organization an identity may
  attach to, and a `SameSite=Lax` nonce cookie set when the flow began. The nonce is the login-CSRF
  defence — without it a signed `state` is unforgeable but not *bound to a browser*, so an attacker
  could start a flow with their own provider account, capture the callback URL, and hand it to a victim
  who would then be silently signed in as the attacker.

  `/api/connect/[provider]/callback` is the OAuth return for all three connectable sources, and it is
  cookie-less for a structural reason: it is a top-level navigation from the provider, which sends no
  cookie Compass set. What authorises it is an HMAC-signed `state` this deployment minted minutes
  earlier, naming **the one organization the credential may be stored against** and **the one provider
  flow it belongs to**, compared in constant time inside a ten-minute window. The organization
  therefore comes from the signed state and never from a query parameter — a caller who could choose it
  would store their own token against somebody else's tenant. The provider is bound into the same
  signature for the neighbouring reason: without it, a state minted for the chat flow could be replayed
  against the tracker's callback and store a chat credential under the tracker's source key, where the
  tracker connector would then try to use it. With no `COMPASS_CONNECT_STATE_SECRET` set every callback
  is refused rather than trusted, which is the same fail-closed posture the three provider webhooks
  take.

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

#### Renewal

An access token from a tracker lives **one hour**, so `expires_at` is stored *in the clear* — it says
when, not what — and a credential is renewed at the moment it is about to be used rather than on a
schedule of its own. `apps/worker/src/connectors.ts` is the only place this happens, because it is
already the only place a sealed row becomes a configured client.

The rule is: if `expires_at` is inside a five-minute margin, exchange the refresh token first. The margin
is not caution for its own sake — a token valid for another ten seconds is expired by the time an ingest
run reaches its second page, so a resolver that refreshed on `expires_at <= now` would hand out
credentials that die mid-read and report a partial window as an authentication failure.

Refresh tokens **rotate**: the exchange invalidates the token that was sent and issues a replacement, so
both rows are rewritten in the same pass. Storing only the new access token would leave a connection that
works now and is unrecoverable in an hour — the worst available outcome, because nothing is stated and
the source goes quiet at a time nobody is watching.

A refusal is distinguished from an outage. A 4xx means the grant is gone (revoked in the provider's own
settings, or the refresh token already spent) and only reconnecting fixes it; anything else is transient.
Neither throws: both become a sentence in the boot log and, through the same underlying fact, in the
freshness indicator. A code host needs none of this — a GitHub App mints short-lived installation tokens
on demand from an installation id, so there is nothing to refresh.

**No API returns a token, masked or otherwise.** A mask still confirms existence, length and
provider prefix. What the API returns is `IntegrationTokenDescription`: `present`, `sourceKey`,
`tokenKind`, `expiresAt`, `keyVersion`. The ESLint rule `compass/no-secret-disclosure` fails the
build if a credential-named field appears inside a `console.*` argument or a response body
anywhere in the workspace.

### Tenant isolation in the database

`ScopedDb` adds `organization_id = $1` to every statement it builds, and `packages/db/tests/scoped-db.test.ts`
inspects the emitted SQL to prove it. That is the enforced path. It binds only callers that go
through it, so migration `0018_row_level_security.sql` puts the same predicate in the database:

- **Row-level security is enabled on every table**, with no exemption list. Every table in the schema
  carries a non-null `organization_id`, so the migration keys off the column rather than a
  hand-written list that would silently miss the next table.
- **One policy per table**, `<table>_tenant_isolation`, `FOR ALL` — the same predicate on reads and on
  writes, so a row a caller cannot see is not one it can create either.
- **The tenant comes from `compass.organization_id`**, read by `compass_current_organization()` and set
  with `SET LOCAL` inside a transaction, the same mechanism migration 0013 uses for `compass.erasure`.
  An unset setting reads as NULL, `organization_id = NULL` is NULL rather than true, and the policy
  therefore **fails closed**: a connection that has not said which tenant it is reads nothing.
- **`anon` and `authenticated` lose their grants** where those roles exist, including the default
  privileges, so a managed provider's auto-generated REST API cannot address the tables at all. If the
  migration role may not alter them, the migration raises a warning naming the role and the operator
  runs the `REVOKE` in the provider's SQL console.

**`FORCE ROW LEVEL SECURITY` is deliberately not set, and that is a limitation rather than an
oversight.** PostgreSQL exempts a table's owner from its own policies, and Compass runs migrations and
application queries as the same role, so RLS today binds every role *except* the application's own —
`anon`, a read-only analyst, a BI tool, a lesser-privileged connection string. Forcing it would break
the pg-boss worker, the seed and the golden-fixture tooling in the same commit, because those query
with no request to take a tenant from; the failure would present as "every report is empty".

To promote RLS from the second lock to the first, a deployment needs three things: a runtime role that
does not own the tables, `ALTER TABLE … FORCE ROW LEVEL SECURITY`, and `SET LOCAL
compass.organization_id` in the transaction that serves each request. `compass_current_organization()`
is the seam, so that is a configuration change and not a schema change. Note that the role grants
themselves cannot be run over a transaction-mode connection pooler — use `DATABASE_URL_DIRECT` or the
provider's SQL console.

`packages/db/tests/migrations.test.ts` is the regression gate. `drizzle-kit generate` does not emit
`ENABLE ROW LEVEL SECURITY`, so a new table's generated SQL looks complete while arriving with no
policy; the gate fails the build for any table without RLS and a policy. It also proves the policy is
*evaluated* rather than merely present, by creating a non-owning role and reading `users` through it —
which is the only way to execute a policy the owner is exempt from.

### Federated identity: SSO, SAML and SCIM

Four ways in besides a password, and one set of account-matching rules behind all of them
(`packages/auth/src/federated-sign-in.ts`). One implementation rather than four is the security
decision here: "never auto-link an unverified address" written four times is four chances to get it
subtly different, and the difference that matters is the one where two rows claim the same person.

**The identity is the provider's subject, never the email.** Google's `sub`, GitHub's numeric `id`, the
SAML `NameID`. An email address is mutable and reassignable — somebody changes their surname, or leaves
and their address is handed to a new joiner — so keying on it means the second person inherits the
first person's account. The address is what the *first* match is made on and is a stored fact
afterwards. `user_identities` enforces it with a unique index on `(organization, provider, subject)`,
and `linkIdentity` never updates `user_id`: a subject belongs permanently to the account it was first
linked to, or the provider becomes an account-takeover primitive.

**The four rules, in order.** A known subject is that person and the asserted email is not consulted.
An unverified address never matches an existing account — refused, with the way back being to sign in
through a channel you already control and link the provider from `/account`, which is an ownership
confirmation made by somebody already known to be the account holder. A verified address matches and
links, activating a *pending* invitation on the way, because a verified address is the proof an
invitation asks for. No match and no provisioning means no account: Compass seats are invited, and a
flow that minted one on first Google login would let anybody with a Google account take a seat in
somebody else's organization.

**Only a directory may provision, and never as an owner.** SAML and SCIM may create a seat because the
assertion comes from the organization's own identity provider — the system that issues its mailboxes —
rather than from a consumer account. `saml_connections.default_role` carries a CHECK excluding `owner`,
so anybody who can add a user to a directory group still cannot take over the organization. A directory
may also *reinstate* a revoked seat, at the role it held; a consumer SSO sign-in may not, or
`removeSeat` would be reversible by the person who was removed.

**Compass's own second factor is still enforced after a federated sign-in.** Deliberate: Compass cannot
see whether the provider applied a second factor to *this* sign-in, so treating a federated sign-in as
self-evidently two-factor would silently downgrade every account that had turned 2FA on. All three
paths — password, OAuth, SAML — hand back the same signed challenge and mint the session from
`startSession`, so rotation and both TTLs are inherited by construction rather than by three call sites
agreeing.

**SAML is one narrow profile, and everything else is refused with a named reason.** Signed *assertions*
(not merely signed responses — a signature over the envelope says nothing about which assertion inside
it to trust), RSA-SHA256, SHA-256 digests, exclusive canonicalisation, exactly one assertion, exactly
one signature that is a direct child of what it signs, and no encrypted assertions. A signature proves
the IdP said it; the audience, recipient, validity-window and replay checks are what establish that it
was said *to Compass*, *now*, and *once*. A missing `AudienceRestriction` is refused rather than
tolerated, because that is the check whose absence lets an assertion minted for any other application
on the same IdP be replayed here.

**The XML signature layer is first-party code, and that is a stated trade.**
`packages/auth/src/xml-signature.ts` implements the exclusive canonicaliser and the DSIG verifier over
`node:crypto`, because a dependency could not be added to this workspace — `pnpm add` fails with
`ERR_PNPM_UNEXPECTED_VIRTUAL_STORE` (the per-package `node_modules` are junctions into a shared store)
and the repair is a full reinstall that rewrites the whole checkout. The risk is contained by refusing
rather than accommodating: DOCTYPEs, entity declarations, comments, CDATA and processing instructions
are all parse *failures*, and anything outside the one algorithm profile is a named refusal. What this
buys is that every deviation fails **closed** — the honest limitation is interoperability, not
security. A canonicaliser that disagreed with some IdP in a corner produces a digest mismatch, which
refuses a sign-in and says so; it does not admit anybody. `packages/auth/tests/xml-signature.test.ts`
states this in its own header and asserts the refusals directly: tampered content, a duplicated
reference id (the wrapping attack), a relocated signature, SHA-1, inclusive c14n, unknown transforms.
Interoperability against a real IdP is an integration test, not something a unit suite can fake.

**SCIM: a SCIM User *is* a Compass seat.** `id` is the membership id and there is no parallel SCIM user
concept, which is what makes "deprovisioning frees a seat" true rather than approximately true — a
separate table would fork the seat lifecycle from the one the seat count reads. Deprovisioning routes
to the same `removeSeat` the owner-facing seat screen calls, so sessions are revoked, invitations
revoked, team scopes cleared and an audit row written; it is satisfied **synchronously**, so there is
no window rather than a cycle-long one. It is honoured on `DELETE`, on Okta's `PATCH {path: "active"}`
and on Azure AD's pathless `PATCH {value: {active: false}}`, because all three are the same act and an
implementation honouring only `DELETE` would leave sessions live for half the market's offboarding
while the provider reported success. Roles are never taken from the payload.

**SCIM tokens are mailed, not returned.** `compass/no-secret-disclosure` refuses a credential in any
response body and the quality gate asserts that no file anywhere disables that rule — so there is no
exception for "but a bearer token has to be delivered somehow". Mail is the channel this product
already uses for a one-time secret, and it is the better answer on the merits: the screen that would
display it is the screen an administrator is most likely to be screen-sharing while configuring an
integration. Only the SHA-256 reaches the database.

**SAML and SCIM are gated to the Business plan**, read from `includesEnterpriseIdentity` in
`packages/billing/src/plans.ts` rather than by comparing a plan name — the version of that check that
breaks the day a fourth plan is added. An organization with no subscription answers *false*, so an
unconfigured deployment does not expose provisioning endpoints. The gate is checked before the bearer
token and before any XML is parsed, and it returns a sentence naming the plan rather than a 404,
because the caller is an administrator wiring up an integration who would otherwise hunt for a typo in
a URL that is correct. Reading `/enterprise` is deliberately *not* gated: a page whose whole content
explains a feature you might buy must not require having bought it.

## Roles in the build

- **Discovery / PM** — turns the idea into a precise spec and a phased plan.
- **Architect** — designs the system and picks the (current, proven) tech stack.
- **Designer** — for user-facing products, authors the design brief (see `docs/DESIGN.md`).
- **Coders** — fixed general coder + per-domain specialists, each with project context.
- **Reviewer** — an independent, skeptical check on every task (anti-hallucination).
- **Verifier / QA** — runs tests, linting and builds across the assembled product.
- **Team Lead** — unblocks stuck loops and decides strategy before escalating.
