#!/usr/bin/env node

/**
 * Export operating factories retained in our database but absent from the
 * latest successful DIW sync population.
 *
 * This script is read-only. It uses factories.last_seen_in_feed, which the
 * nightly upsert stamps with one shared timestamp for every registration seen
 * during that run. Rows older than the maximum timestamp (or never stamped)
 * were not present in the latest feed.
 *
 * Usage:
 *   node server/scripts/export-diw-feed-gap.js [output.csv]
 */

const fs = require("fs");
const path = require("path");
const dotenv = require("../node_modules/dotenv");

const repoRoot = path.resolve(__dirname, "../..");
dotenv.config({ path: path.join(repoRoot, "server/sync/.env") });

const baseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_KEY;

if (!baseUrl || !serviceKey) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_KEY are required");
  process.exit(1);
}

const headers = {
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
};

const columns = [
  "id",
  "registration_display",
  "fid",
  "name",
  "factory_type",
  "province",
  "district",
  "sub_district",
  "address_full",
  "lat",
  "lng",
  "coord_source",
  "last_seen_in_feed",
  "absent_from_feed_as_of",
];

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function getJson(url) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  return response.json();
}

function increment(counter, key) {
  const normalized = key || "ไม่ระบุ";
  counter[normalized] = (counter[normalized] || 0) + 1;
}

async function main() {
  const factoriesUrl = `${baseUrl}/rest/v1/factories`;
  const latestRows = await getJson(
    `${factoriesUrl}?select=last_seen_in_feed` +
      `&order=last_seen_in_feed.desc.nullslast&limit=1`,
  );
  const latestSeen = latestRows[0]?.last_seen_in_feed;
  if (!latestSeen) throw new Error("No last_seen_in_feed timestamp found");

  const rows = [];
  const batchSize = 1000;
  let lastId = null;

  while (true) {
    const params = new URLSearchParams();
    params.set(
      "select",
      "id,registration_display,fid,name,factory_type,province,district," +
        "sub_district,address_full,lat,lng,coord_source,last_seen_in_feed",
    );
    params.set("status", "eq.ดำเนินการ");
    params.set("is_active", "eq.true");
    params.set(
      "or",
      `(last_seen_in_feed.lt.${latestSeen},last_seen_in_feed.is.null)`,
    );
    params.set("order", "id.asc");
    params.set("limit", String(batchSize));
    if (lastId !== null) params.set("id", `gt.${lastId}`);

    const batch = await getJson(`${factoriesUrl}?${params.toString()}`);
    if (batch.length === 0) break;
    rows.push(...batch);
    lastId = batch[batch.length - 1].id;
    process.stdout.write(`\rFetched ${rows.length.toLocaleString()} rows`);
  }
  process.stdout.write("\n");

  const date = latestSeen.slice(0, 10).replaceAll("-", "");
  const defaultOutput = path.join(
    repoRoot,
    "server/data",
    `diw_operating_missing_latest_${date}.csv`,
  );
  const outputPath = path.resolve(process.argv[2] || defaultOutput);
  const summaryPath = outputPath.replace(/\.csv$/i, "_summary.json");

  const csvLines = [columns.join(",")];
  const byType = {};
  const byProvince = {};
  const byLastSeen = {};
  let mapped = 0;

  for (const row of rows) {
    increment(byType, row.factory_type);
    increment(byProvince, row.province);
    increment(byLastSeen, row.last_seen_in_feed?.slice(0, 10) || "never");
    if (row.lat !== null && row.lng !== null) mapped += 1;
    const enriched = { ...row, absent_from_feed_as_of: latestSeen };
    csvLines.push(columns.map((column) => csvCell(enriched[column])).join(","));
  }

  fs.writeFileSync(outputPath, `${csvLines.join("\n")}\n`, "utf8");

  const summary = {
    definition:
      "status=ดำเนินการ AND is_active=true AND last_seen_in_feed older than latest feed timestamp (or null)",
    latest_feed_timestamp_utc: latestSeen,
    missing_operating_factories: rows.length,
    mapped,
    unmapped: rows.length - mapped,
    by_factory_type: Object.fromEntries(
      Object.entries(byType).sort(([a], [b]) => a.localeCompare(b, "th")),
    ),
    by_province: Object.fromEntries(
      Object.entries(byProvince).sort(([, a], [, b]) => b - a),
    ),
    by_last_seen_date: Object.fromEntries(
      Object.entries(byLastSeen).sort(([a], [b]) => b.localeCompare(a)),
    ),
    csv: outputPath,
  };
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  console.log(`CSV: ${outputPath}`);
  console.log(`Summary: ${summaryPath}`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
