CREATE TABLE "subscriptions" (
	"id"                        uuid PRIMARY KEY NOT NULL,
	"owner_id"                  uuid NOT NULL,
	"original_transaction_id"   text NOT NULL UNIQUE,
	"latest_transaction_id"     text NOT NULL,
	"product_id"                text NOT NULL,
	"purchase_at"               timestamptz,
	"expires_at"                timestamptz,
	"revoked_at"                timestamptz,
	"auto_renew"                boolean NOT NULL DEFAULT true,
	"environment"               text NOT NULL DEFAULT 'Production',
	"created_at"                timestamptz NOT NULL DEFAULT now(),
	"updated_at"                timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "subscriptions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "users"("id")
);
--> statement-breakpoint
CREATE INDEX "subscriptions_owner_idx" ON "subscriptions" ("owner_id");
