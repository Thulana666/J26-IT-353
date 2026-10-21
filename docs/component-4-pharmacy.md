# Component 4 – Intelligent Pharmacy Analytics & Stock Optimization

The pharmacy side of the digital twin: batch-level pharmacy inventory,
receiving with discrepancy reports, barcode POS billing (FEFO), purchase
orders and returns to the warehouse, and transparent stock analytics with
rule-based reorder recommendations (Q*).

**Scope.** Pharmacy-side only. The separate warehouse application handles
dispatch, discrepancy resolution and return reception; both apps share the
same Supabase database (`purchase_orders`, `shipments`, `shipment_items`,
`shipment_discrepancies`, `return_requests`, `return_items`). There is no
ML model training, price prediction or logistics here: demand is a simple
moving average behind a provider interface that a future Python ML service
can implement.

## Architecture

```
Browser ──► Next.js (Server Components / Server Actions)        frontend/src/app/dashboard/pharmacy
              │  forwards the user's Supabase access token (+ admin's chosen pharmacy)
              ▼
            Express /api/pharmacy/*                              backend/src/pharmacy
              │  verifies the token, role and pharmacy, Zod validation
              ▼
            Supabase PostgreSQL (service role)
              stock changes only through transactional SQL functions

Warehouse application ──► same tables / functions (dispatch, discrepancy resolution, return reception)
Browser ◄── Supabase Realtime (RLS applies): shipments, discrepancies, returns, stock, alerts
```

- The browser never calls the backend directly and never sees the Supabase
  secret key. Every write is Next.js server action → backend → database function.
- Row level security covers every Component 4 table; signed-in users can only
  read, and pharmacy staff only their own pharmacy's rows.

| Where | What |
|---|---|
| `supabase/migrations/20261010000000_create_pharmacy_schema.sql` | tables, constraints, indexes, RLS, realtime publication |
| `supabase/migrations/20261010000001_create_pharmacy_functions.sql` | checkout, orders, dispatch, returns, discrepancies, daily demand, recommendations |
| `supabase/migrations/20261012000000_update_pharmacy_receiving.sql` | receiving without item scanning, item-level acceptance, idempotent receipt / reports / return acceptance |
| `supabase/migrations/20261016000000_pharmacy_inventory_holds.sql` | discrepancy holds on stock already received (`quantity_held`), release / write-off, backfill of open reports |
| `supabase/migrations/20261020000000_pharmacy_linear_regression_model.sql` | lets runs and forecasts record the `linear_regression` model (widens two check constraints) |
| `supabase/seed/sample_pharmacy.sql` | optional SAMPLE pharmacies, prices, barcodes and **synthetic** history |
| `supabase/seed/remove_synthetic_history.sql` | removes only the synthetic history before evaluation, keeping current stock |
| `backend/src/pharmacy/` | `routes/`, `auth.js`, `validation.js` (Zod), `fefo.js`, `analytics/` |
| `backend/src/pharmacy/analytics/` | `demand.js` (burn rate, moving average, actual vs estimated), `linear-regression.js` (demand model), `forecast-provider.js`, `reorder.js` (Q*), `depletion.js` (stock cover, expiry risk), `alert-rules.js`, `service.js`, `research.js` |
| `frontend/src/app/dashboard/pharmacy/` | pages and server actions |
| `frontend/src/components/pharmacy/`, `frontend/src/lib/pharmacy/` | UI components, barcode input, charts, API client, labels |

The frontend is JavaScript (the repository has no TypeScript); request
validation is Zod in the backend and the database functions check again.

## Roles

`profiles.role` values `pharmacy_staff` and `warehouse_staff` (plus the
existing `admin` / `user`); `profiles.pharmacy_id` links pharmacy staff to
their pharmacy. Admins assign both in **Pharmacy → Settings → Users and access**.

| Role | Pharmacy app | Shared data |
|---|---|---|
| admin | everything, any pharmacy (pharmacy switcher) | reads all |
| pharmacy_staff | own pharmacy: all pharmacy pages | own pharmacy's rows |
| warehouse_staff | none (uses the warehouse application) | reads orders, shipments, discrepancies, returns of all pharmacies |
| user | none | none |

## Data model (shared tables reused)

