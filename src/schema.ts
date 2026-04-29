/**
 * schema.ts — Data Engine & Outreach schema
 * DB: Supabase Postgres (pgvector + PostGIS + RLS)
 * ORM: Drizzle ORM (drizzle-orm/pg-core)
 *
 * Core tables:
 *   contractors_enriched · enrichment_signals · hypotheses
 *   outreach_sequences   · outreach_touches
 *
 * Extensions required (run once in Supabase SQL editor):
 *   CREATE EXTENSION IF NOT EXISTS postgis;
 *   CREATE EXTENSION IF NOT EXISTS vector;
 *   CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
 */

import {
  pgTable,
  pgEnum,
  text,
  integer,
  real,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─── ENUMS ───────────────────────────────────────────────────────────────────

export const licenseStatusEnum = pgEnum("license_status", [
  "active", "inactive", "suspended", "expired",
]);

export const entityTypeEnum = pgEnum("entity_type", [
  "sole_prop", "llc", "corp", "partnership", "unknown",
]);

export const icpTierEnum = pgEnum("icp_tier", ["A", "B", "C", "D"]);

export const signalTypeEnum = pgEnum("signal_type", [
  "permit_velocity_high",
  "correction_rate_high",
  "license_expiring_soon",
  "adu_active",
  "multi_city_active",
  "digital_presence_low",
  "geographic_concentration",
  "new_permit_issued",
  "inspection_delay_pattern",
  "project_stalled",
  "permit_expiring_soon",
  "high_value_project_started",
  "multiple_corrections_same_trade",
  "inspector_pattern_mismatch",
  "new_city_expansion",
  "seasonal_volume_spike",
  "owner_builder_nearby",
  "serial_developer_relationship",
  "workers_comp_lapsed",
  "bond_amount_changed",
  "new_complaint_filed",
  "violation_on_active_project",
  "final_inspection_approaching",
  "trade_sub_overloaded",
  "new_adu_ordinance_change",
  "competitor_permit_surge",
]);

export const channelEnum = pgEnum("channel", ["email", "voice", "sms"]);

export const painAngleEnum = pgEnum("pain_angle", [
  "inspection_delays",
  "correction_rate",
  "multi_city_complexity",
  "missed_deadline_risk",
  "trade_coordination",
  "license_compliance",
  "scale_readiness",
  "digital_presence",
]);

export const touchTypeEnum = pgEnum("touch_type", [
  "email_sent",
  "email_opened",
  "email_clicked",
  "email_replied",
  "email_bounced",
  "email_unsubscribed",
  "call_placed",
  "call_answered",
  "call_voicemail",
  "call_no_answer",
  "call_completed",
  "sms_sent",
  "sms_replied",
  "demo_booked",
  "trial_started",
  "paid_converted",
  "opted_out",
]);

export const sequenceStatusEnum = pgEnum("sequence_status", [
  "draft", "active", "paused", "completed", "archived",
]);

export const touchDirectionEnum = pgEnum("touch_direction", [
  "outbound", "inbound",
]);

// ─── TABLE 1: contractors_enriched ──────────────────────────────────────────
/**
 * One row per CSLB-licensed contractor. Natural key: cslb_license.
 * icp_score recomputed after each enrichment cycle by Signal Computation Engine.
 * Read at signup for auto-match by CSLB license / phone.
 */
export const contractorsEnriched = pgTable(
  "contractors_enriched",
  {
    // ── Identity ──────────────────────────────────────────────────────────
    id:           text("id").primaryKey().default(sql`gen_random_uuid()`),
    cslbLicense:  text("cslb_license").notNull().unique(),
    businessName: text("business_name").notNull(),
    ownerName:    text("owner_name"),

    // ── Contact ───────────────────────────────────────────────────────────
    phone:   text("phone"),   // primary phone from CSLB; used for auto-match
    email:   text("email"),   // enriched via SearchAPI / website scrape
    website: text("website"),

    // ── Address ───────────────────────────────────────────────────────────
    addressStreet: text("address_street"),
    addressCity:   text("address_city"),
    addressState:  text("address_state").default("CA"),
    addressZip:    text("address_zip"),
    // PostGIS geometry(Point, 4326). Drizzle doesn't ship PostGIS types yet;
    // add raw migration after schema push:
    //   ALTER TABLE contractors_enriched ADD COLUMN geom geometry(Point,4326);
    //   CREATE INDEX idx_ce_geom ON contractors_enriched USING GIST(geom);

    // ── CSLB license fields ───────────────────────────────────────────────
    licenseClass:        text("license_class"),         // B, C-10, C-36, etc.
    licenseStatus:       licenseStatusEnum("license_status"),
    licenseExpiry:       text("license_expiry"),        // ISO date string
    bondAmount:          integer("bond_amount"),        // USD
    workerCompInsurer:   text("worker_comp_insurer"),
    workerCompExpiry:    text("worker_comp_expiry"),    // ISO date string
    hasActiveLicense:    boolean("has_active_license").default(false),
    disciplinaryActions: jsonb("disciplinary_actions"), // { date, type, description }[]
    personnelOnLicense:  jsonb("personnel_on_license"), // { name, title, role }[]
    secondaryLicenses:   jsonb("secondary_licenses"),   // { license, class, status }[]

    // ── CA Secretary of State ─────────────────────────────────────────────
    entityType:        entityTypeEnum("entity_type"),
    entityStatus:      text("entity_status"),      // Active | Suspended | Dissolved
    incorporationDate: text("incorporation_date"),  // ISO date string
    agentForService:   text("agent_for_service"),

    // ── SearchAPI.io + website scrape ─────────────────────────────────────
    googleRating:      real("google_rating"),
    reviewCount:       integer("review_count"),
    yelpRating:        real("yelp_rating"),
    bbbRating:         text("bbb_rating"),          // A+, A, B, NR, etc.
    photos:            jsonb("photos"),              // string[] — photo URLs
    socialLinks:       jsonb("social_links"),        // { linkedin, instagram, facebook }
    companySizeAi:     text("company_size_ai"),     // "1-5" | "5-20" | "20-50" | "50+"
    yearsInBusiness:   integer("years_in_business"),
    specializationsAi: jsonb("specializations_ai"), // string[] — LLM-extracted from site

    // ── Permit analytics (computed from Socrata) ──────────────────────────
    permitCountTotal:      integer("permit_count_total").default(0),
    permitCountActive:     integer("permit_count_active").default(0),
    permitCountByCity:     jsonb("permit_count_by_city"),    // { "LA City": 5, "Pasadena": 2 }
    totalProjectValuation: integer("total_project_valuation").default(0), // USD cents
    avgProjectValuation:   integer("avg_project_valuation").default(0),   // USD cents

    // ── Inspection analytics (computed) ───────────────────────────────────
    inspectionPassRate:        real("inspection_pass_rate"),      // 0.0–1.0
    avgDaysBetweenInspections: real("avg_days_between_inspections"),
    correctionRateByTrade:     jsonb("correction_rate_by_trade"), // { electrical: 0.3, ... }

    // ── ICP scoring ───────────────────────────────────────────────────────
    // Dimensions: permit_activity 25% | pain 25% | maturity 20%
    //             adu_focus 15%       | digital 10% | reach 5%
    icpScore:           real("icp_score").default(0),      // 0–100
    icpScoreDimensions: jsonb("icp_score_dimensions"),     // per-dimension breakdown
    icpTier:            icpTierEnum("icp_tier"),

    // ── pgvector embedding (1536-dim, text-embedding-3-small) ─────────────
    // Drizzle doesn't ship vector type yet. Add via raw migration after schema push:
    //   ALTER TABLE contractors_enriched ADD COLUMN embedding vector(1536);
    //   CREATE INDEX idx_ce_embedding ON contractors_enriched
    //     USING hnsw (embedding vector_cosine_ops);

    // ── Pipeline metadata ─────────────────────────────────────────────────
    enrichmentVersion: integer("enrichment_version").default(0),
    lastEnrichedAt:    timestamp("last_enriched_at", { withTimezone: true }),
    enrichmentErrors:  jsonb("enrichment_errors"), // { source, error, ts }[]

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    cslbIdx:          uniqueIndex("idx_ce_cslb").on(t.cslbLicense),
    phoneIdx:         index("idx_ce_phone").on(t.phone),
    icpScoreIdx:      index("idx_ce_icp_score").on(t.icpScore),
    icpTierIdx:       index("idx_ce_icp_tier").on(t.icpTier),
    licenseStatusIdx: index("idx_ce_license_status").on(t.licenseStatus),
    cityIdx:          index("idx_ce_city").on(t.addressCity),
  })
);

