import { db } from "../lib/db";
import { permits } from "../schema";
import { sql } from "drizzle-orm";

async function main() {
  const rows = await db
    .select({ status: permits.status, cnt: sql<number>`cast(count(*) as int)` })
    .from(permits)
    .groupBy(permits.status)
    .orderBy(sql`count(*) desc`)
    .limit(20);

  console.log("=== Permit Status Distribution ===");
  for (const r of rows) {
    console.log(`  ${String(r.cnt).padStart(8)}  ${r.status ?? "(null)"}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
