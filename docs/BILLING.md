# Billing

Plans, seats, trials, dunning and cancellation. Every number and every sentence here is quoted from
`packages/billing/src/plans.ts` and `packages/billing/src/state.ts`; this document explains the
choices, and the code is the source of truth for the values.

## The one module

`packages/billing/src/plans.ts` is the single source of truth the acceptance criterion asks for. The
public pricing page (`/pricing`), the billing page (`/billing`), the checkout route and the webhook
handler all read it. **No price is written into JSX anywhere.**

| Plan | Seat price / month | Seats | Teams |
| --- | --- | --- | --- |
| Starter | £8 | up to 8 | 1 |
| Team | £12 | up to 24 | up to 3 |
| Business | £18 | no ceiling | unlimited |

Trial: **14 days.** Dunning grace period: **7 days.** Currency: GBP, held in **pence** everywhere —
nothing in the package holds a fractional currency amount, and `formatPence` is the only place a
decimal point is produced.

### Why prices are in code and price *ids* are in the environment

Two different kinds of fact. "A seat costs £12 a month on Team" is a product decision that belongs in
review, and the pricing page must be able to print it with no network call and no Stripe key — so it
is a constant. `price_1234…` is a per-account identifier that differs between one deployment's test
mode and another's live mode, so it is configuration. Keeping them apart is what makes `/pricing`
renderable on a deployment with no billing configured at all.

## What counts as a seat

Anybody who can sign in — owner, manager, member or viewer — **plus every pending invitation.** An
invitation is a seat about to be occupied, so excluding it would let an owner buy four seats, invite
twelve, and have the allowance exceeded by people arriving rather than by any billable act. Revoked
seats do not count; that is what revoking is.

Developers whose work Compass *reads* are not seats. A team of eight whose manager is the only reader
is one seat.

## Entitlement is derived, never stored

There is no `is_read_only` column. `billingState(facts, now)` computes it from the subscription row and
the instant, on every read.

A stored flag would need a scheduled job to flip it, and a job that has not run yet — or ran once and
crashed — would leave a trial that expired on Tuesday fully open on Friday. Deriving on read means the
restriction takes effect at the instant it is due, on every surface, with no scheduler in the trust
path. The worker's trial job exists to **notify**, not to enforce.

### The restricted state

One state, shared by an expired trial and a completed cancellation, because a manager in either case
needs the same thing: their history, and a way to pay. `READ_ONLY_PERMITS` and `READ_ONLY_FORBIDS` in
`packages/billing/src/state.ts` are the lists, and `/billing` renders them verbatim.

**Still available**

- Read every report Compass has already written, including the full archive and every evidence chain
- Export the organization's data
- Sign in, manage seats and change or cancel the plan
- Read and change privacy, retention and deletion settings

**Paused**

- Generating a new daily report — the pipeline stops, so no new mornings are added
- Email and Slack delivery of the daily
- Time travel and on-demand regeneration
- Narration — nothing is sent to a language model

The reading surface is never what is taken away. A manager who stops paying keeps everything Compass
has already told them; what stops is Compass doing more work.

## The states

| Status | Entitlement | Meaning |
| --- | --- | --- |
| `none` | full | No subscription row. A new organization before it has chosen anything. |
| `trialing` | full until `trial_ends_at`, then read-only | The 14-day trial. |
| `active` | full | Paid and current. |
| `past_due` | full until the dunning deadline, then read-only | A payment failed. |
| `canceling` | full until `current_period_ends_at`, then read-only | Cancelled, still inside the paid period. |
| `canceled` | read-only | Over. |

### Dunning

Access is **not** cut at the moment a payment fails. A card expires far more often than a customer
leaves, and taking the product away on the first decline would punish the common case. What matters is
the deadline the owner is *told*: seven days from the failure, frozen onto the row at that moment
rather than recomputed on read — "you have until Friday" is a promise made to a person, not a
configuration value an operator may later shorten.

The owner is emailed once per dunning window, not once per webhook: Stripe retries a failed invoice
several times and each retry is another `invoice.payment_failed`. An owner who received four identical
emails would filter the fifth. `dunning_notified_at` is what makes that once-per-window.

### Cancellation

`cancel_at_period_end`, never a delete. A delete would end the subscription immediately and refund
nothing, which is worse for the customer than what they asked for. There is deliberately no "cancel
immediately" button: an owner who wants that can let the period lapse, and a button that threw away
days already paid for would be one Compass had to apologise for.

## Downgrades are blocked, and the block names the seats

Moving to a plan whose ceiling is below the organization's current seat count is **refused**, with a
sentence naming how many seats must go and which ones Compass would start with.

Compass could accept the downgrade and trim the excess itself. It must not: the seats are *people*,
choosing which colleague loses access is a decision only the owner can make, and discovering on Monday
that Compass picked three is not a recoverable surprise. The suggestion is ordered least-privileged
first then newest first, never includes an owner, and **nothing is removed until the owner removes
it.**

`planChangeVerdict` composes that sentence once, and the billing page's plan cards, the plan-change
route and the checkout route all use it — so the refusal an owner reads while deciding is the same one
they would get on submit.

## Webhooks

