-- 0002_score_phase1 — Score Phase-1 forensic-integrity spike (cycle-041 Sprint 1, T1.6)
-- Additive: three new derived/append-mostly tables in the existing `finn` schema.
-- No existing table is altered. Logical FKs only (snapshot_id), matching repo convention.

CREATE TABLE "finn"."score_epoch_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"epoch_ref" text NOT NULL,
	"block_from" bigint NOT NULL,
	"block_to" bigint NOT NULL,
	"tx_count" integer NOT NULL,
	"agent_count" integer NOT NULL,
	"buyer_count" integer NOT NULL,
	"subsidy_micro" bigint NOT NULL,
	"gross_micro" bigint NOT NULL,
	"graph_r2_key" text NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finn"."score_agent_features" (
	"id" text PRIMARY KEY NOT NULL,
	"snapshot_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"recomputed_rank" integer NOT NULL,
	"net_revenue_micro" bigint NOT NULL,
	"gross_revenue_micro" bigint NOT NULL,
	"distinct_buyers" integer NOT NULL,
	"band_deviation" double precision NOT NULL,
	"max_jaccard" double precision NOT NULL,
	"jaccard_pairs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cluster_id" text,
	"shared_deployer" text,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finn"."score_anomaly_screens" (
	"id" text PRIMARY KEY NOT NULL,
	"snapshot_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"band" text NOT NULL,
	"rationale" jsonb NOT NULL,
	"is_internal" boolean DEFAULT true NOT NULL,
	"screened_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_score_band" CHECK ("band" in ('HIGH','MED','LOW','INSUFFICIENT_EVIDENCE'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_score_snapshot" ON "finn"."score_epoch_snapshots" USING btree ("platform","epoch_ref");--> statement-breakpoint
CREATE INDEX "idx_score_snapshot_epoch" ON "finn"."score_epoch_snapshots" USING btree ("platform","epoch_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_score_feature" ON "finn"."score_agent_features" USING btree ("snapshot_id","agent_id");--> statement-breakpoint
CREATE INDEX "idx_score_feature_snapshot" ON "finn"."score_agent_features" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "idx_score_feature_cluster" ON "finn"."score_agent_features" USING btree ("cluster_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_score_screen" ON "finn"."score_anomaly_screens" USING btree ("snapshot_id","agent_id");--> statement-breakpoint
CREATE INDEX "idx_score_screen_snapshot" ON "finn"."score_anomaly_screens" USING btree ("snapshot_id");
