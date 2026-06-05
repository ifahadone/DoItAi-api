CREATE TABLE "note_folders" (
	"id"              uuid PRIMARY KEY NOT NULL,
	"owner_id"        uuid NOT NULL,
	"name"            text NOT NULL,
	"color_hex"       text NOT NULL DEFAULT '#8E8E93',
	"icon"            text NOT NULL DEFAULT 'folder',
	"sort_index"      integer NOT NULL DEFAULT 0,
	"created_at"      timestamptz NOT NULL DEFAULT now(),
	"updated_at"      timestamptz NOT NULL DEFAULT now(),
	"server_version"  integer NOT NULL DEFAULT 1,
	"deleted_at"      timestamptz,
	CONSTRAINT "note_folders_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "users"("id")
);
--> statement-breakpoint
CREATE INDEX "note_folders_owner_idx" ON "note_folders" ("owner_id");
--> statement-breakpoint
CREATE TABLE "notes" (
	"id"              uuid PRIMARY KEY NOT NULL,
	"owner_id"        uuid NOT NULL,
	"folder_id"       uuid,
	"title"           text NOT NULL,
	"body"            text NOT NULL DEFAULT '',
	"pinned"          boolean NOT NULL DEFAULT false,
	"created_at"      timestamptz NOT NULL DEFAULT now(),
	"updated_at"      timestamptz NOT NULL DEFAULT now(),
	"server_version"  integer NOT NULL DEFAULT 1,
	"deleted_at"      timestamptz,
	CONSTRAINT "notes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "users"("id"),
	CONSTRAINT "notes_folder_id_note_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "note_folders"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX "notes_owner_idx" ON "notes" ("owner_id");
--> statement-breakpoint
CREATE INDEX "notes_folder_idx" ON "notes" ("folder_id");
