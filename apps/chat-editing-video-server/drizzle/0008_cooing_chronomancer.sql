CREATE TABLE "compositions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"execution_id" uuid,
	"error" text,
	"manifest" jsonb,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "editing_operations" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"proposal_id" uuid,
	"revision" integer NOT NULL,
	"content_hash" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "edit_proposals" ALTER COLUMN "preview_clip" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "edit_jobs" ADD COLUMN "output_type" text DEFAULT 'mp4' NOT NULL;--> statement-breakpoint
ALTER TABLE "edit_jobs" ADD COLUMN "config_hash" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "kind" text DEFAULT 'video' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "auxiliary" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "counters" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "edit_proposals" ADD COLUMN "preview_status" text DEFAULT 'processing' NOT NULL;--> statement-breakpoint
ALTER TABLE "edit_proposals" ADD COLUMN "preview_error" text;--> statement-breakpoint
ALTER TABLE "edit_proposals" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "edit_proposals" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "edit_proposals" ADD COLUMN "candidate" jsonb;--> statement-breakpoint
ALTER TABLE "edit_proposals" ADD COLUMN "manifest" jsonb;--> statement-breakpoint
ALTER TABLE "edit_proposals" ADD COLUMN "details" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "uploads" ADD COLUMN "kind" text DEFAULT 'video' NOT NULL;--> statement-breakpoint
ALTER TABLE "compositions" ADD CONSTRAINT "compositions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "editing_operations" ADD CONSTRAINT "editing_operations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "editing_operations" ADD CONSTRAINT "editing_operations_proposal_id_edit_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."edit_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "composition_revision" ON "compositions" USING btree ("project_id","revision");