| Concept | Table | Notes |
|---|---|---|
| products | `medicines` (shared) | + brand, manufacturer, dispensing unit, `units_per_pack`, cost, retail price |
| product batches | `batches` (shared) | batch number, manufacture and expiry dates, status |
| barcodes | `product_barcodes` | unit- or pack-level |
| pharmacy stock | `pharmacy_inventory` | per pharmacy **and batch**: on hand, reserved (held for returns), held (by discrepancy reports), cost, price; available = on hand − reserved − held; never deleted at zero |
| orders | `purchase_orders`, `purchase_order_items` | created by the pharmacy; items link to the recommendation they came from |
| shipments | `shipments`, `shipment_items` | written by the warehouse; one per order; items carry the warehouse's batch, shipped packs, `verification_status`, `quantity_accepted`, `accepted_at/by` |
| discrepancies | `shipment_discrepancies` | missing / excess / damaged / incorrect item or batch (+ expired, other); `client_request_id` idempotency key; open → acknowledged → resolved by the warehouse |
| sales | `sales`, `sale_items` | `source` = `pos` or `synthetic_seed`; `client_request_id`; FEFO compliance per line |
| ledger | `stock_movements` | append-only on-hand / reserved / held changes with balances |
| returns | `return_requests`, `return_items` | pending → approved → received, or rejected |
| settings | `pharmacies` (defaults), `reorder_settings` (per product) | lead time, review period, safety stock, window, thresholds, MOQ, capacity |
| analytics | `pharmacy_forecast_runs`, `pharmacy_demand_forecasts`, `reorder_recommendations` | moving-average runs, daily estimates, Q* with inputs and staff decision |
| alerts, audit | `pharmacy_alerts`, `audit_logs` | |

**Units.** Warehouse stock, orders and shipments are in warehouse packs
(e.g. carton); pharmacy stock, sales and returns in dispensing units (e.g.
strip). `units_per_pack` is copied onto shipment items at dispatch.

## Receiving

1. Pharmacy staff create a purchase order (Orders page). Each line shows the
   **warehouse stock** the pharmacy can order: packs in storage zones of its
   supplying warehouse, active locations and batches, at least 30 days of shelf
   life (the same rule as `pharmacy_dispatch_order()`), read live from
   `warehouse_stock` and re-checked every 30 s. Products the warehouse does not
   have are marked *Out of Stock at Warehouse* and cannot be selected; a
   quantity above the warehouse's stock blocks sending. The backend checks the
   quantities against the warehouse again when the order is sent (409). Stock
   is not reserved for submitted orders, so dispatch can still fall short if
   other pharmacies order the same stock first.
2. The warehouse application dispatches it, writing `shipments` and
   `shipment_items` with its batch details (it may use
   `pharmacy_dispatch_order()`, which picks warehouse stock FEFO).
3. The shipment appears on **Receiving** (Realtime) with the original order,
   expected items and quantities, and the warehouse's product and batch details.

**Matching delivery – no scanning.** Staff inspect the boxes against the
order and shipment details and click **Confirm Receipt**.
`pharmacy_confirm_receipt()` (one transaction, shipment row locked):
- checks the pharmacy, the shipment status and that no item is disputed;
- adds each item's **shipped quantity** with the **warehouse's batch, cost and
  price** from `shipment_items` to `pharmacy_inventory` (nothing comes from the
  browser), writes stock movements and the audit log, marks items `matched`,
  the shipment `received` and the order `received`;
- is idempotent: a repeated click, retry, second device or realtime refresh
  returns `already_processed` and changes nothing (concurrency-tested).
- Batches that are expired, recalled or quarantined at receipt cannot be confirmed as correct.

**Disputed item – scan only that item.** On the shipment, **Report
discrepancy / Scan item** opens a barcode input (USB reader = typing + Enter;
typed barcode, batch number, warehouse QR or product name as fallback). The
scanned item opens its **Product Details** page in the shipment's context:
product, brand, manufacturer, batch number, manufacture and expiry dates (from
the warehouse), expected (shipped) and ordered quantities, order and shipment
details. Staff choose missing / excess / damaged / incorrect item / incorrect
batch, enter the observed quantity and notes, and save. `pharmacy_report_discrepancy()`:
- takes the **expected quantity from the shipment**, validates the observed
  quantity for the type (e.g. missing < shipped, damaged 1..shipped);
