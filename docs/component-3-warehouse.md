# Component 3 – Intelligent Warehouse FEFO & QR Management

## Architecture

```
Browser ──► Next.js server (Server Components / Server Actions)
              │  forwards the user's Supabase access token
              ▼
            Express  /api/medicines, /api/warehouse/*      (backend/src/warehouse)
              │  verifies the token, role checks, FEFO + QR rules
              ├──► Supabase PostgreSQL (service role)
              │      stock changes only via transactional functions
              │      (record_inventory_movement, warehouse_allocate_order, ...)
              ├──► Python AI service  POST /warehouse/spatial/recommend   (ai-service/)
              │      stateless; receives the warehouse state, returns ranked locations
              └──► Component 2 API    POST /api/cold-chain/shipments  (handoff at dispatch)

Component 4 (pharmacy) ◄──► shared tables: purchase_orders, shipments, shipment_items,
                            shipment_discrepancies, return_requests (its documented contract)
```

- **FEFO** (First Expiry, First Out) and **QR** are deterministic rules in the
  backend and database. They are not AI.
- **Spatial allocation** is the optimisation part: a modular Python service.
- The browser never calls the backend; the Supabase secret key stays in `backend/.env`.

| Where | What |
|---|---|
| `supabase/migrations/20261008000000_create_warehouse_schema.sql` | warehouse tables, views, `record_inventory_movement()`, RLS |
| `supabase/migrations/20261008000001_grant_profiles_to_service_role.sql` | backend read access to `profiles` |
| `supabase/migrations/20261018000000_warehouse_order_fulfilment.sql` | order fulfilment, reservations, integration outbox, scan history, stricter RLS |
| `supabase/migrations/20261018000001_staff_warehouse_assignment.sql` | `profiles.warehouse_id` (warehouse of warehouse staff / admins) |
| `supabase/seed/sample_warehouse.sql` | SAMPLE warehouse, stock and movements (optional) |
| `backend/src/warehouse/` | API `routes/`; rules `fefo.js`, `expiry.js`, `qr.js`, `movements.js`, `fulfilment.js`; `integrations/` (outbox, cold-chain adapter); `auth.js` (roles) |
| `backend/test/warehouse/` | unit, HTTP access, PGlite database and embedded-PostgreSQL concurrency tests |
| `ai-service/warehouse/` | spatial allocation (`spatial.py` logic, `schemas.py`, `router.py` API) |
| `frontend/src/app/dashboard/warehouse/` | pages and server actions |
| `frontend/src/components/warehouse/`, `frontend/src/lib/warehouse/` | UI components (CSS Modules), API client |

## Roles

`profiles.role` is shared with Components 2 and 4. Admins assign roles in
**Warehouse → Staff** (`/api/warehouse/staff`), which also sets the assignment
the role takes: a **pharmacy** for pharmacy staff, a **warehouse** for warehouse
staff (required) and admins (optional, "all warehouses" when empty). The
database clears the warehouse when a role without warehouse access is set
anywhere (e.g. Pharmacy → Settings). The warehouse assignment is recorded and
shown; it does not yet restrict which warehouse's data a staff member sees
(with one warehouse this makes no difference).

| Role | Warehouse |
|---|---|
| admin | everything, incl. configuration (warehouses, zones, racks, locations, medicines), stock corrections and disposals, batch status, FEFO thresholds, QR deactivation, staff access |
| warehouse_staff | receive, move, pick, dispatch, QR scan, discrepancy reports, returns |
| pharmacy_staff | none (reads the medicine catalogue only) |
| user / inactive | none |

The backend checks every request (`auth.js`); the sidebar hides pages a role cannot use.
Operational warehouse tables are readable (RLS) by warehouse staff and admins only;
`warehouses`, `medicines` and `batches` stay readable by signed-in users (shared).

## Database

Shared tables: `medicines` (storage condition, controlled flag) and `batches`
(batch number, dates, status `active` / `quarantined` / `recalled` / `disposed`;
*expired* and *depleted* are derived).

