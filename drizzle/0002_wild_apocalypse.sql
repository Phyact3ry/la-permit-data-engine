CREATE TABLE "inspections" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"permit_ref" text NOT NULL,
	"permit_id" text,
	"address" text,
	"permit_status" text,
	"inspection_date" text,
	"inspection_type" text,
	"inspection_result" text,
	"lat" real,
	"lng" real,
	"trade_category_ai" text,
	"correction_items_ai" jsonb,
	"is_final" boolean,
	"was_first_attempt_pass" boolean,
	"retry_count" integer,
	"sequence_position" integer,
	"days_since_previous" integer,
	"raw_socrata" jsonb,
	"socrata_updated_at" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_permit_id_permits_id_fk" FOREIGN KEY ("permit_id") REFERENCES "public"."permits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_insp_permit_date_type" ON "inspections" USING btree ("permit_ref","inspection_date","inspection_type");--> statement-breakpoint
CREATE INDEX "idx_insp_permit_ref" ON "inspections" USING btree ("permit_ref");--> statement-breakpoint
CREATE INDEX "idx_insp_permit_id" ON "inspections" USING btree ("permit_id");--> statement-breakpoint
CREATE INDEX "idx_insp_date" ON "inspections" USING btree ("inspection_date");--> statement-breakpoint
CREATE INDEX "idx_insp_result" ON "inspections" USING btree ("inspection_result");--> statement-breakpoint
CREATE INDEX "idx_insp_type" ON "inspections" USING btree ("inspection_type");