- records the report in `shipment_discrepancies` (visible to the warehouse
  immediately) and marks the item disputed; it **never changes stock**;
- ignores a repeated submission with the same request id (each form keeps one
  id until it succeeds), while a new report gets a new id.
- An unknown barcode is recorded as an unknown item with the barcode and
  notes — no product or batch details are invented.

**Partial receipt.** Once any report exists, Confirm Receipt is refused and
the explicit **Accept verified items** is offered: undisputed items are added
as above; disputed items stay `discrepancy` with `quantity_accepted = null`
(held, not in stock). After the warehouse has **resolved every report** of a
held item, staff accept the packs they verified (0..shipped) with
`pharmacy_settle_shipment_item()` — idempotent, never more than shipped.
Excess beyond the shipped quantity is never added (the warehouse must
dispatch it formally).

**Problem found after the item is in stock.** A missing, damaged or incorrect
quantity reported for an item that was already accepted **holds** those units
(`pharmacy_inventory.quantity_held`): they stay on hand but are not available
for sale, returns or adjustments, and analytics do not count them as usable.
Held units = missing: expected − observed; damaged / incorrect: observed —
in dispensing units, capped at what was accepted and what is still available,
held once per report. Excess and other types hold nothing. After the warehouse
**resolves** the report, staff **Release to stock** (the warehouse decided the
units are fine) or **Write off** (they are gone or unusable) with
`pharmacy_settle_discrepancy_hold()` — idempotent and concurrency-safe; each
step is a stock movement (`discrepancy_hold` / `discrepancy_release` /
`discrepancy_write_off`). The migration holds the units of reports that were
already open when it is applied.

## POS

USB barcode readers type into the scan box; product search is the fallback.
The scanned product resolves to its **FEFO batch** (earliest-expiring
sellable batch: active, unexpired, unreserved, priced); another batch can be
chosen and is flagged "not FEFO". `pharmacy_checkout()` prices every line from
`pharmacy_inventory` (never from the client), applies the discount limit and
tax, locks the batch rows, checks expiry, status and unreserved stock,
deducts stock and writes the sale, items, ledger and audit in one transaction.
A repeated `client_request_id` returns the first sale (advisory lock + unique
key). Concurrent checkouts cannot oversell (concurrency-tested).

## Returns

The pharmacy submits a return (status **pending**). Stock is **not deducted**:
the quantity is reserved (still on hand, not sellable, cannot be returned
twice). The warehouse application approves, rejects (reservation released)
or receives it. `pharmacy_receive_return()` removes the stock from the
pharmacy only then, optionally restocks whole packs into a warehouse location,
and is idempotent: confirming an already received return changes nothing
(concurrency-tested). Approving or rejecting twice is also a no-op.

## Analytics (lightweight, explainable)

- **Average daily consumption (burn rate)** = units sold in the historical
  window ÷ days in the window. Only sale items count (no returns, corrections
  or other movements). The window is configurable (Settings, default 28 days).
  If the product has been stocked for fewer days, the rate uses those days and
  is marked *insufficient history*; no history or no sales give a status, not a number.
- **Days of stock cover** = usable available stock ÷ burn rate (statuses for
  out of stock, no recent sales, no history; never infinite).
- **Demand forecast**: a pooled **linear regression** (`linear-regression.js`)
  where it beats the moving average, otherwise the moving average of the
  window (`forecast-provider.js`). See *Demand model* below.
- **Q\*** (rule-based, not EOQ):
  ```
  Inventory position = usable on hand + confirmed incoming − reserved
  Reorder point      = demand during lead time + safety stock
  Target stock       = demand during lead time + review period + safety stock
  Q*                 = max(0, target stock − inventory position)
  ```
  rounded up to whole packs, raised to the minimum order, capped by storage
  capacity. IP ≤ reorder point = **reorder now**. Usable = active, unexpired
  batches minus held units (disputed items are never in stock); confirmed
  incoming = in-transit shipments + submitted orders the warehouse has accepted
  (a live fulfilment: allocated, picking or ready). Orders the warehouse has not
  accepted are shown as *awaiting warehouse* and not counted. Each product
  shows a one-line reason for its recommendation.
  Safety stock: service level `z × daily sd × √(L+R)`, days of cover, or fixed units.
  Every recommendation stores its inputs and a step-by-step explanation; staff
  accept, edit or reject it (recorded).
