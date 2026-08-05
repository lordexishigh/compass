-- ---------------------------------------------------------------------------
-- Billing: what an organization pays for, and which Stripe events have been acted on.
--
-- Two tables, and the split is the design.
--
-- ## `organization_subscriptions` — the current belief, one row per tenant
--
-- Mutable, unlike the history tables. A subscription genuinely moves between states, and an
-- append-only ledger of Stripe's own status transitions would duplicate something Stripe already
-- keeps and shows in its dashboard. What Compass needs is the answer to "may this organization
-- generate a report this morning", and that is one row.
--
-- **There is deliberately no `is_read_only` column.** Entitlement is derived by
-- `billingState(facts, now)` in `@compass/billing` from the instants below. A stored flag would need
-- a scheduled job to flip it, and a job that has not run yet — or ran once and crashed — would leave
-- a trial that expired on Tuesday fully open on Friday. Deriving on read means the restriction takes
-- effect at the instant it is due, on every surface, with no scheduler in the trust path. The
-- worker's trial job exists to *notify*, not to enforce.
--
-- **`dunning_deadline_at` is stored rather than derived** from `dunning_started_at` plus the grace
-- period, for the same reason `sessions.expires_at` is stored: "you have until Friday" is a promise
-- made to a person, and an operator who later shortens the grace period must not retroactively move
-- a deadline somebody was already told.
--
-- ## `billing_events` — the idempotency ledger
--
-- Stripe redelivers. On a timeout, on a deploy, on a 500, and it redelivers events that already
-- succeeded. So every webhook that changes state records its event id **in the same transaction as
-- the change**, behind a UNIQUE constraint: the second delivery's insert conflicts, the transaction
-- is abandoned before it writes anything, and the state moves exactly once.
--
-- The constraint is what makes that true under concurrency. A check-then-write in the handler would
-- still race two simultaneous redeliveries into two state changes, which is why the guarantee lives
-- here and not in TypeScript — the same argument `delivery_log`'s partial unique index makes.
--
-- `stripe_event_id` is unique **globally**, not per `(organization_id, stripe_event_id)`. Stripe
-- event ids are globally unique, and a per-tenant constraint would let one event be applied once per
-- organization if it were ever misattributed, which is the opposite of what the constraint is for.
--
-- ## Both tables carry `organization_id NOT NULL`
--
-- The schema gate requires it of every table and there is no exemption list to creep into. For
-- `billing_events` that has a real consequence, stated rather than worked around: an event Compass
-- cannot attribute to an organization is **not recorded and not applied** — there is no state change
-- to make idempotent, and inventing a placeholder tenant to satisfy the column would put another
-- organization's billing event inside its isolation boundary. The webhook route answers 200 and logs
-- it, because a non-2xx would make Stripe retry an event no version of Compass can place.
-- ---------------------------------------------------------------------------

CREATE TABLE "organization_subscriptions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" uuid NOT NULL,
  "stripe_customer_id" text,
  "stripe_subscription_id" text,
  "status" text NOT NULL,
  "plan_id" text,
  "seat_allowance" integer,
  "trial_ends_at" timestamp with time zone,
  "current_period_ends_at" timestamp with time zone,
  "dunning_started_at" timestamp with time zone,
  "dunning_deadline_at" timestamp with time zone,
  "dunning_notified_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);--> statement-breakpoint

ALTER TABLE "organization_subscriptions" ADD CONSTRAINT "organization_subscriptions_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- The closed set of statuses, mirroring `SUBSCRIPTION_STATUSES` in `@compass/billing`. Written here
-- as well as in TypeScript for the same reason `manager_memos.memo_kind` is: the application check
-- produces a sentence somebody reads, and this one holds for every other path — a psql session, a
-- future importer, a bug in a handler.
ALTER TABLE "organization_subscriptions" ADD CONSTRAINT "organization_subscriptions_status_check"
  CHECK ("status" IN ('none', 'trialing', 'active', 'past_due', 'canceled', 'canceling'));--> statement-breakpoint

-- The plan ids, mirroring `PLAN_IDS`. NULL is permitted: an organization on a trial that has never
-- opened checkout has not chosen a plan, and a default here would invent a commitment.
ALTER TABLE "organization_subscriptions" ADD CONSTRAINT "organization_subscriptions_plan_check"
  CHECK ("plan_id" IS NULL OR "plan_id" IN ('starter', 'team', 'business'));--> statement-breakpoint

-- A seat allowance of zero would be a subscription that entitles nobody, which is a data fault
-- rather than a state the product has a meaning for.
ALTER TABLE "organization_subscriptions" ADD CONSTRAINT "organization_subscriptions_seats_positive_check"
  CHECK ("seat_allowance" IS NULL OR "seat_allowance" > 0);--> statement-breakpoint

-- One subscription per organization. This is what makes the repository's upsert a genuine upsert
-- rather than a select-then-insert that two concurrent webhooks could both pass.
CREATE UNIQUE INDEX "organization_subscriptions_org_key" ON "organization_subscriptions" USING btree ("organization_id");--> statement-breakpoint

CREATE TABLE "billing_events" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" uuid NOT NULL,
  "stripe_event_id" text NOT NULL,
  "stripe_event_type" text NOT NULL,
  "processed_at" timestamp with time zone NOT NULL,
  "detail" text NOT NULL
);--> statement-breakpoint

ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- The idempotency guarantee itself. Global, not per-tenant: see the header.
CREATE UNIQUE INDEX "billing_events_stripe_event_key" ON "billing_events" USING btree ("stripe_event_id");--> statement-breakpoint

CREATE INDEX "billing_events_org_processed_idx" ON "billing_events" USING btree ("organization_id","processed_at");
