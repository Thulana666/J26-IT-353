# Component 3 – Intelligent Warehouse FEFO & QR Management

## Architecture

```
Browser ──► Next.js server (Server Components / Server Actions)
              │  forwards the user's Supabase access token
              ▼
            Express  /api/medicines, /api/warehouse/*      (backend/src/warehouse)
              │  verifies the token, role checks, FEFO + QR rules
              ├──► Supabase PostgreSQL (service role)
              │      stock changes only via record_inventory_movement()
              └──► Python AI service  POST /warehouse/spatial/recommend   (ai-service/)
                     stateless; receives the warehouse state, returns ranked locations
```

- **FEFO** (First Expiry, First Out) and **QR** are deterministic rules in the
  backend (`fefo.js`, `expiry.js`, `qr.js`). They are not AI.
- **Spatial allocation** is the optimisation part: a modular Python service.
- The browser never calls the backend; the Supabase secret key stays in
  `backend/.env`.

| Where | What |
|---|---|
| `supabase/migrations/20261008000000_create_warehouse_schema.sql` | tables, views, `record_inventory_movement()`, RLS |
| `supabase/seed/sample_warehouse.sql` | SAMPLE warehouse, stock and movements (optional) |
| `backend/src/warehouse/` | API: `routes/`, rules (`fefo.js`, `expiry.js`, `qr.js`, `movements.js`), `services.js`, `store.js` |
| `backend/test/warehouse/` | unit tests (`npm test`) |
| `ai-service/warehouse/` | spatial allocation (`spatial.py` logic, `router.py` API) |
| `ai-service/tests/` | unit tests |
| `frontend/src/app/dashboard/warehouse/` | pages and server actions |
| `frontend/src/components/warehouse/`, `frontend/src/lib/warehouse/` | UI components (CSS Modules), API client |

## Database

Shared tables (other components can reference them):

- `medicines` – name, strength, form, `medicine_category_id` (Component 1's
  `medicine_categories`), `storage_condition` (`ambient` / `cool` /
  `refrigerated` / `frozen`), `is_controlled`.
- `batches` – medicine, `batch_number`, manufacturing and `expiry_date`,
  `status` (`active` / `quarantined` / `recalled` / `disposed`).
  *Expired* and *depleted* are derived, not stored.

Component 3 tables:

- `warehouses` (FEFO thresholds `near_expiry_days`, `critical_expiry_days`;
  optional `location_id` → shared `locations`) → `warehouse_zones` (zone type
  `storage`/`quarantine`, storage condition, temperature range, `is_secure`)
  → `warehouse_racks` (`distance_to_dispatch_m`) → `storage_locations`
  (level, `capacity_units`, `accessibility`).
- `warehouse_stock` – quantity of a batch at a location (a batch can span locations).
- `batch_qr_codes` – one active code per batch; old codes are deactivated, not deleted.
- `inventory_movements` – append-only: `receive`, `transfer`, `dispatch`,
  `adjustment`, `disposal`; who (`performed_by`), how (`manual` / `qr_scan` /
  `system`), FEFO compliance and override reason.

Views (read models / digital-twin state): `storage_location_overview`
(occupancy per location), `warehouse_stock_overview` (stock with batch,
medicine and location), `inventory_movement_overview` (movement + warehouse).

Quantities and capacities use the same *storage units* (e.g. cartons).

**Integrity.** `record_inventory_movement()` runs in one transaction, locks
the batch, source stock and destination location, and rejects: insufficient
stock, over-capacity, wrong storage condition, controlled medicine outside a
secure zone, quarantined/recalled/expired stock outside quarantine (and active
stock inside it), cross-warehouse transfers, receiving expired stock,
dispatching non-active or expired batches. Only the service role may call it.
Signed-in users can read all tables; only admins can write master data
directly; stock and movements are read-only for users.

## API (backend, all routes need `Authorization: Bearer <Supabase access token>`)

| Method & path | Who | Purpose |
|---|---|---|
| `GET /api/medicines` · `/categories` · `/:id` | user | medicines (`?q=&active=`) |
| `POST /api/medicines` · `PATCH /:id` | admin | create / edit |
| `GET /api/warehouse/warehouses` · `POST` · `PATCH /:id` | user · admin | warehouses, FEFO thresholds |
| `GET /api/warehouse/storage` | user | zones → racks → locations with occupancy and contents |
| `GET /api/warehouse/storage/locations` | user | flat list (`?warehouseId=&zoneType=&storageCondition=&activeOnly=&minAvailable=`) |
| `POST /api/warehouse/storage/zones` · `/racks` · `/locations` · `PATCH /locations/:id` | admin | structure |
| `GET /api/warehouse/batches` · `/:id` | user | batches; detail with stock, FEFO position, QR, movements |
| `POST /api/warehouse/batches` | active user | register a batch (issues its QR code) |
| `PATCH /api/warehouse/batches/:id` | admin | status: active / quarantined / recalled |
| `GET /api/warehouse/inventory` · `/summary` | user | stock rows (FEFO order, filters) · dashboard figures |
| `GET /api/warehouse/fefo/alerts` | user | expired / critical / near-expiry batches, stock needing quarantine |
| `GET /api/warehouse/fefo/pick` | user | FEFO pick list (`?warehouseId=&medicineId=&quantity=`) |
| `POST /api/warehouse/fefo/dispatch` | active user | dispatch following the pick list |
| `GET /api/warehouse/fefo/compliance` | user | FEFO compliance rate and overrides (`?days=30`) |
| `POST /api/warehouse/qr/resolve` | user | `{ payload }` → batch, stock, FEFO position |
| `GET` · `POST /api/warehouse/qr/batch/:batchId` | user · active user | label image · issue a new label |
| `POST /api/warehouse/qr/:id/deactivate` | admin | deactivate a code |
| `GET /api/warehouse/movements` · `POST` | user · active user | history (`?batchId=&movementType=&warehouseId=&page=`) · record (adjustment/disposal: admin) |
| `POST /api/warehouse/spatial/recommend` · `GET /status` | user | ranked locations · Python service reachable? |
| `GET /api/warehouse/state` | user | full warehouse snapshot for the digital twin |

