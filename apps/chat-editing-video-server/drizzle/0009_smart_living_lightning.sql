ALTER TABLE "editing_operations" DROP CONSTRAINT "editing_operations_pkey";--> statement-breakpoint
ALTER TABLE "editing_operations" ADD CONSTRAINT "editing_operations_project_id_request_id_pk" PRIMARY KEY("project_id","request_id");--> statement-breakpoint
ALTER TABLE "chat_turns" ADD COLUMN "context" jsonb;--> statement-breakpoint
ALTER TABLE "edit_proposals" ADD COLUMN "input_hash" text;
