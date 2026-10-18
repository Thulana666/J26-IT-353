# Component 2 – IoT Cold-Chain Tracking & Logistics Risk Prediction

> Status: the end-to-end workflow (dispatch → allocation → live tracking →
> risk → alerts → delivery → history) works. Risk predictions come from a
> **temporary rule-based prototype**, clearly labelled as such; the CNN-LSTM
> model is prepared in `ai-service/cold_chain/` but **not trained yet**.

## Workflow

```
Warehouse → Orders: dispatch            (Component 3; hands the shipment over via POST /api/cold-chain/shipments,
        │                                or Cold Chain → Create shipment)
        ▼
READY_FOR_DISPATCH ── allocate driver + truck (+ the truck's sensor) ──► ALLOCATED
        ▼                                                                    │ start
   (re-allocation possible until the start)                                  ▼
DELIVERED ◄── driver marks delivered ── IN_TRANSIT ◄── live readings (ESP32 → POST /readings)
   │              final readings recorded,           temperature, humidity, GPS, speed
   │              driver + truck available            → observed alerts, predicted risk, predicted alerts
   ▼
History (summaries; sensor data kept). The pharmacy confirms receipt itself (Component 4).
```

```
SHT31 / NEO-6M / MPU6050 ──► ESP32 ──HTTPS──► Express  POST /api/cold-chain/readings
                                               │  device key, validation, quality flags,
                                               │  observed alerts, risk predictor, predicted alerts
                                               ▼
                                             Supabase PostgreSQL (service role) ──Realtime──► dashboard
                                               ▲
Browser ──► Next.js server ──(user token)──► Express  /api/cold-chain/shipments, /drivers, /trucks, /alerts, /devices
                                               │
                                               └──► ai-service POST /cold-chain/predict (CNN-LSTM; 501 until trained)
```

- Cold-chain tracking extends **Component 4's shipments** without changing
  them: a tracked shipment has a `cold_chain_shipments` row with the
  shipment's own id. Origin, destination, items, batches and the pharmacy's
  receipt come from Components 3/4.
- Devices never hold the Supabase secret key: each device has its own key,
  stored only as a SHA-256 hash.

| Where | What |
|---|---|
| `supabase/migrations/20261017000000_create_cold_chain_schema.sql` | devices, monitored shipments, readings, alerts, predictions, views, RLS, Realtime |
| `supabase/migrations/20261018000002_cold_chain_logistics.sql` | drivers, trucks, trip workflow functions, history summary view, backfill |
| `backend/src/cold-chain/` | API (`routes/`), validation, data quality, observed alerts, `risk/` (prototype predictor, provider interface, predicted alerts, scheduler) |
| `frontend/src/app/dashboard/cold-chain/` | **Cold Chain** pages: Shipments, Create shipment (`start/`), shipment page (`[shipmentId]`), Drivers, Trucks, History, Devices |
| `frontend/src/components/cold-chain/`, `frontend/src/lib/cold-chain/` | trip panel, allocation and fleet forms, charts, map preview, risk card, alerts, readings table |
| `ai-service/cold_chain/` | CNN-LSTM preparation: preprocessing, model definition, training script, `/cold-chain/predict` (501 until trained) |
| `backend/test/cold-chain/`, `ai-service/tests/test_cold_chain.py` | unit, HTTP (fake Supabase) and PGlite database tests; preprocessing tests |
| `backend/scripts/check-cold-chain-api.js` | live end-to-end check against Supabase |
| `backend/scripts/simulate-cold-chain.js` | simulated readings for test trips |

## Database

| Table | Purpose |
|---|---|
| `cold_chain_devices` | ESP32 loggers and simulators; `key_hash`, `is_active`, `last_seen_at` |
| `cold_chain_drivers` | name, phone, email, licence number and expiry, `status` available / assigned / on_trip / inactive |
| `cold_chain_trucks` | registration, type, `is_refrigerated` with the range it holds, installed sensor (`device_id`), `status` available / assigned / in_use / inactive |
| `cold_chain_shipments` | per shipment (PK = `shipments.id`): limits, expected delivery, `is_test`, **trip**: `trip_status`, driver, truck, device, allocated / started / delivered times, delivery note, final readings |
| `cold_chain_readings` | `recorded_at` (device) and `received_at` (server), temperature, humidity, GPS, speed, vibration, `source`, `quality_flags`; unique per shipment and time |
| `cold_chain_alerts` | one active alert per condition (`dedupe_key`); `basis` observed / predicted, level, probability, first/last detection, occurrences, acknowledgement |
| `cold_chain_risk_predictions` | level, probability, main risk type, explanation, per-risk factors, model name/version, `is_prototype` |

