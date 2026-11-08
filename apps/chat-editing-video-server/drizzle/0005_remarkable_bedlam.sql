CREATE TABLE "chat_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"text" text NOT NULL,
	"reply" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'understanding' NOT NULL,
	"base_revision" integer NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "edit_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"base_revision" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"operation" jsonb NOT NULL,
	"source_label" text NOT NULL,
	"destination_label" text NOT NULL,
	"preview_clip" jsonb NOT NULL,
	"applied_revision" integer,
	CONSTRAINT "edit_proposals_turn_id_unique" UNIQUE("turn_id")
);
--> statement-breakpoint
CREATE TABLE "timeline_mutations" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"clip_id" uuid NOT NULL,
	"revision" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timelines" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"state" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "edit_jobs" ADD COLUMN "revision" integer;--> statement-breakpoint
ALTER TABLE "edit_jobs" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "edit_jobs" ADD COLUMN "execution_id" uuid;--> statement-breakpoint
ALTER TABLE "edit_jobs" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "removed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_turns" ADD CONSTRAINT "chat_turns_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_proposals" ADD CONSTRAINT "edit_proposals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_proposals" ADD CONSTRAINT "edit_proposals_turn_id_chat_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."chat_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_mutations" ADD CONSTRAINT "timeline_mutations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timelines" ADD CONSTRAINT "timelines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_turn_request" ON "chat_turns" USING btree ("project_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_turn_active" ON "chat_turns" USING btree ("project_id") WHERE "chat_turns"."status" in ('understanding','pending');