// ─── TABLE 2: enrichment_signals ────────────────────────────────────────────
/**
 * 26 behavioral/contextual signals per contractor.
 * One row per (contractor_id, signal_type). Upsert on each enrichment cycle.
 * signal_value 0.0–1.0 normalized; used as input weights for ICP scoring.
 */
export const enrichmentSignals = pgTable(
  "enrichment_signals",
  {
    id:           text("id").primaryKey().default(sql`gen_random_uuid()`),
    contractorId: text("contractor_id")
      .notNull()
      .references(() => contractorsEnriched.id, { onDelete: "cascade" }),

    signalType:  signalTypeEnum("signal_type").notNull(),
    signalValue: real("signal_value").notNull().default(0), // 0.0–1.0
    isActive:    boolean("is_active").default(true),
    signalMeta:  jsonb("signal_meta"),   // raw evidence that produced this signal
    detectedAt:  timestamp("detected_at", { withTimezone: true }),
    expiresAt:   timestamp("expires_at", { withTimezone: true }), // null = never

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    // upsert target: ON CONFLICT (contractor_id, signal_type) DO UPDATE
    contractorSignalIdx: uniqueIndex("idx_es_contractor_type").on(
      t.contractorId,
      t.signalType
    ),
    activeIdx: index("idx_es_active").on(t.isActive),
    typeIdx:   index("idx_es_type").on(t.signalType),
  })
);

