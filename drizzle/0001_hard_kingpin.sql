CREATE TYPE "public"."project_category" AS ENUM('ADU', 'JADU', 'Kitchen', 'Bathroom', 'Addition', 'Ground-Up', 'Remodel', 'Tenant-Improvement', 'Solar', 'EV-Charger', 'Pool-Spa', 'Demolition', 'Grading', 'Mechanical', 'Electrical', 'Plumbing', 'Re-Roof', 'Fire-Sprinkler', 'Other');--> statement-breakpoint
CREATE TABLE "permits" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"permit_number" text NOT NULL,
	"city" text DEFAULT 'LA City',
	"address" text,
	"address_zip" text,
	"permit_type" text,
	"permit_sub_type" text,
	"status" text,
	"work_description" text,
	"project_category_ai" "project_category",
	"valuation_usd" integer,
	"total_sqft" integer,
	"number_of_stories" integer,
	"occupancy_type" text,
	"adu_flag" boolean DEFAULT false,
	"jadu_flag" boolean DEFAULT false,
	"owner_builder_flag" boolean DEFAULT false,
	"ev_charger" boolean DEFAULT false,
	"solar" boolean DEFAULT false,
	"issued_date" text,
	"expiration_date" text,
	"finaled_date" text,
	"plan_check_date" text,
	"status_date" text,
	"contractor_name" text,
	"contractor_address" text,
	"contractor_id" text,
	"applicant_name" text,
	"plan_check_corrections" text,
	"raw_socrata" jsonb,
	"socrata_updated_at" text,
	"classified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "permits_permit_number_unique" UNIQUE("permit_number")
);
--> statement-breakpoint
ALTER TABLE "permits" ADD CONSTRAINT "permits_contractor_id_contractors_enriched_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors_enriched"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_permits_number" ON "permits" USING btree ("permit_number");--> statement-breakpoint
CREATE INDEX "idx_permits_contractor_id" ON "permits" USING btree ("contractor_id");--> statement-breakpoint
CREATE INDEX "idx_permits_contractor_name" ON "permits" USING btree ("contractor_name");--> statement-breakpoint
CREATE INDEX "idx_permits_address" ON "permits" USING btree ("address");--> statement-breakpoint
CREATE INDEX "idx_permits_status" ON "permits" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_permits_issued_date" ON "permits" USING btree ("issued_date");--> statement-breakpoint
CREATE INDEX "idx_permits_adu" ON "permits" USING btree ("adu_flag");--> statement-breakpoint
CREATE INDEX "idx_permits_category" ON "permits" USING btree ("project_category_ai");--> statement-breakpoint
CREATE INDEX "idx_permits_classified" ON "permits" USING btree ("classified_at");