Views: `cold_chain_latest_readings`, `cold_chain_latest_predictions`,
`cold_chain_shipment_summaries` (history: readings, min/avg/max, readings
outside the limits, alerts, highest predicted risk).

- **Workflow integrity.** Allocation, start and delivery are database
  functions (`cold_chain_allocate_trip`, `cold_chain_start_trip`,
  `cold_chain_deliver_trip`) that lock the trip, driver and truck rows and
  update their statuses in one transaction; partial unique indexes make a
  second live trip for a driver or truck impossible. Allocation refuses
  inactive or unavailable drivers and trucks, expired licences, and
  non-refrigerated trucks (or trucks whose range does not cover the limits)
  for temperature-controlled shipments. A trip starts only with a sensor.
- **Readings only while the trip runs** (a trigger refuses them before the
  start; buffered readings recorded before delivery are still accepted).
- **Test data stays separate**: simulator devices may only report for
  `is_test` shipments (also enforced by a trigger); readings record their
  `source`.
- **RLS**: monitored shipments, readings, alerts and predictions as
  `shipments` (admins and warehouse staff all, pharmacy staff their pharmacy);
  drivers and trucks admins and warehouse staff only; devices and the workflow
  functions backend only.
- Default limits come from the strictest `medicines.storage_condition` of
  the items (prototype defaults; set them from the product labels).

## Device API (ESP32)

```
POST /api/cold-chain/readings
X-Device-Id:  ESP32-001
X-Device-Key: ccd_...            (from device registration; keep it out of source control)

{ "recordedAt": "2026-10-17T03:00:00Z", "temperatureC": 5.4, "humidityPct": 62.1,
  "latitude": 6.9271, "longitude": 79.8612, "speedKmh": 38.5, "vibrationG": 0.12 }
```

Batch (readings buffered while offline), up to 300:
`{ "shipmentNumber": "SH-000001", "readings": [ {...}, {...} ] }`.

- `recordedAt` (ISO 8601 with time zone, or Unix seconds) is required;
  refused before 2020 (clock not set), more than 2 min in the future, or
  outside the trip (start → delivery).
- Measurements are JSON numbers or `null`; out-of-range values, strings,
  a lone latitude, `0, 0` and unknown fields are refused, never adjusted.
- Without `shipmentId` / `shipmentNumber` the device's live trip is used.
- Response `201 { accepted, duplicates, rejected: [{ index, errors }], alerts, risk }`;
  `200` nothing new, `400` nothing valid, `401` wrong key, `403` deactivated
  device, `409` no live trip / trip not started.
- Firmware: drop readings from the buffer on any 2xx or 4xx; retry on 5xx or no answer.
- Quality flags (values kept as sent): `delayed_upload`, `gps_jump`, `after_delivery`.

## Dashboard API (user token)

"Staff" = admins, warehouse staff, and pharmacy staff of the destination pharmacy.
"Logistics" = admins and warehouse staff.

