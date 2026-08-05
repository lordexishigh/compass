-- ---------------------------------------------------------------------------
-- The second factor: one enrollment per user, and the recovery codes that get them back in.
--
-- ## `user_second_factors.last_used_step` is the replay guarantee
--
-- A TOTP code is a one-time password. Presenting the same code twice is either a double-submitted form
-- or somebody replaying an intercepted code, and Compass cannot tell those apart — so it refuses both.
-- Making that true needs the *last step already spent* to be durable: an in-process cache would forget
-- on deploy and would not be shared between the web and worker processes, so the fact is a column.
--
-- `verifyTotpCode` in `@compass/auth` takes it as an argument and returns the step it accepted, which
-- the login path writes back. The signature is what makes it impossible to verify a code correctly and
-- still accept a replay — there is no overload that omits it.
--
-- ## `activated_at` distinguishes an enrollment from an enforcement
--
-- A secret exists from the moment somebody presses "set up". 2FA is not *required* until they have
-- proved they can produce a code from it. Enforcing on the presence of the secret alone would lock out
-- anybody who opened the enrollment screen and closed the tab, which is the classic self-inflicted
-- lockout. There is deliberately no `enforced` boolean beside it: this instant already answers the
-- question, and a second column would be a state to keep in step for no gain.
--
-- ## `secret` is stored as issued, and that is a stated trade
--
-- A TOTP secret is a *verifier*: Compass must hold the same value the phone holds in order to compute
-- the same code, so unlike an OAuth token there is no form of it that is useful to Compass and useless
-- to a database thief. Envelope-encrypting it would move the exposure onto `COMPASS_KMS_MASTER_KEY`
-- without removing it, and would make sign-in depend on the key service being reachable — a second
-- factor that fails closed on a KMS outage locks out every user at once. What protects it is that it is
-- worthless alone: it is a *second* factor, and the first is Argon2id.
--
-- ## `user_recovery_codes` is one row per code, so single-use is a row state
--
-- Ten rows rather than an array column, because "this code has been spent" is a fact about one code and
-- needs somewhere to live. `used_at` is that place; NULL means unspent. Deleting the row instead would
-- lose *when* a recovery code was used, which is precisely the signal that somebody has lost a device.
--
-- Only the hash is stored. The code is shown once at generation and never again, and no query in this
-- schema can return it. The unique index is on `(user_id, code_hash)` rather than on the hash alone:
-- the same code could in principle be drawn for two people, and a global constraint would fail the
-- second person's whole batch for a reason that has nothing to do with them.
-- ---------------------------------------------------------------------------

CREATE TABLE "user_second_factors" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "secret" text NOT NULL,
  "activated_at" timestamp with time zone,
  "last_used_step" integer,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);--> statement-breakpoint

ALTER TABLE "user_second_factors" ADD CONSTRAINT "user_second_factors_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "user_second_factors" ADD CONSTRAINT "user_second_factors_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- An empty secret is not a secret. Written here as well as in the enrollment handler for the same
-- reason every other CHECK in this schema is: the application check produces a sentence somebody reads,
-- and this one holds for every other path — a psql session, a future importer, a bug in a handler.
ALTER TABLE "user_second_factors" ADD CONSTRAINT "user_second_factors_secret_not_empty_check"
  CHECK (length(btrim("secret")) > 0);--> statement-breakpoint

-- A step is a count of 30-second intervals since the epoch, so it is never negative.
ALTER TABLE "user_second_factors" ADD CONSTRAINT "user_second_factors_step_non_negative_check"
  CHECK ("last_used_step" IS NULL OR "last_used_step" >= 0);--> statement-breakpoint

-- One enrollment per user. This is what makes the repository's write a genuine upsert rather than a
-- select-then-insert that two concurrent enrollment attempts could both pass.
CREATE UNIQUE INDEX "user_second_factors_user_key" ON "user_second_factors" USING btree ("user_id");--> statement-breakpoint

CREATE TABLE "user_recovery_codes" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "code_hash" text NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);--> statement-breakpoint

ALTER TABLE "user_recovery_codes" ADD CONSTRAINT "user_recovery_codes_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "user_recovery_codes" ADD CONSTRAINT "user_recovery_codes_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- A 64-character lower-case hex SHA-256. The constraint is what stops a plaintext code ever being
-- written to this column by any path: a recovery code is 9 characters with a hyphen and would fail it.
ALTER TABLE "user_recovery_codes" ADD CONSTRAINT "user_recovery_codes_hash_shape_check"
  CHECK ("code_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint

CREATE UNIQUE INDEX "user_recovery_codes_user_hash_key" ON "user_recovery_codes" USING btree ("user_id","code_hash");--> statement-breakpoint

-- The one read the sign-in path makes: this user's unspent codes.
CREATE INDEX "user_recovery_codes_user_used_idx" ON "user_recovery_codes" USING btree ("user_id","used_at");
