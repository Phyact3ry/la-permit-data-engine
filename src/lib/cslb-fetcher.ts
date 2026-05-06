/**
 * cslb-fetcher.ts — CSLB License Scraper
 *
 * CSLB does NOT support direct GET to LicenseDetail.aspx?LicNum=X without a
 * valid ASP.NET session. A direct GET returns the search form page.
 *
 * Correct flow (verified with real CSLB site, license #1014160):
 *   1. GET CheckLicense.aspx  -> collect ASP.NET_SessionId + VIEWSTATE tokens
 *   2. POST CheckLicense.aspx with tokens + license number + submit button name
 *   3. Server 302-redirects to LicenseDetail.aspx?LicNum=X (session cookie carried)
 *   4. Parse the resulting detail page HTML
 *
 * Public API:
 *   fetchCslbRawHtml(licenseNumber)  -> raw HTML string (for debugging)
 *   fetchCslbLicense(licenseNumber)  -> CslbLicenseData | null
 *   fetchCslbBatch(licenseNumbers)   -> { results, notFound, errors }
 */

import * as cheerio from "cheerio";

const CSLB_SEARCH_URL =
  "https://www.cslb.ca.gov/OnlineServices/CheckLicenseII/CheckLicense.aspx";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ---- Types ------------------------------------------------------------------

export interface DisciplinaryAction {
  date: string;
  type: string;
  description: string;
}

export interface PersonnelEntry {
  name: string;
  title: string;
}

export interface SecondaryLicense {
  license: string;
  licenseClass: string;
  status: string;
}

export interface CslbLicenseData {
  cslbLicense: string;
  businessName: string | null;
  ownerName: string | null;
  phone: string | null;
  addressStreet: string | null;
  addressCity: string | null;
  addressState: string;
  addressZip: string | null;
  licenseClass: string | null;
  licenseStatus: "active" | "inactive" | "suspended" | "expired" | null;
  licenseExpiry: string | null;
  bondAmount: number | null;
  workerCompInsurer: string | null;
  workerCompExpiry: string | null;
  hasActiveLicense: boolean;
  disciplinaryActions: DisciplinaryAction[];
  personnelOnLicense: PersonnelEntry[];
  secondaryLicenses: SecondaryLicense[];
}

// ---- Helpers ----------------------------------------------------------------

function normalizeLicenseStatus(
  raw: string | null
): CslbLicenseData["licenseStatus"] {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (s.includes("active")) return "active";
  if (s.includes("suspended")) return "suspended";
  if (s.includes("expired") || s.includes("expir")) return "expired";
  return "inactive";
}

function parseDollars(raw: string | null): number | null {
  if (!raw) return null;
  const num = parseFloat(raw.replace(/[$,\s]/g, ""));
  return isNaN(num) ? null : Math.round(num * 100);
}

function normalizePhone(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10) return digits;
  return null;
}

function byIdFragment($: cheerio.CheerioAPI, ...fragments: string[]): string | null {
  for (const frag of fragments) {
    const el = $('[id*="' + frag + '"]').first();
    if (el.length) {
      const val = el.text().trim();
      if (val) return val;
    }
  }
  return null;
}

// ---- Parser -----------------------------------------------------------------

/**
 * Parse the CSLB LicenseDetail page HTML.
 *
 * Verified element IDs from real response for license #1014160:
 *   #MainContent_BusInfo         business name + street + city/state/zip + phone
 *                                separated by <br/> tags (NOT newlines in .text()!)
 *   #MainContent_Entity          entity type ("Ltd Liability")
 *   #MainContent_IssDt           issue date  ("05/13/2016")
 *   #MainContent_ExpDt           license expire date ("05/31/2028")
 *   #MainContent_Status          status text ("This license is current and active.")
 *   #MainContent_ClassCellTable  classification links ("B - GENERAL BUILDING")
 *   #MainContent_BondingCellTable bonding info with <strong>Bond Amount: </strong>
 *   #MainContent_WCStatus        WC insurer in <a> tag, expire date in <strong>
 *
 * Returns null if the HTML is the search page (wrong URL / blocked / not found).
 */
