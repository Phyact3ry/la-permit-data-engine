CREATE TYPE "public"."channel" AS ENUM('email', 'voice', 'sms');--> statement-breakpoint
CREATE TYPE "public"."entity_type" AS ENUM('sole_prop', 'llc', 'corp', 'partnership', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."icp_tier" AS ENUM('A', 'B', 'C', 'D');--> statement-breakpoint
CREATE TYPE "public"."license_status" AS ENUM('active', 'inactive', 'suspended', 'expired');--> statement-breakpoint
CREATE TYPE "public"."pain_angle" AS ENUM('inspection_delays', 'correction_rate', 'multi_city_complexity', 'missed_deadline_risk', 'trade_coordination', 'license_compliance', 'scale_readiness', 'digital_presence');--> statement-breakpoint
CREATE TYPE "public"."pipeline_status" AS ENUM('idle', 'running', 'done', 'error');--> statement-breakpoint
CREATE TYPE "public"."sequence_status" AS ENUM('draft', 'active', 'paused', 'completed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."signal_type" AS ENUM('permit_velocity_high', 'correction_rate_high', 'license_expiring_soon', 'adu_active', 'multi_city_active', 'digital_presence_low', 'geographic_concentration', 'new_permit_issued', 'inspection_delay_pattern', 'project_stalled', 'permit_expiring_soon', 'high_value_project_started', 'multiple_corrections_same_trade', 'inspector_pattern_mismatch', 'new_city_expansion', 'seasonal_volume_spike', 'owner_builder_nearby', 'serial_developer_relationship', 'workers_comp_lapsed', 'bond_amount_changed', 'new_complaint_filed', 'violation_on_active_project', 'final_inspection_approaching', 'trade_sub_overloaded', 'new_adu_ordinance_change', 'competitor_permit_surge');--> statement-breakpoint
CREATE TYPE "public"."touch_direction" AS ENUM('outbound', 'inbound');--> statement-breakpoint
CREATE TYPE "public"."touch_type" AS ENUM('email_sent', 'email_opened', 'email_clicked', 'email_replied', 'email_bounced', 'email_unsubscribed', 'call_placed', 'call_answered', 'call_voicemail', 'call_no_answer', 'call_completed', 'sms_sent', 'sms_replied', 'demo_booked', 'trial_started', 'paid_converted', 'opted_out');--> statement-breakpoint
CREATE TABLE "contractors_enriched" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cslb_license" text NOT NULL,
	"business_name" text NOT NULL,
	"owner_name" text,
	"phone" text,
	"email" text,
	"website" text,
	"address_street" text,
	"address_city" text,
	"address_state" text DEFAULT 'CA',
	"address_zip" text,
	"license_class" text,
	"license_status" "license_status",
	"license_expiry" text,
	"bond_amount" integer,
	"worker_comp_insurer" text,
	"worker_comp_expiry" text,
	"has_active_license" boolean DEFAULT false,
	"disciplinary_actions" jsonb,
	"personnel_on_license" jsonb,
	"secondary_licenses" jsonb,
	"entity_type" "entity_type",
	"entity_status" text,
	"incorporation_date" text,
	"agent_for_service" text,
	"google_rating" real,
	"review_count" integer,
	"yelp_rating" real,
	"bbb_rating" text,
	"photos" jsonb,
	"social_links" jsonb,
	"company_size_ai" text,
	"years_in_business" integer,
	"specializations_ai" jsonb,
	"permit_count_total" integer DEFAULT 0,
	"permit_count_active" integer DEFAULT 0,
	"permit_count_by_city" jsonb,
	"total_project_valuation" integer DEFAULT 0,
	"avg_project_valuation" integer DEFAULT 0,
	"inspection_pass_rate" real,
	"avg_days_between_inspections" real,
	"correction_rate_by_trade" jsonb,
	"icp_score" real DEFAULT 0,
	"icp_score_dimensions" jsonb,
	"icp_tier" "icp_tier",
	"enrichment_version" integer DEFAULT 0,
	"last_enriched_at" timestamp with time zone,
	"enrichment_errors" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "contractors_enriched_cslb_license_unique" UNIQUE("cslb_license")
);
--> statement-breakpoint
CREATE TABLE "enrichment_signals" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contractor_id" text NOT NULL,
	"signal_type" "signal_type" NOT NULL,
	"signal_value" real DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true,
	"signal_meta" jsonb,
	"detected_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "hypotheses" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contractor_id" text NOT NULL,
	"rank" integer DEFAULT 1 NOT NULL,
	"pain_angle" "pain_angle" NOT NULL,
	"channel" "channel" DEFAULT 'email',
	"hook_line" text NOT NULL,
	"body_text" text NOT NULL,
	"grounding_signals" jsonb,
	"model_used" text DEFAULT 'claude-sonnet-4-6',
	"prompt_version" text DEFAULT 'v1',
	"was_used" boolean DEFAULT false,
	"opened_at" timestamp with time zone,
	"replied_at" timestamp with time zone,
	"booked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "outreach_sequences" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" "sequence_status" DEFAULT 'draft',
	"channel" "channel" NOT NULL,
	"icp_tier_filter" jsonb,
	"icp_score_min_filter" real,
	"enrolled_count" integer DEFAULT 0,
	"sent_count" integer DEFAULT 0,
	"opened_count" integer DEFAULT 0,
	"replied_count" integer DEFAULT 0,
	"booked_count" integer DEFAULT 0,
	"external_campaign_id" text,
	"steps_config" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "outreach_sequences_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "outreach_touches" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contractor_id" text NOT NULL,
	"hypothesis_id" text,
	"sequence_id" text,
	"channel" "channel" NOT NULL,
	"direction" "touch_direction" DEFAULT 'outbound',
	"touch_type" "touch_type" NOT NULL,
	"sequence_step" integer,
	"external_id" text,
	"twenty_crm_id" text,
	"subject" text,
	"duration_seconds" integer,
	"content_ref" text,
	"raw_webhook" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "pipeline_state" (
	"pipeline_name" text PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_offset" integer DEFAULT 0,
	"records_processed" integer DEFAULT 0,
	"status" "pipeline_status" DEFAULT 'idle',
	"error" text
);
--> statement-breakpoint
ALTER TABLE "enrichment_signals" ADD CONSTRAINT "enrichment_signals_contractor_id_contractors_enriched_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors_enriched"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hypotheses" ADD CONSTRAINT "hypotheses_contractor_id_contractors_enriched_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors_enriched"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_touches" ADD CONSTRAINT "outreach_touches_contractor_id_contractors_enriched_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors_enriched"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_touches" ADD CONSTRAINT "outreach_touches_hypothesis_id_hypotheses_id_fk" FOREIGN KEY ("hypothesis_id") REFERENCES "public"."hypotheses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_touches" ADD CONSTRAINT "outreach_touches_sequence_id_outreach_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."outreach_sequences"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ce_cslb" ON "contractors_enriched" USING btree ("cslb_license");--> statement-breakpoint
CREATE INDEX "idx_ce_phone" ON "contractors_enriched" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "idx_ce_icp_score" ON "contractors_enriched" USING btree ("icp_score");--> statement-breakpoint
CREATE INDEX "idx_ce_icp_tier" ON "contractors_enriched" USING btree ("icp_tier");--> statement-breakpoint
CREATE INDEX "idx_ce_license_status" ON "contractors_enriched" USING btree ("license_status");--> statement-breakpoint
CREATE INDEX "idx_ce_city" ON "contractors_enriched" USING btree ("address_city");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_es_contractor_type" ON "enrichment_signals" USING btree ("contractor_id","signal_type");--> statement-breakpoint
CREATE INDEX "idx_es_active" ON "enrichment_signals" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "idx_es_type" ON "enrichment_signals" USING btree ("signal_type");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_hyp_contractor_rank" ON "hypotheses" USING btree ("contractor_id","rank");--> statement-breakpoint
CREATE INDEX "idx_hyp_contractor" ON "hypotheses" USING btree ("contractor_id");--> statement-breakpoint
CREATE INDEX "idx_hyp_pain" ON "hypotheses" USING btree ("pain_angle");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_seq_name" ON "outreach_sequences" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_seq_status" ON "outreach_sequences" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_ot_contractor" ON "outreach_touches" USING btree ("contractor_id");--> statement-breakpoint
CREATE INDEX "idx_ot_sequence" ON "outreach_touches" USING btree ("sequence_id");--> statement-breakpoint
CREATE INDEX "idx_ot_type" ON "outreach_touches" USING btree ("touch_type");--> statement-breakpoint
CREATE INDEX "idx_ot_occurred_at" ON "outreach_touches" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "idx_ot_external_id" ON "outreach_touches" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "idx_ot_funnel" ON "outreach_touches" USING btree ("contractor_id","touch_type","occurred_at");