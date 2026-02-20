CREATE SCHEMA "finn";
--> statement-breakpoint
CREATE TABLE "finn"."finn_api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"lookup_hash" text NOT NULL,
	"secret_hash" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"balance_micro" bigint DEFAULT 0 NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finn"."finn_billing_events" (
	"id" text PRIMARY KEY NOT NULL,
	"api_key_id" text NOT NULL,
	"request_id" text NOT NULL,
	"amount_micro" bigint NOT NULL,
	"balance_after" bigint NOT NULL,
	"event_type" text DEFAULT 'debit' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finn"."finn_verification_failures" (
	"id" text PRIMARY KEY NOT NULL,
	"tx_hash" text,
	"reason" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_api_keys_lookup_hash" ON "finn"."finn_api_keys" USING btree ("lookup_hash");--> statement-breakpoint
CREATE INDEX "idx_api_keys_tenant" ON "finn"."finn_api_keys" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_billing_events_request_id" ON "finn"."finn_billing_events" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "idx_billing_events_api_key" ON "finn"."finn_billing_events" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "idx_billing_events_created" ON "finn"."finn_billing_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_verification_failures_created" ON "finn"."finn_verification_failures" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_verification_failures_reason" ON "finn"."finn_verification_failures" USING btree ("reason");