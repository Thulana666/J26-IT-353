# Component 2 – IoT Cold-Chain Tracking & Logistics Risk Prediction

> Status: database, backend API and dashboard are in place. The temporary
> risk predictor and the CNN-LSTM service structure come next.

## Architecture

```
SHT31 / NEO-6M / MPU6050 ──► ESP32 ──HTTPS──► Express  POST /api/cold-chain/readings
                                               │  device key, validation, data-quality flags,
                                               │  observed-limit alerts
                                               ▼
                                             Supabase PostgreSQL (service role)
                                               ▲
Browser ──► Next.js server ──(user token)──► Express  /api/cold-chain/shipments, /alerts, /devices
```

- Cold-chain monitoring extends **Component 4's shipments** (warehouse →
  pharmacy). The shipments table is not changed. A shipment is monitored when it
  has a `cold_chain_shipments` row, which uses the shipment's own id. Origin
  (warehouse), destination (pharmacy), delivery status, actual delivery time
  (`received_at`) and the medicines and batches carried come from Component 4.
- Devices never hold the Supabase secret key. Each device has its own key; only
  its SHA-256 hash is stored.
- Alerts in this step are **observed** alerts: a measured value is outside or
  close to a configured limit. **Predicted** risks (trends, delays, route
  anomalies) come from the risk predictor (next steps). Predictions are stored
  with the model name/version and an `is_prototype` flag, so the temporary
  rule-based predictor is never presented as the trained model.

| Where | What |
|---|---|
| `supabase/migrations/20261017000000_create_cold_chain_schema.sql` | tables, views, triggers, RLS, Realtime |
| `backend/src/cold-chain/` | API: `routes/`, `validation.js`, `quality.js`, `alert-rules.js`, `monitoring.js`, `device-auth.js`, `store.js` |
| `frontend/src/app/dashboard/cold-chain/` | **Cold Chain** pages: shipments overview, shipment detail (`[shipmentId]`), start monitoring (`start/`), devices (`devices/`), server actions |
| `frontend/src/components/cold-chain/`, `frontend/src/lib/cold-chain/` | charts (safe band, GPS track), risk card, alerts, readings table, badges; API client and formatting |
| `backend/test/cold-chain/` | `npm test`: unit tests (validation, data quality, alert rules), HTTP tests with a fake Supabase client (`api.test.js`), and database tests in PGlite (`database.test.mjs`: triggers, constraints, views, RLS) |

## Database

| Table | Purpose |
|---|---|
| `cold_chain_devices` | ESP32 loggers and the simulator; `key_hash`, `is_active`, `last_seen_at` |
| `cold_chain_shipments` | monitoring settings per shipment (PK = `shipments.id`): device, temperature/humidity limits, expected delivery, reading interval, `is_test`, `monitoring_status` |
| `cold_chain_readings` | readings: `recorded_at` (device) and `received_at` (server), temperature, humidity, GPS, speed, vibration, `source`, `quality_flags`; unique per shipment and time |
| `cold_chain_alerts` | one active alert per condition (`dedupe_key`), `basis` observed/predicted, level, probability, first/last detection, occurrences |
| `cold_chain_risk_predictions` | predictor output: level, probability, main risk type, explanation, factors, model name/version |

Views `cold_chain_latest_readings` and `cold_chain_latest_predictions` hold the newest row per shipment.

- **Test data stays separate.** Simulator devices may only report for
  `is_test` shipments; a database trigger enforces this too. Readings record
  their `source` (`device` / `simulator`).
- **RLS:** admins and warehouse staff read everything; pharmacy staff read
  shipments to their pharmacy (same rule as `shipments`). Devices are not
  readable from the browser. All writes go through the backend.
- Default limits come from the strictest `medicines.storage_condition` in the
  shipment (refrigerated 2–8 °C, cool 8–15 °C, ambient 15–30 °C, frozen −25 to
  −15 °C; humidity defaults in `constants.js`). They are prototype defaults and
  can be changed per shipment to match product labels.

## Device API (ESP32)

```
POST /api/cold-chain/readings
X-Device-Id:  ESP32-001
X-Device-Key: ccd_...            (from device registration; keep it out of source control)
Content-Type: application/json

{ "recordedAt": "2026-10-17T03:00:00Z", "temperatureC": 5.4, "humidityPct": 62.1,
  "latitude": 6.9271, "longitude": 79.8612, "speedKmh": 38.5, "vibrationG": 0.12 }
```

Batch (e.g. readings buffered while offline), up to 300:
`{ "shipmentNumber": "SH-000001", "readings": [ {...}, {...} ] }`

- `recordedAt`: ISO 8601 with a time zone, or Unix seconds (NTP/GPS time).
  Required. Rejected when before 2020 (clock not set), more than 2 minutes in
  the future, or outside the shipment's monitoring window.
- Measurements must be JSON numbers, or `null` when not measured. Ranges:
  temperature −60–85 °C, humidity 0–100 %, speed 0–250 km/h, vibration 0–16 g.
  Latitude and longitude are sent together; `0, 0` is rejected (send `null`
  without a GPS fix). Unknown fields are rejected.
