-- Component 4 update: disputed / damaged stock is held out of available stock.
--
-- pharmacy_inventory.quantity_held: units on hand that may not be sold or
-- returned because a discrepancy report disputes them, e.g. a problem found
-- after the shipment item was already accepted into stock.
--   available = quantity_on_hand - quantity_reserved - quantity_held
-- A report on an accepted item holds its disputed units in the same
-- transaction. After the warehouse has resolved the report, staff release the
-- units (they are fine) or write them off (missing or unusable). Each report's
-- hold is tracked in the stock ledger (reference_type 'discrepancy'), so a
-- second release or write-off changes nothing.
--
-- Also: existing unresolved reports made after acceptance get their hold
-- (backfill), and shipment_items is published for Realtime.
--
-- Backward compatible: adds columns, allowed check values, a view column and
-- functions. Shared tables (purchase_orders, shipments, shipment_discrepancies,
-- return_requests) are not altered.

-- ---------------------------------------------------------------------------
-- Columns and constraints (Component 4 tables only)
-- ---------------------------------------------------------------------------

alter table public.pharmacy_inventory
  add column if not exists quantity_held integer not null default 0;
alter table public.pharmacy_inventory
  drop constraint if exists pharmacy_inventory_quantity_held_check,
  add constraint pharmacy_inventory_quantity_held_check check (quantity_held >= 0),
  drop constraint if exists pharmacy_inventory_reserved_held_check,
  add constraint pharmacy_inventory_reserved_held_check check (quantity_reserved + quantity_held <= quantity_on_hand);

comment on column public.pharmacy_inventory.quantity_held is
  'Units on hand held by discrepancy reports (disputed, damaged, missing): not sellable or returnable until released or written off.';

alter table public.stock_movements
  add column if not exists held_change integer not null default 0,
  add column if not exists held_after integer not null default 0;
alter table public.stock_movements
  drop constraint if exists stock_movements_held_after_check,
  add constraint stock_movements_held_after_check check (held_after >= 0),
  drop constraint if exists stock_movements_movement_type_check,
  add constraint stock_movements_movement_type_check
    check (movement_type in ('opening_balance', 'receipt', 'sale', 'return_reserve', 'return_release', 'return_dispatch',
                             'adjustment', 'discrepancy_hold', 'discrepancy_release', 'discrepancy_write_off')),
  drop constraint if exists stock_movements_reference_type_check,
  add constraint stock_movements_reference_type_check
    check (reference_type in ('shipment', 'sale', 'return_request', 'adjustment', 'seed', 'discrepancy'));

-- The original "something changed" check did not know about holds.
do $$
declare
  v_name text;
begin
  for v_name in
    select conname from pg_constraint
    where conrelid = 'public.stock_movements'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%on_hand_change <> 0%'
      and pg_get_constraintdef(oid) not like '%held_change%'
  loop
    execute format('alter table public.stock_movements drop constraint %I', v_name);
  end loop;
end;
$$;
alter table public.stock_movements
  drop constraint if exists stock_movements_change_check,
  add constraint stock_movements_change_check check (on_hand_change <> 0 or reserved_change <> 0 or held_change <> 0);

create index if not exists stock_movements_reference_idx on public.stock_movements (reference_type, reference_id);

-- Stock read model: available now excludes held units; quantity_held added at the end.
create or replace view public.pharmacy_inventory_overview
with (security_invoker = true) as
select
  i.id                                                           as inventory_id,
  i.pharmacy_id,
  i.quantity_on_hand,
  i.quantity_reserved,
  (i.quantity_on_hand - i.quantity_reserved - i.quantity_held)  as quantity_available,
  i.unit_cost,
  i.unit_price,
  i.first_received_at,
  i.last_received_at,
  i.updated_at,
  b.id                                                           as batch_id,
  b.batch_number,
  b.manufacturing_date,
  b.expiry_date,
  b.status                                                       as batch_status,
  b.supplier,
  m.id                                                           as medicine_id,
  m.name                                                         as medicine_name,
  m.generic_name,
  m.brand_name,
  m.manufacturer,
  m.strength,
  m.dosage_form,
  m.dispensing_unit,
  m.unit                                                         as pack_unit,
  m.units_per_pack,
  m.storage_condition,
  m.is_controlled,
  m.medicine_category_id,
  i.quantity_held
