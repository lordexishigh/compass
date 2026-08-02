-- ---------------------------------------------------------------------------
-- Stable item identity, change-awareness and the feedback loop.
--
-- Three things, and they are one thing: an item that keeps its identity across days can
-- be compared against its own prior self, and an item that can be compared can carry a
-- manager's verdict that survives to tomorrow.
--
-- ## `report_items` gains the three fields tomorrow's comparison reads
--
-- `first_seen_at`, `severity_score` and `signal_onset_at` are persisted rather than
-- recomputed, because the comparison is between *reports* and not between snapshots. A
-- run that re-derived yesterday's severity from today's snapshot would be comparing today
-- against today and would find that nothing ever changes.
--
-- The three are added nullable, backfilled, then closed. That order is required rather
-- than tidy: unlike `manager_memos` in 0010, `report_items` is populated in every
-- deployment — the boot script writes a report before anything else runs — so a NOT NULL
-- column with no default would fail the migration on a container that has ever served a
-- page. The backfill is the honest value for a row written before change-awareness
-- existed: the report's own instant, a severity of zero, and the same instant as the
-- onset. Those rows then read as "unchanged, day 0", which is exactly true of an item
-- Compass had not yet learned to compare.
--
-- `cause_entity_ref` / `cause_kind` / `cause_discriminator` are the coordinates the id was
-- derived from. They are backfilled from the item's own payload where it has them and
-- from a stated placeholder where it does not, so no historical row claims a cause it
-- cannot substantiate — `legacy_unconverted` matches no detector's cause kind, so no
-- feedback record can ever key to one of these rows by accident.
--
-- ## `feedback_entries` becomes the real feedback model
--
-- It has existed since 0001 as a placeholder with a coarse `verdict` column
-- (`useful` | `not_useful` | …) and nothing in the product has ever written a row. So
-- `verdict` is dropped rather than kept beside `action`: two columns answering "what did
-- the manager say", one of which nothing reads, is how a suppression rule ends up
-- consulting the wrong one.
--
-- The closed six-action vocabulary is a CHECK constraint as well as an application
-- validator, for the same reason `manager_memos.memo_kind` is: `action` is the switch the
-- suppression turns on, and a seventh value would land in no branch at all — the item
-- would keep appearing, the manager would keep clicking, and nothing anywhere would say
-- why. Hand-written, and deliberately not declared in the drizzle schema, so the next
-- `db:generate` does not re-emit it as a duplicate `ADD CONSTRAINT`.
--
-- `snooze_until` is constrained to `snooze` and to nothing else. A dismissal with an
-- expiry would be a snooze wearing a dismissal's name, and the dismissed-risk rule — which
-- suppresses indefinitely until severity materially worsens — would quietly stop holding.
--
-- ## `feedback_link_uses` is what makes an email link single-use
--
-- A signed link is a bearer capability with a 30-day life that lands in an inbox, a mail
-- client's prefetch cache, a corporate scanner and a forwarded thread. The primary key is
-- `(organization_id, token_digest)` and the consume path does a plain INSERT, so the
-- *database* refuses the second click; a read-then-write check would let two concurrent
-- prefetches both pass. The digest is stored, never the token.
--
-- ## `subscriptions.slack_user_id` is the identity mapping a Slack action is authorized by
--
-- `target` cannot serve as one: a Slack subscription usually targets a channel, and a
-- channel is not a person. Nullable, because "not mapped" is a real state that is refused
-- with an ephemeral reply rather than guessed at.
-- ---------------------------------------------------------------------------

-- ---- reports: the rendered change line ---------------------------------------
-- A DEFAULT here rather than a backfill, and it is kept: an empty change line is the true
-- value for a report generated before change-awareness existed, and it stays the true value
-- for any future write that has nothing to say about movement.
ALTER TABLE "reports" ADD COLUMN "change_line" text DEFAULT '' NOT NULL;--> statement-breakpoint

-- ---- report_items: the change-awareness columns -----------------------------
ALTER TABLE "report_items" ADD COLUMN "cause_entity_ref" text;--> statement-breakpoint
ALTER TABLE "report_items" ADD COLUMN "cause_kind" text;--> statement-breakpoint
ALTER TABLE "report_items" ADD COLUMN "cause_discriminator" text;--> statement-breakpoint
ALTER TABLE "report_items" ADD COLUMN "first_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "report_items" ADD COLUMN "severity_score" integer;--> statement-breakpoint
ALTER TABLE "report_items" ADD COLUMN "signal_onset_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "report_items" ADD COLUMN "feedback_state" text;--> statement-breakpoint