// ─── TABLE 3: hypotheses ─────────────────────────────────────────────────────
/**
 * 2–3 Claude-generated outreach angles per contractor.
 * Model: claude-sonnet-4-6.
 */
export const hypotheses = pgTable(
  "hypotheses",
  {
    id:           text("id").primaryKey().default(sql`gen_random_uuid()`),
    contractorId: text("contractor_id")
      .notNull()
      .references(() => contractorsEnriched.id, { onDelete: "cascade" }),

    rank:      integer("rank").notNull().default(1), // 1–3; enforced by unique index
    painAngle: painAngleEnum("pain_angle").notNull(),
    channel:   channelEnum("channel").default("email"),

    hookLine: text("hook_line").notNull(), // email subject / voice opener
    bodyText: text("body_text").notNull(), // email body / voice script brief

    // which signals grounded this hypothesis — for explainability + eval harness
    groundingSignals: jsonb("grounding_signals"), // SignalType[]

    modelUsed:     text("model_used").default("claude-sonnet-4-6"),
    promptVersion: text("prompt_version").default("v1"),

    // performance tracking — updated via Instantly/Vapi webhooks
    wasUsed:   boolean("was_used").default(false),
    openedAt:  timestamp("opened_at", { withTimezone: true }),
    repliedAt: timestamp("replied_at", { withTimezone: true }),
    bookedAt:  timestamp("booked_at", { withTimezone: true }),

    // pgvector embedding of hookLine+bodyText for dedup. Add via raw migration:
    //   ALTER TABLE hypotheses ADD COLUMN embedding vector(1536);
    //   CREATE INDEX idx_hyp_embedding ON hypotheses
    //     USING hnsw (embedding vector_cosine_ops);

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    // enforces max 3 hypotheses per contractor
    contractorRankIdx: uniqueIndex("idx_hyp_contractor_rank").on(
      t.contractorId,
      t.rank
    ),
    contractorIdx: index("idx_hyp_contractor").on(t.contractorId),
    painIdx:       index("idx_hyp_pain").on(t.painAngle),
  })
);

// ─── TABLE 4: outreach_sequences ─────────────────────────────────────────────
/**
 * Named multi-touch sequences (e.g. "top100_m1_launch").
 * One row = one campaign definition. outreach_touches FK here.
 * Maps to a custom object in Twenty CRM.
 */