from public.pharmacy_inventory i
join public.batches b on b.id = i.batch_id
join public.medicines m on m.id = i.medicine_id;

grant select on public.pharmacy_inventory_overview to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Stock change helper: now also changes held units (last parameter, default 0)
-- ---------------------------------------------------------------------------

drop function if exists public.pharmacy_apply_stock_change(uuid, integer, integer, text, text, uuid, uuid, text, timestamptz);

create or replace function public.pharmacy_apply_stock_change(
  p_inventory_id    uuid,
  p_on_hand_change  integer,
  p_reserved_change integer,
  p_movement_type   text,
  p_reference_type  text,
  p_reference_id    uuid,
  p_user_id         uuid,
  p_notes           text default null,
  p_at              timestamptz default now(),
  p_held_change     integer default 0
)
returns public.pharmacy_inventory
language plpgsql
set search_path = ''
as $$
declare
  v_inv public.pharmacy_inventory;
begin
  select * into v_inv from public.pharmacy_inventory where id = p_inventory_id for update;
  if not found then
    raise exception 'Stock item not found' using errcode = 'P0002';
  end if;

  if v_inv.quantity_on_hand + p_on_hand_change < 0 then
    raise exception 'Not enough stock: % unit(s) on hand, % requested',
      v_inv.quantity_on_hand, -p_on_hand_change;
  end if;
  if v_inv.quantity_reserved + p_reserved_change < 0
     or v_inv.quantity_held + p_held_change < 0
     or (v_inv.quantity_reserved + p_reserved_change) + (v_inv.quantity_held + p_held_change)
        > v_inv.quantity_on_hand + p_on_hand_change then
    raise exception 'Stock would be inconsistent (% on hand, % reserved, % held)',
      v_inv.quantity_on_hand + p_on_hand_change, v_inv.quantity_reserved + p_reserved_change,
      v_inv.quantity_held + p_held_change;
  end if;

  update public.pharmacy_inventory
  set quantity_on_hand  = quantity_on_hand + p_on_hand_change,
      quantity_reserved = quantity_reserved + p_reserved_change,
      quantity_held     = quantity_held + p_held_change,
      first_received_at = case when p_movement_type in ('receipt', 'opening_balance')
                               then coalesce(first_received_at, p_at) else first_received_at end,
      last_received_at  = case when p_movement_type in ('receipt', 'opening_balance')
                               then p_at else last_received_at end
  where id = p_inventory_id
  returning * into v_inv;

  insert into public.stock_movements (
    pharmacy_id, inventory_id, medicine_id, batch_id, movement_type,
    on_hand_change, reserved_change, held_change, on_hand_after, reserved_after, held_after,
    reference_type, reference_id, notes, performed_by, created_at
  )
  values (
    v_inv.pharmacy_id, v_inv.id, v_inv.medicine_id, v_inv.batch_id, p_movement_type,
    p_on_hand_change, p_reserved_change, p_held_change, v_inv.quantity_on_hand, v_inv.quantity_reserved, v_inv.quantity_held,
    p_reference_type, p_reference_id, p_notes, p_user_id, p_at
  );

  return v_inv;
end;
$$;

-- ---------------------------------------------------------------------------
-- Availability now excludes held units (same functions, same signatures)
-- ---------------------------------------------------------------------------

create or replace function public.pharmacy_adjust_stock(
  p_pharmacy_id   uuid,
  p_batch_id      uuid,
  p_change        integer,
  p_user_id       uuid,
  p_reason        text,
  p_movement_type text default 'adjustment',
  p_unit_cost     numeric default null,
  p_unit_price    numeric default null,
  p_at            timestamptz default now()
)
returns public.pharmacy_inventory
language plpgsql
set search_path = ''
as $$
declare
  v_inv public.pharmacy_inventory;