| Method & path | Who | Purpose |
|---|---|---|
| `GET /shipments?tripStatus=&status=&test=&limit=` | staff | tracked shipments with trip, driver, truck, latest reading, connection, delivery, alerts, latest prediction, summary |
| `GET /shipments/available` | logistics | dispatched shipments not tracked yet |
| `POST /shipments` | logistics | create (ready for dispatch) `{ shipmentId, expectedDeliveryAt?, isTest?, limits… }`; 409 "already monitored" if it exists (the warehouse handoff relies on this) |
| `POST /shipments/:id/allocate` | logistics | `{ driverId, truckId, deviceId? }` |
| `POST /shipments/:id/start` | logistics | start the trip |
| `POST /shipments/:id/deliver` | logistics | `{ notes? }` mark delivered (on the driver's behalf) |
| `GET /shipments/:id`, `/readings`, `/alerts`, `/risk` | staff | detail, readings, alerts, newest prediction |
| `PATCH /shipments/:id` | logistics | limits, expected delivery, interval, device |
| `GET/POST /drivers`, `PATCH /drivers/:id`, `PATCH /drivers/:id/status { active }` | logistics | drivers |
| `GET/POST /trucks`, `PATCH /trucks/:id`, `PATCH /trucks/:id/status { active }` | logistics | trucks |
| `POST /alerts/:id/acknowledge` | staff | acknowledge an alert |
| `GET/POST /devices`, `PATCH /devices/:id`, `POST /devices/:id/rotate-key` | logistics (write: admin) | sensors; keys shown once |

All paths are under `/api/cold-chain`. Business-rule refusals answer 409 with
a readable message (e.g. "Driver Nimal Perera is not available (on trip)").

## Alerts and risk prediction

**Observed alerts** (measurements): temperature within 0.5 °C of a limit →
medium, beyond it → high; humidity outside its range → medium. One alert per
condition; it is updated while the condition lasts, only escalates, and
resolves when the newest reading is back in range.

**Risk prediction** runs after every upload, when a trip starts, and every
`COLD_CHAIN_RISK_INTERVAL_MINUTES` (default 5) for trips in transit, so a
silent sensor or a passed delivery time is noticed without new readings.
Output: `riskLevel` (low < 0.3 ≤ medium < 0.7 ≤ high), `riskProbability`,
`riskType` (`temperature_excursion`, `humidity_deviation`, `delivery_delay`,
`route_anomaly` = route/logistics risk, `combined`), `explanation`, per-risk
`factors`, model name/version and `is_prototype`.

- **Current predictor: `prototype_rules` 0.1 (temporary, rule-based, not a
  trained model)**: temperature/humidity trend towards a limit (least-squares
  slope over 30 min), delivery delay (remaining distance at the recent average
  speed vs. the expected time), route risk (silent sensor, long stop, GPS
  jumps), combined `1 − Π(1 − p)`. Its scores are heuristics, not calibrated
  probabilities, and are never reported as model results.
- **Interface**: `backend/src/cold-chain/risk/provider.js`. With
  `COLD_CHAIN_RISK_MODEL=cnn_lstm` the backend calls the AI service instead;
  until the model is trained that answers 501 and no prediction is stored
  (no silent fallback).
- **Predicted alerts**: one per risk type, opened at 60 % (high from 80 %),
  resolved below 40 %; combined risk from 70 %. Messages give the probability
  and the predictor ("Predicted risk 82 % (prototype rule-based predictor)").
  A predicted temperature/humidity alert is closed while a measured one is active.
- Predictions are stored when the level changes, the probability moves ≥ 5
  points, or 5 minutes passed (a time series for later evaluation).

## CNN-LSTM (not trained)

`ai-service/cold_chain/`: `preprocessing.py` turns readings into a 60 × 9
sequence (temperature relative to the limits, humidity, speed, time of day,
time to ETA, distance to the pharmacy, GPS-jump flag, measured-step mask);
`model.py` defines Conv1d → LSTM → probability; `training/train.py` trains on
a CSV export of **real** trips (test shipments excluded), splits by trip and
writes the measured precision, recall, F1 and ROC-AUC to
`models/metrics.json`. Install `requirements-training.txt` to train. No model,
weights or results exist yet.

## Development and testing

From `backend/`, with the backend running:

- `node --env-file=.env scripts/check-cold-chain-api.js --shipment SH-xxxxxx [--reset] [--keep]`:
  live end-to-end check on one dispatched shipment (as a test shipment, with
  a temporary driver, truck and simulator): create → allocate → start →
  readings → predicted and observed alerts → delivery → history. Deletes what
  it created unless `--keep`; `--cleanup` removes kept data.
- `node --env-file=.env scripts/simulate-cold-chain.js --shipment SH-xxxxxx --scenario rising [--live]`:
  simulated readings for a **test trip in transit** whose sensor is a
  simulator device (set it up in Cold Chain: create a test shipment, allocate
  a truck with e.g. SIM-001, start). Scenarios: normal, rising, excursion,
  humidity, gps-jump.
- `npm test` (backend), `.venv/Scripts/python -m unittest discover tests` (ai-service).

## Setup

1. Apply both cold-chain migrations (after the pharmacy and warehouse ones),
   then `notify pgrst, 'reload schema';`.
2. Backend env (optional): `COLD_CHAIN_RISK_INTERVAL_MINUTES` (default 5),
   `COLD_CHAIN_RISK_MODEL` (default `prototype`).
3. In Cold Chain: register sensors (Devices, admin; key shown once), add
   drivers and trucks (install a sensor in each truck), then create, allocate,
   start and deliver shipments from their pages.