- **Actual vs estimated**: for each recent day, the moving average of the
  window before it compared with what was sold (MAE, RMSE, bias). Measured on
  recorded sales only; shown only with enough history.
- **Demand model** (trained when staff press **Recalculate**, stored with
  that run in `pharmacy_forecast_runs.summary.model`; the live pages apply
  the latest run's model):
  - target: next-day units sold; features: previous day, same day last week,
    7-day mean (each divided by the product's own 28-day mean, so one model
    fits all products) and day of week. Features use only earlier days; stock
    is never a feature; days that ended out of stock are not targets.
  - least squares with a small ridge penalty (λ = 1), forecast day by day for
    30 days, never negative.
  - evaluation: the last 28 days are held out; the model (fitted on the days
    before) and the 28-day moving average predict each held-out day one step
    ahead; MAE and RMSE in dispensing units/day. A product uses the regression
    only if it was more accurate there (≥ 14 held-out days); safety stock then
    uses the regression's held-out error.
  - data: real POS history once it covers ≥ 90 days; until then the labelled
    sample history (`synthetic_seed`), shown as a demonstration, not
    real-world accuracy. `npm run train:pharmacy-model` prints the report
    without writing anything.
- **Alerts**: low stock, reorder (critical when stock will not last the lead
  time), near expiry, expired, unusual consumption. Recomputed after sales,
  receipts and returns and on demand; cleared automatically.

> The optional seed adds 180 days of **synthetic** sales
> (`sales.source = 'synthetic_seed'`) so the analytics have something to show.
> Pages that use them say so. Before evaluation, run
> `supabase/seed/remove_synthetic_history.sql`: it deletes the synthetic sales
> and their stock movements, keeps current stock and real transactions, and
> adds one opening balance per batch so the ledger still adds up (tested in
> PGlite). Then recalculate. The full sample cleanup is at the bottom of the seed.

## API (backend; `Authorization: Bearer <Supabase access token>`)

| Method & path | Who | Purpose |
|---|---|---|
| `GET /api/pharmacy/context` | any | role, pharmacies, toolbar counts |
| `GET /api/pharmacy/dashboard` | pharmacy | KPIs, trend, alerts, reorder-now list |
| `GET /api/pharmacy/inventory` · `/lookup?code=` · `/products/:id` | pharmacy | stock by batch · barcode/batch/QR/name → product + FEFO batches · product details, ledger, discrepancies |
| `POST /api/pharmacy/inventory/adjust` | admin | stock count correction |
| `GET` · `POST /api/pharmacy/orders` · `GET /:id` · `POST /:id/cancel` | pharmacy | orders (warehouse staff may read); POST refused (409) above the warehouse's stock |
| `GET /api/pharmacy/orders/warehouse-stock` | pharmacy | packs per product the pharmacy can order from its warehouse |
| `GET /api/pharmacy/shipments` · `/:id` | pharmacy | shipments with order, items, reports |
| `POST /api/pharmacy/shipments/:id/receive` | pharmacy | Confirm Receipt (`{ acceptPartial }`), idempotent |
| `POST /api/pharmacy/shipments/:id/items/:itemId/accept` | pharmacy | accept a held item after resolution |
| `GET` · `POST /api/pharmacy/discrepancies` | pharmacy | list / report (`clientRequestId`); response includes `heldUnits` |
| `POST /api/pharmacy/discrepancies/:id/hold` | pharmacy | `{ outcome: "release"|"write_off" }` after the warehouse resolved the report; idempotent |
| `GET` · `POST /api/pharmacy/sales` · `GET /:id` | pharmacy | sales / checkout / receipt |
| `GET` · `POST /api/pharmacy/returns` · `GET /:id` | pharmacy | returns |
| `GET /api/pharmacy/analytics` · `/products/:id` · `/research` · `POST /run` | pharmacy | analytics, recalculate |
| `GET /api/pharmacy/recommendations` · `POST /:id/reject` | pharmacy | Q* list / reject |
| `GET /api/pharmacy/alerts` · `POST /refresh` · `POST /:id/acknowledge|resolve` | pharmacy | alerts |
| `GET /api/pharmacy/settings` · `PATCH /defaults|profile` · `PUT|DELETE /reorder/:id` | pharmacy (profile: admin) | settings |
| `/api/pharmacy/admin/users|pharmacies|products|barcodes` | admin | access and catalogue |

## Warehouse integration contract

The warehouse application works on the shared tables and may call these
functions with its service role:

| Function | Purpose |
|---|---|
| `pharmacy_dispatch_order(order, user, items?, notes?, today?, min_shelf_days?)` | FEFO pick from warehouse stock (via `record_inventory_movement`), creates the shipment |
| `pharmacy_update_discrepancy(report, user, 'acknowledged'|'resolved', notes)` | acknowledge / resolve a report |
| `pharmacy_review_return(return, user, 'approve'|'reject', notes)` | idempotent review |
| `pharmacy_receive_return(return, user, restock?, notes?, today?)` | idempotent receipt; deducts pharmacy stock once |
| `pharmacy_cancel_order(order, user, reason, pharmacy?)` | decline a submitted order |

No other component implements the warehouse side yet, so orders, reports and
returns waiting for the warehouse stay open until it does. Held units are
settled by the **pharmacy** (`pharmacy_settle_discrepancy_hold`) once the
warehouse has resolved the report; the warehouse only resolves it.

## Setup

1. In the Supabase SQL editor, run in order (after the earlier migrations):
   `20261010000000_create_pharmacy_schema.sql`,
   `20261010000001_create_pharmacy_functions.sql`,
   `20261012000000_update_pharmacy_receiving.sql`,
   `20261016000000_pharmacy_inventory_holds.sql`,
   `20261020000000_pharmacy_linear_regression_model.sql`.
2. Optional sample data: `supabase/seed/sample_warehouse.sql`, then
   `supabase/seed/sample_pharmacy.sql` (cleanup SQL at the bottom).
3. Assign roles in Settings → Users and access (or SQL on `profiles`).
4. Backend: `cd backend && npm install && npm run dev` (see `backend/.env.example`).
5. Frontend: `cd frontend && npm install && npm run dev` → **Pharmacy** in the sidebar.
6. Analytics → **Recalculate recommendations** (or set `PHARMACY_FORECAST_INTERVAL_HOURS`).

## Tests

```bash
cd backend && npm test        # unit, access, database (PGlite) and concurrency (embedded PostgreSQL) tests
cd frontend && npm run lint && npm run build
```

- `test/pharmacy/analytics.test.js`: burn rate, stock cover, moving average,
  actual vs estimated, Q* formulas and constraints, FEFO order, alert rules.
- `test/pharmacy/database.test.mjs`: every migration and seed in PGlite;
  idempotent receipt, disputed items held, partial receipt, settlement after
  resolution, discrepancy validation and duplicate submissions, unknown
  items, checkout, FEFO compliance, returns (incl. idempotent acceptance),
  discrepancy holds after acceptance (hold, release, write-off, backfill),
  ledger consistency, RLS per role, and the synthetic-history removal script.
- `test/pharmacy/concurrency.test.mjs`: a real PostgreSQL 17 server
  (embedded-postgres) with 8 parallel connections: no overselling, one sale
  per request id, one receipt, one discrepancy per request id, one return
  transfer, one write-off of a held report. Skipped if the embedded server
  cannot start on the machine.
- `test/pharmacy/stock.test.js`: usable stock in the analytics excludes held units.
- `test/pharmacy/linear-regression.test.js`: least squares, no look-ahead in
  features, out-of-stock days excluded, chronological holdout vs the moving
  average, non-negative forecast, provider fallback, recommendation reason.

## Limitations

- One shipment per order; one pharmacy per staff account.
- Excess packs beyond the shipped quantity are never accepted by the pharmacy app.
- Returns restock whole warehouse packs only.
- The demand model is a small linear regression (day of week and recent
  demand); it does not model events or long-term trends. Until real POS
  history exists it is trained on sample data, so its accuracy figures
  describe the sample generator, not real demand. The provider interface is
  where a Python ai-service model could replace it.
