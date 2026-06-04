CREATE TABLE "comments" (
	"id"              uuid PRIMARY KEY NOT NULL,
	"owner_id"        uuid NOT NULL,
	"task_id"         uuid NOT NULL,
	"body"            text NOT NULL,
	"mentions"        jsonb,
	"created_at"      timestamptz NOT NULL DEFAULT now(),
	"updated_at"      timestamptz NOT NULL DEFAULT now(),
	"server_version"  integer NOT NULL DEFAULT 1,
	"deleted_at"      timestamptz,
	CONSTRAINT "comments_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "users"("id"),
	CONSTRAINT "comments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "comments_task_idx" ON "comments" ("task_id");
