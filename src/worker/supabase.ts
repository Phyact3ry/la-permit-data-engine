const SELECT_FIELDS = [
  "id", "cslb_license", "business_name", "owner_name", "phone", "email", "website",
  "address_street", "address_city", "address_state", "address_zip", "license_class",
  "icp_score", "icp_tier", "has_active_license", "permit_count_active", "permit_count_total",
].join(",");

interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
}

interface ContractorRow {
  id: string;
  cslb_license: string;
  business_name: string;
  owner_name: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  address_street: string | null;
  address_city: string | null;
  address_state: string | null;
  address_zip: string | null;
  license_class: string | null;
  icp_score: number | null;
  icp_tier: string | null;
  has_active_license: boolean;
  permit_count_active: number;
  permit_count_total: number;
}

export interface ContractorResult {
  id: string;
  cslbLicense: string;
  businessName: string;
  ownerName: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  addressStreet: string | null;
  addressCity: string | null;
  addressState: string | null;
  addressZip: string | null;
  licenseClass: string | null;
  icpScore: number | null;
  icpTier: string | null;
  hasActiveLicense: boolean;
  permitCountActive: number;
  permitCountTotal: number;
}

function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10) return digits;
  return null;
}

function mapRow(row: ContractorRow): ContractorResult {
  return {
    id:               row.id,
    cslbLicense:      row.cslb_license,
    businessName:     row.business_name,
    ownerName:        row.owner_name,
    phone:            row.phone,
    email:            row.email,
    website:          row.website,
    addressStreet:    row.address_street,
    addressCity:      row.address_city,
    addressState:     row.address_state,
    addressZip:       row.address_zip,
    licenseClass:     row.license_class,
    icpScore:         row.icp_score,
    icpTier:          row.icp_tier,
    hasActiveLicense: row.has_active_license,
    permitCountActive: row.permit_count_active,
    permitCountTotal:  row.permit_count_total,
  };
}

export async function getTouchByExternalId(
  env: Env,
  externalId: string
): Promise<{ contractor_id: string; hypothesis_id: string | null; sequence_id: string | null } | null> {
  const url = `${env.SUPABASE_URL}/rest/v1/outreach_touches?external_id=eq.${encodeURIComponent(externalId)}&touch_type=eq.call_placed&select=contractor_id,hypothesis_id,sequence_id&limit=1`;
  const res = await fetch(url, {
    headers: {
      apikey:        env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) return null;
  const rows = (await res.json()) as Array<{ contractor_id: string; hypothesis_id: string | null; sequence_id: string | null }>;
  return rows.length ? rows[0] : null;
}

export async function insertTouch(
  env: Env,
  row: {
    contractor_id:    string;
    hypothesis_id:    string | null;
    sequence_id:      string | null;
    channel:          string;
    direction:        string;
    touch_type:       string;
    external_id:      string;
    duration_seconds?: number;
    occurred_at:      string;
  }
): Promise<void> {
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/outreach_touches`, {
    method: "POST",
    headers: {
      apikey:         env.SUPABASE_SERVICE_KEY,
      Authorization:  `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer:         "return=minimal",
    },
    body: JSON.stringify(row),
  });
  if (!resp.ok) throw new Error(`insertTouch failed: ${resp.status} ${await resp.text()}`);
}

/** Full inspection-stats artifact payload. Shape mirrors
 *  compute-inspection-stats.ts InspectionStatsArtifact. */
export interface InspectionStatsPayload {
  snapshot_date: string;
  period: { start: string; end: string; label: string };
  source: Record<string, string>;
  methodology: string;
  sample_threshold: number;
  types: Array<{ slug: string; [key: string]: unknown }>;
}

/** Read the latest published inspection-stats snapshot (by snapshot_date desc). */
export async function getLatestInspectionSnapshot(
  env: Env
): Promise<InspectionStatsPayload | null> {
  const url = `${env.SUPABASE_URL}/rest/v1/inspection_stats_snapshots?select=payload&order=snapshot_date.desc&limit=1`;
  const res = await fetch(url, {
    headers: {
      apikey:        env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) return null;
  const rows = (await res.json()) as Array<{ payload: InspectionStatsPayload }>;
  return rows.length ? rows[0].payload : null;
}

export async function queryContractor(
  env: Env,
  filter: { cslbLicense?: string; phone?: string }
): Promise<ContractorResult | null> {
  const base = `${env.SUPABASE_URL}/rest/v1/contractors_enriched?select=${SELECT_FIELDS}`;
  const headers = {
    apikey:        env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
  };

  let url: string;
  if (filter.cslbLicense !== undefined) {
    url = `${base}&cslb_license=eq.${encodeURIComponent(filter.cslbLicense)}&limit=1`;
  } else if (filter.phone !== undefined) {
    const normalized = normalizePhone(filter.phone);
    if (!normalized) return null;
    url = `${base}&phone=eq.${normalized}&limit=1`;
  } else {
    return null;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) return null;

  const rows = (await res.json()) as ContractorRow[];
  if (!rows.length) return null;
  return mapRow(rows[0]);
}
