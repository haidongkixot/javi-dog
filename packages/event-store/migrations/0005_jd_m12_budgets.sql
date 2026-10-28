CREATE TABLE "budget_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"month" date NOT NULL,
	"threshold" smallint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"attempts" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "budget_alerts_project_month_threshold_key" UNIQUE("project_id","month","threshold"),
	CONSTRAINT "budget_alerts_threshold_check" CHECK ("budget_alerts"."threshold" in (80, 100)),
	CONSTRAINT "budget_alerts_status_check" CHECK ("budget_alerts"."status" in ('pending', 'sent', 'failed', 'covered'))
);
--> statement-breakpoint
CREATE TABLE "project_budgets" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"monthly_limit_usd" numeric(12, 2) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "project_budgets_limit_check" CHECK ("project_budgets"."monthly_limit_usd" > 0 and "project_budgets"."monthly_limit_usd" <= 1000000)
);
--> statement-breakpoint
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_budgets" ADD CONSTRAINT "project_budgets_project_workspace_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_budgets_workspace_idx" ON "project_budgets" USING btree ("workspace_id");