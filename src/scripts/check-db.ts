import { db } from "../lib/db";
import { inspections, pipelineState, permits } from "../schema";
import { sql, eq } from "drizzle-orm";

async function main() {
  const [iCount] = await db.select({ count: sql<number>`count(*)` }).from(inspections);
  const [pCount] = await db.select({ count: sql<number>`count(*)` }).from(permits);
  const [iState] = await db
    .select()
    .from(pipelineState)
    .where(eq(pipelineState.pipelineName, "ingest-lacity-inspections"));
  const [pState] = await db
    .select()
    .from(pipelineState)
    .where(eq(pipelineState.pipelineName, "ingest-lacity-permits"));

  console.log("=== DB Status ===");
  console.log("Permits in DB:       ", pCount.count);
  console.log("Inspections in DB:   ", iCount.count);
  console.log("\n--- Permits pipeline ---");
  console.log(JSON.stringify(pState ?? "no state", null, 2));
  console.log("\n--- Inspections pipeline ---");
  console.log(JSON.stringify(iState ?? "no state", null, 2));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
