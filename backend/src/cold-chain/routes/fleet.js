// Drivers and trucks for cold-chain trips (admins and warehouse staff).
//
// /api/cold-chain/drivers
//   GET    /             drivers with their live trip (?status=available)
//   POST   /             add { fullName, phone, email?, licenceNumber, licenceExpiry (YYYY-MM-DD), notes? }
//   PATCH  /:id          edit any of those fields
//   PATCH  /:id/status   { active: false } deactivate (only while not on a trip) | { active: true }
//   POST   /:id/account  { email } link the driver's own account (Driver Portal); DELETE unlinks
//
// /api/cold-chain/trucks
//   GET    /             trucks with their live trip and installed device (?status=available)
//   POST   /             add { registrationNumber, truckType, isRefrigerated, minTempC?, maxTempC?, deviceId?, notes? }
//   PATCH  /:id          edit any of those fields
//   PATCH  /:id/status   { active: false | true }
//
// Assigned / on trip / in use statuses are set only by the trip workflow
// (allocate, start, deliver); see 20261018000002_cold_chain_logistics.sql.

const express = require("express");
const { supabase, DRIVER_SELECT, TRUCK_SELECT, audit } = require("../store");
const { today, daysBetween } = require("../../pharmacy/store");
const { HttpError, unwrap } = require("../errors");
const { requireWarehouseStaff } = require("../../pharmacy/auth");
const { parse, z, id, driverCreate, driverUpdate, truckCreate, truckUpdate, statusBody, accountBody } = require("../validation");
const { toDriver, toTruck } = require("../mappers");
const { DRIVER_STATUSES, TRUCK_STATUSES } = require("../constants");

const fieldErrors = (fields) => new HttpError(400, "Invalid request", { fields });

// Live trips (allocated or in transit) keyed by driver_id or truck_id.
async function liveTrips(column, ids) {
  if (ids.length === 0) return new Map();
  const rows = unwrap(
    await supabase
      .from("cold_chain_shipments")
      .select(`shipment_id, trip_status, ${column}, shipment:shipments(shipment_number)`)
      .in(column, ids)
      .in("trip_status", ["allocated", "in_transit"])
  );
  return new Map(rows.map((r) => [r[column], { shipmentId: r.shipment_id, shipmentNumber: r.shipment?.shipment_number ?? null, tripStatus: r.trip_status }]));
}

// Status change from the activate/deactivate switch.
function nextStatus(current, active, kind) {
  if (active) return current === "inactive" ? "available" : current;
  if (current === "inactive") return current;
  if (current !== "available") {
    throw new HttpError(409, `This ${kind} is ${current.replace("_", " ")}; deliver or re-allocate the trip first`);
  }
  return "inactive";
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

const drivers = express.Router();
drivers.use(requireWarehouseStaff);

const DRIVER_COLUMNS = {
  fullName: "full_name",
  phone: "phone",
  email: "email",
  licenceNumber: "licence_number",
  licenceExpiry: "licence_expiry",
  notes: "notes",
};
const toColumns = (body, map) =>
  Object.fromEntries(Object.entries(map).filter(([key]) => body[key] !== undefined).map(([key, column]) => [column, body[key]]));

drivers.get("/", async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(DRIVER_STATUSES).optional() }), req.query);
  let query = supabase.from("cold_chain_drivers").select(DRIVER_SELECT).order("full_name");
  if (status) query = query.eq("status", status);
  const rows = unwrap(await query);
  const trips = await liveTrips("driver_id", rows.map((r) => r.id));
  const todayIso = today();
  res.json({
    drivers: rows.map((r) => ({ ...toDriver(r, trips.get(r.id) ?? null), licenceDaysLeft: daysBetween(todayIso, r.licence_expiry) })),
  });
});

drivers.post("/", async (req, res) => {
  const body = parse(driverCreate, req.body);
  const row = unwrap(
    await supabase
      .from("cold_chain_drivers")
      .insert({ ...toColumns(body, DRIVER_COLUMNS), created_by: req.user.id })
      .select(DRIVER_SELECT)
      .single()
  );
  await audit(req, { action: "cold_chain.driver_added", entityType: "cold_chain_driver", entityId: row.id, details: { fullName: row.full_name } });
  res.status(201).json({ driver: toDriver(row, null) });
});

drivers.patch("/:id", async (req, res) => {
  const { id: driverId } = parse(z.object({ id }), req.params);
  const changes = toColumns(parse(driverUpdate, req.body), DRIVER_COLUMNS);
  if (Object.keys(changes).length === 0) throw new HttpError(400, "Nothing to change");
  const row = unwrap(await supabase.from("cold_chain_drivers").update(changes).eq("id", driverId).select(DRIVER_SELECT).maybeSingle());
  if (!row) throw new HttpError(404, "Driver not found");
  await audit(req, { action: "cold_chain.driver_updated", entityType: "cold_chain_driver", entityId: row.id, details: changes });
  const trips = await liveTrips("driver_id", [row.id]);
  res.json({ driver: toDriver(row, trips.get(row.id) ?? null) });
});