`POST /api/stripe/webhook`, verified over the **raw** request body.

- **The scheme.** `Stripe-Signature: t=<unix>,v1=<hex>`; the signed payload is `<t>.<raw body>`,
  HMAC-SHA256 under the endpoint secret. Every `v1` in the header is tried, because Stripe sends more
  than one during a signing-secret rotation and a verifier reading only the first would fail every
  delivery for the duration of the roll.
- **Raw bytes, byte for byte.** `await request.text()` is the first thing that touches the body.
  `JSON.parse` then `JSON.stringify` is not byte-preserving, and the failure mode is a signature that
  mismatches for reasons nobody can see in a diff.
- **A five-minute window, absolute.** A timestamp from the future is refused too: clock skew on the
  sender is not a reason to accept an unbounded replay window in one direction.
- **Fails closed.** With no `STRIPE_WEBHOOK_SECRET`, every delivery is refused with 503. A security
  control that fails open on a misconfiguration looks exactly like one that is working.
- **`runtime = 'nodejs'`.** Verification uses `node:crypto`, which the edge runtime does not provide.

### Exactly one state change per event

Stripe redelivers — on a timeout, on a deploy, on a 500, and for events that already succeeded. So
`applyBillingEventOnce` inserts the event id into `billing_events` behind a **UNIQUE** index and
applies the subscription change **in the same transaction**. The second delivery's insert conflicts,
the transaction commits nothing, and the route answers 200.

The constraint is what makes this true under concurrency. A check-then-write in the handler would let
two simultaneous redeliveries both pass the check — which is why the guarantee lives in the database,
the same argument `delivery_log`'s partial unique index makes.

`stripe_event_id` is unique **globally**, not per organization: Stripe event ids are globally unique,
and a per-tenant constraint would let one event be applied once per organization if it were ever
misattributed.

### Which failures answer what

| Condition | Status | Why |
| --- | --- | --- |
| Signature did not verify | 401 | Nothing is read. The body says only that it did not verify — which check failed is a tuning signal. |
| No `STRIPE_WEBHOOK_SECRET` | 503 | The operator's own misconfiguration, and that one *is* actionable. |
| Verified, type Compass ignores | 200 | A non-2xx makes Stripe retry an event no version of Compass acts on. |
| Verified, no organization in metadata | 200 | There is no state change to make idempotent. See below. |
| Verified, but applying it threw | 500 | The one case where a Stripe retry is the right answer. |

An event Compass cannot attribute to an organization is **not recorded and not applied.**
`billing_events.organization_id` is NOT NULL — the schema gate requires it of every table — and
inventing a placeholder tenant to satisfy the column would file one organization's billing event
inside another's isolation boundary.

## With no Stripe key

`STRIPE_SECRET_KEY` absent is a **supported state**, not a misconfiguration.

- `/billing` says "billing is not configured", names the variable, and states that nothing else is
  affected. An operator who reads it and infers an outage has been told the wrong thing.
- `/pricing` renders the whole plan table, because the prices are constants.
- Report generation, delivery, the roster, privacy and every other screen work exactly as they do on a
  paid deployment.
- Nothing 500s. `resolveBillingConfig` reads the environment *inside* the function and returns a
  discriminated result rather than throwing, and the Stripe client is constructed lazily — a
  `new Stripe(process.env.STRIPE_SECRET_KEY!)` at module scope would throw at *import* and take down
  every page that transitively reached it.

### TEST versus LIVE

Derived from the key prefix, because that is the only thing that *is* the truth: a separate
`STRIPE_MODE` variable could disagree with the key, and then the badge on the billing page would be a
lie about which account is being charged. `sk_live_`/`rk_live_` is live; **anything else, including a
malformed key, reports TEST.** Defaulting the other way would let a typo present a test deployment as
one that charges real cards. The mode is shown on `/billing`.

## Why the Stripe SDK is not a dependency

Four API calls. `packages/billing` defines a `BillingGateway` port with a `fetch`-based
implementation and a recording fake in `src/testkit/` — the same arrangement `EmailTransport` and the
connector port use, so the whole checkout, plan-change and invoice path is exercised in tests as the
production code path with the network removed. The SDK's value is breadth Compass does not use, and it
would bring its own HTTP agent and runtime assumptions into a package that otherwise depends on
nothing but `@compass/clock`. This is a reversible decision; it is written down because it is a
judgement call rather than an obvious one.

Invoice documents are **never proxied.** `/billing` links to Stripe's own hosted PDF: the URL is
short-lived and account-scoped, and re-serving the bytes would make Compass a cache of somebody's
billing history.

## Environment variables

All five are optional. See `.env.example` for the full commentary.

| Variable | Absent means |
| --- | --- |
| `STRIPE_SECRET_KEY` | Billing is off; every other surface works. |
| `STRIPE_WEBHOOK_SECRET` | Checkout works; the webhook endpoint refuses every delivery with 503. |
| `STRIPE_PRICE_STARTER` | Starter is listed on `/pricing` and cannot be checked out. |
| `STRIPE_PRICE_TEAM` | As above, for Team. |
| `STRIPE_PRICE_BUSINESS` | As above, for Business. |
