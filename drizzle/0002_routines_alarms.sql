CREATE TABLE "routines" (
	"id"             uuid PRIMARY KEY NOT NULL,
	"owner_id"       uuid NOT NULL,
	"name"           text NOT NULL DEFAULT '',
	"color_hex"      text NOT NULL DEFAULT '#4F46E5',
	"anchor_time"    text,
	"recurrence"     jsonb,
	"chained"        boolean NOT NULL DEFAULT false,
	"is_habit"       boolean NOT NULL DEFAULT false,
	"streak_current" integer NOT NULL DEFAULT 0,
	"streak_longest" integer NOT NULL DEFAULT 0,
	"grace_days"     integer NOT NULL DEFAULT 0,
	"steps"          jsonb,
	"created_at"     timestamptz NOT NULL DEFAULT now(),
	"updated_at"     timestamptz NOT NULL DEFAULT now(),
	"server_version" integer NOT NULL DEFAULT 1,
	"deleted_at"     timestamptz,
	CONSTRAINT "routines_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "users"("id")
);
--> statement-breakpoint
CREATE TABLE "alarms" (
	"id"                 uuid PRIMARY KEY NOT NULL,
	"owner_id"           uuid NOT NULL,
	"task_id"            uuid,
	"fire_at"            timestamptz,
	"type"               smallint NOT NULL DEFAULT 0,
	"sound_name"         text,
	"snooze_minutes"     integer,
	"uses_live_activity" boolean NOT NULL DEFAULT false,
	"created_at"         timestamptz NOT NULL DEFAULT now(),
	"updated_at"         timestamptz NOT NULL DEFAULT now(),
	"server_version"     integer NOT NULL DEFAULT 1,
	"deleted_at"         timestamptz,
	CONSTRAINT "alarms_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "users"("id"),
	CONSTRAINT "alarms_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "alarms_task_idx" ON "alarms" ("task_id");
