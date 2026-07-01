import "dotenv/config";
import { db } from "../lib/db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("[trgm] Enabling pg_trgm extension...");
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

  console.log("[trgm] Creating GIN index on contractors_enriched.business_name...");
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_contractors_business_name_trgm
    ON contractors_enriched
    USING GIN (business_name gin_trgm_ops)
  `);

  console.log("[trgm] Done — ILIKE queries on business_name are now fast.");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