export const outreachSequences = pgTable(
  "outreach_sequences",
  {
    id:   text("id").primaryKey().default(sql`gen_random_uuid()`),
    name: text("name").notNull().unique(),

    status:  sequenceStatusEnum("status").default("draft"),
    channel: channelEnum("channel").notNull(),

    // ICP filter snapshot used when building the contact list
    icpTierFilter:     jsonb("icp_tier_filter"),      // IcpTier[]
    icpScoreMinFilter: real("icp_score_min_filter"),  // e.g. 65.0

    // Live funnel counters — updated by webhook aggregator
    enrolledCount: integer("enrolled_count").default(0),
    sentCount:     integer("sent_count").default(0),
    openedCount:   integer("opened_count").default(0),
    repliedCount:  integer("replied_count").default(0),
    bookedCount:   integer("booked_count").default(0),

    externalCampaignId: text("external_campaign_id"), // Instantly / Vapi campaign ID
    stepsConfig:        jsonb("steps_config"),         // step definitions + delays

    startedAt:   timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt:   timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt:   timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    nameIdx:   uniqueIndex("idx_seq_name").on(t.name),
    statusIdx: index("idx_seq_status").on(t.status),
  })
);

// ─── TABLE 5: outreach_touches ────────────────────────────────────────────────
/**
 * Immutable append-only log of every outreach event.
 * Never updated after insert — only new rows added.
 * Source of truth for cadence logic and Twenty CRM sync.
 */
export const outreachTouches = pgTable(
  "outreach_touches",
  {
    id:           text("id").primaryKey().default(sql`gen_random_uuid()`),
    contractorId: text("contractor_id")
      .notNull()
      .references(() => contractorsEnriched.id, { onDelete: "cascade" }),
    hypothesisId: text("hypothesis_id")
      .references(() => hypotheses.id, { onDelete: "set null" }),
    sequenceId:   text("sequence_id")
      .references(() => outreachSequences.id, { onDelete: "set null" }),

    channel:      channelEnum("channel").notNull(),
    direction:    touchDirectionEnum("direction").default("outbound"),
    touchType:    touchTypeEnum("touch_type").notNull(),
    sequenceStep: integer("sequence_step"), // 1-indexed step within the sequence

    // dedup + webhook correlation
    externalId:  text("external_id"),  // Instantly message ID or Vapi call ID
    twentyCrmId: text("twenty_crm_id"), // Twenty CRM record ID after sync

    // event payload
    subject:         text("subject"),            // email subject
    durationSeconds: integer("duration_seconds"), // call duration
    contentRef:      text("content_ref"),        // transcript URL / email body hash
    rawWebhook:      jsonb("raw_webhook"),        // raw provider payload for audit

    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt:  timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    contractorIdx: index("idx_ot_contractor").on(t.contractorId),
    sequenceIdx:   index("idx_ot_sequence").on(t.sequenceId),
    touchTypeIdx:  index("idx_ot_type").on(t.touchType),
    occurredAtIdx: index("idx_ot_occurred_at").on(t.occurredAt),
    externalIdIdx: index("idx_ot_external_id").on(t.externalId),
    // fast funnel aggregation query
    funnelIdx:     index("idx_ot_funnel").on(
      t.contractorId,
      t.touchType,
      t.occurredAt
    ),
  })
);

// ─── TABLE 6: pipeline_state ─────────────────────────────────────────────────
/**
 * One row per Inngest pipeline. Tracks run state, offset (for resumable
 * pagination), and last error. Upserted at the start and end of every run.
 *
 * pipeline_name values (matches Inngest function IDs):
 *   "ingest-cslb" | "ingest-socrata-permits" | "ingest-socrata-inspections"
 *
 * Usage pattern:
 *   await db.insert(pipelineState)
 *     .values({ pipeline_name: "ingest-cslb", status: "running" })
 *     .onConflictDoUpdate({
 *       target: pipelineState.pipelineName,
 *       set: { status: "running", lastRunAt: new Date() },
 *     });
 */

export const pipelineStatusEnum = pgEnum("pipeline_status", [
  "idle", "running", "done", "error",
]);

