CREATE TABLE "media_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_contexts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"context_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"asset_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "status" text DEFAULT 'queued' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "stage" text DEFAULT '等待处理' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "progress" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "deleting" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "original" jsonb;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "normalized" jsonb;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "normalized_key" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "derived_prefix" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "next_media_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "media_runs" ADD CONSTRAINT "media_runs_asset_id_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."media_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_contexts" ADD CONSTRAINT "upload_contexts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_contexts" ADD CONSTRAINT "upload_contexts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_context_id_upload_contexts_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."upload_contexts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_asset_id_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "media_runs_generation_idx" ON "media_runs" USING btree ("asset_id","generation");
--> statement-breakpoint
WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY project_id ORDER BY created_at, id)::integer AS n FROM media_assets
) UPDATE media_assets SET number = numbered.n FROM numbered WHERE media_assets.id = numbered.id;
--> statement-breakpoint
UPDATE projects SET next_media_number = COALESCE((SELECT max(number) + 1 FROM media_assets WHERE project_id = projects.id), 1);
--> statement-breakpoint
INSERT INTO media_runs (asset_id, generation)
SELECT m.id, m.generation FROM media_assets m JOIN projects p ON p.id = m.project_id WHERE p.owner_id IS NOT NULL;