begin
  if p_change is null or p_change = 0 then
    raise exception 'The adjustment must change the quantity';
  end if;
  if p_movement_type not in ('adjustment', 'opening_balance') then
    raise exception 'Unsupported adjustment type %', p_movement_type;
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'Give a reason for the stock adjustment';
  end if;
  if not exists (select 1 from public.pharmacies where id = p_pharmacy_id) then
    raise exception 'Pharmacy not found' using errcode = 'P0002';
  end if;

  insert into public.pharmacy_inventory (pharmacy_id, batch_id, medicine_id, unit_cost, unit_price)
  select p_pharmacy_id, p_batch_id, b.medicine_id,
         coalesce(p_unit_cost, m.unit_cost), coalesce(p_unit_price, m.retail_price)
  from public.batches b
  join public.medicines m on m.id = b.medicine_id
  where b.id = p_batch_id
  on conflict (pharmacy_id, batch_id) do update
    set unit_cost  = coalesce(p_unit_cost, public.pharmacy_inventory.unit_cost),
        unit_price = coalesce(p_unit_price, public.pharmacy_inventory.unit_price)
  returning * into v_inv;
  if v_inv.id is null then
    raise exception 'Batch not found' using errcode = 'P0002';
  end if;

  if p_change < 0 and v_inv.quantity_on_hand - v_inv.quantity_reserved - v_inv.quantity_held < -p_change then
    raise exception 'Cannot remove % unit(s): only % available (the rest is reserved for returns or held by discrepancy reports)',
      -p_change, v_inv.quantity_on_hand - v_inv.quantity_reserved - v_inv.quantity_held;
  end if;

  v_inv := public.pharmacy_apply_stock_change(
    v_inv.id, p_change, 0, p_movement_type, 'adjustment', null, p_user_id, btrim(p_reason), p_at);

  perform public.pharmacy_audit(p_user_id, p_pharmacy_id, 'stock.' || p_movement_type, 'pharmacy_inventory', v_inv.id,
    jsonb_build_object('batch_id', p_batch_id, 'change', p_change, 'reason', btrim(p_reason)));
  return v_inv;
end;
$$;

create or replace function public.pharmacy_checkout(
  p_pharmacy_id       uuid,
  p_user_id           uuid,
  p_client_request_id uuid,
  p_items             jsonb,
  p_discount_percent  numeric default 0,
  p_payment_method    text default 'cash',
  p_amount_tendered   numeric default null,
  p_payment_reference text default null,
  p_customer_ref      text default null,
  p_today             date default ((now() at time zone 'Asia/Colombo')::date)
)
returns public.sales
language plpgsql
set search_path = ''
as $$
declare
  v_pharmacy public.pharmacies;
  v_sale     public.sales;
  v_line     record;
  v_inv      public.pharmacy_inventory;
  v_batch    public.batches;
  v_name     text;
  v_line_sum numeric(14, 2);
  v_subtotal numeric(14, 2) := 0;
  v_discount numeric(14, 2);
  v_tax      numeric(14, 2);
  v_total    numeric(14, 2);
  v_tendered numeric(14, 2);