export const pipelineState = pgTable("pipeline_state", {
  pipelineName:      text("pipeline_name").primaryKey(),
  lastRunAt:         timestamp("last_run_at", { withTimezone: true }),
  lastOffset:        integer("last_offset").default(0),
  lastCursor:        text("last_cursor"),
  recordsProcessed:  integer("records_processed").default(0),
  status:            pipelineStatusEnum("status").default("idle"),
  error:             text("error"),
});

// ─── TABLE 7: permits ────────────────────────────────────────────────────────
/**
 * LA City building/electrical/mechanical/plumbing permits from Socrata pi9x-tg5x.
 * Natural key: permit_number. Ingested by the fetch_lacity_permits pipeline.
 * project_category_ai populated by Claude Haiku after each ingest batch.
 *
 * Field name mapping (Socrata → our column):
 *   permit_nbr         → permit_number
 *   address_start      → address
 *   work_description   → work_description
 *   permit_type        → permit_type
 *   permit_sub_type    → permit_sub_type
 *   latest_status      → status
 *   valuation          → valuation_usd
 *   permit_date        → issued_date
 *   expiry_date        → expiration_date
 *   contractor_business_name → contractor_name
 *   adu_changed        → adu_flag
 *
 * IMPORTANT: verify real field names against:
 *   https://data.lacity.org/resource/pi9x-tg5x.json?$limit=1
 * before the first production run. See socrata-permits-fetcher.ts FIELD_NAMES.
 */

export const projectCategoryEnum = pgEnum("project_category", [
  "ADU", "JADU", "Kitchen", "Bathroom", "Addition", "Ground-Up",
  "Remodel", "Tenant-Improvement", "Solar", "EV-Charger",
  "Pool-Spa", "Demolition", "Grading", "Mechanical", "Electrical",
  "Plumbing", "Re-Roof", "Fire-Sprinkler", "Other",
]);

export const permits = pgTable(
  "permits",
  {
    // ── Identity ───────────────────────────────────────────────────────────
    id:           text("id").primaryKey().default(sql`gen_random_uuid()`),
    permitNumber: text("permit_number").notNull().unique(), // e.g. "24010-10000-06790"
    city:         text("city").default("LA City"),          // "LA City" | "LA County" | etc.

    // ── Location ───────────────────────────────────────────────────────────
    address:    text("address"),
    addressZip: text("address_zip"),
    // geom: see contractors_enriched for PostGIS migration pattern

    // ── Permit details ─────────────────────────────────────────────────────
    permitType:    text("permit_type"),     // BLDG | ELEC | MECH | PLUMB | GRAD
    permitSubType: text("permit_sub_type"),
    status:        text("status"),          // Permit Issued | CofO Issued | Expired | ...
    workDescription: text("work_description"),

    // LLM-classified category — populated by Claude Haiku post-ingest
    projectCategoryAi: projectCategoryEnum("project_category_ai"),

    // ── Financials & specs ─────────────────────────────────────────────────
    valuationUsd:    integer("valuation_usd"),      // USD (not cents — raw from Socrata)
    totalSqft:       integer("total_sqft"),
    numberOfStories: integer("number_of_stories"),
    occupancyType:   text("occupancy_type"),

    // ── Flags ─────────────────────────────────────────────────────────────
    aduFlag:         boolean("adu_flag").default(false),
    juniAdUFlag:     boolean("jadu_flag").default(false),
    ownerBuilderFlag: boolean("owner_builder_flag").default(false),
    evCharger:       boolean("ev_charger").default(false),
    solar:           boolean("solar").default(false),

    // ── Dates ─────────────────────────────────────────────────────────────
    issuedDate:       text("issued_date"),      // ISO date string "YYYY-MM-DD"
    expirationDate:   text("expiration_date"),
    finaledDate:      text("finaled_date"),
    planCheckDate:    text("plan_check_date"),
    statusDate:       text("status_date"),       // date of latest status change

    // ── Contractor reference ───────────────────────────────────────────────
    // Raw names from Socrata. contractor_id resolved via D1 cache (task 2.6).
    contractorName:    text("contractor_name"),
    contractorAddress: text("contractor_address"),
    contractorId:      text("contractor_id")
      .references(() => contractorsEnriched.id, { onDelete: "set null" }),

    // ── Applicant ──────────────────────────────────────────────────────────
    applicantName: text("applicant_name"),

    // ── Plan check ────────────────────────────────────────────────────────
    planCheckCorrections: text("plan_check_corrections"),

    // ── Raw payload ────────────────────────────────────────────────────────
    rawSocrata: jsonb("raw_socrata"), // full raw record for schema-drift auditing

    // ── Pipeline metadata ──────────────────────────────────────────────────
    socrataUpdatedAt: text("socrata_updated_at"), // :updated_at from Socrata
    classifiedAt:     timestamp("classified_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    permitNumberIdx:  uniqueIndex("idx_permits_number").on(t.permitNumber),
    contractorIdx:    index("idx_permits_contractor_id").on(t.contractorId),
    contractorNameIdx: index("idx_permits_contractor_name").on(t.contractorName),
    addressIdx:       index("idx_permits_address").on(t.address),
    statusIdx:        index("idx_permits_status").on(t.status),
    issuedDateIdx:    index("idx_permits_issued_date").on(t.issuedDate),
    aduIdx:           index("idx_permits_adu").on(t.aduFlag),
    categoryIdx:      index("idx_permits_category").on(t.projectCategoryAi),
    classifiedIdx:    index("idx_permits_classified").on(t.classifiedAt),
  })
);

