import { db } from "../lib/db";
import { permits, contractorsEnriched } from "../schema";
import { sql } from "drizzle-orm";

async function main() {
  // 1. Check "Unknown [0]" contractor — is it distorting results?
  const [unknown] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(permits)
    .where(sql`${permits.contractorId} IN (
      SELECT id FROM contractors_enriched WHERE cslb_license = '0'
    )`);

  // 2. Real contractors (excluding [0]) with active permits
  const [realActive] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(contractorsEnriched)
    .where(sql`${contractorsEnriched.permitCountActive} > 0 AND ${contractorsEnriched.cslbLicense} != '0'`);

  // 3. Pass 0 (CSLB license) vs Pass 1/2 coverage estimate
  const [withLicense] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(permits)
    .where(sql`${permits.contractorId} IS NOT NULL AND ${permits.rawSocrata}->>'license' IS NOT NULL AND ${permits.rawSocrata}->>'license' != '' AND ${permits.rawSocrata}->>'license' != '0'`);

  // 4. permit_count_total still 0 (expected — A4 fills it)
  const [zeroTotal] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(contractorsEnriched)
    .where(sql`${contractorsEnriched.permitCountTotal} = 0`);

  const [totalCe] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(contractorsEnriched);

  console.log("=== A3 Deep Verification ===");
  console.log(`Permits linked to 'Unknown [0]':       ${unknown.count.toLocaleString()}`);
  console.log(`Real contractors w/ active permits:    ${realActive.count.toLocaleString()}`);
  console.log(`Permits w/ real CSLB license linked:  ${withLicense.count.toLocaleString()}`);
  console.log(`permit_count_total = 0 (expected):    ${zeroTotal.count}/${totalCe.count} ✅ (A4 fills this)`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
