CREATE TABLE "inspection_stats_snapshots" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_date" text NOT NULL,
	"period_start" text NOT NULL,
	"period_end" text NOT NULL,
	"sample_threshold" integer DEFAULT 100 NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "idx_iss_snapshot_date" ON "inspection_stats_snapshots" USING btree ("snapshot_date");