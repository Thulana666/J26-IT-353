// Development simulator for Component 2 (IoT cold-chain monitoring).
//
// Sends SIMULATED sensor readings through the real device API
// (POST /api/cold-chain/readings), the same way an ESP32 logger does, for a
// TEST trip that is in transit. Simulated data never reaches real shipments:
// the trip must be a test shipment (is_test) and its allocated sensor a
// 'simulator' device; the database refuses simulated readings otherwise.
// Use it to develop and demonstrate the dashboard, never for research results.
//
// Set the trip up through the normal workflow first (Cold Chain): create a
// test shipment, allocate a driver and a truck whose sensor is a simulator
// device (e.g. SIM-001), and start it. The script then issues a new key for
// that simulator device (kept only in this process) and sends the readings.
//
// Usage (from backend/, with the backend running):
//   node --env-file=.env scripts/simulate-cold-chain.js [options]
//     --shipment SH-000123   the test trip (default: the newest test trip in transit with a simulator sensor)
//     --scenario NAME        normal | rising | excursion | humidity | gps-jump   (default: excursion)
//     --minutes 60           simulated history to send, ending now (never before the trip started)
//     --interval 60          seconds between readings
//     --live                 then keep sending one reading per interval (Ctrl+C to stop)
//     --seed 1               random seed (same seed, same data)
//   BACKEND_URL defaults to http://localhost:5000.

const supabase = require("../src/config/supabase");
const { generateDeviceKey, hashDeviceKey } = require("../src/cold-chain/device-auth");

const BACKEND_URL = (process.env.BACKEND_URL || "http://localhost:5000").replace(/\/$/, "");
const SCENARIOS = ["normal", "rising", "excursion", "humidity", "gps-jump"];
// Readings per upload (the API accepts up to 300).
const BATCH_SIZE = 100;
const MIN = 60_000;
// Used when the warehouse or pharmacy has no coordinates (Colombo area).
const DEFAULT_ROUTE = { from: { latitude: 6.9497, longitude: 79.922 }, to: { latitude: 6.9061, longitude: 79.8656 } };

const TRIP_SELECT =
  "shipment_id, is_test, trip_status, trip_started_at, temp_min_c, temp_max_c, humidity_max_pct, reading_interval_seconds, " +
  "device:cold_chain_devices(id, device_code, device_type, is_active), " +
  "pharmacy:pharmacies(name, location:locations(latitude, longitude)), " +
  "shipment:shipments!inner(shipment_number, warehouse:warehouses(name, location:locations(latitude, longitude)))";

function must({ data, error }) {
  if (error) throw new Error(`${error.code ?? ""} ${error.message}`.trim());
  return data;
}

function parseArgs(argv) {
  const args = { scenario: "excursion", minutes: 60, interval: 60, seed: 1, live: false, shipment: null };
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
    else throw new Error(`Unknown option ${flag}`);
  }
  if (!SCENARIOS.includes(args.scenario)) throw new Error(`--scenario must be one of ${SCENARIOS.join(", ")}`);
  if (!(args.minutes >= 1 && args.minutes <= 7 * 24 * 60)) throw new Error("--minutes must be 1-10080");
  if (!(args.interval >= 5 && args.interval <= 3600)) throw new Error("--interval must be 5-3600 seconds");
  return args;
}

// The test trip in transit to simulate, with its simulator sensor.
async function findTrip(shipmentNumber) {
  let query = supabase.from("cold_chain_shipments").select(TRIP_SELECT).eq("trip_status", "in_transit").eq("is_test", true);
  if (shipmentNumber) query = query.eq("shipment.shipment_number", shipmentNumber);
  const trips = must(await query.order("trip_started_at", { ascending: false }).limit(20));
  const trip = trips.find((t) => t.device?.device_type === "simulator");
  if (!trip) {
    throw new Error(
      `${shipmentNumber ?? "No test trip"} is not a test trip in transit with a simulator sensor. In Cold Chain: create a test ` +
        "shipment, allocate a driver and a truck with a simulator device (e.g. SIM-001), and start the trip."
    );
  }
  if (!trip.device.is_active) throw new Error(`Simulator ${trip.device.device_code} is deactivated`);
  return trip;
}

