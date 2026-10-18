-- Component 3: warehouse fulfilment of pharmacy orders.
--
-- Builds on Component 4's contract (purchase_orders, purchase_order_items,
-- shipments, shipment_items) without changing its tables or statuses:
--   * warehouse_order_fulfilments  warehouse progress of one order:
--       allocated -> picking -> ready -> dispatched   (or cancelled)
--     Component 4 keeps seeing the order as 'submitted' until dispatch.
--   * warehouse_order_picks        FEFO allocation lines. Their quantity is
--     reserved: it stays in warehouse_stock but no other order, transfer,
--     disposal or dispatch can take it.
--   * warehouse_integration_events outbox for handing dispatched shipments to
--     Component 2 (cold-chain monitoring); the backend delivers and retries.
--   * warehouse_scan_events        QR scan history (lookups, pick verification).
--
-- record_inventory_movement() gains p_pick_id (consume a reservation) and
-- p_client_request_id (a repeated request returns the first movement). Its
-- existing 12-argument calls (Component 4's functions) keep working.
--
-- Also: operational warehouse tables become readable by warehouse staff and
-- admins only (they were readable by every signed-in user).
--
-- Business-rule violations raise P0001, missing rows P0002 (as before).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.warehouse_order_fulfilments (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references public.purchase_orders (id) on delete restrict,
  warehouse_id   uuid not null references public.warehouses (id) on delete restrict,
  status         text not null default 'allocated'
                 check (status in ('allocated', 'picking', 'ready', 'dispatched', 'cancelled')),
  -- Batches with less shelf life than this are not sent to pharmacies.
  min_shelf_days integer not null default 30 check (min_shelf_days between 0 and 3650),
  notes          text check (length(notes) <= 1000),
  allocated_by   uuid references auth.users (id) on delete set null,
  allocated_at   timestamptz not null default now(),
  ready_at       timestamptz,
  shipment_id    uuid references public.shipments (id) on delete restrict,
  dispatched_by  uuid references auth.users (id) on delete set null,
  dispatched_at  timestamptz,
  cancelled_by   uuid references auth.users (id) on delete set null,
  cancelled_at   timestamptz,
  cancel_reason  text check (length(cancel_reason) <= 1000),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check ((status = 'dispatched') = (shipment_id is not null)),
  check ((status = 'cancelled') = (cancelled_at is not null))
);

-- One live fulfilment per order (a cancelled one can be re-allocated).
create unique index if not exists warehouse_order_fulfilments_one_live
  on public.warehouse_order_fulfilments (order_id) where status <> 'cancelled';
create index if not exists warehouse_order_fulfilments_status_idx
  on public.warehouse_order_fulfilments (status, allocated_at desc);

create table if not exists public.warehouse_order_picks (
  id                  uuid primary key default gen_random_uuid(),
  fulfilment_id       uuid not null references public.warehouse_order_fulfilments (id) on delete cascade,
  order_item_id       uuid not null references public.purchase_order_items (id) on delete restrict,
  medicine_id         uuid not null references public.medicines (id) on delete restrict,
  batch_id            uuid not null references public.batches (id) on delete restrict,
  storage_location_id uuid not null references public.storage_locations (id) on delete restrict,
  -- Warehouse packs.
  quantity            integer not null check (quantity > 0),
  -- FEFO order in which the picks were allocated.
  pick_sequence       integer not null,
  -- reserved -> picked (verified at the shelf) -> dispatched; released when cancelled.
  status              text not null default 'reserved'
                      check (status in ('reserved', 'picked', 'dispatched', 'released')),
  fefo_compliant      boolean not null default true,
  fefo_note           text,
  picked_by           uuid references auth.users (id) on delete set null,
  picked_at           timestamptz,
  picked_via          text check (picked_via in ('qr_scan', 'manual')),
  movement_id         uuid references public.inventory_movements (id) on delete set null,
  created_at          timestamptz not null default now(),
  check (status not in ('picked', 'dispatched') or picked_at is not null),
  check (fefo_compliant or fefo_note is not null)
);

create index if not exists warehouse_order_picks_fulfilment_idx on public.warehouse_order_picks (fulfilment_id, pick_sequence);
create index if not exists warehouse_order_picks_reserved_idx
  on public.warehouse_order_picks (batch_id, storage_location_id) where status in ('reserved', 'picked');

create table if not exists public.warehouse_integration_events (
  id              uuid primary key default gen_random_uuid(),
  target          text not null check (target in ('cold_chain')),
  event_type      text not null check (event_type in ('shipment.dispatched')),
  -- shipments.id for shipment events.
  entity_id       uuid not null,
  payload         jsonb not null default '{}'::jsonb,
  -- skipped: the user chose not to hand it over (e.g. no monitoring needed).
  status          text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  attempts        integer not null default 0 check (attempts >= 0),
  last_error      text,
  last_attempt_at timestamptz,
  completed_at    timestamptz,
  response        jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (target, event_type, entity_id)
);

create index if not exists warehouse_integration_events_status_idx
  on public.warehouse_integration_events (status, created_at);

create table if not exists public.warehouse_scan_events (
  id                  uuid primary key default gen_random_uuid(),
  purpose             text not null check (purpose in ('lookup', 'pick', 'put_away')),
  result              text not null
                      check (result in ('ok', 'invalid', 'not_found', 'inactive', 'batch_mismatch', 'location_mismatch')),
  -- What was scanned or typed (QR payloads are opaque codes, never secrets).
  scanned_code        text check (length(scanned_code) <= 200),
  location_code       text check (length(location_code) <= 100),
  batch_id            uuid references public.batches (id) on delete set null,
  storage_location_id uuid references public.storage_locations (id) on delete set null,
  pick_id             uuid references public.warehouse_order_picks (id) on delete set null,
  message             text,
  user_id             uuid references auth.users (id) on delete set null,
  created_at          timestamptz not null default now()
);

create index if not exists warehouse_scan_events_created_idx on public.warehouse_scan_events (created_at desc);
create index if not exists warehouse_scan_events_batch_idx on public.warehouse_scan_events (batch_id);

-- A repeated movement request (double click, retry) returns the first movement.
alter table public.inventory_movements add column if not exists client_request_id uuid;
create unique index if not exists inventory_movements_client_request_idx
  on public.inventory_movements (client_request_id) where client_request_id is not null;

-- ---------------------------------------------------------------------------
-- Reservations
-- ---------------------------------------------------------------------------

-- Packs of a batch at a location reserved by live picks (optionally ignoring one pick).
create or replace function public.warehouse_reserved_quantity(
  p_batch_id    uuid,
  p_location_id uuid,
  p_except_pick uuid default null
)
returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(quantity), 0)::integer
  from public.warehouse_order_picks
  where batch_id = p_batch_id
    and storage_location_id = p_location_id
    and status in ('reserved', 'picked')
    and (p_except_pick is null or id <> p_except_pick);
