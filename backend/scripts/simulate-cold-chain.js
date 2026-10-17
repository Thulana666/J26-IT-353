// Development simulator for Component 2 (IoT cold-chain monitoring).
//
// Sends SIMULATED sensor readings through the real device API
// (POST /api/cold-chain/readings), the same way an ESP32 logger does. The data
// is marked as test data everywhere: the device is a 'simulator' device, the
// shipment is monitored with is_test = true, and every reading is stored with
// source 'simulator' (the database refuses simulated readings for real
// shipments). Use it to develop and demonstrate the dashboard, never to
// produce research results.
//
// Setup uses the backend's service-role key (backend/.env) to register the
// simulator device (a new key on every run, kept only in this process) and to
// start TEST monitoring of an in-transit shipment.
//
// Usage (from backend/, with the backend running):
//   node --env-file=.env scripts/simulate-cold-chain.js [options]
//     --shipment SH-000123   in-transit shipment (default: the newest SAMPLE pharmacy one)
//     --scenario NAME        normal | rising | excursion | humidity | gps-jump   (default: excursion)
//     --minutes 120          simulated history to send, ending now
//     --interval 60          seconds between readings
//     --live                 then keep sending one reading per interval (Ctrl+C to stop)
//     --reset                first delete this shipment's TEST monitoring, readings and alerts
//     --seed 1               random seed (same seed, same data)
//   BACKEND_URL defaults to http://localhost:5000.

const supabase = require("../src/config/supabase");
const { generateDeviceKey, hashDeviceKey } = require("../src/cold-chain/device-auth");
const { defaultLimits } = require("../src/cold-chain/monitoring");

const BACKEND_URL = (process.env.BACKEND_URL || "http://localhost:5000").replace(/\/$/, "");
const SIMULATOR_CODE = "SIM-001";
const SCENARIOS = ["normal", "rising", "excursion", "humidity", "gps-jump"];
// Readings per upload (the API accepts up to 300).
const BATCH_SIZE = 100;
const MIN = 60_000;
// Used when the warehouse or pharmacy has no coordinates (Colombo area).
const DEFAULT_ROUTE = { from: { latitude: 6.9497, longitude: 79.922 }, to: { latitude: 6.9061, longitude: 79.8656 } };

const SHIPMENT_SELECT =
  "id, shipment_number, status, dispatched_at, pharmacy_id, " +
  "pharmacy:pharmacies!inner(code, name, location:locations(latitude, longitude)), " +
  "warehouse:warehouses(name, location:locations(latitude, longitude)), " +
  "items:shipment_items(medicine:medicines(storage_condition))";

function must({ data, error }) {
  if (error) throw new Error(`${error.code ?? ""} ${error.message}`.trim());
  return data;
}

function parseArgs(argv) {
  const args = { scenario: "excursion", minutes: 120, interval: 60, seed: 1, live: false, reset: false, shipment: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      if (argv[i + 1] === undefined) throw new Error(`${flag} needs a value`);
      return argv[++i];
    };
    if (flag === "--shipment") args.shipment = value();
    else if (flag === "--scenario") args.scenario = value();
    else if (flag === "--minutes") args.minutes = Number(value());
    else if (flag === "--interval") args.interval = Number(value());
    else if (flag === "--seed") args.seed = Number(value());
    else if (flag === "--live") args.live = true;
    else if (flag === "--reset") args.reset = true;
    else throw new Error(`Unknown option ${flag}`);
  }
  if (!SCENARIOS.includes(args.scenario)) throw new Error(`--scenario must be one of ${SCENARIOS.join(", ")}`);
  if (!(args.minutes >= 1 && args.minutes <= 7 * 24 * 60)) throw new Error("--minutes must be 1-10080");
  if (!(args.interval >= 5 && args.interval <= 3600)) throw new Error("--interval must be 5-3600 seconds");
  return args;
}

// An in-transit shipment: the one named, else the newest to a SAMPLE pharmacy.
async function findShipment(shipmentNumber) {
  let query = supabase.from("shipments").select(SHIPMENT_SELECT).eq("status", "in_transit");
  query = shipmentNumber
    ? query.eq("shipment_number", shipmentNumber)
    : query.like("pharmacy.code", "SAMPLE-%").order("dispatched_at", { ascending: false });
  const [shipment] = must(await query.limit(1));
  if (!shipment) {
    throw new Error(
      shipmentNumber
        ? `${shipmentNumber} is not a shipment in transit.`
        : "No in-transit shipment to a SAMPLE pharmacy. Dispatch a sample order first, or pass --shipment SH-xxxxxx."
    );
  }
  return shipment;
}