// ─── TABLE 8: inspections ────────────────────────────────────────────────────
/**
 * LA City building inspections from Socrata 9w5z-rg2h.
 *
 * Real field names (verified 2026-04-23):
 *   permit           → permit_ref  (permit number string, FK candidate to permits.permit_number)
 *   address          → address
 *   permit_status    → permit_status
 *   inspection_date  → inspection_date
 *   inspection       → inspection_type
 *   inspection_result→ inspection_result
 *   lat_lon          → lat / lng
 *   :updated_at      → socrata_updated_at (Socrata system field, for delta mode)
 *
 * No inspection_number in this dataset — dedup key is (permit_ref, inspection_date, inspection_type).
 *
 * Computed fields (nullable until populated by later pipelines):
 *   trade_category_ai, correction_items_ai, is_final, was_first_attempt_pass,
 *   retry_count, sequence_position, days_since_previous
 */
export const inspections = pgTable(
  "inspections",
  {
    // ── Identity ───────────────────────────────────────────────────────────
    id: text("id").primaryKey().default(sql`gen_random_uuid()`),

    // ── Permit reference ──────────────────────────────────────────────────
    // Raw "permit" string from Socrata (e.g. "14044 10000 02293").
    // Used as dedup key. Matches permits.permit_number after space-trim normalization.
    permitRef: text("permit_ref").notNull(),
    // Resolved FK — populated by D1 sync (task 2.6) or join logic later.
    permitId: text("permit_id")
      .references(() => permits.id, { onDelete: "set null" }),

    // ── Socrata raw fields ─────────────────────────────────────────────────
    address:          text("address"),
    permitStatus:     text("permit_status"),    // "Issued" | "Permit Finaled" | etc.
    inspectionDate:   text("inspection_date"),  // ISO date "YYYY-MM-DD"
    inspectionType:   text("inspection_type"),  // "Rough-Ventilation" | "Smoke Detectors" | etc.
    inspectionResult: text("inspection_result"), // "Approved" | "Disapproved" | "Partial Approval" | etc.
    lat:              real("lat"),
    lng:              real("lng"),

    // ── Computed fields (future pipelines, nullable until then) ───────────
    // LLM trade classifier (Framing | Electrical | Plumbing | HVAC | etc.)
    tradeCategoryAi:     text("trade_category_ai"),
    // LLM-extracted correction items from result_description (future dataset/source)
    correctionItemsAi:   jsonb("correction_items_ai"),  // { trade, description, code }[]
    // Analytics computed from permit's full inspection timeline
    isFinal:             boolean("is_final"),
    wasFirstAttemptPass: boolean("was_first_attempt_pass"),
    retryCount:          integer("retry_count"),
    sequencePosition:    integer("sequence_position"),
    daysSincePrevious:   integer("days_since_previous"),

    // ── Pipeline metadata ─────────────────────────────────────────────────
    rawSocrata:       jsonb("raw_socrata"),        // full record for schema-drift auditing
    socrataUpdatedAt: text("socrata_updated_at"),  // :updated_at from Socrata (for delta)

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    // Dedup key: one record per (permit, date, type) — no natural inspection_number in dataset
    permitDateTypeIdx: uniqueIndex("idx_insp_permit_date_type").on(
      t.permitRef,
      t.inspectionDate,
      t.inspectionType
    ),
    permitRefIdx:   index("idx_insp_permit_ref").on(t.permitRef),
    permitIdIdx:    index("idx_insp_permit_id").on(t.permitId),
    dateIdx:        index("idx_insp_date").on(t.inspectionDate),
    resultIdx:      index("idx_insp_result").on(t.inspectionResult),
    typeIdx:        index("idx_insp_type").on(t.inspectionType),
  })
);

