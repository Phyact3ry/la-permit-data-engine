import { db } from "../lib/db";
import { permits, contractorsEnriched, pipelineState } from "../schema";
import { sql, eq, isNotNull, isNull } from "drizzle-orm";

async function main() {
  // 1. Pipeline state
  const [state] = await db
    .select()
    .from(pipelineState)
    .where(eq(pipelineState.pipelineName, "link-permits-to-contractors"));

  console.log("=== A3 Pipeline State ===");
  console.log(JSON.stringify(state ?? "no state", null, 2));

  // 2. Link coverage
  const [linked] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(permits)
    .where(isNotNull(permits.contractorId));

  const [unlinked] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(permits)
    .where(isNull(permits.contractorId));

  const total = linked.count + unlinked.count;
  const pct   = total > 0 ? ((linked.count / total) * 100).toFixed(1) : "0";

  console.log("\n=== Link Coverage ===");
  console.log(`Linked:   ${linked.count.toLocaleString()} (${pct}%)`);
  console.log(`Unlinked: ${unlinked.count.toLocaleString()}`);
  console.log(`Total:    ${total.toLocaleString()}`);

  // 3. Contractors with updated counters
  const [withActive] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(contractorsEnriched)
    .where(sql`${contractorsEnriched.permitCountActive} > 0`);

  const [withLinked] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(contractorsEnriched)
    .where(sql`${contractorsEnriched.permitCountByCity} != '{}'::jsonb`);

  console.log("\n=== Contractor Counters ===");
  console.log(`With permit_count_active > 0:    ${withActive.count.toLocaleString()}`);
  console.log(`With permit_count_by_city set:   ${withLinked.count.toLocaleString()}`);

  // 4. Top 5 contractors by active permits
  const top5 = await db
    .select({
      businessName:      contractorsEnriched.businessName,
      cslbLicense:       contractorsEnriched.cslbLicense,
      permitCountActive: contractorsEnriched.permitCountActive,
      permitCountByCity: contractorsEnriched.permitCountByCity,
    })
    .from(contractorsEnriched)
    .where(sql`${contractorsEnriched.permitCountActive} > 0`)
    .orderBy(sql`${contractorsEnriched.permitCountActive} DESC`)
    .limit(5);

  console.log("\n=== Top 5 Contractors by Active Permits ===");
  for (const c of top5) {
    console.log(`  ${c.businessName} [${c.cslbLicense}]: ${c.permitCountActive} active`);
    console.log(`    Cities: ${JSON.stringify(c.permitCountByCity)}`);
  }

  // 5. Sample of linked permits
  const sample = await db
    .select({
      permitId:         permits.id,
      contractorName:   permits.contractorName,
      contractorId:     permits.contractorId,
      businessName:     contractorsEnriched.businessName,
      cslbLicense:      contractorsEnriched.cslbLicense,
    })
    .from(permits)
    .innerJoin(contractorsEnriched, eq(permits.contractorId, contractorsEnriched.id))
    .limit(5);

  console.log("\n=== Sample Linked Permits ===");
  for (const r of sample) {
    console.log(`  Permit: ${r.permitId}`);
    console.log(`    Permit name:     "${r.contractorName}"`);
    console.log(`    Matched to:      "${r.businessName}" [${r.cslbLicense}]`);
  }

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