drivers.patch("/:id/status", async (req, res) => {
  const { id: driverId } = parse(z.object({ id }), req.params);
  const { active } = parse(statusBody, req.body);
  const current = unwrap(await supabase.from("cold_chain_drivers").select("id, status").eq("id", driverId).maybeSingle());
  if (!current) throw new HttpError(404, "Driver not found");
  const status = nextStatus(current.status, active, "driver");
  // Only from the status just read, so a concurrent allocation is not overwritten.
  const row = unwrap(
    await supabase.from("cold_chain_drivers").update({ status }).eq("id", driverId).eq("status", current.status).select(DRIVER_SELECT).maybeSingle()
  );
  if (!row) throw new HttpError(409, "The driver's status changed meanwhile; reload and try again");
  await audit(req, { action: active ? "cold_chain.driver_activated" : "cold_chain.driver_deactivated", entityType: "cold_chain_driver", entityId: row.id });
  res.json({ driver: toDriver(row, null) });
});

// Driver Portal account: the driver signs up with the normal Sign up page, then
// staff link that account here. Only a plain 'user' account (or one already
// a driver) can become a driver account, so staff can never change the role
// of another staff member or an admin. Unlinking makes it a plain user again.
//   POST   /:id/account { email }
//   DELETE /:id/account
async function loadDriver(driverId) {
  const driver = unwrap(await supabase.from("cold_chain_drivers").select("id, full_name, profile_id").eq("id", driverId).maybeSingle());
  if (!driver) throw new HttpError(404, "Driver not found");
  return driver;
}

async function releaseAccount(profileId) {
  unwrap(await supabase.from("profiles").update({ role: "user" }).eq("id", profileId).eq("role", "driver"));
}

drivers.post("/:id/account", async (req, res) => {
  const { id: driverId } = parse(z.object({ id }), req.params);
  const { email } = parse(accountBody, req.body);
  const driver = await loadDriver(driverId);
  const pattern = email.replace(/[\\%_]/g, (c) => `\\${c}`);
  const profile = unwrap(await supabase.from("profiles").select("id, email, role, status").ilike("email", pattern).maybeSingle());
  if (!profile) {
    throw new HttpError(404, "No account with this email. The driver signs up first (Sign up page), then link the account here.");
  }
  if (profile.status !== "active") throw new HttpError(409, "This account is inactive");
  if (!["user", "driver"].includes(profile.role)) {
    throw new HttpError(409, `This account has the role ${profile.role.replace("_", " ")}; only a plain user account can become a driver account`);
  }
  const [other] = unwrap(await supabase.from("cold_chain_drivers").select("full_name").eq("profile_id", profile.id).neq("id", driverId).limit(1));
  if (other) throw new HttpError(409, `This account is already linked to driver ${other.full_name}`);

  if (driver.profile_id && driver.profile_id !== profile.id) await releaseAccount(driver.profile_id);
  unwrap(await supabase.from("profiles").update({ role: "driver" }).eq("id", profile.id));
  const row = unwrap(await supabase.from("cold_chain_drivers").update({ profile_id: profile.id }).eq("id", driverId).select(DRIVER_SELECT).single());
  await audit(req, { action: "cold_chain.driver_account_linked", entityType: "cold_chain_driver", entityId: driverId, details: { email: profile.email } });
  res.json({ driver: toDriver(row, null) });
});

drivers.delete("/:id/account", async (req, res) => {
  const { id: driverId } = parse(z.object({ id }), req.params);
  const driver = await loadDriver(driverId);
  if (driver.profile_id) await releaseAccount(driver.profile_id);
  const row = unwrap(await supabase.from("cold_chain_drivers").update({ profile_id: null }).eq("id", driverId).select(DRIVER_SELECT).single());
  await audit(req, { action: "cold_chain.driver_account_unlinked", entityType: "cold_chain_driver", entityId: driverId });
  res.json({ driver: toDriver(row, null) });
});

// ---------------------------------------------------------------------------
// Trucks
// ---------------------------------------------------------------------------

const trucks = express.Router();
trucks.use(requireWarehouseStaff);

const TRUCK_COLUMNS = {
  registrationNumber: "registration_number",
  truckType: "truck_type",
  isRefrigerated: "is_refrigerated",
  minTempC: "min_temp_c",
  maxTempC: "max_temp_c",
  deviceId: "device_id",
  notes: "notes",
};

