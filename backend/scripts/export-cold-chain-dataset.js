// Exports the cold-chain training data (Component 2) from Supabase for the
// AI service: ai-service/cold_chain/training/build_dataset.py reads it.
//
// Writes three files to a new folder (git-ignored):
//   trips.csv      one row per started trip: limits, planned/actual delivery
//                  times, truck type, sensor type, origin/destination coordinates
//   readings.csv   every sensor reading of those trips, as stored (no changes)
//   manifest.json  dataset version (SHA-256 of both CSVs), counts, filters
//
// Real data only by default: test shipments (is_test, simulated readings) are
// left out. --include-test adds them for a pipeline smoke test; the manifest
// then says "validForEvaluation": false and the data must not be used for
// research results.
//
// Personal data is not exported: no driver, account, phone, licence or truck
// registration columns, and no free-text notes. Raw GPS stays in the export
// only so movement features can be derived from it.
//
// The planned delivery time can be edited during a trip, which would leak the
// outcome into the delay label. The audit log is used to recover the value in
// effect when the trip started (expected_delivery_at_start).
//
// Usage (from backend/):
//   node --env-file=.env scripts/export-cold-chain-dataset.js [--include-test] [--out DIR]
//   default DIR: ../ai-service/cold_chain/data/exports/<UTC time>-<real|with-test>

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const supabase = require("../src/config/supabase");

const PAGE = 1000;
const IDS_PER_QUERY = 100;

const TRIP_SELECT =
  "shipment_id, is_test, storage_condition, temp_min_c, temp_max_c, humidity_min_pct, humidity_max_pct, " +
  "reading_interval_seconds, trip_status, trip_started_at, expected_delivery_at, delivered_at, " +
  "truck:cold_chain_trucks(truck_type, is_refrigerated), device:cold_chain_devices(device_type), " +
  "pharmacy:pharmacies(location:locations(latitude, longitude)), " +
  "shipment:shipments!inner(shipment_number, warehouse:warehouses(location:locations(latitude, longitude)))";

const TRIP_COLUMNS = [
  "shipment_id",
  "shipment_number",
  "is_test",
  "storage_condition",
  "temp_min_c",
  "temp_max_c",
  "humidity_min_pct",
  "humidity_max_pct",
  "reading_interval_seconds",
  "trip_status",
  "trip_started_at",
  "expected_delivery_at",
  "expected_delivery_at_start",
  "eta_source",
  "eta_changed_after_start",
  "delivered_at",
  "truck_type",
  "truck_is_refrigerated",
  "device_type",
  "origin_latitude",
  "origin_longitude",
  "destination_latitude",
  "destination_longitude",
];
const READING_COLUMNS = [
  "shipment_id",
  "source",
  "recorded_at",
  "received_at",
  "temperature_c",
  "humidity_pct",
  "latitude",
  "longitude",
  "speed_kmh",
  "vibration_g",
  "quality_flags",
];