$$;

-- Stock with its reservations (appended columns; existing columns unchanged).
create or replace view public.warehouse_stock_overview
with (security_invoker = true) as
select
  st.id                    as stock_id,
  st.quantity,
  st.created_at            as placed_at,
  st.updated_at,
  b.id                     as batch_id,
  b.batch_number,
  b.manufacturing_date,
  b.expiry_date,
  b.status                 as batch_status,
  b.created_at             as batch_created_at,
  m.id                     as medicine_id,
  m.name                   as medicine_name,
  m.generic_name,
  m.strength,
  m.dosage_form,
  m.unit,
  m.storage_condition,
  m.is_controlled,
  m.medicine_category_id,
  l.id                     as storage_location_id,
  l.code                   as location_code,
  l.accessibility,
  r.id                     as rack_id,
  r.code                   as rack_code,
  r.distance_to_dispatch_m,
  z.id                     as zone_id,
  z.code                   as zone_code,
  z.zone_type,
  w.id                     as warehouse_id,
  w.code                   as warehouse_code,
  w.name                   as warehouse_name,
  coalesce(rs.reserved, 0)::integer                as quantity_reserved,
  (st.quantity - coalesce(rs.reserved, 0))::integer as quantity_available
from public.warehouse_stock st
join public.batches b on b.id = st.batch_id
join public.medicines m on m.id = b.medicine_id
join public.storage_locations l on l.id = st.storage_location_id
join public.warehouse_racks r on r.id = l.rack_id
join public.warehouse_zones z on z.id = r.zone_id
join public.warehouses w on w.id = z.warehouse_id
left join (
  select batch_id, storage_location_id, sum(quantity) as reserved
  from public.warehouse_order_picks
  where status in ('reserved', 'picked')
  group by batch_id, storage_location_id
) rs on rs.batch_id = st.batch_id and rs.storage_location_id = st.storage_location_id;

