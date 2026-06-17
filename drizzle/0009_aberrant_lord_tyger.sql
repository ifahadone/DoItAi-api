-- Batch 8: routine suspend/archive + Keeper task-note linking.
-- Hand-corrected to an incremental, idempotent ALTER (drizzle-kit emitted a full
-- baseline because the local DB was bootstrapped via `push`, not `migrate`).
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "archived" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "task_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notes" ADD CONSTRAINT "notes_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notes_task_idx" ON "notes" USING btree ("task_id");
