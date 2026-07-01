/**
 * test-cslb.ts - quick CSLB parser smoke test
 *
 * Usage:
 *   npx tsx src/scripts/test-cslb.ts 1234567
 *   npx tsx src/scripts/test-cslb.ts 1234567 --save-html
 *
 * --save-html: saves the real detail page HTML to cslb_debug.html.
 *   Open in browser + DevTools (F12) to inspect element IDs when a field is null.
 *   Look for IDs like: MainContent_BusInfo, MainContent_ExpDt, MainContent_Status
 *
 * NOTE: uses fetchCslbRawHtml() which does the correct GET->POST flow.
 * A direct GET to LicenseDetail.aspx always returns the search form --
 * parseCslbHtml() correctly returns null for it. Do not use that URL.
 */

import * as dotenv from "dotenv";
dotenv.config();

import * as fs from "fs";
import * as path from "path";
import { fetchCslbLicense, fetchCslbRawHtml, parseCslbHtml } from "../lib/cslb-fetcher";

const licenseNumber = process.argv[2];
const saveHtml = process.argv.includes("--save-html");

if (!licenseNumber) {
  console.error("\nUsage:");
  console.error("  npx tsx src/scripts/test-cslb.ts 1234567");
  console.error("  npx tsx src/scripts/test-cslb.ts 1234567 --save-html\n");
  process.exit(1);
}

(async () => {
  console.log("\nFetching CSLB license: " + licenseNumber + " ...\n");

  try {
    if (saveHtml) {
      const html = await fetchCslbRawHtml(licenseNumber);
      const debugPath = path.join(process.cwd(), "cslb_debug.html");
      fs.writeFileSync(debugPath, html, "utf8");
      console.log("HTML saved: " + debugPath);
      console.log("Open in browser + F12 -> look for id attributes like");
      console.log("  MainContent_BusInfo, MainContent_ExpDt, MainContent_Status, etc.\n");

      const result = parseCslbHtml(html, licenseNumber);
      if (!result) {
        console.log("WARNING: parseCslbHtml returned null.");
        console.log("Check cslb_debug.html:");
        console.log("  -> If it shows the search form: license does not exist OR CSLB is rate-limiting (wait 30s + retry)");
        console.log("  -> If it shows license details: check the isDetailPage guard in cslb-fetcher.ts");
      } else {
        console.log("OK - Parse result:");
        console.log(JSON.stringify(result, null, 2));
        reportNulls(result as unknown as Record<string, unknown>);
      }
    } else {
      const result = await fetchCslbLicense(licenseNumber);
      if (!result) {
        console.log("NOT FOUND. Run with --save-html to inspect raw HTML.");
      } else {
        console.log("OK - Result:");
        console.log(JSON.stringify(result, null, 2));
        reportNulls(result as unknown as Record<string, unknown>);
      }
    }
  } catch (err) {
    console.error("ERROR: " + (err as Error).message);
    process.exit(1);
  }
})();

function reportNulls(result: Record<string, unknown>) {
  const nullFields = Object.entries(result)
    .filter(([, v]) => v === null || (Array.isArray(v) && v.length === 0))
    .map(([k]) => k);

  if (nullFields.length === 0) {
    console.log("\nAll fields populated!");
  } else {
    console.log("\nEmpty / null fields: " + nullFields.join(", "));
    console.log("Run with --save-html -> open cslb_debug.html -> F12 -> find element -> update selector in cslb-fetcher.ts");
  }
}