-- ---------------------------------------------------------------------------
-- record_inventory_movement(): reservation-aware and idempotent.
-- The old 12-argument version is replaced (calls with 12 arguments, such as
-- Component 4's, resolve to this one through the defaults).
-- ---------------------------------------------------------------------------
drop function if exists public.record_inventory_movement(
  uuid, text, integer, uuid, uuid, uuid, text, boolean, text, text, text, date
);

create or replace function public.record_inventory_movement(
  p_batch_id             uuid,
  p_movement_type        text,
  p_quantity             integer,
  p_from_location_id     uuid default null,
  p_to_location_id       uuid default null,
  p_performed_by         uuid default null,
  p_performed_via        text default 'manual',
  p_fefo_compliant       boolean default null,
  p_fefo_override_reason text default null,
  p_reference            text default null,
  p_notes                text default null,
  p_today                date default current_date,
  -- The order pick whose reservation this movement consumes (dispatch of an order).
  p_pick_id              uuid default null,
  -- Idempotency key: a repeated key returns the movement it created.
  p_client_request_id    uuid default null
)
returns public.inventory_movements
language plpgsql
set search_path = ''
as $$
declare
  v_batch            public.batches;
  v_medicine         public.medicines;
  v_from_stock       public.warehouse_stock;
  v_from_warehouse   uuid;
  v_to               record;
  v_occupied         integer;
  v_reserved         integer;
  v_pick             public.warehouse_order_picks;
  v_needs_quarantine boolean;
  v_movement         public.inventory_movements;
begin
  if p_client_request_id is not null then
    -- Concurrent duplicates wait here; the second one finds the first movement.
    perform pg_advisory_xact_lock(hashtextextended(p_client_request_id::text, 0));
    select * into v_movement from public.inventory_movements where client_request_id = p_client_request_id;
    if found then
      return v_movement;
    end if;
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be a positive whole number';
  end if;

  -- Concurrent movements of the same batch run one after another.
  select * into v_batch from public.batches where id = p_batch_id for no key update;
  if not found then
    raise exception 'Batch not found' using errcode = 'P0002';
  end if;
  select * into v_medicine from public.medicines where id = v_batch.medicine_id;

  if v_batch.status = 'disposed' then
    raise exception 'Batch % has been disposed; it cannot be moved', v_batch.batch_number;
  end if;
  if p_movement_type = 'receive' and v_batch.expiry_date < p_today then
    raise exception 'Batch % expired on %; expired stock cannot be received',
      v_batch.batch_number, v_batch.expiry_date;
  end if;
  if p_movement_type = 'dispatch' and (v_batch.status <> 'active' or v_batch.expiry_date < p_today) then
    raise exception 'Batch % cannot be dispatched: only active, unexpired batches can leave the warehouse',
      v_batch.batch_number;
  end if;

  if p_pick_id is not null then
    select * into v_pick from public.warehouse_order_picks where id = p_pick_id;
    if not found then
      raise exception 'Order pick not found' using errcode = 'P0002';
    end if;
    if v_pick.status not in ('reserved', 'picked') or v_pick.batch_id <> p_batch_id
       or v_pick.storage_location_id is distinct from p_from_location_id or p_quantity > v_pick.quantity then
      raise exception 'The movement does not match the reserved order pick';
    end if;
  end if;

  -- Take stock out of the source location (never stock reserved for other orders).
  if p_from_location_id is not null then
    select * into v_from_stock
    from public.warehouse_stock
    where batch_id = p_batch_id and storage_location_id = p_from_location_id
    for no key update;
    if not found then
      raise exception 'Batch % is not stored at the source location', v_batch.batch_number;
    end if;
    v_reserved := public.warehouse_reserved_quantity(p_batch_id, p_from_location_id, p_pick_id);
    if v_from_stock.quantity - v_reserved < p_quantity then
      if v_reserved > 0 then
        raise exception 'Not enough unreserved stock: % unit(s) at the source location, % reserved for orders, % requested',
          v_from_stock.quantity, v_reserved, p_quantity;
      end if;
      raise exception 'Not enough stock: % unit(s) at the source location, % requested',
        v_from_stock.quantity, p_quantity;
    end if;

    if v_from_stock.quantity = p_quantity then
      delete from public.warehouse_stock where id = v_from_stock.id;
    else
      update public.warehouse_stock set quantity = quantity - p_quantity where id = v_from_stock.id;
    end if;

    select z.warehouse_id into v_from_warehouse
    from public.storage_locations l
    join public.warehouse_racks r on r.id = l.rack_id
    join public.warehouse_zones z on z.id = r.zone_id
    where l.id = p_from_location_id;
  end if;

  -- Put stock into the destination location.
  if p_to_location_id is not null then
    -- Locking the location serialises concurrent put-aways into it.
    select l.id, l.code, l.capacity_units, l.is_active,
           z.zone_type, z.storage_condition, z.is_secure, z.warehouse_id
    into v_to
    from public.storage_locations l
    join public.warehouse_racks r on r.id = l.rack_id
    join public.warehouse_zones z on z.id = r.zone_id
    where l.id = p_to_location_id
    for no key update of l;
    if not found then
      raise exception 'Destination location not found' using errcode = 'P0002';
    end if;

    if not v_to.is_active then
      raise exception 'Location % is inactive', v_to.code;
    end if;
    if v_from_warehouse is not null and v_from_warehouse <> v_to.warehouse_id then
      raise exception 'Transfers must stay within one warehouse';
    end if;
    if v_to.storage_condition <> v_medicine.storage_condition then
      raise exception '% needs % storage; location % is %',
        v_medicine.name, v_medicine.storage_condition, v_to.code, v_to.storage_condition;
    end if;
    if v_medicine.is_controlled and not v_to.is_secure then
      raise exception '% is a controlled medicine and must be stored in a secure zone', v_medicine.name;
    end if;

    v_needs_quarantine := v_batch.status in ('quarantined', 'recalled') or v_batch.expiry_date < p_today;
    if v_needs_quarantine and v_to.zone_type <> 'quarantine' then
      raise exception 'Batch % is % and must be moved to a quarantine zone',
        v_batch.batch_number,
        case when v_batch.status = 'active' then 'expired' else v_batch.status end;
    end if;
    if not v_needs_quarantine and v_to.zone_type = 'quarantine' then
      raise exception 'Batch % is active; set its status to quarantined before moving it to quarantine',
        v_batch.batch_number;
    end if;

    select coalesce(sum(quantity), 0) into v_occupied
    from public.warehouse_stock
    where storage_location_id = p_to_location_id;
    if v_occupied + p_quantity > v_to.capacity_units then
      raise exception 'Location % has space for % more unit(s); % requested',
        v_to.code, v_to.capacity_units - v_occupied, p_quantity;
    end if;

    insert into public.warehouse_stock (batch_id, storage_location_id, quantity)
    values (p_batch_id, p_to_location_id, p_quantity)
    on conflict (batch_id, storage_location_id)
    do update set quantity = public.warehouse_stock.quantity + excluded.quantity;
  end if;

  insert into public.inventory_movements (
    batch_id, movement_type, quantity, from_location_id, to_location_id,
    performed_by, performed_via, fefo_compliant, fefo_override_reason, reference, notes, client_request_id
  )
  values (
    p_batch_id, p_movement_type, p_quantity, p_from_location_id, p_to_location_id,
    p_performed_by, p_performed_via, p_fefo_compliant, p_fefo_override_reason, p_reference, p_notes,
    p_client_request_id
  )
  returning * into v_movement;

  -- A batch whose last stock was disposed of is closed.
  if p_movement_type = 'disposal'
     and not exists (select 1 from public.warehouse_stock where batch_id = p_batch_id) then
    update public.batches set status = 'disposed' where id = p_batch_id;
  end if;

  return v_movement;
end;
$$;

-- ---------------------------------------------------------------------------
-- Order fulfilment
-- ---------------------------------------------------------------------------

-- Locks the warehouse stock rows of one medicine in a fixed order (by id), so
-- allocations and dispatches touching the same rows queue instead of deadlocking.
create or replace function public.warehouse_lock_medicine_stock(p_warehouse_id uuid, p_medicine_id uuid)
returns void
language sql
set search_path = ''
as $$
  select 1
  from public.warehouse_stock st
  join public.batches b on b.id = st.batch_id
  join public.storage_locations l on l.id = st.storage_location_id
  join public.warehouse_racks r on r.id = l.rack_id
  join public.warehouse_zones z on z.id = r.zone_id
  where b.medicine_id = p_medicine_id and z.warehouse_id = p_warehouse_id
  order by st.id
  for no key update of st;
$$;

-- Reserves stock for a submitted order in FEFO order (active batch, storage
-- zone, active location, at least p_min_shelf_days of shelf life; earliest
-- expiry, then older manufacture, earlier receipt, nearer dispatch). All or
-- nothing. Skipping short-dated stock is recorded the same way as in
-- Component 4's pharmacy_dispatch_order(). Calling it again for an order that
-- is already allocated returns that allocation unchanged.
--
-- p_items (optional): [{ "orderItemId", "quantity" }] to supply less than
-- ordered (0 skips an item). Items not listed get the ordered quantity.
create or replace function public.warehouse_allocate_order(
  p_order_id       uuid,
  p_user_id        uuid,
  p_items          jsonb default null,
  p_min_shelf_days integer default 30,
  p_notes          text default null,
  p_today          date default ((now() at time zone 'Asia/Colombo')::date)
)
returns public.warehouse_order_fulfilments
language plpgsql
set search_path = ''
as $$
declare
  v_order     public.purchase_orders;
  v_ful       public.warehouse_order_fulfilments;
  v_item      record;
  v_stock     record;
  v_qty       integer;
  v_remaining integer;
  v_take      integer;
  v_skipped   date;
  v_sequence  integer := 0;
  v_total     integer := 0;
begin
  if p_min_shelf_days is null or p_min_shelf_days < 0 or p_min_shelf_days > 3650 then
    raise exception 'Minimum shelf life must be between 0 and 3650 days';
  end if;

  -- Serialises allocation of the same order.
  select * into v_order from public.purchase_orders where id = p_order_id for update;
  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;

  select * into v_ful from public.warehouse_order_fulfilments where order_id = p_order_id and status <> 'cancelled';
  if found then
    return v_ful;
  end if;
  if v_order.status <> 'submitted' then
    raise exception 'Order % is % and cannot be allocated', v_order.order_number, v_order.status;
  end if;
  if v_order.warehouse_id is null then
    raise exception 'Order % has no supplying warehouse', v_order.order_number;
  end if;
  if p_items is not null and (jsonb_typeof(p_items) <> 'array' or exists (
    select 1 from jsonb_array_elements(p_items) e
    where not exists (
      select 1 from public.purchase_order_items oi
      where oi.order_id = p_order_id and oi.id::text = e ->> 'orderItemId'
    )
  )) then
    raise exception 'An allocation line does not belong to order %', v_order.order_number;
  end if;

  insert into public.warehouse_order_fulfilments (order_id, warehouse_id, min_shelf_days, notes, allocated_by)
  values (p_order_id, v_order.warehouse_id, p_min_shelf_days, nullif(btrim(p_notes), ''), p_user_id)
  returning * into v_ful;

  for v_item in
    select oi.id, oi.medicine_id, oi.quantity_ordered, m.name
    from public.purchase_order_items oi
    join public.medicines m on m.id = oi.medicine_id
    where oi.order_id = p_order_id
    order by oi.created_at, oi.id
  loop
    v_qty := v_item.quantity_ordered;
    if p_items is not null then
      select (e ->> 'quantity')::integer into v_qty
      from jsonb_array_elements(p_items) e
      where e ->> 'orderItemId' = v_item.id::text;
      v_qty := coalesce(v_qty, v_item.quantity_ordered);
    end if;
    if v_qty < 0 or v_qty > v_item.quantity_ordered then
      raise exception 'Allocate between 0 and % pack(s) of %', v_item.quantity_ordered, v_item.name;
    end if;
    continue when v_qty = 0;

    perform public.warehouse_lock_medicine_stock(v_order.warehouse_id, v_item.medicine_id);

    -- Short-dated stock that plain FEFO would have sent first.
    select min(b.expiry_date) into v_skipped
    from public.warehouse_stock st
    join public.batches b on b.id = st.batch_id
    join public.storage_locations l on l.id = st.storage_location_id
    join public.warehouse_racks r on r.id = l.rack_id
    join public.warehouse_zones z on z.id = r.zone_id
    where b.medicine_id = v_item.medicine_id
      and z.warehouse_id = v_order.warehouse_id
      and z.zone_type = 'storage'
      and b.status = 'active'
      and l.is_active
      and b.expiry_date >= p_today
      and b.expiry_date < p_today + p_min_shelf_days
      and st.quantity > public.warehouse_reserved_quantity(st.batch_id, st.storage_location_id);

    v_remaining := v_qty;
    for v_stock in
      select st.batch_id, st.storage_location_id,
             st.quantity - public.warehouse_reserved_quantity(st.batch_id, st.storage_location_id) as available
      from public.warehouse_stock st
      join public.batches b on b.id = st.batch_id
      join public.storage_locations l on l.id = st.storage_location_id
      join public.warehouse_racks r on r.id = l.rack_id
      join public.warehouse_zones z on z.id = r.zone_id
      where b.medicine_id = v_item.medicine_id
        and z.warehouse_id = v_order.warehouse_id
        and z.zone_type = 'storage'
        and b.status = 'active'
        and l.is_active
        and b.expiry_date >= p_today + p_min_shelf_days
      order by b.expiry_date, b.manufacturing_date nulls last, b.created_at,
               r.distance_to_dispatch_m, st.created_at, st.id
    loop
      exit when v_remaining = 0;
      continue when v_stock.available <= 0;
      v_take := least(v_remaining, v_stock.available);
      v_sequence := v_sequence + 1;

      insert into public.warehouse_order_picks (
        fulfilment_id, order_item_id, medicine_id, batch_id, storage_location_id,
        quantity, pick_sequence, fefo_compliant, fefo_note
      )
      values (
        v_ful.id, v_item.id, v_item.medicine_id, v_stock.batch_id, v_stock.storage_location_id,
        v_take, v_sequence, v_skipped is null,
        case when v_skipped is not null
             then format('Pharmacy supply rule: at least %s days of shelf life (earlier batch expires %s)',
                         p_min_shelf_days, v_skipped)
        end
      );
      v_remaining := v_remaining - v_take;
      v_total := v_total + v_take;
    end loop;

    if v_remaining > 0 then
      raise exception 'Not enough unreserved stock of %: % of % pack(s) available with at least % days of shelf life',
        v_item.name, v_qty - v_remaining, v_qty, p_min_shelf_days;
    end if;
  end loop;

  if v_total = 0 then
    raise exception 'Nothing to allocate: every quantity is zero';
  end if;

  perform public.pharmacy_audit(p_user_id, v_order.pharmacy_id, 'order.allocated', 'purchase_order', v_order.id,
    jsonb_build_object('order_number', v_order.order_number, 'fulfilment_id', v_ful.id, 'packs', v_total));
  return v_ful;
end;
$$;

-- Confirms one pick at the shelf: the scanned batch and location must be the
-- reserved ones. Confirming an already picked line changes nothing.
create or replace function public.warehouse_confirm_pick(
  p_pick_id     uuid,
  p_user_id     uuid,
  p_batch_id    uuid,
  p_location_id uuid,
  p_via         text default 'qr_scan'
)
returns public.warehouse_order_picks
language plpgsql
set search_path = ''
as $$
declare
  v_pick public.warehouse_order_picks;
  v_ful  public.warehouse_order_fulfilments;
begin
  if p_via not in ('qr_scan', 'manual') then
    raise exception 'Unknown verification method %', p_via;
  end if;
  select * into v_pick from public.warehouse_order_picks where id = p_pick_id;
  if not found then
    raise exception 'Order pick not found' using errcode = 'P0002';
  end if;
  select * into v_ful from public.warehouse_order_fulfilments where id = v_pick.fulfilment_id for update;
  select * into v_pick from public.warehouse_order_picks where id = p_pick_id for update;

  if v_pick.status = 'picked' then
    return v_pick;
  end if;
  if v_ful.status not in ('allocated', 'picking') or v_pick.status <> 'reserved' then
    raise exception 'This pick is % (order fulfilment %) and cannot be confirmed', v_pick.status, v_ful.status;
  end if;
  if p_batch_id is distinct from v_pick.batch_id then
    raise exception 'Wrong batch: this pick is for batch %',
      (select batch_number from public.batches where id = v_pick.batch_id);
  end if;
  if p_location_id is distinct from v_pick.storage_location_id then
    raise exception 'Wrong location: pick this batch from %',
      (select code from public.storage_locations where id = v_pick.storage_location_id);
  end if;

  update public.warehouse_order_picks
  set status = 'picked', picked_by = p_user_id, picked_at = now(), picked_via = p_via
  where id = p_pick_id
  returning * into v_pick;

  update public.warehouse_order_fulfilments
  set status   = case when exists (
                   select 1 from public.warehouse_order_picks where fulfilment_id = v_ful.id and status = 'reserved'
                 ) then 'picking' else 'ready' end,
      ready_at = case when exists (
                   select 1 from public.warehouse_order_picks where fulfilment_id = v_ful.id and status = 'reserved'
                 ) then null else now() end
  where id = v_ful.id;

  return v_pick;
end;
$$;

-- Dispatches a fully picked order: one shipment with the picked batches
-- (Component 4's shipment contract), one dispatch movement per pick that
-- consumes its reservation, the order becomes 'dispatched', and the shipment
-- is queued for the cold-chain handoff (Component 2). Dispatching an already
-- dispatched fulfilment returns its shipment unchanged.
--
-- p_cold_chain: { "monitor": true|false, "expectedDeliveryAt": "<ISO time>"? }
create or replace function public.warehouse_dispatch_fulfilment(
  p_fulfilment_id uuid,
  p_user_id       uuid,
  p_notes         text default null,
  p_cold_chain    jsonb default null,
  p_today         date default ((now() at time zone 'Asia/Colombo')::date)
)
returns public.shipments
language plpgsql
set search_path = ''
as $$
declare
  v_ful      public.warehouse_order_fulfilments;
  v_order    public.purchase_orders;
  v_shipment public.shipments;
  v_pick     record;
  v_movement public.inventory_movements;
  v_medicine uuid;
  v_total    integer := 0;
  v_monitor  boolean := coalesce((p_cold_chain ->> 'monitor')::boolean, false);
begin
  select * into v_ful from public.warehouse_order_fulfilments where id = p_fulfilment_id for update;
  if not found then
    raise exception 'Order fulfilment not found' using errcode = 'P0002';
  end if;
  if v_ful.status = 'dispatched' then
    select * into v_shipment from public.shipments where id = v_ful.shipment_id;
    return v_shipment;
  end if;
  if v_ful.status <> 'ready' then
    raise exception 'Every pick must be verified before dispatch (fulfilment is %)', v_ful.status;
  end if;

  select * into v_order from public.purchase_orders where id = v_ful.order_id for update;
  if v_order.status <> 'submitted' then
    raise exception 'Order % is % and cannot be dispatched', v_order.order_number, v_order.status;
  end if;

  for v_medicine in
    select distinct medicine_id from public.warehouse_order_picks where fulfilment_id = v_ful.id order by medicine_id
  loop
    perform public.warehouse_lock_medicine_stock(v_ful.warehouse_id, v_medicine);
  end loop;

  insert into public.shipments (order_id, pharmacy_id, warehouse_id, dispatched_by, notes)
  values (v_order.id, v_order.pharmacy_id, v_ful.warehouse_id, p_user_id, nullif(btrim(p_notes), ''))
  returning * into v_shipment;

  for v_pick in
    select p.*, m.units_per_pack, m.unit_cost, m.retail_price
    from public.warehouse_order_picks p
    join public.medicines m on m.id = p.medicine_id
    where p.fulfilment_id = v_ful.id and p.status = 'picked'
    order by p.pick_sequence
  loop
    v_movement := public.record_inventory_movement(
      v_pick.batch_id, 'dispatch', v_pick.quantity, v_pick.storage_location_id, null, p_user_id,
      case when v_pick.picked_via = 'qr_scan' then 'qr_scan' else 'manual' end,
      v_pick.fefo_compliant,
      case when not v_pick.fefo_compliant then v_pick.fefo_note end,
      v_shipment.shipment_number,
      format('Pharmacy order %s', v_order.order_number),
      p_today,
      v_pick.id);

    insert into public.shipment_items (
      shipment_id, pharmacy_id, order_item_id, medicine_id, batch_id,
      quantity_shipped, units_per_pack, unit_cost, unit_price
    )
    values (
      v_shipment.id, v_order.pharmacy_id, v_pick.order_item_id, v_pick.medicine_id, v_pick.batch_id,
      v_pick.quantity, v_pick.units_per_pack, v_pick.unit_cost, v_pick.retail_price
    )
    on conflict (shipment_id, batch_id) do update
      set quantity_shipped = public.shipment_items.quantity_shipped + excluded.quantity_shipped;

    update public.warehouse_order_picks set status = 'dispatched', movement_id = v_movement.id where id = v_pick.id;
    v_total := v_total + v_pick.quantity;
  end loop;

  if v_total = 0 then
    raise exception 'Nothing to dispatch';
  end if;

  -- Fulfilment first: the order trigger below then sees it as finished.
  update public.warehouse_order_fulfilments
  set status = 'dispatched', shipment_id = v_shipment.id, dispatched_by = p_user_id, dispatched_at = now()
  where id = v_ful.id;
  update public.purchase_orders set status = 'dispatched', dispatched_at = now() where id = v_order.id;

  insert into public.warehouse_integration_events (target, event_type, entity_id, payload, status, completed_at)
  values (
    'cold_chain', 'shipment.dispatched', v_shipment.id,
    jsonb_build_object(
      'shipmentId', v_shipment.id,
      'shipmentNumber', v_shipment.shipment_number,
      'expectedDeliveryAt', nullif(p_cold_chain ->> 'expectedDeliveryAt', '')
    ),
    case when v_monitor then 'pending' else 'skipped' end,
    case when v_monitor then null else now() end
  )
  on conflict (target, event_type, entity_id) do nothing;

  perform public.pharmacy_audit(p_user_id, v_order.pharmacy_id, 'shipment.dispatched', 'shipment', v_shipment.id,
    jsonb_build_object('shipment_number', v_shipment.shipment_number, 'order_number', v_order.order_number,
                       'packs', v_total, 'fulfilment_id', v_ful.id));
  return v_shipment;
end;
$$;

-- Cancels an allocation and releases its reservations (the order stays
-- submitted and can be allocated again or declined). Idempotent.
create or replace function public.warehouse_cancel_fulfilment(
  p_fulfilment_id uuid,
  p_user_id       uuid,
  p_reason        text
)
returns public.warehouse_order_fulfilments
language plpgsql
set search_path = ''
as $$
declare
  v_ful   public.warehouse_order_fulfilments;
  v_order public.purchase_orders;
begin
  select * into v_ful from public.warehouse_order_fulfilments where id = p_fulfilment_id for update;
  if not found then
    raise exception 'Order fulfilment not found' using errcode = 'P0002';
  end if;
  if v_ful.status = 'cancelled' then
    return v_ful;
  end if;
  if v_ful.status = 'dispatched' then
    raise exception 'A dispatched order cannot be un-allocated';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'Give a reason for cancelling the allocation';
  end if;

  update public.warehouse_order_picks set status = 'released'
  where fulfilment_id = v_ful.id and status in ('reserved', 'picked');
  update public.warehouse_order_fulfilments
  set status = 'cancelled', cancelled_by = p_user_id, cancelled_at = now(), cancel_reason = btrim(p_reason)
  where id = v_ful.id
  returning * into v_ful;

  select * into v_order from public.purchase_orders where id = v_ful.order_id;
  perform public.pharmacy_audit(p_user_id, v_order.pharmacy_id, 'order.allocation_cancelled', 'purchase_order',
    v_order.id, jsonb_build_object('order_number', v_order.order_number, 'reason', v_ful.cancel_reason));
  return v_ful;
end;
$$;

-- When an order is cancelled (pharmacy or warehouse decline) or dispatched
-- outside this workflow (e.g. pharmacy_dispatch_order()), its live
-- allocation is closed and the reservations are released.
create or replace function public.warehouse_close_fulfilment_on_order_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status in ('cancelled', 'dispatched') and old.status is distinct from new.status then
    update public.warehouse_order_picks p set status = 'released'
    from public.warehouse_order_fulfilments f
    where p.fulfilment_id = f.id and f.order_id = new.id
      and f.status in ('allocated', 'picking', 'ready') and p.status in ('reserved', 'picked');
    update public.warehouse_order_fulfilments
    set status        = 'cancelled',
        cancelled_at  = now(),
        cancelled_by  = case when new.status = 'cancelled' then new.cancelled_by end,
        cancel_reason = case when new.status = 'cancelled'
                             then coalesce('Order cancelled: ' || new.cancel_reason, 'Order cancelled')
                             else 'Order dispatched outside the warehouse fulfilment' end
    where order_id = new.id and status in ('allocated', 'picking', 'ready');
  end if;
  return new;
end;
$$;

drop trigger if exists warehouse_close_fulfilment_on_order_change on public.purchase_orders;
create trigger warehouse_close_fulfilment_on_order_change
  after update of status on public.purchase_orders
  for each row execute function public.warehouse_close_fulfilment_on_order_change();

-- Dispatch of loose stock (not a pharmacy order) in FEFO order, all or
-- nothing, never touching reserved stock. A repeated p_client_request_id
-- returns the first result.
create or replace function public.warehouse_fefo_dispatch(
  p_warehouse_id      uuid,
  p_medicine_id       uuid,
  p_quantity          integer,
  p_user_id           uuid,
  p_reference         text default null,
  p_notes             text default null,
  p_today             date default ((now() at time zone 'Asia/Colombo')::date),
  p_client_request_id uuid default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_stock     record;
  v_remaining integer := p_quantity;
  v_take      integer;
  v_movement  public.inventory_movements;
  v_ids       uuid[] := '{}';
  v_first     boolean := true;
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be a positive whole number';
  end if;
  if p_client_request_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_client_request_id::text, 0));
    select * into v_movement from public.inventory_movements where client_request_id = p_client_request_id;
    if found then
      return jsonb_build_object('duplicate', true, 'movementIds',
        (select coalesce(jsonb_agg(id), '[]'::jsonb) from public.inventory_movements
         where reference is not distinct from v_movement.reference and created_at = v_movement.created_at
           and movement_type = 'dispatch'));
    end if;
  end if;

  perform public.warehouse_lock_medicine_stock(p_warehouse_id, p_medicine_id);

  for v_stock in
    select st.batch_id, st.storage_location_id,
           st.quantity - public.warehouse_reserved_quantity(st.batch_id, st.storage_location_id) as available
    from public.warehouse_stock st
    join public.batches b on b.id = st.batch_id
    join public.storage_locations l on l.id = st.storage_location_id
    join public.warehouse_racks r on r.id = l.rack_id
    join public.warehouse_zones z on z.id = r.zone_id
    where b.medicine_id = p_medicine_id
      and z.warehouse_id = p_warehouse_id
      and z.zone_type = 'storage'
      and b.status = 'active'
      and b.expiry_date >= p_today
    order by b.expiry_date, b.manufacturing_date nulls last, b.created_at,
             r.distance_to_dispatch_m, st.created_at, st.id
  loop
    exit when v_remaining = 0;
    continue when v_stock.available <= 0;
    v_take := least(v_remaining, v_stock.available);
    -- The request id goes on the first movement (it is unique per movement).
    v_movement := public.record_inventory_movement(
      v_stock.batch_id, 'dispatch', v_take, v_stock.storage_location_id, null, p_user_id, 'manual',
      true, null, nullif(btrim(p_reference), ''), nullif(btrim(p_notes), ''), p_today, null,
      case when v_first then p_client_request_id end);
    v_first := false;
    v_ids := v_ids || v_movement.id;
    v_remaining := v_remaining - v_take;
  end loop;

  if v_remaining > 0 then
    raise exception 'Only % unit(s) can be dispatched (FEFO-eligible, unreserved stock); % requested',
      p_quantity - v_remaining, p_quantity;
  end if;
  return jsonb_build_object('duplicate', false, 'movementIds', to_jsonb(v_ids), 'allocated', p_quantity);
end;
$$;

-- ---------------------------------------------------------------------------
-- Access: warehouse staff and admins only
-- ---------------------------------------------------------------------------

-- New tables: readable by warehouse staff / admins; written by the backend.
do $$
declare
  t text;
begin
  foreach t in array array[
    'warehouse_order_fulfilments', 'warehouse_order_picks', 'warehouse_integration_events', 'warehouse_scan_events'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "Warehouse staff can read" on public.%I', t);
    execute format(
      'create policy "Warehouse staff can read" on public.%I for select to authenticated
         using ((select public.is_warehouse_staff()))', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;

  -- Operational warehouse tables were readable by every signed-in user.
  -- Shared reference data (warehouses, medicines, batches) stays readable.
  foreach t in array array[
    'warehouse_zones', 'warehouse_racks', 'storage_locations', 'warehouse_stock',
    'batch_qr_codes', 'inventory_movements'
  ]
  loop
    execute format('drop policy if exists "Authenticated users can read" on public.%I', t);
    execute format('drop policy if exists "Warehouse staff can read" on public.%I', t);
    execute format(
      'create policy "Warehouse staff can read" on public.%I for select to authenticated
         using ((select public.is_warehouse_staff()))', t);
  end loop;
end;
$$;

drop trigger if exists warehouse_order_fulfilments_set_updated_at on public.warehouse_order_fulfilments;
create trigger warehouse_order_fulfilments_set_updated_at
  before update on public.warehouse_order_fulfilments
  for each row execute function public.set_updated_at();
drop trigger if exists warehouse_integration_events_set_updated_at on public.warehouse_integration_events;
create trigger warehouse_integration_events_set_updated_at
  before update on public.warehouse_integration_events
  for each row execute function public.set_updated_at();

-- Only the backend (service role) may run these.
do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('record_inventory_movement', 'warehouse_reserved_quantity', 'warehouse_lock_medicine_stock',
                        'warehouse_allocate_order', 'warehouse_confirm_pick', 'warehouse_dispatch_fulfilment',
                        'warehouse_cancel_fulfilment', 'warehouse_fefo_dispatch')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