Component 3 tables:

- `warehouses` (FEFO thresholds) → `warehouse_zones` (`storage`/`quarantine`, storage
  condition, temperature range, `is_secure`) → `warehouse_racks`
  (`distance_to_dispatch_m`) → `storage_locations` (level, `capacity_units`, `accessibility`).
- `warehouse_stock` – packs of a batch at a location.
- `batch_qr_codes` – one active code per batch; old codes are deactivated, not deleted.
- `inventory_movements` – append-only `receive` / `transfer` / `dispatch` / `adjustment` /
  `disposal`, with who, how (`manual` / `qr_scan` / `system`), FEFO compliance and an
  optional `client_request_id` (idempotency key).
- `warehouse_order_fulfilments` – warehouse progress of one pharmacy order.
- `warehouse_order_picks` – FEFO allocation lines; `reserved` and `picked` lines hold stock.
- `warehouse_integration_events` – outbox of handoffs to other components.
- `warehouse_scan_events` – QR scan history (lookups, pick verification, rejections).

Views: `storage_location_overview`, `warehouse_stock_overview` (with
`quantity_reserved`, `quantity_available`), `inventory_movement_overview`.

**Integrity.** All stock changes run in database functions that lock rows and
check the rules in one transaction: no negative stock, no over-capacity, storage
condition and secure-zone rules, quarantine rules, no cross-warehouse transfers,
no receiving expired stock, no dispatching non-active or expired batches, and
**reserved stock cannot be moved, disposed, dispatched loose or taken by another
order** (including Component 4's `pharmacy_dispatch_order()`). Rows are locked in a
fixed order to avoid deadlocks. Only the service role may call the functions.

## Pharmacy order fulfilment

```
Component 4:  submitted ───────────────────────────────────────► dispatched ──► received
Component 3:  pending ─► allocated ─► picking ─► ready ─► dispatched
                  │         └────────── cancelled (reservation released) ──┘
                  └─ declined (order cancelled)
```

1. **Allocate** (`warehouse_allocate_order`): reserves stock for every item in FEFO
   order – active batch, storage zone, active location, at least `minShelfDays`
   (default 30) of shelf life; earliest expiry, then older manufacture, earlier
   receipt, nearer dispatch. All or nothing; quantities may be reduced per item.
   Skipping short-dated stock is recorded the same way as Component 4's dispatch
   function. Repeating it returns the same allocation.
2. **Pick** (`warehouse_confirm_pick`): at the shelf, staff scan the batch label (or
   type the batch number) and the location label `PTWH:LOC:<id>` (or type the
   location code). Wrong batch, wrong location, unknown or deactivated labels are
   rejected and logged. When every pick is verified the order is **ready**.
3. **Dispatch** (`warehouse_dispatch_fulfilment`): one transaction creates the
   `shipments` / `shipment_items` rows Component 4 receives (picked batches, packs,
   `units_per_pack`, prices copied), records one dispatch movement per pick that
   consumes its reservation, sets the order to `dispatched` and queues the
   cold-chain handoff. Repeating it returns the same shipment (no second deduction).
4. **Cancel / decline**: releasing an allocation frees the stock; declining calls
   Component 4's `pharmacy_cancel_order()`. A trigger releases reservations whenever
   an order is cancelled (also by the pharmacy) or dispatched outside this workflow.
5. **Receipt** is confirmed by the pharmacy in Component 4 (`pharmacy_confirm_receipt`);
   the warehouse order page shows the shipment status, packs accepted per batch and
   any discrepancy reports. Dashboard stock flow distinguishes **warehouse stock**
   (incl. reserved), **in transit** (shipments not yet received) and **confirmed by
   pharmacies** (`quantity_accepted`).

Concurrency is tested on a real PostgreSQL server: competing allocations never
over-reserve, parallel allocations/dispatches of one order produce one allocation
and one shipment, a repeated movement request moves stock once.

## Cross-component contracts

| With | Contract (documented by the other component) | Used for |
|---|---|---|
| Component 4 | shared tables above; functions `pharmacy_cancel_order`, `pharmacy_update_discrepancy`, `pharmacy_review_return`, `pharmacy_receive_return`; `/api/pharmacy/admin/users` and `/pharmacies` | orders, dispatch into shipments, discrepancy acknowledge/resolve, return review/receipt (restock into a location), staff access |
| Component 2 | `POST /api/cold-chain/shipments { shipmentId, expectedDeliveryAt? }` with the user's token | hand the shipment over to monitoring at dispatch (optional) |

**Cold-chain handoff.** Sensor devices and monitoring limits belong to Component 2;
the warehouse never assigns devices. Every dispatched shipment is in `shipments`
(`in_transit`), where Component 2's Cold Chain → Start monitoring finds it. At
dispatch staff may also tick "Hand over to cold-chain monitoring now": dispatch then
writes a `pending` `warehouse_integration_events` row in the same transaction
(otherwise `skipped`). The
backend delivers it right after dispatch (`integrations/cold-chain.js`): network
errors and 5xx answers are retried with backoff; `409 already monitored` counts as
delivered (idempotent); other 4xx answers are final. Failures are recorded
(attempts, last error) and can be retried from the order page
(`POST /api/warehouse/integrations/:id/retry`). Delivery uses the user's session,
so there is no background retry when nobody is signed in.

Not covered (no contract exists yet): notifying Component 4 actively (it reads the
shared tables and Realtime), and Component 2 → warehouse feedback.

## API (backend; `Authorization: Bearer <Supabase access token>`)

Warehouse staff unless marked *admin*.

| Method & path | Purpose |
|---|---|
| `GET /api/medicines` · `/categories` · `/:id` | catalogue (any staff role) |
| `POST /api/medicines` · `PATCH /:id` | *admin*: create / edit |
| `GET /api/warehouse/warehouses` · `POST` · `PATCH /:id` | warehouses (*admin* writes) |
| `GET /api/warehouse/storage` · `/locations` · `/locations/:id/label` | hierarchy with contents · flat list · location QR label |
| `POST /api/warehouse/storage/zones` · `/racks` · `/locations`; `PATCH /zones/:id` · `/racks/:id` · `/locations/:id` | *admin*: structure |
| `GET /api/warehouse/batches` · `/:id`; `POST /` | batches; register a batch (issues its QR) |
| `PATCH /api/warehouse/batches/:id` | *admin*: status |
| `GET /api/warehouse/inventory` · `/summary` | stock (FEFO order) · dashboard incl. orders and stock flow |
| `GET /api/warehouse/fefo/alerts` · `/pick` · `/compliance`; `POST /dispatch` | FEFO alerts, pick list, compliance; loose FEFO dispatch (atomic, `clientRequestId`) |
| `POST /api/warehouse/qr/resolve`; `GET`·`POST /qr/batch/:batchId`; `POST /qr/:id/deactivate` | lookup (logged) · label / new label · *admin* deactivate |
| `GET` · `POST /api/warehouse/movements` | history · record (`clientRequestId`; adjustment/disposal *admin*) |
| `GET /api/warehouse/orders` · `/:id` | orders by stage with counts · detail |
| `POST /api/warehouse/orders/:id/allocate` · `/picks/:pickId/confirm` · `/cancel-allocation` · `/dispatch` · `/decline` | fulfilment |
| `GET /api/warehouse/discrepancies`; `POST /:id/acknowledge` · `/:id/resolve` | pharmacy discrepancy reports |
| `GET /api/warehouse/returns` · `/:id`; `POST /:id/review` · `/:id/receive` | returns |
| `GET /api/warehouse/integrations`; `POST /:id/retry` | handoff outbox |
| `GET /api/warehouse/scans` | scan history |
| `GET /api/warehouse/staff`; `PATCH /:id` | *admin*: accounts; role, status and pharmacy / warehouse assignment |
| `POST /api/warehouse/spatial/recommend` · `GET /status` | ranked locations · service reachable? |
| `GET /api/warehouse/state` | warehouse snapshot for the digital twin |

Errors are JSON `{ error, details? }`: 400 validation (`details.fields`), 401/403,
404, 409 business rule or concurrent change, 410 inactive QR, 503 service down.

## FEFO logic

- Expiry status: `expired` (before today), `critical` (≤ critical threshold, default
  30 days), `near_expiry` (≤ near threshold, default 90), `ok`; thresholds per
  warehouse; "today" in `WAREHOUSE_TIME_ZONE` (default `Asia/Colombo`).
- Eligible for outbound: active batch, not expired, storage zone, unreserved stock.
- Order: earliest expiry → older manufacture → earlier receipt (FIFO only as a
  tie-break) → nearer dispatch.
- Dispatching a later-expiring batch while an earlier eligible one exists needs an
  override reason and is recorded as non-compliant; compliance rate =
  compliant / (compliant + overrides).

## QR workflow

1. Registering a batch issues a code (12 random Crockford base32 characters + a Luhn
   mod 32 check character). The QR encodes only `PTWH:1:<code>`; storage location
   labels encode `PTWH:LOC:<location id>`. No secrets or batch data are encoded.
2. Labels are shown and printed on the batch page (batch) and in Configuration (locations).
3. Scanning (camera via `BarcodeDetector` or jsQR, handheld scanner, or typing):
   lookups and pick verification validate format, check character, registration
   and active status, and every attempt is stored in the scan history.
4. A lost or damaged label is replaced; the old code is deactivated and kept.

## Spatial allocation (ai-service)

Rule-based multi-criteria scoring – a transparent heuristic, not a trained model.
Hard constraints (same as the database checks) remove unsuitable locations; the rest
are scored on expiry ↔ accessibility match (40%), capacity fit (25%), consolidation
(25%) and zone efficiency (10%), returned with factor values, reasons and rejected
locations. Invalid input (e.g. all weights zero) is a 422. If the service is down,
Receive & Allocate lists compatible locations nearest to dispatch, labelled
"not optimised", so receiving continues.

## Setup and run

1. In the Supabase SQL editor apply, after the earlier migrations,
   `20261008000000_create_warehouse_schema.sql`,
   `20261008000001_grant_profiles_to_service_role.sql` and (after the pharmacy and
   cold-chain migrations) `20261018000000_warehouse_order_fulfilment.sql` and
   `20261018000001_staff_warehouse_assignment.sql`. Do not
   re-run `20261008000000` afterwards: it would re-create the old
   `record_inventory_movement()` signature next to the new one.
2. Assign roles in **Warehouse → Staff** (warehouse staff need `warehouse_staff`).
3. Backend (`backend/.env`, see `backend/.env.example`; optional
   `SPATIAL_SERVICE_URL=http://localhost:8000`, `WAREHOUSE_TIME_ZONE=Asia/Colombo`,
   `COLD_CHAIN_API_URL` if Component 2 is not served by the same backend):
   `cd backend && npm install && npm run dev`.
4. AI service (Python 3.10+):

   ```bash
   cd ai-service
   python -m venv .venv
   .venv\Scripts\pip install -r requirements.txt      # macOS/Linux: .venv/bin/pip
   .venv\Scripts\uvicorn main:app --port 8000
   ```
5. Frontend: `cd frontend && npm install && npm run dev` → **Warehouse** in the sidebar.

Tests:

```bash
cd backend && npm test            # includes PGlite and embedded-PostgreSQL tests
cd ai-service && .venv\Scripts\python -m unittest discover tests
cd frontend && npm run lint && npm run build
```

## Limitations

- One shipment per order (Component 4's contract); short-dated stock is never sent
  to pharmacies, so an order may need a reduced quantity.
- A pick confirms the whole reserved quantity of one batch at one location; partial
  picks need the allocation to be cancelled and re-made.
- Batches larger than any free location must be split manually.
- Cold-chain handoff retries need a signed-in user (no background worker).
- A shipment handed over at dispatch is monitored without a sensor device until the
  Cold Chain component assigns one (pending in Component 2).
