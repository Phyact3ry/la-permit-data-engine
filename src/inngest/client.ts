import { Inngest } from "inngest";

// Prod (Inngest Cloud) когда INNGEST_DEV не выставлен в "1"/"true".
// eventKey / signingKey SDK берёт из env (INNGEST_EVENT_KEY / INNGEST_SIGNING_KEY).
const isDev = /^(1|true)$/i.test(process.env.INNGEST_DEV ?? "");

export const inngest = new Inngest({
  id: "la-permit-data-engine",  // ID приложения в Inngest Cloud
  isDev,
});