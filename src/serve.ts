import * as dotenv from "dotenv";
dotenv.config();

import { createServer } from "inngest/node";
import {
  inngest,
  ingestCslb,
  ingestLacityPermits,
  ingestLacityInspections,
  linkPermitsToContractors,
  computeIcpScores,
  generateHypotheses,
  syncToTwenty,
  sendSmsOutreach,
  initiateVapiCalls,
  computeInspectionStatsFn,
} from "./inngest";

const server = createServer({
  client: inngest,
  functions: [
    ingestCslb,
    ingestLacityPermits,
    ingestLacityInspections,
    linkPermitsToContractors,
    computeIcpScores,
    generateHypotheses,
    syncToTwenty,
    sendSmsOutreach,
    initiateVapiCalls,
    computeInspectionStatsFn,
  ],
});

const PORT = 3000;

server.listen(PORT, () => {
  console.log(`✅ Inngest serve handler running on http://localhost:${PORT}/api/inngest`);
  console.log(`   Inngest Dev UI: http://localhost:8288`);
});