function routeOf(shipment) {
  const point = (location) =>
    location?.latitude != null && location?.longitude != null
      ? { latitude: Number(location.latitude), longitude: Number(location.longitude) }
      : null;
  const from = point(shipment.warehouse?.location);
  const to = point(shipment.pharmacy?.location);
  return from && to ? { from, to } : DEFAULT_ROUTE;
}

// The simulator device with a fresh key (only this process knows it).
async function prepareSimulatorDevice() {
  const deviceKey = generateDeviceKey();
  const existing = must(
    await supabase.from("cold_chain_devices").select("id, device_type").eq("device_code", SIMULATOR_CODE).maybeSingle()
  );
  if (existing && existing.device_type !== "simulator") {
    throw new Error(`${SIMULATOR_CODE} is registered as a real device; the simulator only uses simulator devices.`);
  }
  const values = { key_hash: hashDeviceKey(deviceKey), is_active: true };
  const device = existing
    ? must(await supabase.from("cold_chain_devices").update(values).eq("id", existing.id).select("id, device_code").single())
    : must(
        await supabase
          .from("cold_chain_devices")
          .insert({
            ...values,
            device_code: SIMULATOR_CODE,
            device_type: "simulator",
            name: "Development simulator",
            notes: "Generates test data only (backend/scripts/simulate-cold-chain.js).",
          })
          .select("id, device_code")
          .single()
      );
  return { ...device, deviceKey };
}

// TEST monitoring of the shipment, reported by the simulator device. Real
// (non-test) monitoring is never touched.
async function prepareTestMonitoring(shipment, device, { reset, minutes, interval }) {
  let monitor = must(await supabase.from("cold_chain_shipments").select("*").eq("shipment_id", shipment.id).maybeSingle());
  if (monitor && !monitor.is_test) {
    throw new Error(`${shipment.shipment_number} has real (non-test) monitoring; the simulator does not touch it.`);
  }
  if (monitor && reset) {
    must(await supabase.from("cold_chain_shipments").delete().eq("shipment_id", shipment.id).eq("is_test", true));
    monitor = null;
  }
  // The simulator reports for one shipment at a time.
  must(
    await supabase
      .from("cold_chain_shipments")
      .update({ device_id: null })
      .eq("device_id", device.id)
      .eq("monitoring_status", "active")
      .neq("shipment_id", shipment.id)
  );

  if (monitor) {
    return must(
      await supabase
        .from("cold_chain_shipments")
        .update({ device_id: device.id, monitoring_status: "active", ended_at: null })
        .eq("shipment_id", shipment.id)
        .select("*")
        .single()
    );
  }
  const { mixed: _mixed, ...limits } = defaultLimits(shipment.items.map((item) => item.medicine?.storage_condition));
  return must(
    await supabase
      .from("cold_chain_shipments")
      .insert({
        shipment_id: shipment.id,
        pharmacy_id: shipment.pharmacy_id,
        device_id: device.id,
        storage_condition: limits.storageCondition,
        temp_min_c: limits.tempMinC,
        temp_max_c: limits.tempMaxC,
        humidity_min_pct: limits.humidityMinPct,
        humidity_max_pct: limits.humidityMaxPct,
        expected_delivery_at: new Date(Date.now() + 2 * 60 * MIN).toISOString(),
        reading_interval_seconds: interval,
        is_test: true,
        started_at: new Date(Date.now() - (minutes + 1) * MIN).toISOString(),
      })
      .select("*")
      .single()
  );
}

// Small seeded PRNG (mulberry32), so a seed always gives the same data.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// One simulated reading at progress p (0 = start of the history, 1 = now).
function simulate(scenario, p, { limits, route, rand, jumpIndex, index }) {
  const noise = (amplitude) => (rand() * 2 - 1) * amplitude;
  const mid = (Number(limits.temp_min_c) + Number(limits.temp_max_c)) / 2;
  const half = (Number(limits.temp_max_c) - Number(limits.temp_min_c)) / 2;
  const humidityMax = limits.humidity_max_pct === null ? null : Number(limits.humidity_max_pct);

  let temperature = mid + 0.15 * half * Math.sin(p * 6 * Math.PI) + noise(0.12);
  let humidity = (humidityMax ?? 75) - 20 + 3 * Math.sin(p * 4 * Math.PI) + noise(1);
  // Rising: drifts up into the warning band just below the upper limit.
  if (scenario === "rising") temperature = mid + 0.92 * half * p + noise(0.1);
  // Excursion: a warm spell peaking 1.5 °C above the limit at 70 %, then recovery.
  if (scenario === "excursion") temperature += (half + 1.5) * Math.exp(-(((p - 0.7) / 0.1) ** 2));
  // Humidity: climbs past the upper limit in the second half.
  if (scenario === "humidity") humidity += Math.max(0, p - 0.5) * 2 * 35;

  let latitude = route.from.latitude + (route.to.latitude - route.from.latitude) * p + noise(0.0002);
  let longitude = route.from.longitude + (route.to.longitude - route.from.longitude) * p + noise(0.0002);
  // GPS jump: one fix about 100 km off the route.
  if (scenario === "gps-jump" && index === jumpIndex) [latitude, longitude] = [latitude + 0.9, longitude + 0.2];

  return {
    temperatureC: round(clamp(temperature, -60, 85), 2),
    humidityPct: round(clamp(humidity, 0, 100), 1),
    latitude: round(latitude, 6),
    longitude: round(longitude, 6),
    // The GPS module reports its own speed; a stop now and then.
    speedKmh: rand() < 0.1 ? 0 : round(clamp(35 + noise(12), 0, 120), 1),
    vibrationG: round(0.05 + rand() * 0.12, 3),
  };
}