begin
  if p_client_request_id is null then
    raise exception 'Checkout request id is missing';
  end if;

  -- A double-clicked or retried checkout waits for the first one, then gets its sale.
  perform pg_advisory_xact_lock(hashtextextended('pharmacy_checkout:' || p_client_request_id::text, 0));
  select * into v_sale from public.sales
  where pharmacy_id = p_pharmacy_id and client_request_id = p_client_request_id;
  if found then
    return v_sale;
  end if;

  select * into v_pharmacy from public.pharmacies where id = p_pharmacy_id;
  if not found then
    raise exception 'Pharmacy not found' using errcode = 'P0002';
  end if;
  if not v_pharmacy.is_active then
    raise exception 'Pharmacy % is inactive', v_pharmacy.name;
  end if;
  if p_discount_percent is null or p_discount_percent < 0 or p_discount_percent > v_pharmacy.max_discount_percent then
    raise exception '%', format('Discount must be between 0%% and %s%%', v_pharmacy.max_discount_percent);
  end if;
  if p_payment_method not in ('cash', 'card', 'mobile', 'other') then
    raise exception 'Unknown payment method %', p_payment_method;
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'The bill is empty';
  end if;

  insert into public.sales (
    pharmacy_id, client_request_id, subtotal, discount_percent, discount_amount,
    tax_percent, tax_amount, total_amount, payment_method, payment_reference, customer_ref, served_by
  )
  values (
    p_pharmacy_id, p_client_request_id, 0, p_discount_percent, 0,
    v_pharmacy.tax_rate_percent, 0, 0, p_payment_method,
    nullif(btrim(p_payment_reference), ''), nullif(btrim(p_customer_ref), ''), p_user_id
  )
  returning * into v_sale;

  -- Lines for the same batch are merged; rows are locked in a fixed order.
  for v_line in
    select (e ->> 'batchId')::uuid as batch_id, sum((e ->> 'quantity')::integer)::integer as quantity,
           bool_or((e ->> 'quantity')::integer <= 0) as has_bad_quantity
    from jsonb_array_elements(p_items) e
    group by 1
    order by 1
  loop
    if v_line.quantity is null or v_line.has_bad_quantity then
      raise exception 'Quantities must be positive whole numbers';
    end if;

    select * into v_inv from public.pharmacy_inventory
    where pharmacy_id = p_pharmacy_id and batch_id = v_line.batch_id
    for update;
    if not found then
      raise exception 'A batch on the bill is not stocked at this pharmacy' using errcode = 'P0002';
    end if;
    select * into v_batch from public.batches where id = v_line.batch_id;
    select name into v_name from public.medicines where id = v_inv.medicine_id;

    if v_batch.expiry_date < p_today then
      raise exception '% batch % expired on %; it cannot be sold', v_name, v_batch.batch_number, v_batch.expiry_date;
    end if;
    if v_batch.status <> 'active' then
      raise exception '% batch % is %; it cannot be sold', v_name, v_batch.batch_number, v_batch.status;
    end if;
    if v_inv.quantity_on_hand - v_inv.quantity_reserved - v_inv.quantity_held < v_line.quantity then
      raise exception 'Not enough stock of % (batch %): % available, % on the bill',
        v_name, v_batch.batch_number, v_inv.quantity_on_hand - v_inv.quantity_reserved - v_inv.quantity_held, v_line.quantity;
    end if;
    if v_inv.unit_price is null then
      raise exception '% batch % has no selling price', v_name, v_batch.batch_number;
    end if;

    v_line_sum := round(v_inv.unit_price * v_line.quantity, 2);
    insert into public.sale_items (
      sale_id, pharmacy_id, inventory_id, medicine_id, batch_id, quantity, unit_price, line_total, sold_at
    )
    values (
      v_sale.id, p_pharmacy_id, v_inv.id, v_inv.medicine_id, v_line.batch_id, v_line.quantity,
      v_inv.unit_price, v_line_sum, v_sale.sold_at
    );
    v_subtotal := v_subtotal + v_line_sum;

    perform public.pharmacy_apply_stock_change(
      v_inv.id, -v_line.quantity, 0, 'sale', 'sale', v_sale.id, p_user_id, v_sale.sale_number);
  end loop;

  -- FEFO: false when an earlier-expiring sellable batch of the product is still on the shelf.
  update public.sale_items si
  set fefo_compliant = not exists (
    select 1
    from public.pharmacy_inventory i
    join public.batches b on b.id = i.batch_id
    where i.pharmacy_id = p_pharmacy_id
      and i.medicine_id = si.medicine_id
      and i.batch_id <> si.batch_id
      and i.quantity_on_hand - i.quantity_reserved - i.quantity_held > 0
      and b.status = 'active'
      and b.expiry_date >= p_today
      and b.expiry_date < (select expiry_date from public.batches where id = si.batch_id)
  )
  where si.sale_id = v_sale.id;

  v_discount := round(v_subtotal * p_discount_percent / 100, 2);
  v_tax := round((v_subtotal - v_discount) * v_pharmacy.tax_rate_percent / 100, 2);
  v_total := v_subtotal - v_discount + v_tax;

  if p_payment_method = 'cash' then
    if p_amount_tendered is null or round(p_amount_tendered, 2) < v_total then
      raise exception 'Cash received (%) is less than the bill total (%)', coalesce(round(p_amount_tendered, 2), 0), v_total;
    end if;
    v_tendered := round(p_amount_tendered, 2);
  else
    v_tendered := v_total;
  end if;

  update public.sales
  set subtotal = v_subtotal, discount_amount = v_discount, tax_amount = v_tax, total_amount = v_total,
      amount_tendered = v_tendered, change_due = v_tendered - v_total
  where id = v_sale.id
  returning * into v_sale;

  perform public.pharmacy_audit(p_user_id, p_pharmacy_id, 'sale.completed', 'sale', v_sale.id,
    jsonb_build_object('sale_number', v_sale.sale_number, 'total', v_total,
                       'lines', (select count(*) from public.sale_items where sale_id = v_sale.id)));
  return v_sale;
