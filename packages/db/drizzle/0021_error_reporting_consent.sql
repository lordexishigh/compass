-- Error reporting becomes a choice an organization makes, rather than a thing the deployment does.
--
-- Sentry receives stack traces and the organization id. The scrubber in `@compass/observability`
-- removes addresses, credentials and ingested text before an event leaves the process, and
-- `/trust/subprocessors` has always disclosed the processing — but disclosure is not consent, and
-- until now the only control was an operator deleting `SENTRY_DSN` from the environment. That is a
-- deployment-wide switch held by whoever runs the servers, which is not the same person as the
-- controller whose data it is.
--
-- ## Why three values and not a boolean
--
-- `unset` is *not yet asked*. A boolean cannot hold that: `false` would be indistinguishable from a
-- deliberate refusal, the banner would have nothing to key on, and the first read would silently
-- convert "nobody has decided" into "they said no". Keeping the three apart is what lets the banner
-- appear exactly once and lets an owner change their mind afterwards on /privacy.
--
-- ## Why the backfill is `unset` rather than `granted`
--
-- An existing organization has never been asked, so recording it as having agreed would be
-- inventing a consent that was never given — the one outcome a consent column must never produce.
-- The cost is stated plainly: a deployment that is reporting errors today stops until an owner
-- answers. That is the correct direction for this, and errors continue to reach the structured log
-- throughout, so nothing is lost that was not already written down somewhere else.
ALTER TABLE "org_privacy_settings"
  ADD COLUMN "error_reporting_consent" text NOT NULL DEFAULT 'unset';--> statement-breakpoint

-- Constrained here as well as in `@compass/db`, for the reason every closed vocabulary in this
-- schema is constrained twice: a fourth value would land in no branch of the reporting gate, and
-- the failure mode of *that* is an event sent — or withheld — with nothing anywhere to see.
ALTER TABLE "org_privacy_settings" ADD CONSTRAINT "org_privacy_settings_error_reporting_consent"
  CHECK ("error_reporting_consent" IN ('unset', 'granted', 'denied'));--> statement-breakpoint

-- The default is dropped once the backfill has run. Every writer states the value explicitly —
-- `PRIVACY_DEFAULTS` in `packages/db/src/repositories/privacy.ts` — and leaving a column default in
-- place would mean a future INSERT that forgot the field silently got one posture rather than
-- failing, which is the same class of quiet mistake this column exists to prevent.
ALTER TABLE "org_privacy_settings"
  ALTER COLUMN "error_reporting_consent" DROP DEFAULT;
