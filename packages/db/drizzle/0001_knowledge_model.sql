CREATE TABLE "absences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"natural_key" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"belief_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL,
	"developer_key" text NOT NULL,
	"absence_kind" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"note" text,
	CONSTRAINT "absences_org_natural_key" UNIQUE("organization_id","natural_key")
);
--> statement-breakpoint
CREATE TABLE "blockers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"natural_key" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"belief_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"team_key" text,
	"summary" text NOT NULL,
	"state" text NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"evidence" jsonb NOT NULL,
	"cause" text NOT NULL,
	CONSTRAINT "blockers_org_natural_key" UNIQUE("organization_id","natural_key")
);
--> statement-breakpoint
CREATE TABLE "branch_refs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"natural_key" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"belief_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL,
	"repository_key" text NOT NULL,
	"name" text NOT NULL,
	"revision_id" text NOT NULL,
	"is_default" boolean NOT NULL,
	CONSTRAINT "branch_refs_org_natural_key" UNIQUE("organization_id","natural_key")
);
--> statement-breakpoint
CREATE TABLE "commits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"natural_key" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"belief_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL,
	"repository_key" text NOT NULL,
	"revision_id" text NOT NULL,
	"author_developer_key" text,
	"unmatched_identity_key" text,
	"authored_at" timestamp with time zone NOT NULL,
	"message" text NOT NULL,
	"changed_file_count" double precision NOT NULL,
	"branch_name" text,
	"parent_revision_ids" jsonb NOT NULL,
	"ticket_key" text,
	CONSTRAINT "commits_org_natural_key" UNIQUE("organization_id","natural_key")
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"natural_key" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"belief_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"timezone" text NOT NULL,
	CONSTRAINT "companies_org_natural_key" UNIQUE("organization_id","natural_key")
);
--> statement-breakpoint
CREATE TABLE "developers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"natural_key" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"belief_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL,
	"display_name" text NOT NULL,
	"team_key" text,
	"active" boolean NOT NULL,
	CONSTRAINT "developers_org_natural_key" UNIQUE("organization_id","natural_key")
);
--> statement-breakpoint
CREATE TABLE "features" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"natural_key" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"belief_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL,
	"project_key" text NOT NULL,
	"title" text NOT NULL,
	"status" text,
	"status_category" text,
	CONSTRAINT "features_org_natural_key" UNIQUE("organization_id","natural_key")
);
--> statement-breakpoint
CREATE TABLE "feedback_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"natural_key" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"belief_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL,
	"report_item_stable_id" text NOT NULL,
	"author_user_id" uuid,
	"verdict" text NOT NULL,
	"note" text,
	"submitted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "feedback_entries_org_natural_key" UNIQUE("organization_id","natural_key")
);
--> statement-breakpoint
CREATE TABLE "identity_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"natural_key" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"belief_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL,
	"identity_kind" text NOT NULL,
	"identity_value" text NOT NULL,
	"developer_key" text NOT NULL,
	"origin" text NOT NULL,
	CONSTRAINT "identity_links_org_natural_key" UNIQUE("organization_id","natural_key")
);
--> statement-breakpoint
CREATE TABLE "manager_memos" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"natural_key" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"belief_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL,
	"author_user_id" uuid,
	"submitted_at" timestamp with time zone NOT NULL,
	"raw_text" text NOT NULL,
	"memo_kind" text,
	"status" text NOT NULL,
	"extracted" jsonb,
	CONSTRAINT "manager_memos_org_natural_key" UNIQUE("organization_id","natural_key")
);
--> statement-breakpoint
CREATE TABLE "objectives" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"natural_key" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"belief_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL,
	"objective_kind" text NOT NULL,
	"parent_objective_key" text,
	"title" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_until" timestamp with time zone NOT NULL,
	"is_current" boolean NOT NULL,
	CONSTRAINT "objectives_org_natural_key" UNIQUE("organization_id","natural_key")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"natural_key" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"belief_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"team_key" text,
	"methodology" text,
	"default_branch" text,
	CONSTRAINT "projects_org_natural_key" UNIQUE("organization_id","natural_key")
);
--> statement-breakpoint
CREATE TABLE "pull_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"natural_key" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"belief_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL,
	"repository_key" text NOT NULL,
	"display_number" double precision NOT NULL,
	"title" text NOT NULL,
	"state" text NOT NULL,
	"author_developer_key" text,
	"created_at" timestamp with time zone NOT NULL,
	"merged_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"source_branch" text NOT NULL,
	"target_branch" text NOT NULL,
	"head_revision_id" text NOT NULL,
	"merge_revision_id" text,
	"linked_item_keys" jsonb NOT NULL,
	"requested_reviewer_keys" jsonb NOT NULL,
	CONSTRAINT "pull_requests_org_natural_key" UNIQUE("organization_id","natural_key")
);
--> statement-breakpoint
CREATE TABLE "recommendations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"natural_key" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"belief_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"team_key" text,
	"summary" text NOT NULL,
	"state" text NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"evidence" jsonb NOT NULL,
	"cause" text NOT NULL,
	"action" text NOT NULL,
	CONSTRAINT "recommendations_org_natural_key" UNIQUE("organization_id","natural_key")
);
--> statement-breakpoint
CREATE TABLE "release_tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"natural_key" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"belief_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL,
	"repository_key" text NOT NULL,
	"name" text NOT NULL,
	"revision_id" text NOT NULL,
	"released_at" timestamp with time zone NOT NULL,
	"description" text,
	CONSTRAINT "release_tags_org_natural_key" UNIQUE("organization_id","natural_key")
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"natural_key" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"belief_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"project_key" text,
	"default_branch" text,
	CONSTRAINT "repositories_org_natural_key" UNIQUE("organization_id","natural_key")
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"natural_key" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"belief_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL,
	"pull_request_key" text NOT NULL,
	"reviewer_developer_key" text,
	"verdict" text NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"comment_count" double precision NOT NULL,
	CONSTRAINT "reviews_org_natural_key" UNIQUE("organization_id","natural_key")
);
--> statement-breakpoint
CREATE TABLE "risks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"natural_key" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"belief_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"team_key" text,
	"summary" text NOT NULL,
	"state" text NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"evidence" jsonb NOT NULL,
	"cause" text NOT NULL,
	"severity" text NOT NULL,
	CONSTRAINT "risks_org_natural_key" UNIQUE("organization_id","natural_key")
);
--> statement-breakpoint
CREATE TABLE "sprints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"natural_key" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"belief_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL,
	"project_key" text NOT NULL,
	"name" text NOT NULL,
	"goal" text,
	"state" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"committed_item_keys" jsonb NOT NULL,
	CONSTRAINT "sprints_org_natural_key" UNIQUE("organization_id","natural_key")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"natural_key" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"belief_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"methodology" text NOT NULL,
	"project_key" text,
	"objective_key" text,
	"conversation_key" text,
	"timezone" text NOT NULL,
	CONSTRAINT "teams_org_natural_key" UNIQUE("organization_id","natural_key")
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"natural_key" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"belief_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL,
	"project_key" text NOT NULL,
	"feature_key" text,
	"item_key" text NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"status_category" text NOT NULL,
	"item_type" text NOT NULL,
	"priority" text,
	"estimate_points" double precision,
	"labels" jsonb NOT NULL,
	"assignee_developer_key" text,
	"reporter_developer_key" text,
	"sprint_key" text,
	"flagged_blocked" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "tickets_org_natural_key" UNIQUE("organization_id","natural_key")
);
--> statement-breakpoint
CREATE TABLE "unmatched_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"natural_key" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"belief_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL,
	"identity_kind" text NOT NULL,
	"identity_value" text NOT NULL,
	"display_name" text,
	"occurrence_count" integer NOT NULL,
	"witness_refs" jsonb NOT NULL,
	"artifact_kinds" jsonb NOT NULL,
	"source_keys" jsonb NOT NULL,
	CONSTRAINT "unmatched_identities_org_natural_key" UNIQUE("organization_id","natural_key")
);
--> statement-breakpoint
CREATE TABLE "wins" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"natural_key" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"belief_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"team_key" text,
	"summary" text NOT NULL,
	"state" text NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"evidence" jsonb NOT NULL,
	"cause" text NOT NULL,
	CONSTRAINT "wins_org_natural_key" UNIQUE("organization_id","natural_key")
);
--> statement-breakpoint
CREATE TABLE "corrections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"prior_version" integer NOT NULL,
	"prior_belief" text NOT NULL,
	"new_belief" text NOT NULL,
	"contradiction" text NOT NULL,
	"evidence_kind" text NOT NULL,
	"evidence_label" text NOT NULL,
	"evidence_source_key" text NOT NULL,
	"evidence_source_record_id" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"occurrence_count" double precision NOT NULL,
	CONSTRAINT "corrections_org_subject_evidence_key" UNIQUE("organization_id","subject_kind","subject_key","prior_version","evidence_source_record_id")
);
--> statement-breakpoint
CREATE TABLE "entity_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"entity_kind" text NOT NULL,
	"entity_natural_key" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"tracked_fields" jsonb NOT NULL,
	"changed_fields" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"evidence_source_key" text,
	"evidence_source_record_id" text,
	CONSTRAINT "entity_versions_org_entity_version_key" UNIQUE("organization_id","entity_kind","entity_natural_key","version")
);
--> statement-breakpoint
CREATE TABLE "sprint_scope_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"sprint_key" text NOT NULL,
	"ticket_key" text NOT NULL,
	"source_key" text NOT NULL,
	"source_record_id" text NOT NULL,
	"change" text NOT NULL,
	"actor_developer_key" text,
	"changed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sprint_scope_changes_org_source_record_key" UNIQUE("organization_id","source_key","source_record_id")
);
--> statement-breakpoint
CREATE TABLE "ticket_status_transitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"ticket_key" text NOT NULL,
	"source_key" text NOT NULL,
	"source_record_id" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"from_status_category" text,
	"to_status_category" text NOT NULL,
	"actor_developer_key" text,
	"transitioned_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ticket_status_transitions_org_source_record_key" UNIQUE("organization_id","source_key","source_record_id")
);
--> statement-breakpoint
ALTER TABLE "absences" ADD CONSTRAINT "absences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blockers" ADD CONSTRAINT "blockers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_refs" ADD CONSTRAINT "branch_refs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commits" ADD CONSTRAINT "commits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "developers" ADD CONSTRAINT "developers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "features" ADD CONSTRAINT "features_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_entries" ADD CONSTRAINT "feedback_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_links" ADD CONSTRAINT "identity_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manager_memos" ADD CONSTRAINT "manager_memos_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objectives" ADD CONSTRAINT "objectives_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_tags" ADD CONSTRAINT "release_tags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risks" ADD CONSTRAINT "risks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprints" ADD CONSTRAINT "sprints_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unmatched_identities" ADD CONSTRAINT "unmatched_identities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wins" ADD CONSTRAINT "wins_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_versions" ADD CONSTRAINT "entity_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint_scope_changes" ADD CONSTRAINT "sprint_scope_changes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_status_transitions" ADD CONSTRAINT "ticket_status_transitions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "absences_org_last_seen_idx" ON "absences" USING btree ("organization_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "blockers_org_last_seen_idx" ON "blockers" USING btree ("organization_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "branch_refs_org_last_seen_idx" ON "branch_refs" USING btree ("organization_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "commits_org_last_seen_idx" ON "commits" USING btree ("organization_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "commits_org_author_idx" ON "commits" USING btree ("organization_id","author_developer_key");--> statement-breakpoint
CREATE INDEX "companies_org_last_seen_idx" ON "companies" USING btree ("organization_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "developers_org_last_seen_idx" ON "developers" USING btree ("organization_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "features_org_last_seen_idx" ON "features" USING btree ("organization_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "features_org_project_idx" ON "features" USING btree ("organization_id","project_key");--> statement-breakpoint
CREATE INDEX "feedback_entries_org_last_seen_idx" ON "feedback_entries" USING btree ("organization_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "feedback_entries_org_item_idx" ON "feedback_entries" USING btree ("organization_id","report_item_stable_id");--> statement-breakpoint
CREATE INDEX "identity_links_org_last_seen_idx" ON "identity_links" USING btree ("organization_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "identity_links_org_lookup_idx" ON "identity_links" USING btree ("organization_id","identity_kind","identity_value");--> statement-breakpoint
CREATE INDEX "manager_memos_org_last_seen_idx" ON "manager_memos" USING btree ("organization_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "objectives_org_last_seen_idx" ON "objectives" USING btree ("organization_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "projects_org_last_seen_idx" ON "projects" USING btree ("organization_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "pull_requests_org_last_seen_idx" ON "pull_requests" USING btree ("organization_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "recommendations_org_last_seen_idx" ON "recommendations" USING btree ("organization_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "release_tags_org_last_seen_idx" ON "release_tags" USING btree ("organization_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "repositories_org_last_seen_idx" ON "repositories" USING btree ("organization_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "reviews_org_last_seen_idx" ON "reviews" USING btree ("organization_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "reviews_org_pull_request_idx" ON "reviews" USING btree ("organization_id","pull_request_key");--> statement-breakpoint
CREATE INDEX "risks_org_last_seen_idx" ON "risks" USING btree ("organization_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "sprints_org_last_seen_idx" ON "sprints" USING btree ("organization_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "teams_org_last_seen_idx" ON "teams" USING btree ("organization_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "tickets_org_last_seen_idx" ON "tickets" USING btree ("organization_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "tickets_org_feature_idx" ON "tickets" USING btree ("organization_id","feature_key");--> statement-breakpoint
CREATE INDEX "tickets_org_sprint_idx" ON "tickets" USING btree ("organization_id","sprint_key");--> statement-breakpoint
CREATE INDEX "unmatched_identities_org_last_seen_idx" ON "unmatched_identities" USING btree ("organization_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "wins_org_last_seen_idx" ON "wins" USING btree ("organization_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "corrections_org_detected_idx" ON "corrections" USING btree ("organization_id","detected_at");--> statement-breakpoint
CREATE INDEX "entity_versions_org_entity_idx" ON "entity_versions" USING btree ("organization_id","entity_kind","entity_natural_key");--> statement-breakpoint
CREATE INDEX "sprint_scope_changes_org_sprint_idx" ON "sprint_scope_changes" USING btree ("organization_id","sprint_key","changed_at");--> statement-breakpoint
CREATE INDEX "ticket_status_transitions_org_ticket_idx" ON "ticket_status_transitions" USING btree ("organization_id","ticket_key","transitioned_at");

--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- The append-only guarantee, at the level that cannot be bypassed.
--
-- `ScopedDb.updateIn` / `deleteFrom` already refuse these tables, but that guard
-- only binds code that goes through the scoped layer. Elapsed facts ("still
-- blocked, day 6") and Corrections ("reported blocked yesterday, actually
-- merged") are only trustworthy if yesterday's record is still on disk, so the
-- database refuses the mutation itself - for a migration, a psql session and an
-- ORM alike.
--
-- The triggers are statement-level on purpose. A row-level trigger does not fire
-- for a statement that matches no rows, so `delete from entity_versions` would
-- succeed silently on an empty table and the guard would read as working when it
-- was not being exercised at all.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION compass_reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION
    'Table % is append-only: % is not permitted. Append a new row instead.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = '0A000';
END;
$fn$;--> statement-breakpoint
CREATE TRIGGER audit_log_entries_append_only BEFORE UPDATE OR DELETE ON "audit_log_entries" FOR EACH STATEMENT EXECUTE FUNCTION compass_reject_history_mutation();--> statement-breakpoint
CREATE TRIGGER audit_log_entries_no_truncate BEFORE TRUNCATE ON "audit_log_entries" FOR EACH STATEMENT EXECUTE FUNCTION compass_reject_history_mutation();--> statement-breakpoint
CREATE TRIGGER corrections_append_only BEFORE UPDATE OR DELETE ON "corrections" FOR EACH STATEMENT EXECUTE FUNCTION compass_reject_history_mutation();--> statement-breakpoint
CREATE TRIGGER corrections_no_truncate BEFORE TRUNCATE ON "corrections" FOR EACH STATEMENT EXECUTE FUNCTION compass_reject_history_mutation();--> statement-breakpoint
CREATE TRIGGER entity_versions_append_only BEFORE UPDATE OR DELETE ON "entity_versions" FOR EACH STATEMENT EXECUTE FUNCTION compass_reject_history_mutation();--> statement-breakpoint
CREATE TRIGGER entity_versions_no_truncate BEFORE TRUNCATE ON "entity_versions" FOR EACH STATEMENT EXECUTE FUNCTION compass_reject_history_mutation();--> statement-breakpoint
CREATE TRIGGER sprint_scope_changes_append_only BEFORE UPDATE OR DELETE ON "sprint_scope_changes" FOR EACH STATEMENT EXECUTE FUNCTION compass_reject_history_mutation();--> statement-breakpoint
CREATE TRIGGER sprint_scope_changes_no_truncate BEFORE TRUNCATE ON "sprint_scope_changes" FOR EACH STATEMENT EXECUTE FUNCTION compass_reject_history_mutation();--> statement-breakpoint
CREATE TRIGGER ticket_status_transitions_append_only BEFORE UPDATE OR DELETE ON "ticket_status_transitions" FOR EACH STATEMENT EXECUTE FUNCTION compass_reject_history_mutation();--> statement-breakpoint
CREATE TRIGGER ticket_status_transitions_no_truncate BEFORE TRUNCATE ON "ticket_status_transitions" FOR EACH STATEMENT EXECUTE FUNCTION compass_reject_history_mutation();