end;
$$;

create or replace function public.pharmacy_create_return(
  p_pharmacy_id uuid,
  p_user_id     uuid,
  p_items       jsonb,
  p_notes       text default null
)
returns public.return_requests
language plpgsql
set search_path = ''
as $$
declare
  v_pharmacy public.pharmacies;
  v_return   public.return_requests;
  v_line     record;
  v_inv      public.pharmacy_inventory;
  v_label    text;
begin
  select * into v_pharmacy from public.pharmacies where id = p_pharmacy_id;
  if not found then
    raise exception 'Pharmacy not found' using errcode = 'P0002';
  end if;
  if v_pharmacy.warehouse_id is null then
    raise exception 'Pharmacy % has no supplying warehouse; set one in Settings', v_pharmacy.name;
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one item to the return';
  end if;
  if (select count(distinct e ->> 'inventoryId') from jsonb_array_elements(p_items) e) <> jsonb_array_length(p_items) then
    raise exception 'Each batch can appear only once in a return';
  end if;

  insert into public.return_requests (pharmacy_id, warehouse_id, notes, requested_by)
  values (p_pharmacy_id, v_pharmacy.warehouse_id, nullif(btrim(p_notes), ''), p_user_id)
  returning * into v_return;

  for v_line in
    select (e ->> 'inventoryId')::uuid       as inventory_id,
           (e ->> 'quantity')::integer       as quantity,
           e ->> 'reason'                    as reason,
           nullif(btrim(e ->> 'notes'), '')  as notes
    from jsonb_array_elements(p_items) e
    order by 1
  loop
    if v_line.quantity is null or v_line.quantity <= 0 then
      raise exception 'Return quantities must be positive whole numbers';
    end if;
    if v_line.reason is null or v_line.reason not in
       ('expired', 'near_expiry', 'damaged', 'recalled', 'overstock', 'incorrect_item', 'other') then
      raise exception 'Choose a valid return reason';
    end if;

    select * into v_inv from public.pharmacy_inventory
    where id = v_line.inventory_id and pharmacy_id = p_pharmacy_id
    for update;
    if not found then
      raise exception 'A stock item in the return is not held by this pharmacy' using errcode = 'P0002';
    end if;
    if v_inv.quantity_on_hand - v_inv.quantity_reserved - v_inv.quantity_held < v_line.quantity then
      select m.name || ' (batch ' || b.batch_number || ')' into v_label
      from public.medicines m, public.batches b where m.id = v_inv.medicine_id and b.id = v_inv.batch_id;
      raise exception 'Only % unit(s) of % can be returned; % already reserved for returns or held by discrepancy reports',
        v_inv.quantity_on_hand - v_inv.quantity_reserved - v_inv.quantity_held, v_label, v_inv.quantity_reserved + v_inv.quantity_held;
    end if;

    insert into public.return_items (return_id, pharmacy_id, inventory_id, medicine_id, batch_id, quantity, reason, notes)
    values (v_return.id, p_pharmacy_id, v_inv.id, v_inv.medicine_id, v_inv.batch_id, v_line.quantity,
            v_line.reason, v_line.notes);

    perform public.pharmacy_apply_stock_change(
      v_inv.id, 0, v_line.quantity, 'return_reserve', 'return_request', v_return.id, p_user_id, v_return.return_number);
  end loop;

  perform public.pharmacy_audit(p_user_id, p_pharmacy_id, 'return.requested', 'return_request', v_return.id,
    jsonb_build_object('return_number', v_return.return_number, 'items', jsonb_array_length(p_items)));
  return v_return;
end;
$$;

-- ---------------------------------------------------------------------------
-- Discrepancy holds
-- ---------------------------------------------------------------------------

