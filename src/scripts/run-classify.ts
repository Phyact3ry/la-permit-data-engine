import { classifyUnclassifiedPermits } from "../lib/socrata-permits-fetcher";

async function main() {
  console.log("[classify] Starting standalone classification...");
  const start = Date.now();
  const total = await classifyUnclassifiedPermits();
  const mins = ((Date.now() - start) / 60_000).toFixed(1);
  console.log(`[classify] Done — ${total} permits classified in ${mins} min`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