UPDATE "report_items" AS i
SET
  "first_seen_at" = COALESCE("first_seen_at", r."report_instant"),
  "signal_onset_at" = COALESCE("signal_onset_at", r."report_instant"),
  "severity_score" = COALESCE("severity_score", 0),
  -- Where the payload carries the coordinates, use them; otherwise state plainly that this
  -- row predates the conversion rather than inventing a cause it does not have.
  "cause_entity_ref" = COALESCE("cause_entity_ref", i."payload" #>> '{cause,entityRef}', 'legacy:' || i."stable_id"),
  "cause_kind" = COALESCE("cause_kind", i."payload" #>> '{cause,causeKind}', 'legacy_unconverted'),
  "cause_discriminator" = COALESCE("cause_discriminator", i."payload" #>> '{cause,causeDiscriminator}', '')
FROM "reports" AS r
WHERE r."id" = i."report_id";--> statement-breakpoint

-- Any row whose report row has gone (there should be none: the cascade removes children
-- first) still gets a total value rather than blocking the NOT NULL below.
UPDATE "report_items"
SET
  "first_seen_at" = COALESCE("first_seen_at", now()),
  "signal_onset_at" = COALESCE("signal_onset_at", now()),
  "severity_score" = COALESCE("severity_score", 0),
  "cause_entity_ref" = COALESCE("cause_entity_ref", 'legacy:' || "stable_id"),
  "cause_kind" = COALESCE("cause_kind", 'legacy_unconverted'),
  "cause_discriminator" = COALESCE("cause_discriminator", '')
WHERE "first_seen_at" IS NULL
   OR "signal_onset_at" IS NULL
   OR "severity_score" IS NULL
   OR "cause_entity_ref" IS NULL
   OR "cause_kind" IS NULL
   OR "cause_discriminator" IS NULL;--> statement-breakpoint

ALTER TABLE "report_items" ALTER COLUMN "cause_entity_ref" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "report_items" ALTER COLUMN "cause_kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "report_items" ALTER COLUMN "cause_discriminator" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "report_items" ALTER COLUMN "first_seen_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "report_items" ALTER COLUMN "severity_score" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "report_items" ALTER COLUMN "signal_onset_at" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "report_items" ADD CONSTRAINT "report_items_feedback_state_check"
  CHECK ("feedback_state" IS NULL OR "feedback_state" IN ('accepted', 'resurfaced'));--> statement-breakpoint

ALTER TABLE "report_items" ADD CONSTRAINT "report_items_change_tag_check"
  CHECK ("change_tag" IN ('new', 'unchanged', 'worsened', 'improved', 'resolved'));--> statement-breakpoint

CREATE INDEX "report_items_org_stable_id_idx" ON "report_items" USING btree ("organization_id","stable_id");--> statement-breakpoint

-- ---- feedback_entries: the real feedback model -------------------------------
ALTER TABLE "feedback_entries" DROP COLUMN "verdict";--> statement-breakpoint
ALTER TABLE "feedback_entries" ADD COLUMN "cause_entity_ref" text NOT NULL;--> statement-breakpoint
ALTER TABLE "feedback_entries" ADD COLUMN "cause_kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "feedback_entries" ADD COLUMN "cause_discriminator" text NOT NULL;--> statement-breakpoint
ALTER TABLE "feedback_entries" ADD COLUMN "action" text NOT NULL;--> statement-breakpoint
ALTER TABLE "feedback_entries" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "feedback_entries" ADD COLUMN "snooze_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "feedback_entries" ADD COLUMN "severity_score_at_verdict" integer;--> statement-breakpoint
ALTER TABLE "feedback_entries" ADD COLUMN "source_channel" text NOT NULL;--> statement-breakpoint
ALTER TABLE "feedback_entries" ADD COLUMN "report_id" uuid;--> statement-breakpoint

ALTER TABLE "feedback_entries" ADD CONSTRAINT "feedback_entries_action_check"
  CHECK ("action" IN (
    'dismiss_risk',
    'off_goal_flag_wrong',
    'accept_recommendation',
    'reject_recommendation',
    'blocker_already_resolved',
    'snooze'
  ));--> statement-breakpoint

ALTER TABLE "feedback_entries" ADD CONSTRAINT "feedback_entries_source_channel_check"
  CHECK ("source_channel" IN ('web', 'email', 'slack'));--> statement-breakpoint

-- Only a snooze has an end. Anything else with one would be a snooze under another name.
ALTER TABLE "feedback_entries" ADD CONSTRAINT "feedback_entries_snooze_check"
  CHECK (("snooze_until" IS NOT NULL) = ("action" = 'snooze'));--> statement-breakpoint

-- A snooze must cover at least one instant, or it would expire before it began.
ALTER TABLE "feedback_entries" ADD CONSTRAINT "feedback_entries_snooze_order_check"
  CHECK ("snooze_until" IS NULL OR "snooze_until" > "submitted_at");--> statement-breakpoint

CREATE INDEX "feedback_entries_org_cause_idx"
  ON "feedback_entries" USING btree ("organization_id","cause_entity_ref","cause_kind","cause_discriminator");--> statement-breakpoint

-- ---- feedback_link_uses: single-use email links ------------------------------
CREATE TABLE "feedback_link_uses" (
  "organization_id" uuid NOT NULL,
  "token_digest" text NOT NULL,
  "report_item_stable_id" text NOT NULL,
  "action" text NOT NULL,
  "used_at" timestamp with time zone NOT NULL,
  CONSTRAINT "feedback_link_uses_pkey" PRIMARY KEY("organization_id","token_digest")
);--> statement-breakpoint

ALTER TABLE "feedback_link_uses" ADD CONSTRAINT "feedback_link_uses_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ---- subscriptions: the Slack identity mapping -------------------------------
ALTER TABLE "subscriptions" ADD COLUMN "slack_user_id" text;--> statement-breakpoint

CREATE INDEX "subscriptions_org_slack_user_idx"
  ON "subscriptions" USING btree ("organization_id","slack_user_id");