Errors are JSON `{ error, details? }`: 400 validation (`details.fields`), 401/403,
404, 409 business rule (e.g. `details.code = "FEFO_VIOLATION"`), 410 inactive QR,
503 spatial service down.

## FEFO logic

- Expiry status: `expired` (expiry date before today; the expiry date itself is
  usable), `critical` (≤ critical threshold, default 30 days), `near_expiry`
  (≤ near threshold, default 90), `ok`. Thresholds are per warehouse (admins
  edit them on the FEFO page). "Today" is the warehouse's local date
  (`WAREHOUSE_TIME_ZONE`, default `Asia/Colombo`).
- Eligible for outbound: active batch, not expired, in a storage zone, stock > 0.
- Order: earliest expiry → older manufacturing date → earlier receipt (FIFO only
  as a tie-break) → location nearer dispatch.
- Dispatching a batch while an earlier-expiring eligible batch exists is refused
  (409) unless an override reason is given; it is then recorded with
  `fefo_compliant = false`. Same-day expiry counts as compliant. Compliance rate =
  compliant / (compliant + overrides).

## QR workflow

1. Registering a batch issues a code: 12 random Crockford base32 characters plus
   a Luhn mod 32 check character. The QR image encodes only `PTWH:1:<code>`
   (opaque; batch data is looked up, so labels never go stale).
2. The batch page shows the label (SVG) and prints it.
3. Scanning (camera via `BarcodeDetector` or jsQR, a handheld scanner, or typing)
   calls `/qr/resolve`: invalid format or check character → 400, unknown → 404,
   deactivated → 410 with a hint to use the newer label.
4. The result shows locations and FEFO position, with transfer/dispatch forms
   (movements are recorded with `performed_via = 'qr_scan'`).
5. A damaged or lost label is replaced with "Issue new label"; the old code is
   deactivated and kept for history.

## Spatial allocation (ai-service)

Rule-based multi-criteria scoring – a transparent heuristic, not a trained model.

1. Hard constraints (same as the database checks): active location, matching
   storage condition, secure zone for controlled medicines, quarantine zone only
   and always for quarantined/recalled/expired stock, enough free capacity.
2. Factor scores in [0, 1], weighted (defaults):
   - expiry ↔ accessibility match, 40% – urgency (1 at the critical threshold,
     falling to 0 at 365 days) vs accessibility (shelf accessibility and
     distance to dispatch): short-dated stock near dispatch, long-dated deeper;
   - capacity fit, 25% – best fit, `quantity / free space`;
   - consolidation, 25% – same batch / same medicine nearby, avoid mixing medicines;
   - zone efficiency, 10% – keep secure storage for controlled medicines.
3. Score = 100 × weighted sum; output has the recommendation, alternatives,
   factor values, reasons and rejected locations with their reasons. Weights can
   be passed per request; the module (`spatial.recommend`) can be replaced by
   another allocator with the same input/output.

## Setup and run

1. Apply `supabase/migrations/20261008000000_create_warehouse_schema.sql` and
   `20261008000001_grant_profiles_to_service_role.sql` in the Supabase SQL
   editor (after the earlier migrations). Optionally run
   `supabase/seed/sample_warehouse.sql` for SAMPLE data (it has a cleanup block).
2. Backend (`backend/.env` as in the main README; optional
   `SPATIAL_SERVICE_URL=http://localhost:8000`, `WAREHOUSE_TIME_ZONE=Asia/Colombo`):

   ```bash
   cd backend && npm install && npm run dev
   ```
3. AI service (Python 3.10+):

   ```bash
   cd ai-service
   python -m venv .venv
   .venv\Scripts\pip install -r requirements.txt      # macOS/Linux: .venv/bin/pip
   .venv\Scripts\uvicorn main:app --port 8000
   ```
4. Frontend: `cd frontend && npm install && npm run dev`, then open
   **Warehouse** in the sidebar. `BACKEND_URL` in `frontend/.env.local` defaults
   to `http://localhost:5000`.

Tests:

```bash
cd backend && npm test
cd ai-service && .venv\Scripts\python -m unittest discover tests
```

Roles: signed-in users can view everything and scan; active users receive,
transfer and dispatch; admins also adjust, dispose, change batch status, edit
thresholds and master data.
