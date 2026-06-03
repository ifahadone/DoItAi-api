CREATE TABLE "reminders" (
	"id"              uuid PRIMARY KEY NOT NULL,
	"owner_id"        uuid NOT NULL,
	"task_id"         uuid NOT NULL,
	"kind"            smallint NOT NULL DEFAULT 0,
	"fire_at"         timestamptz,
	"offset_minutes"  integer,
	"region"          jsonb,
	"interruption"    smallint NOT NULL DEFAULT 1,
	"notification_id" text,
	"created_at"      timestamptz NOT NULL DEFAULT now(),
	"updated_at"      timestamptz NOT NULL DEFAULT now(),
	"server_version"  integer NOT NULL DEFAULT 1,
	"deleted_at"      timestamptz,
	CONSTRAINT "reminders_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "users"("id"),
	CONSTRAINT "reminders_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "reminders_task_idx" ON "reminders" ("task_id");
--> statement-breakpoint
CREATE TABLE "checklist_items" (
	"id"             uuid PRIMARY KEY NOT NULL,
	"owner_id"       uuid NOT NULL,
	"task_id"        uuid NOT NULL,
	"text"           text NOT NULL,
	"done"           boolean NOT NULL DEFAULT false,
	"ord"            integer NOT NULL DEFAULT 0,
	"created_at"     timestamptz NOT NULL DEFAULT now(),
	"updated_at"     timestamptz NOT NULL DEFAULT now(),
	"server_version" integer NOT NULL DEFAULT 1,
	"deleted_at"     timestamptz,
	CONSTRAINT "checklist_items_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "users"("id"),
	CONSTRAINT "checklist_items_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "checklist_items_task_idx" ON "checklist_items" ("task_id");
