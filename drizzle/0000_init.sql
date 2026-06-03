-- DoIT — initial schema (Phase 0). Hand-authored to mirror src/db/schema.ts and
-- ApiSpec §5. Applying via `drizzle-kit migrate` (or `psql -f`) creates the full
-- Phase 0 table set. Forward-only; rollback = drop the objects below.
--
-- Sync convention (ApiSpec §5): every synced entity carries id (client UUID),
-- owner_id, created_at, updated_at, server_version, deleted_at (soft delete).

-- ============================================================================
-- users
-- ============================================================================
CREATE TABLE "users" (
  "id"           uuid PRIMARY KEY NOT NULL,
  "apple_sub"    text NOT NULL,
  "email"        text,
  "display_name" text NOT NULL DEFAULT '',
  "settings"     jsonb NOT NULL DEFAULT '{}'::jsonb,
  "ai_consent"   boolean NOT NULL DEFAULT false,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "updated_at"   timestamptz NOT NULL DEFAULT now(),
  "deleted_at"   timestamptz,
  CONSTRAINT "users_apple_sub_unique" UNIQUE ("apple_sub")
);

-- ============================================================================
-- devices
-- ============================================================================
CREATE TABLE "devices" (
  "id"           uuid PRIMARY KEY NOT NULL,
  "user_id"      uuid NOT NULL,
  "apns_token"   text,
  "platform"     text NOT NULL DEFAULT 'ios',
  "app_version"  text,
  "push_prefs"   jsonb NOT NULL DEFAULT '{}'::jsonb,
  "last_seen_at" timestamptz,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "revoked_at"   timestamptz,
  CONSTRAINT "devices_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE INDEX "devices_user_idx" ON "devices" ("user_id");

-- ============================================================================
-- refresh_tokens (rotating, single-use; ApiSpec §4.2)
-- ============================================================================
CREATE TABLE "refresh_tokens" (
  "id"          uuid PRIMARY KEY NOT NULL,
  "user_id"     uuid NOT NULL,
  "device_id"   uuid,
  "token_hash"  bytea NOT NULL,
  "expires_at"  timestamptz NOT NULL,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "revoked_at"  timestamptz,
  "replaced_by" uuid,
  CONSTRAINT "refresh_tokens_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "refresh_tokens_device_id_devices_id_fk"
    FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL
);
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" ("user_id");
CREATE UNIQUE INDEX "refresh_tokens_hash_uidx" ON "refresh_tokens" ("token_hash");

-- ============================================================================
-- task_lists
-- ============================================================================
CREATE TABLE "task_lists" (
  "id"             uuid PRIMARY KEY NOT NULL,
  "owner_id"       uuid NOT NULL,
  "name"           text NOT NULL,
  "color_hex"      text NOT NULL DEFAULT '#8E8E93',
  "icon"           text NOT NULL DEFAULT 'list.bullet',
  "sort_index"     integer NOT NULL DEFAULT 0,
  "share_id"       uuid,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_at"     timestamptz NOT NULL DEFAULT now(),
  "server_version" integer NOT NULL DEFAULT 1,
  "deleted_at"     timestamptz,
  CONSTRAINT "task_lists_owner_id_users_id_fk"
    FOREIGN KEY ("owner_id") REFERENCES "users"("id")
);
CREATE INDEX "task_lists_owner_idx" ON "task_lists" ("owner_id");

-- ============================================================================
-- tags
-- ============================================================================
CREATE TABLE "tags" (
  "id"             uuid PRIMARY KEY NOT NULL,
  "owner_id"       uuid NOT NULL,
  "name"           text NOT NULL,
  "color_hex"      text NOT NULL DEFAULT '#8E8E93',
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_at"     timestamptz NOT NULL DEFAULT now(),
  "server_version" integer NOT NULL DEFAULT 1,
  "deleted_at"     timestamptz,
  CONSTRAINT "tags_owner_id_users_id_fk"
    FOREIGN KEY ("owner_id") REFERENCES "users"("id")
);
CREATE INDEX "tags_owner_idx" ON "tags" ("owner_id");

-- ============================================================================
-- tasks
-- ============================================================================
CREATE TABLE "tasks" (
  "id"                   uuid PRIMARY KEY NOT NULL,
  "owner_id"             uuid NOT NULL,
  "list_id"              uuid,
  "parent_task_id"       uuid,
  "title"                text NOT NULL,
  "notes"                text,
  "status"               smallint NOT NULL DEFAULT 0,
  "priority"             smallint NOT NULL DEFAULT 0,
  "rank"                 integer NOT NULL DEFAULT 0,
  "energy"               smallint,
  "due_at"               timestamptz,
  "scheduled_start"      timestamptz,
  "scheduled_end"        timestamptz,
  "estimated_minutes"    integer,
  "actual_minutes"       integer,
  "is_all_day"           boolean NOT NULL DEFAULT false,
  "recurrence"           jsonb,
  "recurrence_parent_id" uuid,
  "routine_instance_of"  uuid,
  "assignee_user_id"     uuid,
  "location"             jsonb,
  "url"                  text,
  "field_meta"           jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at"           timestamptz NOT NULL,
  "updated_at"           timestamptz NOT NULL,
  "completed_at"         timestamptz,
  "archived"             boolean NOT NULL DEFAULT false,
  "server_version"       integer NOT NULL DEFAULT 1,
  "deleted_at"           timestamptz,
  CONSTRAINT "tasks_owner_id_users_id_fk"
    FOREIGN KEY ("owner_id") REFERENCES "users"("id"),
  CONSTRAINT "tasks_list_id_task_lists_id_fk"
    FOREIGN KEY ("list_id") REFERENCES "task_lists"("id") ON DELETE SET NULL,
  CONSTRAINT "tasks_assignee_user_id_users_id_fk"
    FOREIGN KEY ("assignee_user_id") REFERENCES "users"("id")
);
-- Self-FK for subtasks (added after table exists). recurrence_parent_id and
-- routine_instance_of are FK-less in Phase 0 (routines table arrives later).
ALTER TABLE "tasks"
  ADD CONSTRAINT "tasks_parent_task_id_tasks_id_fk"
  FOREIGN KEY ("parent_task_id") REFERENCES "tasks"("id") ON DELETE CASCADE;

CREATE INDEX "tasks_owner_updated_idx" ON "tasks" ("owner_id", "updated_at");
CREATE INDEX "tasks_list_idx" ON "tasks" ("list_id") WHERE "deleted_at" IS NULL;
CREATE INDEX "tasks_owner_status_due_idx"
  ON "tasks" ("owner_id", "status", "due_at") WHERE "deleted_at" IS NULL;

-- ============================================================================
-- task_tags (M:N)
-- ============================================================================
CREATE TABLE "task_tags" (
  "task_id" uuid NOT NULL,
  "tag_id"  uuid NOT NULL,
  CONSTRAINT "task_tags_task_id_tag_id_pk" PRIMARY KEY ("task_id", "tag_id"),
  CONSTRAINT "task_tags_task_id_tasks_id_fk"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE,
  CONSTRAINT "task_tags_tag_id_tags_id_fk"
    FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE
);
CREATE INDEX "task_tags_tag_idx" ON "task_tags" ("tag_id");

-- ============================================================================
-- change_log (sync journal + cursor; ApiSpec §5.2)
-- ============================================================================
CREATE TABLE "change_log" (
  "seq"              bigserial PRIMARY KEY NOT NULL,
  "entity_type"      text NOT NULL,
  "entity_id"        uuid NOT NULL,
  "op"               text NOT NULL,
  "version"          integer NOT NULL,
  "actor_user_id"    uuid NOT NULL,
  "visible_user_ids" uuid[] NOT NULL,
  "payload"          jsonb,
  "committed_at"     timestamptz NOT NULL DEFAULT now()
);
-- GIN index for `:userId = ANY(visible_user_ids)` fan-out (ApiSpec §5.2).
CREATE INDEX "change_log_visible_gin" ON "change_log" USING gin ("visible_user_ids");
CREATE INDEX "change_log_seq_idx" ON "change_log" ("seq");

-- ============================================================================
-- idempotency_keys (per-op dedupe; ApiSpec §6.3)
-- ============================================================================
CREATE TABLE "idempotency_keys" (
  "op_id"         uuid PRIMARY KEY NOT NULL,
  "user_id"       uuid NOT NULL,
  "response_hash" jsonb NOT NULL,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "idempotency_keys_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