function must({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}

async function pages(build) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const page = must(await build().range(from, from + PAGE - 1));
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(columns, rows) {
  return [columns.join(","), ...rows.map((row) => columns.map((c) => csvCell(row[c])).join(","))].join("\n") + "\n";
}

const sameTime = (a, b) => (a ? Date.parse(a) : null) === (b ? Date.parse(b) : null);

// The planned delivery time when the trip started, from the audit log of the
// shipment's creation and edits (events oldest first). Without a record of it
// the current value is used (eta_source "current") unless it was edited after
// the start, in which case it is unknown (eta_source "unknown", null).
function etaAtStart(trip, events) {
  const started = Date.parse(trip.trip_started_at);
  // A (test) shipment can be deleted and created again under the same id: only
  // the events since its last creation before the start belong to this trip.
  const createdIndex = events.findLastIndex(
    (e) => e.action === "cold_chain.monitoring_started" && Date.parse(e.created_at) <= started
  );
  const created = createdIndex === -1 ? null : events[createdIndex];
  const updates = events
    .slice(createdIndex + 1)
    .filter((e) => e.action === "cold_chain.monitoring_updated" && Object.hasOwn(e.details ?? {}, "expectedDeliveryAt"));
  let value = created ? (created.details?.expectedDeliveryAt ?? null) : undefined;
  let changedAfterStart = false;
  for (const event of updates) {
    const next = event.details.expectedDeliveryAt ?? null;
    if (Date.parse(event.created_at) <= started) value = next;
    else if (value === undefined || !sameTime(next, value)) changedAfterStart = true;
  }
  if (value !== undefined) return { value, source: "audit", changedAfterStart };
  return changedAfterStart
    ? { value: null, source: "unknown", changedAfterStart }
    : { value: trip.expected_delivery_at, source: "current", changedAfterStart };
}

function parseArgs(argv) {
  const args = { includeTest: argv.includes("--include-test"), out: null };
  const i = argv.indexOf("--out");
  if (i !== -1) args.out = argv[i + 1];
  return args;
}

async function main() {
  const { includeTest, out } = parseArgs(process.argv.slice(2));

  const trips = await pages(() => {
    let query = supabase
      .from("cold_chain_shipments")
      .select(TRIP_SELECT)
      .not("trip_started_at", "is", null)
      .order("trip_started_at")
      .order("shipment_id");
    if (!includeTest) query = query.eq("is_test", false);
    return query;
  });
  const ids = trips.map((t) => t.shipment_id);

  const readings = [];
  const events = [];
  for (const group of chunks(ids, IDS_PER_QUERY)) {
    readings.push(
      ...(await pages(() =>
        supabase
          .from("cold_chain_readings")
          .select(READING_COLUMNS.join(", "))
          .in("shipment_id", group)
          .order("shipment_id")
          .order("recorded_at")
          .order("id")
      ))
    );
    events.push(
      ...(await pages(() =>
        supabase
          .from("audit_logs")
          .select("entity_id, action, details, created_at")
          .eq("module", "cold_chain")
          .in("action", ["cold_chain.monitoring_started", "cold_chain.monitoring_updated"])
          .in("entity_id", group)
          .order("created_at")
          .order("id")
      ))
    );
  }

  const tripRows = trips.map((t) => {
    const eta = etaAtStart(
      t,
      events.filter((e) => e.entity_id === t.shipment_id)
    );
    const origin = t.shipment?.warehouse?.location;
    const destination = t.pharmacy?.location;
    return {
      ...t,
      shipment_number: t.shipment?.shipment_number,
      expected_delivery_at_start: eta.value,
      eta_source: eta.source,
      eta_changed_after_start: eta.changedAfterStart,
      truck_type: t.truck?.truck_type,
      truck_is_refrigerated: t.truck?.is_refrigerated,
      device_type: t.device?.device_type,
      origin_latitude: origin?.latitude,
      origin_longitude: origin?.longitude,
      destination_latitude: destination?.latitude,
      destination_longitude: destination?.longitude,
    };
  });
  const readingRows = readings.map((r) => ({ ...r, quality_flags: (r.quality_flags ?? []).join("|") }));

  const tripsCsv = toCsv(TRIP_COLUMNS, tripRows);
  const readingsCsv = toCsv(READING_COLUMNS, readingRows);
  const datasetVersion = crypto.createHash("sha256").update(tripsCsv).update(readingsCsv).digest("hex").slice(0, 12);
  const testTrips = new Set(trips.filter((t) => t.is_test).map((t) => t.shipment_id));
  const exportedAt = new Date().toISOString();
  const containsTestData = testTrips.size > 0 || readings.some((r) => r.source !== "device");

  const count = (rows, key) => rows.reduce((acc, row) => ((acc[key(row)] = (acc[key(row)] ?? 0) + 1), acc), {});
  const manifest = {
    datasetVersion,
    exportedAt,
    source: "supabase",
    filters: { startedTripsOnly: true, includeTest },
    containsTestData,
    validForEvaluation: !containsTestData,
    counts: {
      trips: trips.length,
      testTrips: testTrips.size,
      tripsByStatus: count(trips, (t) => t.trip_status),
      readings: readings.length,
      readingsBySource: count(readings, (r) => r.source),
      readingsOnTestTrips: readings.filter((r) => testTrips.has(r.shipment_id)).length,
    },
    files: { trips: { columns: TRIP_COLUMNS }, readings: { columns: READING_COLUMNS, qualityFlagsSeparator: "|" } },
    notPersonalData:
      "Driver, account, phone, licence and truck registration columns and free-text notes are not exported.",
    notes: [
      "Readings are exported as stored; cleaning happens in ai-service/cold_chain/preprocessing.py and is reported there.",
      "expected_delivery_at_start is the planned delivery time in effect when the trip started (audit log); eta_source 'current' means no audit entry existed and the current value was used.",
      "Destination coordinates are the pharmacy's location record (may be city level).",
    ],
  };

  const dir = path.resolve(
    out ?? path.join(__dirname, "../../ai-service/cold_chain/data/exports", `${exportedAt.replace(/[-:]/g, "").slice(0, 15)}-${includeTest ? "with-test" : "real"}`)
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "trips.csv"), tripsCsv);
  fs.writeFileSync(path.join(dir, "readings.csv"), readingsCsv);
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  console.log(`Exported dataset ${datasetVersion} to ${dir}`);
  console.log(`  trips: ${trips.length} (test: ${testTrips.size}), readings: ${readings.length} ${JSON.stringify(manifest.counts.readingsBySource)}`);
  if (containsTestData) console.log("  CONTAINS TEST/SIMULATED DATA: pipeline smoke test only, not valid for evaluation.");
  if (trips.length === 0) console.log("  No started trips to export yet.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Export failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { etaAtStart, toCsv };