export function parseCslbHtml(
  html: string,
  licenseNumber: string
): CslbLicenseData | null {
  const $ = cheerio.load(html);
  const bodyText = $("body").text().toLowerCase();

  // Guard: search form is present -> we got the wrong page
  const isSearchPage =
    $('input[name="ctl00$MainContent$LicNo"]').length > 0 ||
    bodyText.includes("enter the contractor license number to check") ||
    bodyText.includes("type only the first 10 to 15 letters");

  if (isSearchPage) return null;

  // Guard: must be a detail page
  const isDetailPage =
    bodyText.includes("license detail for license") ||
    $("#MainContent_Header2Detail").length > 0 ||
    $("h1").text().toLowerCase().includes("license detail");

  if (!isDetailPage) return null;

  // ---- Business Information -------------------------------------------------
  // #MainContent_BusInfo: NAME<br/>STREET<br/>CITY, STATE ZIP<br/>Business Phone Number:PHONE
  // IMPORTANT: cheerio .text() does NOT insert newlines for <br> tags.
  // We must split the innerHTML on <br> ourselves.
  let businessName: string | null = null;
  let phone: string | null = null;
  let addressStreet: string | null = null;
  let addressCity: string | null = null;
  let addressZip: string | null = null;

  const busInfoEl = $("#MainContent_BusInfo");
  if (busInfoEl.length) {
    const rawHtml = busInfoEl.html() ?? "";
    const parts = rawHtml
      .split(/<br\s*\/?>/gi)
      .map((p) => p.replace(/<[^>]+>/g, "").trim())
      .filter(Boolean);

    if (parts[0]) businessName = parts[0];
    if (parts[1]) addressStreet = parts[1];
    if (parts[2]) {
      const cityMatch = parts[2].match(/^(.+),\s*([A-Z]{2})\s*(\d{5}(?:-\d{4})?)/);
      if (cityMatch) {
        addressCity = cityMatch[1].trim();
        addressZip = cityMatch[3];
      } else {
        addressCity = parts[2];
      }
    }
    const phonePart = parts.find((p) => /Business Phone Number/i.test(p));
    if (phonePart) {
      phone = normalizePhone(phonePart.replace(/Business Phone Number[:\s]*/i, ""));
    }
  }

  // ---- Entity ---------------------------------------------------------------
  // <td id="MainContent_Entity">Ltd Liability</td>
  const entityRaw = byIdFragment($, "Entity") || null;

  // ---- License expiry -------------------------------------------------------
  // <td id="MainContent_ExpDt" ...>05/31/2028</td>
  const licenseExpiry = byIdFragment($, "ExpDt") || null;

  // ---- License status -------------------------------------------------------
  // <td id="MainContent_Status"><span><strong>This license is current and active.</strong>...
  let licenseStatusRaw: string | null = null;
  const statusEl = $("#MainContent_Status");
  if (statusEl.length) {
    const statusText = statusEl.text().toLowerCase();
    if (statusText.includes("current and active"))  licenseStatusRaw = "active";
    else if (statusText.includes("not current"))    licenseStatusRaw = "inactive";
    else if (statusText.includes("suspended"))      licenseStatusRaw = "suspended";
    else if (statusText.includes("expired"))        licenseStatusRaw = "expired";
  }
  if (!licenseStatusRaw) {
    if (bodyText.includes("current and active")) licenseStatusRaw = "active";
    else if (bodyText.includes("not current"))   licenseStatusRaw = "inactive";
    else if (bodyText.includes("suspended"))     licenseStatusRaw = "suspended";
  }
  const licenseStatus = normalizeLicenseStatus(licenseStatusRaw);

  // ---- License class --------------------------------------------------------
  // <td id="MainContent_ClassCellTable"><a href="...">B - GENERAL BUILDING</a></td>
  let licenseClass: string | null = null;
  const classEl = $("#MainContent_ClassCellTable");
  if (classEl.length) {
    licenseClass = classEl.find("a").first().text().trim() || null;
  }

  // ---- Bond amount ----------------------------------------------------------
  // Inside #MainContent_BondingCellTable:
  //   <p><strong>Bond Amount: </strong>$25,000</p>
  // We take the FIRST match (= Contractor's Bond).
  let bondAmount: number | null = null;
  const bondingEl = $("#MainContent_BondingCellTable");
  if (bondingEl.length) {
    bondingEl.find("strong").each((_, el) => {
      if ($(el).text().trim() === "Bond Amount:") {
        const val = $(el).parent().text().replace("Bond Amount:", "").trim();
        bondAmount = parseDollars(val);
        return false as any; // stop after first match
      }
    });
  }

  // ---- Workers' Compensation ------------------------------------------------
  // <td id="MainContent_WCStatus">
  //   <p>...insurance with the <a>PIE INSURANCE COMPANY (THE)</a></p>
  //   <strong>Expire Date:</strong> 02/03/2027<br />
  // </td>
  let workerCompInsurer: string | null = null;
  let workerCompExpiry: string | null = null;
  const wcEl = $("#MainContent_WCStatus");
  if (wcEl.length) {
    workerCompInsurer = wcEl.find("a").first().text().trim() || null;
    const wcHtml = wcEl.html() ?? "";
    const expireMatch = wcHtml.match(/<strong>Expire Date:<\/strong>\s*(\d{2}\/\d{2}\/\d{4})/i);
    if (expireMatch) workerCompExpiry = expireMatch[1];
  }

  // ---- Personnel & secondary licenses --------------------------------------
  // Personnel requires a separate POST (PersonnelLink button) — not on this page.
  const personnelOnLicense: PersonnelEntry[] = [];
  const secondaryLicenses: SecondaryLicense[] = [];

  return {
    cslbLicense: licenseNumber,
    businessName,
    ownerName: null,
    phone,
    addressStreet,
    addressCity,
    addressState: "CA",
    addressZip,
    licenseClass,
    licenseStatus,
    licenseExpiry,
    bondAmount,
    workerCompInsurer,
    workerCompExpiry,
    hasActiveLicense: licenseStatus === "active",
    disciplinaryActions: [],
    personnelOnLicense,
    secondaryLicenses,
  };
}

