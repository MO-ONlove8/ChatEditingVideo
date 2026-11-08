ALTER TABLE "media_assets" ADD COLUMN "editing" jsonb;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "editing_key" text;--> statement-breakpoint
UPDATE "media_assets" SET "editing" = jsonb_build_object('kind', 'normalized', 'info', "normalized"), "editing_key" = "normalized_key" WHERE "normalized_key" IS NOT NULL AND "normalized"->>'frameCount' IS NOT NULL;--> statement-breakpoint
ALTER TABLE "media_runs" ADD COLUMN "phase" text DEFAULT 'index' NOT NULL;
