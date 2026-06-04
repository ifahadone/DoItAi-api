CREATE TABLE "ai_usage" (
	"id"                     uuid PRIMARY KEY NOT NULL,
	"owner_id"               uuid NOT NULL,
	"endpoint"               text NOT NULL,
	"model"                  text NOT NULL,
	"input_tokens"           integer NOT NULL DEFAULT 0,
	"output_tokens"          integer NOT NULL DEFAULT 0,
	"cache_read_tokens"      integer NOT NULL DEFAULT 0,
	"cache_creation_tokens"  integer NOT NULL DEFAULT 0,
	"created_at"             timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "ai_usage_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "users"("id")
);
--> statement-breakpoint
CREATE INDEX "ai_usage_owner_created_idx" ON "ai_usage" ("owner_id","created_at");
