CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"producer_id" text NOT NULL,
	"event_id" text NOT NULL,
	"thread_ref" text NOT NULL,
	"agent_ref" text,
	"sequence" bigint NOT NULL,
	"type" text NOT NULL,
	"status" text,
	"privacy_class" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"usage_delta" jsonb,
	"attributes" jsonb,
	"encrypted" jsonb,
	CONSTRAINT "events_privacy_class_check" CHECK ("events"."privacy_class" in ('L0', 'L1', 'L2'))
);
--> statement-breakpoint
CREATE TABLE "ingest_rate_windows" (
	"token_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "ingest_rate_windows_pkey" PRIMARY KEY("token_id","window_start")
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_project_workspace_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "events_project_producer_event_key" ON "events" USING btree ("project_id","producer_id","event_id");--> statement-breakpoint
CREATE INDEX "events_project_thread_received_idx" ON "events" USING btree ("project_id","thread_ref","received_at");--> statement-breakpoint
CREATE INDEX "events_received_idx" ON "events" USING btree ("received_at");