-- Units of one report currently held (net of release / write-off).
create or replace function public.pharmacy_discrepancy_held_units(p_discrepancy_id uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(held_change), 0)::integer
  from public.stock_movements
  where reference_type = 'discrepancy' and reference_id = p_discrepancy_id;
$$;

-- Holds the disputed units of a report whose shipment item is already in
-- stock (internal). Disputed packs: missing = expected - observed; damaged
-- and incorrect = observed; never more than the accepted packs or the units
-- still available. A report is held at most once. Returns the units held.
create or replace function public.pharmacy_hold_for_discrepancy(
  p_discrepancy_id uuid,
  p_user_id        uuid
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_report public.shipment_discrepancies;
  v_item   public.shipment_items;
  v_inv    public.pharmacy_inventory;
  v_packs  integer;
  v_units  integer;
begin
  select * into v_report from public.shipment_discrepancies where id = p_discrepancy_id;
  if not found or v_report.shipment_item_id is null then
    return 0;
  end if;
  if exists (select 1 from public.stock_movements where reference_type = 'discrepancy' and reference_id = p_discrepancy_id) then
    return 0;
  end if;
  select * into v_item from public.shipment_items where id = v_report.shipment_item_id;
  -- Not accepted into stock (held at receipt instead): nothing to hold here.
  if v_item.quantity_accepted is null or v_item.quantity_accepted = 0 then
    return 0;
  end if;

  v_packs := case v_report.discrepancy_type
    when 'missing' then greatest(coalesce(v_report.expected_quantity, 0) - coalesce(v_report.actual_quantity, 0), 0)
    when 'damaged' then coalesce(v_report.actual_quantity, 0)
    when 'incorrect_item' then coalesce(v_report.actual_quantity, 0)
    when 'incorrect_batch' then coalesce(v_report.actual_quantity, 0)
    else 0
  end;
  v_packs := least(v_packs, v_item.quantity_accepted);
  if v_packs <= 0 then
    return 0;
  end if;

  select * into v_inv from public.pharmacy_inventory
  where pharmacy_id = v_item.pharmacy_id and batch_id = v_item.batch_id
  for update;
  if not found then
    return 0;
  end if;
  -- Units already sold or reserved cannot be held any more.
  v_units := least(v_packs * v_item.units_per_pack,
                   greatest(v_inv.quantity_on_hand - v_inv.quantity_reserved - v_inv.quantity_held, 0));
  if v_units <= 0 then
    return 0;
  end if;

  perform public.pharmacy_apply_stock_change(
    v_inv.id, 0, 0, 'discrepancy_hold', 'discrepancy', p_discrepancy_id, p_user_id,
    format('%s: %s unit(s) held until the warehouse resolves the report', v_report.report_number, v_units),
    now(), v_units);
  return v_units;
end;
$$;

-- Records a discrepancy (as before) and, when the item is already in stock,
-- holds its disputed units in the same transaction.
-- Returns the report as JSON plus "duplicate" and "held_units".
create or replace function public.pharmacy_report_discrepancy(
  p_shipment_id       uuid,
  p_pharmacy_id       uuid,
  p_user_id           uuid,
  p_type              text,
  p_shipment_item_id  uuid default null,
  p_observed          integer default null,
  p_notes             text default null,
  p_barcode           text default null,
  p_batch_number      text default null,
  p_medicine_id       uuid default null,
  p_client_request_id uuid default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_shipment public.shipments;
  v_item     public.shipment_items;
  v_row      public.shipment_discrepancies;
  v_expected integer;
  v_medicine uuid;
  v_held     integer := 0;
begin
  if p_client_request_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('pharmacy_discrepancy:' || p_client_request_id::text, 0));
    select * into v_row from public.shipment_discrepancies
    where shipment_id = p_shipment_id and client_request_id = p_client_request_id;
    if found then
      return to_jsonb(v_row) || jsonb_build_object('duplicate', true,
                                                   'held_units', public.pharmacy_discrepancy_held_units(v_row.id));
    end if;
  end if;

  select * into v_shipment from public.shipments where id = p_shipment_id for update;
  if not found or v_shipment.pharmacy_id <> p_pharmacy_id then
    raise exception 'Shipment not found' using errcode = 'P0002';
  end if;
  if p_type not in ('missing', 'excess', 'damaged', 'incorrect_item', 'incorrect_batch', 'expired', 'other') then
    raise exception 'Unknown discrepancy type %', p_type;
  end if;
  if p_observed is not null and p_observed < 0 then
    raise exception 'The observed quantity must be zero or more';
  end if;

  if p_shipment_item_id is not null then
    select * into v_item from public.shipment_items where id = p_shipment_item_id and shipment_id = p_shipment_id;
    if not found then
      raise exception 'The item is not part of shipment %', v_shipment.shipment_number;
    end if;
    v_expected := v_item.quantity_shipped;
    v_medicine := v_item.medicine_id;
    if p_type in ('missing', 'excess', 'damaged', 'incorrect_item', 'incorrect_batch') and p_observed is null then
      raise exception 'Enter the observed quantity (packs)';
    end if;
    if p_type = 'missing' and p_observed >= v_expected then
      raise exception 'Missing: the observed quantity must be less than the % pack(s) shipped', v_expected;
    end if;
    if p_type = 'excess' and p_observed <= v_expected then
      raise exception 'Excess: the observed quantity must be more than the % pack(s) shipped', v_expected;
    end if;
    if p_type = 'damaged' and (p_observed < 1 or p_observed > v_expected) then
      raise exception 'Damaged: enter the number of damaged packs (1 to %)', v_expected;
    end if;
    if p_type in ('incorrect_item', 'incorrect_batch') and p_observed < 1 then
      raise exception 'Incorrect: enter how many incorrect packs were delivered';
    end if;
  else
    -- An item that is not part of the shipment (unexpected or unknown).
    if p_type not in ('incorrect_item', 'incorrect_batch', 'excess', 'other') then
      raise exception 'Choose the shipment item for a % report', p_type;
    end if;
    if p_observed is null or p_observed < 1 then
      raise exception 'Enter how many packs of the unexpected item were delivered';
    end if;
    if p_medicine_id is not null and not exists (select 1 from public.medicines where id = p_medicine_id) then
      raise exception 'Product not found' using errcode = 'P0002';
    end if;
    if p_medicine_id is null and nullif(btrim(p_barcode), '') is null and nullif(btrim(p_notes), '') is null then
      raise exception 'Describe the unknown item (barcode or notes)';
    end if;
    v_expected := 0;
    v_medicine := p_medicine_id;
  end if;

  insert into public.shipment_discrepancies (
    shipment_id, shipment_item_id, order_id, pharmacy_id, medicine_id, batch_id,
    observed_barcode, observed_batch_number, discrepancy_type,
    expected_quantity, actual_quantity, notes, reported_by, client_request_id
  )
  values (
    v_shipment.id, v_item.id, v_shipment.order_id, v_shipment.pharmacy_id, v_medicine, v_item.batch_id,
    nullif(btrim(p_barcode), ''), nullif(btrim(p_batch_number), ''), p_type,
    v_expected, p_observed, nullif(btrim(p_notes), ''), p_user_id, p_client_request_id
  )
  returning * into v_row;

  -- Before receipt the item is disputed (held at receipt); after acceptance
  -- its disputed units are held in stock now.
  if v_shipment.status = 'in_transit' and v_item.id is not null then
    update public.shipment_items set verification_status = 'discrepancy' where id = v_item.id;
  end if;
  if v_shipment.status = 'received' then
    update public.shipments set status = 'received_with_discrepancies' where id = p_shipment_id;
  end if;
  v_held := public.pharmacy_hold_for_discrepancy(v_row.id, p_user_id);

  perform public.pharmacy_audit(p_user_id, p_pharmacy_id, 'discrepancy.reported', 'shipment_discrepancy', v_row.id,
    jsonb_build_object('report_number', v_row.report_number, 'shipment_number', v_shipment.shipment_number,
                       'type', p_type, 'expected', v_expected, 'observed', p_observed,
                       'after_receipt', v_shipment.status <> 'in_transit', 'held_units', v_held));
  return to_jsonb(v_row) || jsonb_build_object('duplicate', false, 'held_units', v_held);
end;
$$;

-- After the warehouse resolved a report, staff release its held units back
-- to available stock ('release') or remove them from stock ('write_off').
-- Repeating the call changes nothing.
-- Returns { already_processed, outcome, units }.
create or replace function public.pharmacy_settle_discrepancy_hold(
  p_discrepancy_id uuid,
  p_pharmacy_id    uuid,
  p_user_id        uuid,
  p_outcome        text,
  p_notes          text default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_report    public.shipment_discrepancies;
  v_held      integer;
  v_inventory uuid;
  v_note      text;
begin
  -- Locking the report serialises settlements of the same hold.
  select * into v_report from public.shipment_discrepancies where id = p_discrepancy_id for update;
  if not found or v_report.pharmacy_id <> p_pharmacy_id then
    raise exception 'Discrepancy report not found' using errcode = 'P0002';
  end if;
  if p_outcome is null or p_outcome not in ('release', 'write_off') then
    raise exception 'Choose release or write off';
  end if;

  v_held := public.pharmacy_discrepancy_held_units(p_discrepancy_id);
  if v_held <= 0 then
    return jsonb_build_object('already_processed', true, 'outcome', p_outcome, 'units', 0);
  end if;
  if v_report.status <> 'resolved' then
    raise exception 'The warehouse has not resolved report % yet; the held units stay unavailable until then', v_report.report_number;
  end if;

  select inventory_id into v_inventory
  from public.stock_movements
  where reference_type = 'discrepancy' and reference_id = p_discrepancy_id and movement_type = 'discrepancy_hold'
  order by entry_no
  limit 1;

  v_note := concat_ws(' ', format('%s: %s unit(s) %s', v_report.report_number, v_held,
                                  case when p_outcome = 'release' then 'released to available stock' else 'written off' end),
                      nullif(btrim(p_notes), ''));
  if p_outcome = 'release' then
    perform public.pharmacy_apply_stock_change(v_inventory, 0, 0, 'discrepancy_release', 'discrepancy', p_discrepancy_id,
                                               p_user_id, v_note, now(), -v_held);
  else
    perform public.pharmacy_apply_stock_change(v_inventory, -v_held, 0, 'discrepancy_write_off', 'discrepancy', p_discrepancy_id,
                                               p_user_id, v_note, now(), -v_held);
  end if;

  perform public.pharmacy_audit(p_user_id, p_pharmacy_id,
    case when p_outcome = 'release' then 'discrepancy.hold_released' else 'discrepancy.hold_written_off' end,
    'shipment_discrepancy', p_discrepancy_id,
    jsonb_build_object('report_number', v_report.report_number, 'units', v_held, 'notes', nullif(btrim(p_notes), '')));
  return jsonb_build_object('already_processed', false, 'outcome', p_outcome, 'units', v_held);
end;
$$;

-- ---------------------------------------------------------------------------
-- Backfill: unresolved reports made after their item was accepted
-- ---------------------------------------------------------------------------
do $$
declare
  v_report record;
  v_units  integer;
begin
  for v_report in
    select d.id, d.pharmacy_id, d.reported_by
    from public.shipment_discrepancies d
    join public.shipment_items si on si.id = d.shipment_item_id
    where d.status <> 'resolved'
      and si.quantity_accepted > 0
      and si.accepted_at is not null
      and d.reported_at > si.accepted_at
      and not exists (
        select 1 from public.stock_movements m where m.reference_type = 'discrepancy' and m.reference_id = d.id
      )
    order by d.reported_at
  loop
    v_units := public.pharmacy_hold_for_discrepancy(v_report.id, v_report.reported_by);
    if v_units > 0 then
      perform public.pharmacy_audit(v_report.reported_by, v_report.pharmacy_id, 'discrepancy.hold_backfilled',
        'shipment_discrepancy', v_report.id, jsonb_build_object('held_units', v_units));
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Realtime: item-level receiving status (RLS still applies per user)
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'shipment_items'
     ) then
    alter publication supabase_realtime add table public.shipment_items;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Only the backend (service role) may run these.
-- ---------------------------------------------------------------------------
do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('pharmacy_apply_stock_change', 'pharmacy_adjust_stock', 'pharmacy_checkout', 'pharmacy_create_return',
                        'pharmacy_discrepancy_held_units', 'pharmacy_hold_for_discrepancy', 'pharmacy_report_discrepancy',
                        'pharmacy_settle_discrepancy_hold')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
