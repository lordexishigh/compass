-- The renderer's sentences for one claim, stored beside the section's prose.
--
-- Added with a default and then stripped of it: a database that already holds
-- reports (a dev container booted before this migration) has rows that need a
-- value, and `ADD COLUMN ... NOT NULL` with nothing to fill them would abort the
-- migration on exactly the machines that have been running longest. Backfilled
-- rows carry an empty string, which the view renders as the claim's headline —
-- the honest fallback, and one the next generation replaces.
ALTER TABLE "report_items" ADD COLUMN "prose" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "report_items" ALTER COLUMN "prose" DROP DEFAULT;
