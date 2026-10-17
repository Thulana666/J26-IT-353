-- Component 4: Intelligent Pharmacy Analytics & Stock Optimization - schema.
--
-- Reuses shared tables (additive changes only):
--   profiles    + roles 'pharmacy_staff' / 'warehouse_staff', + pharmacy_id
--   medicines   product master data   + brand, manufacturer, pack size, prices
--   batches     product batches (batch number, manufacture and expiry dates)
--   warehouses  the warehouse that supplies a pharmacy
--
-- Units: warehouse stock, orders and shipments are counted in warehouse packs
-- (medicines.unit, e.g. carton). Pharmacy stock, sales and returns are counted
-- in dispensing units (medicines.dispensing_unit, e.g. strip).
-- medicines.units_per_pack converts one into the other.
--
-- Names: the research spec's `products` / `product_batches` are the shared
-- `medicines` / `batches`; `demand_forecasts` and `alerts` are prefixed with
-- `pharmacy_` because Component 1 reserves `demand_forecasts` and other
-- components are likely to need their own alerts.
--
-- Access model:
--   * Admins read everything. Pharmacy staff read their own pharmacy's rows.
--     Warehouse staff read orders, shipments, discrepancies and returns of
--     every pharmacy (what they need to fulfil them), not sales or stock.
--   * Nothing is writable from the browser. The backend (service role)
--     checks roles and writes; stock changes only through the functions in
--     20261010000001_create_pharmacy_functions.sql.

-- ---------------------------------------------------------------------------
-- Roles and pharmacies
-- ---------------------------------------------------------------------------

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin', 'user', 'pharmacy_staff', 'warehouse_staff'));

