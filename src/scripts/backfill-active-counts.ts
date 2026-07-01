import { db } from "../lib/db";
import { permits, contractorsEnriched } from "../schema";
import { sql } from "drizzle-orm";

const TERMINAL_STATUSES = [
  "Permit Finaled", "Permit Expired", "Permit Closed", "Permit Withdrawn",
  "Permit Revoked", "Refund Completed", "CofO Issued", "CofC Issued",
  "CofO Corrected", "CofC Corrected",
];

async function main() {
  console.log("Fetching all contractors with linked permits...");
  const contractorRows = await db
    .selectDistinct({ contractorId: permits.contractorId })
    .from(permits)
    .where(sql`${permits.contractorId} IS NOT NULL`);

  const allIds = contractorRows.map((r) => r.contractorId!);
  console.log(`Found ${allIds.length} contractors to recompute.`);

  const CHUNK = 500;
  let updated = 0;

  for (let i = 0; i < allIds.length; i += CHUNK) {
    const chunk = allIds.slice(i, i + CHUNK);
    const idList = sql.join(chunk.map((id) => sql`${id}`), sql`, `);

    const terminalList = sql.join(TERMINAL_STATUSES.map((s) => sql`${s}`), sql`, `);

    const [activeCounts, cityCounts] = await Promise.all([
      db
        .select({
          contractorId: permits.contractorId,
          cnt: sql<number>`cast(count(*) as int)`,
        })
        .from(permits)
        .where(sql`${permits.contractorId} IN (${idList}) AND ${permits.status} NOT IN (${terminalList})`)
        .groupBy(permits.contractorId),
      db
        .select({
          contractorId: permits.contractorId,
          city:         permits.city,
          cnt:          sql<number>`cast(count(*) as int)`,
        })
        .from(permits)
        .where(sql`${permits.contractorId} IN (${idList})`)
        .groupBy(permits.contractorId, permits.city),
    ]);

    const activeMap: Record<string, number> = {};
    for (const r of activeCounts) {
      if (r.contractorId) activeMap[r.contractorId] = r.cnt;
    }

    const cityMapByContractor: Record<string, Record<string, number>> = {};
    for (const r of cityCounts) {
      if (!r.contractorId || !r.city) continue;
      (cityMapByContractor[r.contractorId] ??= {})[r.city] = r.cnt;
    }

    const rows = sql.join(
      chunk.map((cid) => {
        const active  = activeMap[cid] ?? 0;
        const cityMap = JSON.stringify(cityMapByContractor[cid] ?? {});
        return sql`(${cid}::text, ${active}::int, ${cityMap}::jsonb)`;
      }),
      sql`, `
    );

    await db.execute(sql`
      UPDATE contractors_enriched AS ce
      SET permit_count_active  = m.active_count,
          permit_count_by_city = m.city_map,
          updated_at           = NOW()
      FROM (VALUES ${rows}) AS m(cid, active_count, city_map)
      WHERE ce.id = m.cid
    `);

    updated += chunk.length;
    if (i % 5000 === 0 || i + CHUNK >= allIds.length) {
      console.log(`  ${updated}/${allIds.length} done`);
    }
  }

  // Verify
  const [withActive] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(contractorsEnriched)
    .where(sql`${contractorsEnriched.permitCountActive} > 0`);

  console.log(`\nDone. Contractors with permit_count_active > 0: ${withActive.count}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
