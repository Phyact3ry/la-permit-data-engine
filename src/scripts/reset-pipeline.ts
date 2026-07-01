import { db } from "../lib/db";
import { pipelineState } from "../schema";
import { eq, sql } from "drizzle-orm";

async function main() {
  const name = process.argv[2];
  if (!name) { console.error("Usage: tsx reset-pipeline.ts <pipeline-name>"); process.exit(1); }
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ WRITE`);
    await tx.update(pipelineState).set({ status: "done" }).where(eq(pipelineState.pipelineName, name));
  });
  console.log(`Reset "${name}" → done`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