// ---- HTTP layer -------------------------------------------------------------

/**
 * Fetch the raw HTML of a CSLB license detail page.
 * Uses the correct GET->POST flow with session cookie + VIEWSTATE.
 * Exported so test-cslb.ts --save-html can save it for selector debugging.
 */
export async function fetchCslbRawHtml(licenseNumber: string): Promise<string> {
  // Step 1: GET search page -> session cookie + ASP.NET VIEWSTATE tokens
  const getRes = await fetch(CSLB_SEARCH_URL, {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml",
    },
  });

  if (!getRes.ok) {
    throw new Error("CSLB search page GET failed: " + getRes.status);
  }

  const getHtml = await getRes.text();
  const $get = cheerio.load(getHtml);

  const viewState   = ($get('input[name="__VIEWSTATE"]').val()          as string) ?? "";
  const vsGenerator = ($get('input[name="__VIEWSTATEGENERATOR"]').val() as string) ?? "";
  const eventVal    = ($get('input[name="__EVENTVALIDATION"]').val()    as string) ?? "";

  if (!viewState) {
    throw new Error("CSLB: could not extract __VIEWSTATE from search page");
  }

  // Extract ASP.NET_SessionId cookie
  const rawSetCookie = getRes.headers.get("set-cookie") ?? "";
  const sessionMatch = rawSetCookie.match(/ASP\.NET_SessionId=[^;]+/);
  const sessionCookie = sessionMatch ? sessionMatch[0] : "";

  // Step 2: POST the search form
  // CRITICAL: include the submit button name -- ASP.NET WebForms uses it to
  // identify which button was clicked. Without it, the server ignores the search.
  const body = new URLSearchParams();
  body.set("__VIEWSTATE",            viewState);
  body.set("__VIEWSTATEGENERATOR",   vsGenerator);
  body.set("__EVENTVALIDATION",      eventVal);
  body.set("ctl00$MainContent$LicNo", licenseNumber);
  body.set("ctl00$MainContent$Contractor_License_Number_Search", " ");

  const postRes = await fetch(CSLB_SEARCH_URL, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": sessionCookie,
      "Referer": CSLB_SEARCH_URL,
      "Origin": "https://www.cslb.ca.gov",
      "Accept": "text/html,application/xhtml+xml",
    },
    body: body.toString(),
    redirect: "follow", // follows 302 to LicenseDetail.aspx?LicNum=X (same origin)
  });

  if (!postRes.ok) {
    throw new Error("CSLB POST failed: " + postRes.status + " " + postRes.statusText);
  }

  return postRes.text();
}

/**
 * Fetch and parse a single CSLB license.
 * Returns null if the license number is not found.
 */
export async function fetchCslbLicense(
  licenseNumber: string
): Promise<CslbLicenseData | null> {
  const html = await fetchCslbRawHtml(licenseNumber);
  return parseCslbHtml(html, licenseNumber);
}

/**
 * Fetch a batch of CSLB licenses with rate-limit delay between requests.
 */
export async function fetchCslbBatch(
  licenseNumbers: string[],
  options: { delayMs?: number } = {}
): Promise<{ results: CslbLicenseData[]; notFound: number; errors: number }> {
  const { delayMs = 800 } = options;
  const results: CslbLicenseData[] = [];
  let notFound = 0;
  let errors = 0;

  for (let i = 0; i < licenseNumbers.length; i++) {
    const license = licenseNumbers[i];
    try {
      const data = await fetchCslbLicense(license);
      if (data) {
        results.push(data);
      } else {
        notFound++;
      }
    } catch (err) {
      errors++;
      console.error("[cslb] Error fetching " + license + ": " + (err as Error).message);
    }

    if (i < licenseNumbers.length - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  return { results, notFound, errors };
}