- Without `shipmentId` / `shipmentNumber`, the device's active assignment is used.
- Each reading is validated separately. Valid ones are stored even if others
  are rejected. A resent reading (same time) is reported in `duplicates` and
  not stored twice.
- **Retry rule for firmware:** drop readings from the buffer on any 2xx or 4xx
  answer; keep and retry them only on 5xx or no answer.

Response: `201 { shipmentId, shipmentNumber, accepted, duplicates, rejected: [{ index, errors }], alerts: { opened, updated, resolved } }`
(`200` if nothing new was stored, `400` if no reading was valid, `401` wrong key, `403` deactivated device, `409` device not assigned).

**Data-quality flags** (stored values are never changed):
`delayed_upload` (received > 5 min or 3 intervals after recording),
`gps_jump` (> 200 km/h implied between fixes at least 1 km apart),
`after_delivery` (recorded after the pharmacy received the shipment).

## Dashboard API (user token, roles as in Component 4)

| Method & path | Who | Purpose |
|---|---|---|
| `GET /api/cold-chain/shipments?status=&test=&limit=` | staff | monitored shipments, each with latest reading, connection, delivery, open alerts, latest prediction |
| `GET /api/cold-chain/shipments/available` | admin, warehouse | in-transit shipments not yet monitored, with default limits |
| `POST /api/cold-chain/shipments` | admin, warehouse | start monitoring `{ shipmentId, deviceId?, expectedDeliveryAt?, startedAt?, isTest?, tempMinC?, tempMaxC?, humidityMinPct?, humidityMaxPct?, readingIntervalSeconds? }` |
| `GET /api/cold-chain/shipments/:id` | staff | one monitored shipment |
| `PATCH /api/cold-chain/shipments/:id` | admin, warehouse | device, limits, expected delivery, interval; `{ monitoringStatus: "ended" }` |
| `GET /api/cold-chain/shipments/:id/readings?from=&to=&limit=` | staff | readings, oldest first (default: newest 1000) |
| `GET /api/cold-chain/shipments/:id/alerts?status=` | staff | alerts |
| `GET /api/cold-chain/shipments/:id/risk` | staff | newest risk prediction, or `null` |
| `POST /api/cold-chain/alerts/:id/acknowledge` | staff | acknowledge an open alert |
| `GET /api/cold-chain/devices` | admin, warehouse | devices and their active shipment |
| `POST /api/cold-chain/devices` | admin | register `{ deviceCode, name?, deviceType?: "esp32" \| "simulator", notes? }`; the key is returned once |
| `PATCH /api/cold-chain/devices/:id` | admin | `{ name?, notes?, isActive? }` |
| `POST /api/cold-chain/devices/:id/rotate-key` | admin | new key, returned once |

"Staff" = admin, warehouse staff, or pharmacy staff of the destination pharmacy.

**Connection status** (age of the newest reading): `online` ≤ 3 intervals,
`delayed` ≤ 10 intervals, `offline` beyond that, `no_data`, `ended`.

## Observed alerts

One alert per condition (`temperature_excursion:above|below`,
`humidity_deviation:above|below`):

- Temperature within 0.5 °C of a limit → **medium** ("approaching"); beyond
  the limit → **high**. Humidity outside the configured range → **medium**.
- While the condition lasts, the same alert is updated (last detection, peak
  value, occurrences). It only escalates. An escalated alert that was
  acknowledged is opened again.
- It resolves when the newest reading is back inside the safe band. A later
  breach opens a new alert, so each excursion is its own record.
- The wording reports measurements ("Measured temperature reached 9.1 °C,
  above the 8 °C limit … check the products' stability data"). It never states
  that a product is spoiled.

## Development: simulator and live checks

Both scripts need an **in-transit shipment to a SAMPLE pharmacy** (or
`--shipment SH-xxxxxx`) and the backend running. They run from `backend/`.

- `node --env-file=.env scripts/simulate-cold-chain.js --scenario excursion`
  sends simulated history through the real device API.
  - Scenarios: `normal`, `rising`, `excursion`, `humidity`, `gps-jump`.
  - Options: `--minutes`, `--interval`, `--seed`, `--live` (keep sending in
    real time), `--reset` (delete the shipment's test data first).
  - It registers the `SIM-001` simulator device with a fresh key on every run
    and monitors the shipment as a **test** shipment. Simulated data cannot
    reach real shipments.
- `node --env-file=.env scripts/check-cold-chain-api.js` runs live checks
  against Supabase.
  - The device API is checked over HTTP on the running backend.
  - The dashboard routes run in-process as a stub admin, because a script
    cannot sign in as a person.
  - Everything it creates is deleted at the end.

## Setup

1. Apply `supabase/migrations/20261017000000_create_cold_chain_schema.sql`
   (after the pharmacy migrations).
2. Run the backend (`cd backend && npm run dev`). No new environment variables.
3. As an admin, register a device on **Cold Chain → Devices** (the key is
   shown once; put it in the firmware). Then, as an admin or warehouse staff,
   use **Cold Chain → Start monitoring** to assign the device to an
   in-transit shipment, check its limits and set the expected delivery time.
   The same is possible through the API (`POST /api/cold-chain/devices`,
   `POST /api/cold-chain/shipments`).
