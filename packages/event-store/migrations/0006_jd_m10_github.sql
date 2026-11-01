CREATE TABLE "github_deliveries" (
	"body_sha256" text PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_deliveries_body_sha256_check" CHECK ("github_deliveries"."body_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "github_installations" (
	"installation_id" bigint PRIMARY KEY NOT NULL,
	"account_id" bigint NOT NULL,
	"account_type" text NOT NULL,
	"claimed_workspace_id" uuid,
	"suspended_at" timestamp with time zone,
	"last_verified_delivery_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_installations_installation_workspace_key" UNIQUE("installation_id","claimed_workspace_id"),
	CONSTRAINT "github_installations_account_type_check" CHECK ("github_installations"."account_type" in ('User', 'Organization'))
);
--> statement-breakpoint
CREATE TABLE "github_repositories" (
	"repo_id" bigint PRIMARY KEY NOT NULL,
	"installation_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"workspace_id" uuid,
	"project_id" uuid,
	"linked_at" timestamp with time zone,
	"linked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_repositories_link_check" CHECK (("github_repositories"."project_id" is null) = ("github_repositories"."workspace_id" is null))
);
--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_claimed_workspace_id_workspaces_id_fk" FOREIGN KEY ("claimed_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_repositories" ADD CONSTRAINT "github_repositories_installation_id_github_installations_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."github_installations"("installation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_repositories" ADD CONSTRAINT "github_repositories_project_workspace_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."projects"("id","workspace_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_repositories" ADD CONSTRAINT "github_repositories_installation_workspace_fk" FOREIGN KEY ("installation_id","workspace_id") REFERENCES "public"."github_installations"("installation_id","claimed_workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_deliveries_received_idx" ON "github_deliveries" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "github_installations_workspace_idx" ON "github_installations" USING btree ("claimed_workspace_id");--> statement-breakpoint
CREATE INDEX "github_repositories_installation_idx" ON "github_repositories" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "github_repositories_project_workspace_idx" ON "github_repositories" USING btree ("project_id","workspace_id");