async function postReadings(device, body) {
  const response = await fetch(`${BACKEND_URL}/api/cold-chain/readings`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-id": device.device_code, "x-device-key": device.deviceKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const shipment = await findShipment(args.shipment);
  const device = await prepareSimulatorDevice();
  const monitor = await prepareTestMonitoring(shipment, device, args);
  const route = routeOf(shipment);
  const rand = prng(args.seed);
  console.log(`TEST data -> ${shipment.shipment_number} (${shipment.pharmacy.name}) via ${device.device_code}, scenario "${args.scenario}"`);
  console.log(`Limits ${monitor.temp_min_c}-${monitor.temp_max_c} °C, humidity max ${monitor.humidity_max_pct ?? "none"} %RH; backend ${BACKEND_URL}`);

  const now = Date.now();
  const step = args.interval * 1000;
  // History ending now, never before monitoring started.
  const first = Math.max(now - args.minutes * MIN, Date.parse(monitor.started_at) + 1000);
  const count = Math.max(1, Math.floor((now - first) / step) + 1);
  const jumpIndex = Math.floor(count * 0.6);
  const readings = Array.from({ length: count }, (_, index) => {
    const recordedAt = now - (count - 1 - index) * step;
    const p = count === 1 ? 1 : index / (count - 1);
    return { recordedAt: new Date(recordedAt).toISOString(), ...simulate(args.scenario, p, { limits: monitor, route, rand, jumpIndex, index }) };
  });

  const totals = { accepted: 0, duplicates: 0, rejected: 0, opened: 0, updated: 0, resolved: 0 };
  for (let i = 0; i < readings.length; i += BATCH_SIZE) {
    const { status, body } = await postReadings(device, { shipmentNumber: shipment.shipment_number, readings: readings.slice(i, i + BATCH_SIZE) });
    if (status >= 300 && status !== 400) throw new Error(`Backend answered HTTP ${status}: ${body?.error ?? "no JSON body"}`);
    totals.accepted += body.accepted ?? 0;
    totals.duplicates += body.duplicates?.length ?? 0;
    totals.rejected += (body.rejected ?? body.details?.rejected ?? []).length;
    for (const key of ["opened", "updated", "resolved"]) totals[key] += body.alerts?.[key] ?? 0;
  }
  console.log(
    `Sent ${readings.length} reading(s): ${totals.accepted} stored, ${totals.duplicates} duplicate(s), ${totals.rejected} rejected; ` +
      `alerts ${totals.opened} opened, ${totals.updated} updated, ${totals.resolved} resolved.`
  );

  const alerts = must(
    await supabase
      .from("cold_chain_alerts")
      .select("risk_level, status, title")
      .eq("shipment_id", shipment.id)
      .order("last_detected_at", { ascending: false })
      .limit(5)
  );
  for (const alert of alerts) console.log(`  [${alert.status}] ${alert.risk_level.toUpperCase()} ${alert.title}`);

  if (!args.live) return;
  console.log(`Live: one reading every ${args.interval} s (Ctrl+C to stop).`);
  for (let index = count; ; index++) {
    await new Promise((resolve) => setTimeout(resolve, step));
    const reading = { recordedAt: new Date().toISOString(), ...simulate(args.scenario, 1, { limits: monitor, route, rand, jumpIndex: -1, index }) };
    const { status, body } = await postReadings(device, reading);
    console.log(`${reading.recordedAt} ${reading.temperatureC} °C ${reading.humidityPct} %RH -> HTTP ${status}${body?.error ? ` ${body.error}` : ""}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Simulator stopped: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { findShipment, postReadings, routeOf, BACKEND_URL };