create table if not exists public.pharmacies (
  id                         uuid primary key default gen_random_uuid(),
  code                       text not null unique,
  name                       text not null,
  -- Warehouse that receives this pharmacy's orders and returns.
  warehouse_id               uuid references public.warehouses (id) on delete set null,
  location_id                uuid references public.locations (id) on delete set null,
  address                    text,
  phone                      text,
  license_number             text,
  -- Defaults for products without their own reorder_settings row.
  default_lead_time_days     integer not null default 3 check (default_lead_time_days between 0 and 90),
  default_review_period_days integer not null default 7 check (default_review_period_days between 1 and 90),
  default_service_level      numeric(4, 3) not null default 0.95
                             check (default_service_level >= 0.5 and default_service_level < 1),
  -- Days of sales history used for the burn rate.
  burn_rate_window_days      integer not null default 28 check (burn_rate_window_days between 7 and 365),
  near_expiry_days           integer not null default 90 check (near_expiry_days between 1 and 730),
  -- Billing: tax is added after the discount; staff may discount up to the maximum.
  tax_rate_percent           numeric(5, 2) not null default 0 check (tax_rate_percent between 0 and 100),
  max_discount_percent       numeric(5, 2) not null default 10 check (max_discount_percent between 0 and 100),
  currency                   char(3) not null default 'LKR',
  is_active                  boolean not null default true,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

-- Pharmacy staff belong to one pharmacy (admins may also have one as default).
alter table public.profiles
  add column if not exists pharmacy_id uuid references public.pharmacies (id) on delete set null;
create index if not exists profiles_pharmacy_id_idx on public.profiles (pharmacy_id);

-- ---------------------------------------------------------------------------
-- Product master data (shared medicines) and barcodes
-- ---------------------------------------------------------------------------

alter table public.medicines
  add column if not exists brand_name      text,
  add column if not exists manufacturer    text,
  -- What a pharmacy sells one of, e.g. 'strip of 10 tablets'. Null = unit.
  add column if not exists dispensing_unit text,
  -- Dispensing units in one warehouse pack (medicines.unit).
  add column if not exists units_per_pack  integer not null default 1,
  -- Per dispensing unit. Copied onto shipment items at dispatch, so a later
  -- price change does not alter stock already delivered.
  add column if not exists unit_cost       numeric(12, 2),
  add column if not exists retail_price    numeric(12, 2);

alter table public.medicines
  drop constraint if exists medicines_units_per_pack_check,
  add constraint medicines_units_per_pack_check check (units_per_pack > 0),
  drop constraint if exists medicines_unit_cost_check,
  add constraint medicines_unit_cost_check check (unit_cost is null or unit_cost >= 0),
  drop constraint if exists medicines_retail_price_check,
  add constraint medicines_retail_price_check check (retail_price is null or retail_price >= 0);

create table if not exists public.product_barcodes (
  id              uuid primary key default gen_random_uuid(),
  medicine_id     uuid not null references public.medicines (id) on delete cascade,
  barcode         text not null unique
                  check (barcode = btrim(barcode) and length(barcode) between 3 and 128),
  symbology       text not null default 'EAN13'
                  check (symbology in ('EAN13', 'EAN8', 'UPCA', 'CODE128', 'GS1_DATAMATRIX', 'QR', 'INTERNAL')),
  -- unit: printed on a dispensing unit; pack: printed on a warehouse pack.
  packaging_level text not null default 'unit' check (packaging_level in ('unit', 'pack')),
  is_primary      boolean not null default false,
  created_at      timestamptz not null default now()
);

create index if not exists product_barcodes_medicine_idx on public.product_barcodes (medicine_id);

-- ---------------------------------------------------------------------------
-- Pharmacy stock (by pharmacy, product and batch)
-- ---------------------------------------------------------------------------

-- Rows are never deleted: a sold-out batch keeps its row with quantity 0.
create table if not exists public.pharmacy_inventory (
  id                uuid primary key default gen_random_uuid(),
  pharmacy_id       uuid not null references public.pharmacies (id) on delete restrict,
  batch_id          uuid not null references public.batches (id) on delete restrict,
  -- Always the batch's medicine (set by trigger).
  medicine_id       uuid not null references public.medicines (id) on delete restrict,
  -- Dispensing units physically in the pharmacy, including reserved ones.
  quantity_on_hand  integer not null default 0 check (quantity_on_hand >= 0),
  -- Units held for pending/approved returns: still on hand, not sellable.
  quantity_reserved integer not null default 0 check (quantity_reserved >= 0),
  unit_cost         numeric(12, 2) check (unit_cost is null or unit_cost >= 0),
  -- Selling price per dispensing unit; the POS never trusts a client price.
  unit_price        numeric(12, 2) check (unit_price is null or unit_price >= 0),
  first_received_at timestamptz,
  last_received_at  timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (pharmacy_id, batch_id),
  check (quantity_reserved <= quantity_on_hand)
);

create index if not exists pharmacy_inventory_medicine_idx on public.pharmacy_inventory (pharmacy_id, medicine_id);
create index if not exists pharmacy_inventory_batch_idx on public.pharmacy_inventory (batch_id);

-- ---------------------------------------------------------------------------
-- Orders, shipments and discrepancies (pharmacy <-> warehouse)
-- ---------------------------------------------------------------------------

create sequence if not exists public.purchase_order_number_seq;
create sequence if not exists public.shipment_number_seq;
create sequence if not exists public.discrepancy_number_seq;
create sequence if not exists public.sale_number_seq;
create sequence if not exists public.return_number_seq;

create table if not exists public.purchase_orders (
  id            uuid primary key default gen_random_uuid(),
  order_number  text not null unique
                default 'PO-' || lpad(nextval('public.purchase_order_number_seq')::text, 6, '0'),
  pharmacy_id   uuid not null references public.pharmacies (id) on delete restrict,
  warehouse_id  uuid references public.warehouses (id) on delete set null,
  status        text not null default 'submitted'
                check (status in ('submitted', 'dispatched', 'received', 'cancelled')),
  notes         text check (length(notes) <= 1000),
  created_by    uuid references auth.users (id) on delete set null,
  submitted_at  timestamptz not null default now(),
  dispatched_at timestamptz,
  received_at   timestamptz,
  cancelled_at  timestamptz,
  cancelled_by  uuid references auth.users (id) on delete set null,
  cancel_reason text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists purchase_orders_pharmacy_idx on public.purchase_orders (pharmacy_id, created_at desc);
create index if not exists purchase_orders_status_idx on public.purchase_orders (status, created_at desc);

-- Forecast runs, forecasts and recommendations are defined here because order
-- items link to the recommendation they came from (acceptance tracking).
create table if not exists public.pharmacy_forecast_runs (
  id            uuid primary key default gen_random_uuid(),
  pharmacy_id   uuid not null references public.pharmacies (id) on delete cascade,
  status        text not null default 'running' check (status in ('running', 'completed', 'failed')),
  -- ai_service: Python models; baseline_fallback: backend moving average only.
  engine        text not null check (engine in ('ai_service', 'baseline_fallback')),
  history_start date,
  history_end   date,
  horizon_days  integer not null check (horizon_days between 1 and 180),
  test_days     integer check (test_days >= 0),
  product_count integer,
  -- Per product: hold-out MAE/RMSE of every model and the selected one.
  evaluation    jsonb not null default '[]'::jsonb,
  summary       jsonb not null default '{}'::jsonb,
  -- E.g. share of synthetic (seeded) sales in the training data.
  data_note     text,
  error_message text,
  triggered_by  uuid references auth.users (id) on delete set null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);

create index if not exists pharmacy_forecast_runs_pharmacy_idx
  on public.pharmacy_forecast_runs (pharmacy_id, started_at desc);

create table if not exists public.pharmacy_demand_forecasts (
  id                 uuid primary key default gen_random_uuid(),
  run_id             uuid not null references public.pharmacy_forecast_runs (id) on delete cascade,
  pharmacy_id        uuid not null references public.pharmacies (id) on delete cascade,
  medicine_id        uuid not null references public.medicines (id) on delete cascade,
  forecast_date      date not null,
  -- Dispensing units.
  predicted_quantity numeric(12, 3) not null check (predicted_quantity >= 0),
  lower_quantity     numeric(12, 3),
  upper_quantity     numeric(12, 3),
  model_name         text not null check (model_name in ('moving_average', 'random_forest', 'xgboost')),
  -- True when there was too little history to validate the model.
  is_provisional     boolean not null default false,
  created_at         timestamptz not null default now(),
  unique (run_id, medicine_id, forecast_date)
);

create index if not exists pharmacy_demand_forecasts_lookup_idx
  on public.pharmacy_demand_forecasts (pharmacy_id, medicine_id, forecast_date);

-- Practical periodic-review reorder policy (not the classical EOQ formula):
--   inventory position = usable on hand + confirmed incoming - reserved
--   reorder point      = forecast demand during lead time + safety stock
--   target stock       = forecast demand during lead time + review period + safety stock
--   recommended Q*     = max(0, target stock - inventory position), then pack
--                        size, minimum order and storage capacity constraints.
create table if not exists public.reorder_recommendations (
  id                    uuid primary key default gen_random_uuid(),
  run_id                uuid references public.pharmacy_forecast_runs (id) on delete set null,
  pharmacy_id           uuid not null references public.pharmacies (id) on delete cascade,
  medicine_id           uuid not null references public.medicines (id) on delete cascade,
  model_name            text not null,
  is_provisional        boolean not null default false,
  -- Dispensing units per day / units.
  burn_rate             numeric(12, 3),
  forecast_daily_demand numeric(12, 3) not null,
  lead_time_days        integer not null,
  review_period_days    integer not null,
  lead_time_demand      numeric(12, 2) not null,
  review_period_demand  numeric(12, 2) not null,
  safety_stock          numeric(12, 2) not null,
  reorder_point         numeric(12, 2) not null,
  target_stock          numeric(12, 2) not null,
  on_hand_usable        integer not null,
  reserved              integer not null,
  incoming              integer not null,
  inventory_position    numeric(12, 2) not null,
  days_of_cover         numeric(10, 1),
  projected_stockout_date date,
  stockout_risk         text not null check (stockout_risk in ('none', 'low', 'medium', 'high')),
  -- Units expected to expire before they can be sold (FEFO simulation).
  expiry_risk_units     integer not null default 0,
  needs_reorder         boolean not null,
  raw_quantity          numeric(12, 2) not null,
  recommended_units     integer not null check (recommended_units >= 0),
  recommended_packs     integer not null check (recommended_packs >= 0),
  constraints_applied   jsonb not null default '[]'::jsonb,
  explanation           text not null,
  assumptions           jsonb not null default '{}'::jsonb,
  status                text not null default 'pending'
                        check (status in ('pending', 'accepted', 'edited', 'rejected', 'superseded')),
  decided_packs         integer check (decided_packs >= 0),
  decided_by            uuid references auth.users (id) on delete set null,
  decided_at            timestamptz,
  decision_notes        text,
  order_id              uuid references public.purchase_orders (id) on delete set null,
  generated_at          timestamptz not null default now()
);

create index if not exists reorder_recommendations_pharmacy_idx
  on public.reorder_recommendations (pharmacy_id, status, generated_at desc);
create unique index if not exists reorder_recommendations_one_pending
  on public.reorder_recommendations (pharmacy_id, medicine_id) where status = 'pending';

create table if not exists public.purchase_order_items (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references public.purchase_orders (id) on delete cascade,
  -- Copy of the order's pharmacy, for row level security and realtime filters.
  pharmacy_id       uuid not null references public.pharmacies (id) on delete restrict,
  medicine_id       uuid not null references public.medicines (id) on delete restrict,
  -- Warehouse packs.
  quantity_ordered  integer not null check (quantity_ordered > 0),
  recommendation_id uuid references public.reorder_recommendations (id) on delete set null,
  notes             text,
  created_at        timestamptz not null default now(),
  unique (order_id, medicine_id)
);

create index if not exists purchase_order_items_medicine_idx on public.purchase_order_items (pharmacy_id, medicine_id);

-- One shipment per order.
create table if not exists public.shipments (
  id              uuid primary key default gen_random_uuid(),
  shipment_number text not null unique
                  default 'SH-' || lpad(nextval('public.shipment_number_seq')::text, 6, '0'),
  order_id        uuid not null unique references public.purchase_orders (id) on delete restrict,
  pharmacy_id     uuid not null references public.pharmacies (id) on delete restrict,
  warehouse_id    uuid references public.warehouses (id) on delete set null,
  status          text not null default 'in_transit'
                  check (status in ('in_transit', 'received', 'received_with_discrepancies')),
  dispatched_by   uuid references auth.users (id) on delete set null,
  dispatched_at   timestamptz not null default now(),
  received_by     uuid references auth.users (id) on delete set null,
  received_at     timestamptz,
  notes           text,
  receipt_notes   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists shipments_pharmacy_idx on public.shipments (pharmacy_id, dispatched_at desc);
create index if not exists shipments_status_idx on public.shipments (status);

create table if not exists public.shipment_items (
  id                  uuid primary key default gen_random_uuid(),
  shipment_id         uuid not null references public.shipments (id) on delete cascade,
  pharmacy_id         uuid not null references public.pharmacies (id) on delete restrict,
  order_item_id       uuid references public.purchase_order_items (id) on delete set null,
  medicine_id         uuid not null references public.medicines (id) on delete restrict,
  batch_id            uuid not null references public.batches (id) on delete restrict,
  -- Warehouse packs. The pharmacy counts packs; accepted packs become
  -- accepted x units_per_pack dispensing units of stock.
  quantity_shipped    integer not null check (quantity_shipped > 0),
  units_per_pack      integer not null check (units_per_pack > 0),
  quantity_received   integer check (quantity_received >= 0),
  quantity_damaged    integer check (quantity_damaged >= 0),
  quantity_accepted   integer check (quantity_accepted >= 0),
  -- Per dispensing unit, copied from medicines at dispatch.
  unit_cost           numeric(12, 2),
  unit_price          numeric(12, 2),
  verification_status text not null default 'pending'
                      check (verification_status in ('pending', 'matched', 'discrepancy')),
  -- Barcode scans counted for this item when it was received.
  scan_count          integer not null default 0 check (scan_count >= 0),
  verified_at         timestamptz,
  created_at          timestamptz not null default now(),
  unique (shipment_id, batch_id),
  check (quantity_damaged is null or quantity_received is null or quantity_damaged <= quantity_received),
  check (quantity_accepted is null or quantity_accepted <= quantity_shipped)
);

create index if not exists shipment_items_shipment_idx on public.shipment_items (shipment_id);

create table if not exists public.shipment_discrepancies (
  id                    uuid primary key default gen_random_uuid(),
  report_number         text not null unique
                        default 'DR-' || lpad(nextval('public.discrepancy_number_seq')::text, 6, '0'),
  shipment_id           uuid not null references public.shipments (id) on delete restrict,
  shipment_item_id      uuid references public.shipment_items (id) on delete set null,
  order_id              uuid not null references public.purchase_orders (id) on delete restrict,
  pharmacy_id           uuid not null references public.pharmacies (id) on delete restrict,
  medicine_id           uuid references public.medicines (id) on delete set null,
  batch_id              uuid references public.batches (id) on delete set null,
  -- What staff actually found, for items that are not in the shipment.
  observed_barcode      text,
  observed_batch_number text,
  discrepancy_type      text not null
                        check (discrepancy_type in ('missing', 'excess', 'damaged', 'incorrect_item',
                                                    'incorrect_batch', 'expired', 'other')),
  -- Warehouse packs.
  expected_quantity     integer check (expected_quantity >= 0),
  actual_quantity       integer check (actual_quantity >= 0),
  notes                 text check (length(notes) <= 2000),
  status                text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  resolution_notes      text check (length(resolution_notes) <= 2000),
  reported_by           uuid references auth.users (id) on delete set null,
  reported_at           timestamptz not null default now(),
  acknowledged_by       uuid references auth.users (id) on delete set null,
  acknowledged_at       timestamptz,
  resolved_by           uuid references auth.users (id) on delete set null,
  resolved_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists shipment_discrepancies_pharmacy_idx
  on public.shipment_discrepancies (pharmacy_id, reported_at desc);
create index if not exists shipment_discrepancies_status_idx
  on public.shipment_discrepancies (status, reported_at desc);
create index if not exists shipment_discrepancies_shipment_idx on public.shipment_discrepancies (shipment_id);

-- ---------------------------------------------------------------------------
-- Sales (POS)
-- ---------------------------------------------------------------------------

create table if not exists public.sales (
  id                uuid primary key default gen_random_uuid(),
  sale_number       text not null unique
                    default 'INV-' || lpad(nextval('public.sale_number_seq')::text, 7, '0'),
  pharmacy_id       uuid not null references public.pharmacies (id) on delete restrict,
  -- Idempotency key sent by the POS; a repeated checkout returns the first sale.
  client_request_id uuid,
  -- synthetic_seed: generated history for demos; never real transactions.
  source            text not null default 'pos' check (source in ('pos', 'synthetic_seed')),
  subtotal          numeric(14, 2) not null check (subtotal >= 0),
  discount_percent  numeric(5, 2) not null default 0 check (discount_percent between 0 and 100),
  discount_amount   numeric(14, 2) not null default 0 check (discount_amount >= 0),
  tax_percent       numeric(5, 2) not null default 0 check (tax_percent between 0 and 100),
  tax_amount        numeric(14, 2) not null default 0 check (tax_amount >= 0),
  total_amount      numeric(14, 2) not null check (total_amount >= 0),
  payment_method    text not null default 'cash' check (payment_method in ('cash', 'card', 'mobile', 'other')),
  amount_tendered   numeric(14, 2) check (amount_tendered >= 0),
  change_due        numeric(14, 2) check (change_due >= 0),
  payment_reference text,
  customer_ref      text,
  served_by         uuid references auth.users (id) on delete set null,
  sold_at           timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  unique (pharmacy_id, client_request_id),
  check (total_amount = subtotal - discount_amount + tax_amount)
);

create index if not exists sales_pharmacy_sold_at_idx on public.sales (pharmacy_id, sold_at desc);

create table if not exists public.sale_items (
  id             uuid primary key default gen_random_uuid(),
  sale_id        uuid not null references public.sales (id) on delete cascade,
  pharmacy_id    uuid not null references public.pharmacies (id) on delete restrict,
  inventory_id   uuid not null references public.pharmacy_inventory (id) on delete restrict,
  medicine_id    uuid not null references public.medicines (id) on delete restrict,
  batch_id       uuid not null references public.batches (id) on delete restrict,
  -- Dispensing units.
  quantity       integer not null check (quantity > 0),
  unit_price     numeric(12, 2) not null check (unit_price >= 0),
  line_total     numeric(14, 2) not null check (line_total >= 0),
  -- False when an earlier-expiring sellable batch of the product was left.
  fefo_compliant boolean,
  -- Copy of sales.sold_at for daily demand aggregation.
  sold_at        timestamptz not null,
  created_at     timestamptz not null default now()
);

create index if not exists sale_items_sale_idx on public.sale_items (sale_id);
create index if not exists sale_items_demand_idx on public.sale_items (pharmacy_id, medicine_id, sold_at);

-- ---------------------------------------------------------------------------
-- Stock movement ledger (pharmacy side; the warehouse has inventory_movements)
-- ---------------------------------------------------------------------------

create table if not exists public.stock_movements (
  id              uuid primary key default gen_random_uuid(),
  -- Insertion order; created_at is equal for movements of one transaction.
  entry_no        bigint generated always as identity,
  pharmacy_id     uuid not null references public.pharmacies (id) on delete restrict,
  inventory_id    uuid not null references public.pharmacy_inventory (id) on delete restrict,
  medicine_id     uuid not null references public.medicines (id) on delete restrict,
  batch_id        uuid not null references public.batches (id) on delete restrict,
  movement_type   text not null
                  check (movement_type in ('opening_balance', 'receipt', 'sale', 'return_reserve',
                                           'return_release', 'return_dispatch', 'adjustment')),
  -- Dispensing units. Reservations change reserved, not on hand.
  on_hand_change  integer not null default 0,
  reserved_change integer not null default 0,
  on_hand_after   integer not null check (on_hand_after >= 0),
  reserved_after  integer not null check (reserved_after >= 0),
  reference_type  text check (reference_type in ('shipment', 'sale', 'return_request', 'adjustment', 'seed')),
  reference_id    uuid,
  notes           text,
  performed_by    uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  check (on_hand_change <> 0 or reserved_change <> 0)
);

create index if not exists stock_movements_inventory_idx on public.stock_movements (inventory_id, created_at desc, entry_no desc);
create index if not exists stock_movements_pharmacy_idx on public.stock_movements (pharmacy_id, created_at desc);
create index if not exists stock_movements_medicine_idx on public.stock_movements (pharmacy_id, medicine_id, created_at);

-- ---------------------------------------------------------------------------
-- Returns (pharmacy -> warehouse)
-- ---------------------------------------------------------------------------

create table if not exists public.return_requests (
  id            uuid primary key default gen_random_uuid(),
  return_number text not null unique
                default 'RT-' || lpad(nextval('public.return_number_seq')::text, 6, '0'),
  pharmacy_id   uuid not null references public.pharmacies (id) on delete restrict,
  warehouse_id  uuid references public.warehouses (id) on delete set null,
  -- pending -> approved -> received; pending/approved -> rejected.
  status        text not null default 'pending'
                check (status in ('pending', 'approved', 'rejected', 'received')),
  notes         text check (length(notes) <= 1000),
  requested_by  uuid references auth.users (id) on delete set null,
  requested_at  timestamptz not null default now(),
  reviewed_by   uuid references auth.users (id) on delete set null,
  reviewed_at   timestamptz,
  review_notes  text,
  received_by   uuid references auth.users (id) on delete set null,
  received_at   timestamptz,
  receipt_notes text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists return_requests_pharmacy_idx on public.return_requests (pharmacy_id, requested_at desc);
create index if not exists return_requests_status_idx on public.return_requests (status, requested_at desc);

create table if not exists public.return_items (
  id                    uuid primary key default gen_random_uuid(),
  return_id             uuid not null references public.return_requests (id) on delete cascade,
  pharmacy_id           uuid not null references public.pharmacies (id) on delete restrict,
  inventory_id          uuid not null references public.pharmacy_inventory (id) on delete restrict,
  medicine_id           uuid not null references public.medicines (id) on delete restrict,
  batch_id              uuid not null references public.batches (id) on delete restrict,
  -- Dispensing units.
  quantity              integer not null check (quantity > 0),
  reason                text not null
                        check (reason in ('expired', 'near_expiry', 'damaged', 'recalled', 'overstock',
                                          'incorrect_item', 'other')),
  notes                 text check (length(notes) <= 1000),
  -- Warehouse packs put back into warehouse stock when the return was received.
  restocked_packs       integer check (restocked_packs >= 0),
  warehouse_movement_id uuid references public.inventory_movements (id) on delete set null,
  created_at            timestamptz not null default now()
);

create index if not exists return_items_return_idx on public.return_items (return_id);
create index if not exists return_items_inventory_idx on public.return_items (inventory_id);

-- ---------------------------------------------------------------------------
-- Reorder settings, alerts and audit log
-- ---------------------------------------------------------------------------

-- Per product; null values fall back to the pharmacy defaults.
create table if not exists public.reorder_settings (
  id                  uuid primary key default gen_random_uuid(),
  pharmacy_id         uuid not null references public.pharmacies (id) on delete cascade,
  medicine_id         uuid not null references public.medicines (id) on delete cascade,
  lead_time_days      integer check (lead_time_days between 0 and 90),
  review_period_days  integer check (review_period_days between 1 and 90),
  -- service_level: z x sd(daily demand) x sqrt(lead time);
  -- days_of_cover: safety_stock_days x forecast daily demand;
  -- fixed_units:   safety_stock_units.
  safety_stock_method text not null default 'service_level'
                      check (safety_stock_method in ('service_level', 'days_of_cover', 'fixed_units')),
  service_level       numeric(4, 3) check (service_level >= 0.5 and service_level < 1),
  safety_stock_days   numeric(6, 2) check (safety_stock_days >= 0),
  safety_stock_units  integer check (safety_stock_units >= 0),
  -- Dispensing units; null = alert at the reorder point.
  low_stock_threshold integer check (low_stock_threshold >= 0),
  -- Minimum order quantity in warehouse packs.
  min_order_packs     integer not null default 1 check (min_order_packs >= 1),
  -- Storage capacity in dispensing units (null = unlimited).
  max_stock_units     integer check (max_stock_units > 0),
  -- False: no reorder recommendations for this product.
  is_active           boolean not null default true,
  updated_by          uuid references auth.users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (pharmacy_id, medicine_id)
);

create table if not exists public.pharmacy_alerts (
  id              uuid primary key default gen_random_uuid(),
  pharmacy_id     uuid not null references public.pharmacies (id) on delete cascade,
  medicine_id     uuid references public.medicines (id) on delete cascade,
  batch_id        uuid references public.batches (id) on delete cascade,
  alert_type      text not null
                  check (alert_type in ('low_stock', 'predicted_stockout', 'near_expiry', 'expired',
                                        'unusual_consumption')),
  severity        text not null check (severity in ('info', 'warning', 'critical')),
  title           text not null,
  message         text not null,
  details         jsonb not null default '{}'::jsonb,
  -- Identifies the condition, e.g. 'low_stock:<medicine id>'; one active alert per key.
  dedupe_key      text not null,
  status          text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  acknowledged_by uuid references auth.users (id) on delete set null,
  acknowledged_at timestamptz,
  resolved_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists pharmacy_alerts_active_key
  on public.pharmacy_alerts (pharmacy_id, dedupe_key) where status <> 'resolved';
create index if not exists pharmacy_alerts_pharmacy_idx on public.pharmacy_alerts (pharmacy_id, status, created_at desc);

create table if not exists public.audit_logs (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references auth.users (id) on delete set null,
  pharmacy_id uuid references public.pharmacies (id) on delete set null,
  module      text not null default 'pharmacy',
  action      text not null,
  entity_type text not null,
  entity_id   uuid,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists audit_logs_pharmacy_idx on public.audit_logs (pharmacy_id, created_at desc);
create index if not exists audit_logs_entity_idx on public.audit_logs (entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- Stock read model
-- ---------------------------------------------------------------------------

create or replace view public.pharmacy_inventory_overview
with (security_invoker = true) as
select
  i.id                                         as inventory_id,
  i.pharmacy_id,
  i.quantity_on_hand,
  i.quantity_reserved,
  (i.quantity_on_hand - i.quantity_reserved)   as quantity_available,
  i.unit_cost,
  i.unit_price,
  i.first_received_at,
  i.last_received_at,
  i.updated_at,
  b.id                                         as batch_id,
  b.batch_number,
  b.manufacturing_date,
  b.expiry_date,
  b.status                                     as batch_status,
  b.supplier,
  m.id                                         as medicine_id,
  m.name                                       as medicine_name,
  m.generic_name,
  m.brand_name,
  m.manufacturer,
  m.strength,
  m.dosage_form,
  m.dispensing_unit,
  m.unit                                       as pack_unit,
  m.units_per_pack,
  m.storage_condition,
  m.is_controlled,
  m.medicine_category_id
from public.pharmacy_inventory i
join public.batches b on b.id = i.batch_id
join public.medicines m on m.id = i.medicine_id;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

-- Rows that carry both batch_id and medicine_id always use the batch's medicine.
create or replace function public.set_medicine_from_batch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  select b.medicine_id into new.medicine_id from public.batches b where b.id = new.batch_id;
  if new.medicine_id is null then
    raise exception 'Batch not found' using errcode = 'P0002';
  end if;
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['pharmacy_inventory', 'shipment_items', 'sale_items', 'stock_movements', 'return_items']
  loop
    execute format('drop trigger if exists %1$s_set_medicine on public.%1$I', t);
    execute format(
      'create trigger %1$s_set_medicine before insert or update of batch_id, medicine_id on public.%1$I
         for each row execute function public.set_medicine_from_batch()', t);
  end loop;

  foreach t in array array['pharmacies', 'pharmacy_inventory', 'purchase_orders', 'shipments',
                           'shipment_discrepancies', 'return_requests', 'reorder_settings', 'pharmacy_alerts']
  loop
    execute format('drop trigger if exists %1$s_set_updated_at on public.%1$I', t);
    execute format(
      'create trigger %1$s_set_updated_at before update on public.%1$I
         for each row execute function public.set_updated_at()', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

-- Helpers read profiles regardless of the caller's own RLS (security definer).

-- Admin, or pharmacy staff of this pharmacy (active accounts only).
create or replace function public.can_access_pharmacy(p_pharmacy_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and status = 'active'
      and (role = 'admin' or (role = 'pharmacy_staff' and pharmacy_id = p_pharmacy_id))
  );
$$;

-- Active warehouse staff or admin.
create or replace function public.is_warehouse_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and status = 'active'
      and role in ('admin', 'warehouse_staff')
  );
$$;

grant execute on function public.can_access_pharmacy(uuid) to authenticated, service_role;
grant execute on function public.is_warehouse_staff() to authenticated, service_role;

do $$
declare
  t text;
begin
  -- Pharmacy-only data: admins and the pharmacy's own staff.
  foreach t in array array['pharmacy_inventory', 'sales', 'sale_items', 'stock_movements', 'reorder_settings',
                           'pharmacy_forecast_runs', 'pharmacy_demand_forecasts', 'reorder_recommendations',
                           'pharmacy_alerts']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "Pharmacy staff can read their pharmacy" on public.%I', t);
    execute format(
      'create policy "Pharmacy staff can read their pharmacy" on public.%I
         for select to authenticated using (public.can_access_pharmacy(pharmacy_id))', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;

  -- Shared with the warehouse: orders, shipments, discrepancies, returns.
  foreach t in array array['purchase_orders', 'purchase_order_items', 'shipments', 'shipment_items',
                           'shipment_discrepancies', 'return_requests', 'return_items']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "Pharmacy and warehouse staff can read" on public.%I', t);
    execute format(
      'create policy "Pharmacy and warehouse staff can read" on public.%I
         for select to authenticated
         using (public.can_access_pharmacy(pharmacy_id) or public.is_warehouse_staff())', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end;
$$;

alter table public.pharmacies enable row level security;
drop policy if exists "Staff can read their pharmacies" on public.pharmacies;
create policy "Staff can read their pharmacies" on public.pharmacies
  for select to authenticated
  using (public.can_access_pharmacy(id) or public.is_warehouse_staff());
grant select on public.pharmacies to authenticated;
grant all on public.pharmacies to service_role;

-- Barcodes are catalogue data like medicines: everyone signed in reads,
-- active admins write.
alter table public.product_barcodes enable row level security;
drop policy if exists "Authenticated users can read" on public.product_barcodes;
create policy "Authenticated users can read" on public.product_barcodes
  for select to authenticated using (true);
drop policy if exists "Admins can write" on public.product_barcodes;
create policy "Admins can write" on public.product_barcodes
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
grant select, insert, update, delete on public.product_barcodes to authenticated;
grant all on public.product_barcodes to service_role;

alter table public.audit_logs enable row level security;
drop policy if exists "Admins and pharmacy staff can read" on public.audit_logs;
create policy "Admins and pharmacy staff can read" on public.audit_logs
  for select to authenticated
  using ((select public.is_admin()) or public.can_access_pharmacy(pharmacy_id));
grant select on public.audit_logs to authenticated;
grant all on public.audit_logs to service_role;

grant select on public.pharmacy_inventory_overview to authenticated, service_role;

grant usage, select on sequence
  public.purchase_order_number_seq, public.shipment_number_seq, public.discrepancy_number_seq,
  public.sale_number_seq, public.return_number_seq
to service_role;

-- The backend (service role) updates profiles from the Settings page
-- (role, pharmacy, status). The profiles migration granted it read only.
grant update (role, status, pharmacy_id, full_name) on public.profiles to service_role;

-- ---------------------------------------------------------------------------
-- Realtime: pages refresh when these change (RLS still applies per user).
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['purchase_orders', 'shipments', 'shipment_discrepancies', 'return_requests',
                             'pharmacy_inventory', 'pharmacy_alerts', 'sales', 'reorder_recommendations']
    loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end;
$$;