// Refrigerated trucks need a range; other trucks have none.
function refrigeration(next) {
  if (!next.is_refrigerated) return { min_temp_c: null, max_temp_c: null };
  const errors = {};
  if (next.min_temp_c === null || next.min_temp_c === undefined) errors.minTempC = "is required for a refrigerated truck";
  if (next.max_temp_c === null || next.max_temp_c === undefined) errors.maxTempC = "is required for a refrigerated truck";
  if (!errors.minTempC && !errors.maxTempC && !(next.min_temp_c < next.max_temp_c)) errors.maxTempC = "must be above the minimum temperature";
  if (Object.keys(errors).length) throw fieldErrors(errors);
  return { min_temp_c: next.min_temp_c, max_temp_c: next.max_temp_c };
}

// A device is installed in one truck at a time.
async function assertDeviceFree(deviceId, truckId = null) {
  if (!deviceId) return;
  const device = unwrap(await supabase.from("cold_chain_devices").select("id, device_code").eq("id", deviceId).maybeSingle());
  if (!device) throw new HttpError(404, "Device not found");
  let query = supabase.from("cold_chain_trucks").select("registration_number").eq("device_id", deviceId);
  if (truckId) query = query.neq("id", truckId);
  const [other] = unwrap(await query.limit(1));
  if (other) throw new HttpError(409, `Device ${device.device_code} is installed in truck ${other.registration_number}`);
}

trucks.get("/", async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(TRUCK_STATUSES).optional() }), req.query);
  let query = supabase.from("cold_chain_trucks").select(TRUCK_SELECT).order("registration_number");
  if (status) query = query.eq("status", status);
  const rows = unwrap(await query);
  const trips = await liveTrips("truck_id", rows.map((r) => r.id));
  res.json({ trucks: rows.map((r) => toTruck(r, trips.get(r.id) ?? null)) });
});

trucks.post("/", async (req, res) => {
  const body = parse(truckCreate, req.body);
  const columns = toColumns(body, TRUCK_COLUMNS);
  await assertDeviceFree(columns.device_id);
  const row = unwrap(
    await supabase
      .from("cold_chain_trucks")
      .insert({ ...columns, ...refrigeration(columns), created_by: req.user.id })
      .select(TRUCK_SELECT)
      .single()
  );
  await audit(req, { action: "cold_chain.truck_added", entityType: "cold_chain_truck", entityId: row.id, details: { registrationNumber: row.registration_number } });
  res.status(201).json({ truck: toTruck(row, null) });
});

trucks.patch("/:id", async (req, res) => {
  const { id: truckId } = parse(z.object({ id }), req.params);
  const changes = toColumns(parse(truckUpdate, req.body), TRUCK_COLUMNS);
  if (Object.keys(changes).length === 0) throw new HttpError(400, "Nothing to change");
  const current = unwrap(await supabase.from("cold_chain_trucks").select("*").eq("id", truckId).maybeSingle());
  if (!current) throw new HttpError(404, "Truck not found");
  if (changes.device_id !== undefined) await assertDeviceFree(changes.device_id, truckId);
  const pick = (column) => (changes[column] !== undefined ? changes[column] : current[column] === null ? null : Number(current[column]));
  const next = { is_refrigerated: changes.is_refrigerated ?? current.is_refrigerated, min_temp_c: pick("min_temp_c"), max_temp_c: pick("max_temp_c") };
  const row = unwrap(
    await supabase
      .from("cold_chain_trucks")
      .update({ ...changes, ...refrigeration(next) })
      .eq("id", truckId)
      .select(TRUCK_SELECT)
      .single()
  );
  await audit(req, { action: "cold_chain.truck_updated", entityType: "cold_chain_truck", entityId: row.id, details: changes });
  const trips = await liveTrips("truck_id", [row.id]);
  res.json({ truck: toTruck(row, trips.get(row.id) ?? null) });
});

trucks.patch("/:id/status", async (req, res) => {
  const { id: truckId } = parse(z.object({ id }), req.params);
  const { active } = parse(statusBody, req.body);
  const current = unwrap(await supabase.from("cold_chain_trucks").select("id, status").eq("id", truckId).maybeSingle());
  if (!current) throw new HttpError(404, "Truck not found");
  const status = nextStatus(current.status, active, "truck");
  const row = unwrap(
    await supabase.from("cold_chain_trucks").update({ status }).eq("id", truckId).eq("status", current.status).select(TRUCK_SELECT).maybeSingle()
  );
  if (!row) throw new HttpError(409, "The truck's status changed meanwhile; reload and try again");
  await audit(req, { action: active ? "cold_chain.truck_activated" : "cold_chain.truck_deactivated", entityType: "cold_chain_truck", entityId: row.id });
  res.json({ truck: toTruck(row, null) });
});

module.exports = { drivers, trucks };
