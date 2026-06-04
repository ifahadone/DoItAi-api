CREATE TABLE "shares" (
	"id"          uuid PRIMARY KEY NOT NULL,
	"list_id"     uuid NOT NULL,
	"owner_id"    uuid NOT NULL,
	"created_at"  timestamptz NOT NULL DEFAULT now(),
	"deleted_at"  timestamptz,
	CONSTRAINT "shares_list_id_task_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "task_lists"("id") ON DELETE CASCADE,
	CONSTRAINT "shares_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "users"("id")
);
--> statement-breakpoint
CREATE INDEX "shares_list_idx" ON "shares" ("list_id");
--> statement-breakpoint
CREATE INDEX "shares_owner_idx" ON "shares" ("owner_id");
--> statement-breakpoint
CREATE TABLE "share_members" (
	"id"         uuid PRIMARY KEY NOT NULL,
	"share_id"   uuid NOT NULL,
	"user_id"    uuid NOT NULL,
	"role"       text NOT NULL DEFAULT 'editor',
	"joined_at"  timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "share_members_share_id_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "shares"("id") ON DELETE CASCADE,
	CONSTRAINT "share_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "share_members_unique" ON "share_members" ("share_id","user_id");
--> statement-breakpoint
CREATE INDEX "share_members_user_idx" ON "share_members" ("user_id");
--> statement-breakpoint
CREATE TABLE "invites" (
	"token"        text PRIMARY KEY NOT NULL,
	"share_id"     uuid NOT NULL,
	"role"         text NOT NULL DEFAULT 'editor',
	"created_by"   uuid NOT NULL,
	"expires_at"   timestamptz,
	"revoked_at"   timestamptz,
	"reported_at"  timestamptz,
	"created_at"   timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "invites_share_id_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "shares"("id") ON DELETE CASCADE,
	CONSTRAINT "invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id")
);
--> statement-breakpoint
CREATE INDEX "invites_share_idx" ON "invites" ("share_id");