// ─── TABLE 9: inspection_stats_snapshots ─────────────────────────────────────
/**
 * One row per SUCCESSFUL run of the compute-inspection-stats pipeline.
 *
 * Holds the full machine-readable artifact (first-time pass rate per ADU inspection
 * type) as a jsonb payload. New row each run — history is preserved.
 * The site / CF Worker reads the latest by snapshot_date DESC.
 *
 * Idempotency: a failed/partial run throws and inserts nothing, so the previous
 * snapshot stays "latest". Never upserted.
 */
export const inspectionStatsSnapshots = pgTable(
  "inspection_stats_snapshots",
  {
    id:              text("id").primaryKey().default(sql`gen_random_uuid()`),
    snapshotDate:    text("snapshot_date").notNull(),     // 'YYYY-MM-DD' run date = "Last updated"
    periodStart:     text("period_start").notNull(),      // rolling window start 'YYYY-MM-DD'
    periodEnd:       text("period_end").notNull(),         // rolling window end 'YYYY-MM-DD'
    sampleThreshold: integer("sample_threshold").notNull().default(100),
    payload:         jsonb("payload").notNull(),           // full artifact (see compute-inspection-stats)
    createdAt:       timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    snapshotDateIdx: index("idx_iss_snapshot_date").on(t.snapshotDate),
  })
);

// -- TYPE EXPORTS -------------------------------------------------------------

export type ContractorEnriched    = typeof contractorsEnriched.$inferSelect;
export type NewContractorEnriched = typeof contractorsEnriched.$inferInsert;
export type EnrichmentSignal      = typeof enrichmentSignals.$inferSelect;
export type NewEnrichmentSignal   = typeof enrichmentSignals.$inferInsert;
export type Hypothesis            = typeof hypotheses.$inferSelect;
export type NewHypothesis         = typeof hypotheses.$inferInsert;
export type OutreachSequence      = typeof outreachSequences.$inferSelect;
export type NewOutreachSequence   = typeof outreachSequences.$inferInsert;
export type OutreachTouch         = typeof outreachTouches.$inferSelect;
export type NewOutreachTouch      = typeof outreachTouches.$inferInsert;
export type PipelineState         = typeof pipelineState.$inferSelect;
export type NewPipelineState      = typeof pipelineState.$inferInsert;
export type Permit                = typeof permits.$inferSelect;
export type NewPermit             = typeof permits.$inferInsert;
export type PipelineStatus        = typeof pipelineStatusEnum.enumValues[number];
export type SignalType            = typeof signalTypeEnum.enumValues[number];
export type TouchType             = typeof touchTypeEnum.enumValues[number];
export type PainAngle             = typeof painAngleEnum.enumValues[number];
export type IcpTier               = typeof icpTierEnum.enumValues[number];
export type Channel               = typeof channelEnum.enumValues[number];
export type ProjectCategory       = typeof projectCategoryEnum.enumValues[number];
export type Inspection            = typeof inspections.$inferSelect;
export type NewInspection         = typeof inspections.$inferInsert;
export type InspectionStatsSnapshot    = typeof inspectionStatsSnapshots.$inferSelect;
export type NewInspectionStatsSnapshot = typeof inspectionStatsSnapshots.$inferInsert;
