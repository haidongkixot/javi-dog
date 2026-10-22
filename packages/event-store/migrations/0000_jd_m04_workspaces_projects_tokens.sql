CREATE TABLE "ingest_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"display_prefix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "ingest_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "ingest_tokens_hash_check" CHECK ("ingest_tokens"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"platforms" text[] NOT NULL,
	"privacy_class" text DEFAULT 'L0' NOT NULL,
	"repository_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_signal_at" timestamp with time zone,
	CONSTRAINT "projects_id_workspace_key" UNIQUE("id","workspace_id"),
	CONSTRAINT "projects_privacy_class_check" CHECK ("projects"."privacy_class" in ('L0', 'L1', 'L2'))
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "ingest_tokens" ADD CONSTRAINT "ingest_tokens_project_workspace_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingest_tokens_active_project_idx" ON "ingest_tokens" USING btree ("project_id") WHERE "ingest_tokens"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_workspace_slug_key" ON "projects" USING btree ("workspace_id","slug");