function routeOf(trip) {
  const point = (location) =>
    location?.latitude != null && location?.longitude != null
      ? { latitude: Number(location.latitude), longitude: Number(location.longitude) }
      : null;
  const from = point(trip.shipment?.warehouse?.location);
  const to = point(trip.pharmacy?.location);
  return from && to ? { from, to } : DEFAULT_ROUTE;
}

// A new key for the trip's simulator device; only this process knows it.
async function issueSimulatorKey(device) {
  if (device.device_type !== "simulator") throw new Error(`${device.device_code} is a real device; the simulator never uses its key`);
  const deviceKey = generateDeviceKey();
  must(
    await supabase.from("cold_chain_devices").update({ key_hash: hashDeviceKey(deviceKey) }).eq("id", device.id).eq("device_type", "simulator")
  );
  return { device_code: device.device_code, deviceKey };
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
  const trip = await findTrip(args.shipment);
  const device = await issueSimulatorKey(trip.device);
  const route = routeOf(trip);
  const rand = prng(args.seed);
  const number = trip.shipment.shipment_number;
  console.log(`TEST data -> ${number} (${trip.pharmacy?.name ?? "?"}) via ${device.device_code}, scenario "${args.scenario}"`);
  console.log(`Limits ${trip.temp_min_c}-${trip.temp_max_c} °C, humidity max ${trip.humidity_max_pct ?? "none"} %RH; backend ${BACKEND_URL}`);

  const now = Date.now();
  const step = args.interval * 1000;
  // History ending now, never before the trip started.
  const first = Math.max(now - args.minutes * MIN, Date.parse(trip.trip_started_at) + 1000);
  const count = Math.max(1, Math.floor((now - first) / step) + 1);
  const jumpIndex = Math.floor(count * 0.6);
  const readings = Array.from({ length: count }, (_, index) => {
    const recordedAt = now - (count - 1 - index) * step;
    const p = count === 1 ? 1 : index / (count - 1);
    return { recordedAt: new Date(recordedAt).toISOString(), ...simulate(args.scenario, p, { limits: trip, route, rand, jumpIndex, index }) };
  });

  const totals = { accepted: 0, duplicates: 0, rejected: 0, opened: 0, updated: 0, resolved: 0 };
  let risk = null;
  for (let i = 0; i < readings.length; i += BATCH_SIZE) {
    const { status, body } = await postReadings(device, { shipmentNumber: number, readings: readings.slice(i, i + BATCH_SIZE) });
    if (status >= 300 && status !== 400) throw new Error(`Backend answered HTTP ${status}: ${body?.error ?? "no JSON body"}`);
    totals.accepted += body.accepted ?? 0;
    totals.duplicates += body.duplicates?.length ?? 0;
    totals.rejected += (body.rejected ?? body.details?.rejected ?? []).length;
    for (const key of ["opened", "updated", "resolved"]) totals[key] += body.alerts?.[key] ?? 0;
    risk = body.risk ?? risk;
  }
  console.log(
    `Sent ${readings.length} reading(s): ${totals.accepted} stored, ${totals.duplicates} duplicate(s), ${totals.rejected} rejected; ` +
      `observed alerts ${totals.opened} opened, ${totals.updated} updated, ${totals.resolved} resolved.`
  );
  if (risk) {
    console.log(`Predicted risk: ${risk.riskLevel} ${Math.round(risk.riskProbability * 100)}% ${risk.riskType ?? ""} (${risk.isPrototype ? "prototype" : "model"})`);
  }

  const alerts = must(
    await supabase
      .from("cold_chain_alerts")
      .select("risk_level, basis, status, title")
      .eq("shipment_id", trip.shipment_id)
      .order("last_detected_at", { ascending: false })
      .limit(6)
  );
  for (const alert of alerts) console.log(`  [${alert.status}] ${alert.risk_level.toUpperCase()} ${alert.basis}: ${alert.title}`);

  if (!args.live) return;
  console.log(`Live: one reading every ${args.interval} s (Ctrl+C to stop).`);
  for (let index = count; ; index++) {
    await new Promise((resolve) => setTimeout(resolve, step));
    const reading = { recordedAt: new Date().toISOString(), ...simulate(args.scenario, 1, { limits: trip, route, rand, jumpIndex: -1, index }) };
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

module.exports = { simulate, prng, postReadings, routeOf, BACKEND_URL };
