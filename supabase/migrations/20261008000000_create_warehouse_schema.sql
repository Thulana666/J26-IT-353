-- Component 3: Intelligent Warehouse FEFO & QR Management.
--
-- Shared tables (other components can reference them):
--   medicines            medicine master data, linked to medicine_categories
--   batches              manufacturer batches of a medicine (batch number, expiry)
-- Component 3 tables:
--   warehouses > warehouse_zones > warehouse_racks > storage_locations
--   warehouse_stock      quantity of a batch held at a storage location
--   batch_qr_codes       QR identifiers printed on batch labels
--   inventory_movements  append-only movement history
--
-- Quantities and capacities are both counted in storage units (e.g. cartons);
-- medicines.unit says what one unit of that medicine is.
--
-- Reuses public.set_updated_at() and public.is_admin() from earlier migrations.
--
-- Access model (same as the other modules):
--   * Signed-in users can read everything.
--   * Master data can be written directly only by active admins; the backend
--     uses the service-role key and applies its own role checks.
--   * Stock and movements change only through record_inventory_movement(),
--     which only the service role may call, so stock always matches history.

-- ---------------------------------------------------------------------------
-- Shared: medicines and batches
-- ---------------------------------------------------------------------------

create table if not exists public.medicines (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  generic_name         text,
  medicine_category_id uuid references public.medicine_categories (id) on delete set null,
  dosage_form          text,
  strength             text,
  unit                 text not null default 'pack',
  -- ambient 15-30 C, cool 8-15 C, refrigerated 2-8 C, frozen -15 C or below.
  storage_condition    text not null default 'ambient'
                       check (storage_condition in ('ambient', 'cool', 'refrigerated', 'frozen')),
  -- Controlled medicines must be stored in secure zones.
  is_controlled        boolean not null default false,
  is_active            boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique nulls not distinct (name, strength, dosage_form)
);

-- "Expired" and "depleted" are derived (expiry_date, stock), not stored.
create table if not exists public.batches (
  id                 uuid primary key default gen_random_uuid(),
  medicine_id        uuid not null references public.medicines (id) on delete restrict,
  batch_number       text not null,
  manufacturing_date date,
  -- Last day the batch may be used.
  expiry_date        date not null,
  supplier           text,
  status             text not null default 'active'
                     check (status in ('active', 'quarantined', 'recalled', 'disposed')),
  notes              text,
  created_by         uuid references auth.users (id) on delete set null default auth.uid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (medicine_id, batch_number),
  check (manufacturing_date is null or manufacturing_date < expiry_date)
);

-- ---------------------------------------------------------------------------
-- Component 3: warehouse structure
-- ---------------------------------------------------------------------------

create table if not exists public.warehouses (
  id                   uuid primary key default gen_random_uuid(),
  code                 text not null unique,
  name                 text not null,
  -- District/city from the shared locations table, for the digital twin map.
  location_id          uuid references public.locations (id) on delete set null,
  address              text,
  -- FEFO warning thresholds (days before expiry).
  near_expiry_days     integer not null default 90,
  critical_expiry_days integer not null default 30,
  is_active            boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (critical_expiry_days > 0 and near_expiry_days > critical_expiry_days)
);

create table if not exists public.warehouse_zones (
  id                uuid primary key default gen_random_uuid(),
  warehouse_id      uuid not null references public.warehouses (id) on delete cascade,
  code              text not null,
  name              text not null,
  -- quarantine zones hold quarantined, recalled or expired stock only.
  zone_type         text not null default 'storage'
                    check (zone_type in ('storage', 'quarantine')),
  storage_condition text not null default 'ambient'
                    check (storage_condition in ('ambient', 'cool', 'refrigerated', 'frozen')),
  min_temp_c        numeric(5, 2),
  max_temp_c        numeric(5, 2),
  is_secure         boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (warehouse_id, code),
  check (min_temp_c is null or max_temp_c is null or min_temp_c <= max_temp_c)
);

create table if not exists public.warehouse_racks (
  id                     uuid primary key default gen_random_uuid(),
  zone_id                uuid not null references public.warehouse_zones (id) on delete cascade,
  code                   text not null,
  -- Walking distance to the dispatch area (picking effort).
  distance_to_dispatch_m numeric(7, 2) not null default 0 check (distance_to_dispatch_m >= 0),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (zone_id, code)
);

create table if not exists public.storage_locations (
  id             uuid primary key default gen_random_uuid(),
  rack_id        uuid not null references public.warehouse_racks (id) on delete cascade,
  code           text not null,
  -- Shelf level, 1 = floor.
  level          smallint not null default 1 check (level >= 1),
  capacity_units integer not null check (capacity_units > 0),
  -- How easy the location is to reach (high = waist height near the aisle).
  accessibility  text not null default 'medium'
                 check (accessibility in ('high', 'medium', 'low')),
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (rack_id, code)
);

-- ---------------------------------------------------------------------------
-- Component 3: stock, QR codes and movements
-- ---------------------------------------------------------------------------

-- One row per batch per location; rows are removed when they reach zero.
create table if not exists public.warehouse_stock (
  id                  uuid primary key default gen_random_uuid(),
  batch_id            uuid not null references public.batches (id) on delete restrict,
  storage_location_id uuid not null references public.storage_locations (id) on delete restrict,
  quantity            integer not null check (quantity > 0),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (batch_id, storage_location_id)
);

-- The QR image encodes only `payload` (an opaque code); everything else is
-- looked up, so labels never show stale data.
create table if not exists public.batch_qr_codes (
  id             uuid primary key default gen_random_uuid(),
  batch_id       uuid not null references public.batches (id) on delete cascade,
  code           text not null unique,
  payload        text not null unique,
  is_active      boolean not null default true,
  created_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  deactivated_at timestamptz,
  check (is_active = (deactivated_at is null))
);

create table if not exists public.inventory_movements (
  id                   uuid primary key default gen_random_uuid(),
  batch_id             uuid not null references public.batches (id) on delete restrict,
  movement_type        text not null
                       check (movement_type in ('receive', 'transfer', 'dispatch', 'adjustment', 'disposal')),
  quantity             integer not null check (quantity > 0),
  from_location_id     uuid references public.storage_locations (id) on delete restrict,
  to_location_id       uuid references public.storage_locations (id) on delete restrict,
  performed_by         uuid references auth.users (id) on delete set null,
  performed_via        text not null default 'manual'
                       check (performed_via in ('manual', 'qr_scan', 'system')),
  -- Dispatches only: was this the earliest-expiring eligible batch?
  fefo_compliant       boolean,
  fefo_override_reason text,
  -- Delivery note, order number or destination.
  reference            text,
  notes                text,
  created_at           timestamptz not null default now(),
  check (case movement_type
    when 'receive'    then from_location_id is null and to_location_id is not null
    when 'transfer'   then from_location_id is not null and to_location_id is not null
                           and from_location_id <> to_location_id
    when 'dispatch'   then from_location_id is not null and to_location_id is null
    when 'disposal'   then from_location_id is not null and to_location_id is null
    -- Stock count correction: out of (from) or into (to) one location.
    when 'adjustment' then (from_location_id is null) <> (to_location_id is null)
  end),
  check (movement_type = 'dispatch' or (fefo_compliant is null and fefo_override_reason is null)),
  check (fefo_compliant is distinct from false or fefo_override_reason is not null)
);

-- ---------------------------------------------------------------------------
-- Indexes (unique constraints above already cover their leading columns)
-- ---------------------------------------------------------------------------
create index if not exists medicines_category_idx on public.medicines (medicine_category_id);
create index if not exists batches_expiry_date_idx on public.batches (expiry_date);
create index if not exists warehouses_location_id_idx on public.warehouses (location_id);
create index if not exists warehouse_stock_location_idx on public.warehouse_stock (storage_location_id);
create unique index if not exists batch_qr_codes_one_active_per_batch
  on public.batch_qr_codes (batch_id) where is_active;
create index if not exists inventory_movements_batch_idx on public.inventory_movements (batch_id, created_at desc);
create index if not exists inventory_movements_created_at_idx on public.inventory_movements (created_at desc);
create index if not exists inventory_movements_from_idx on public.inventory_movements (from_location_id);
create index if not exists inventory_movements_to_idx on public.inventory_movements (to_location_id);

-- ---------------------------------------------------------------------------
-- Read views: current warehouse state (digital-twin ready)
-- security_invoker so the caller's row level security applies.
-- ---------------------------------------------------------------------------

create or replace view public.storage_location_overview
with (security_invoker = true) as
select
  l.id                                           as storage_location_id,
  l.code                                         as location_code,
  l.level,
  l.accessibility,
  l.capacity_units,
  coalesce(s.occupied_units, 0)::integer         as occupied_units,
  (l.capacity_units - coalesce(s.occupied_units, 0))::integer as available_units,
  coalesce(s.batch_count, 0)::integer            as batch_count,
  l.is_active,
  r.id                                           as rack_id,
  r.code                                         as rack_code,
  r.distance_to_dispatch_m,
  z.id                                           as zone_id,
  z.code                                         as zone_code,
  z.name                                         as zone_name,
  z.zone_type,
  z.storage_condition,
  z.is_secure,
  w.id                                           as warehouse_id,
  w.code                                         as warehouse_code,
  w.name                                         as warehouse_name
from public.storage_locations l
join public.warehouse_racks r on r.id = l.rack_id
join public.warehouse_zones z on z.id = r.zone_id
join public.warehouses w on w.id = z.warehouse_id
left join (
  select storage_location_id, sum(quantity) as occupied_units, count(*) as batch_count
  from public.warehouse_stock
  group by storage_location_id
) s on s.storage_location_id = l.id;

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
  w.name                   as warehouse_name
from public.warehouse_stock st
join public.batches b on b.id = st.batch_id
join public.medicines m on m.id = b.medicine_id
join public.storage_locations l on l.id = st.storage_location_id
join public.warehouse_racks r on r.id = l.rack_id
join public.warehouse_zones z on z.id = r.zone_id
join public.warehouses w on w.id = z.warehouse_id;

-- Movements with the warehouse they happened in (from the source location,
-- else the destination; a movement never spans two warehouses).
create or replace view public.inventory_movement_overview
with (security_invoker = true) as
select mv.*, z.warehouse_id
from public.inventory_movements mv
left join public.storage_locations l on l.id = coalesce(mv.from_location_id, mv.to_location_id)
left join public.warehouse_racks r on r.id = l.rack_id
left join public.warehouse_zones z on z.id = r.zone_id;

-- ---------------------------------------------------------------------------
-- record_inventory_movement(): the only way stock changes.
--
-- Runs in one transaction: locks the batch, the source stock row and the
-- destination location, checks stock, capacity and storage compatibility,
-- updates warehouse_stock and appends to inventory_movements.
-- Business-rule violations raise P0001, missing rows raise P0002.
-- p_today lets the backend use the warehouse's local date.
-- ---------------------------------------------------------------------------
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
  p_today                date default current_date
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
  v_needs_quarantine boolean;
  v_movement         public.inventory_movements;
begin
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

  -- Take stock out of the source location.
  if p_from_location_id is not null then
    select * into v_from_stock
    from public.warehouse_stock
    where batch_id = p_batch_id and storage_location_id = p_from_location_id
    for no key update;
    if not found then
      raise exception 'Batch % is not stored at the source location', v_batch.batch_number;
    end if;
    if v_from_stock.quantity < p_quantity then
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
    performed_by, performed_via, fefo_compliant, fefo_override_reason, reference, notes
  )
  values (
    p_batch_id, p_movement_type, p_quantity, p_from_location_id, p_to_location_id,
    p_performed_by, p_performed_via, p_fefo_compliant, p_fefo_override_reason, p_reference, p_notes
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

-- Only the backend (service role) may change stock.
revoke execute on function public.record_inventory_movement(
  uuid, text, integer, uuid, uuid, uuid, text, boolean, text, text, text, date
) from public, anon, authenticated;
grant execute on function public.record_inventory_movement(
  uuid, text, integer, uuid, uuid, uuid, text, boolean, text, text, text, date
) to service_role;

-- ---------------------------------------------------------------------------
-- updated_at triggers, row level security, policies and grants
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  -- Master data: everyone signed in reads, active admins write.
  foreach t in array array[
    'medicines', 'batches', 'warehouses', 'warehouse_zones', 'warehouse_racks',
    'storage_locations', 'batch_qr_codes'
  ]
  loop
    -- batch_qr_codes has no updated_at column.
    if t <> 'batch_qr_codes' then
      execute format('drop trigger if exists %1$s_set_updated_at on public.%1$I', t);
      execute format(
        'create trigger %1$s_set_updated_at before update on public.%1$I
           for each row execute function public.set_updated_at()', t);
    end if;

    execute format('alter table public.%I enable row level security', t);

    execute format('drop policy if exists "Authenticated users can read" on public.%I', t);
    execute format(
      'create policy "Authenticated users can read" on public.%I
         for select to authenticated using (true)', t);

    execute format('drop policy if exists "Admins can insert" on public.%I', t);
    execute format(
      'create policy "Admins can insert" on public.%I
         for insert to authenticated with check ((select public.is_admin()))', t);

    execute format('drop policy if exists "Admins can update" on public.%I', t);
    execute format(
      'create policy "Admins can update" on public.%I
         for update to authenticated
         using ((select public.is_admin())) with check ((select public.is_admin()))', t);

    execute format('drop policy if exists "Admins can delete" on public.%I', t);
    execute format(
      'create policy "Admins can delete" on public.%I
         for delete to authenticated using ((select public.is_admin()))', t);

    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;

  -- Stock and movements: read-only for users; written by record_inventory_movement().
  foreach t in array array['warehouse_stock', 'inventory_movements']
  loop
    if t = 'warehouse_stock' then
      execute format('drop trigger if exists %1$s_set_updated_at on public.%1$I', t);
      execute format(
        'create trigger %1$s_set_updated_at before update on public.%1$I
           for each row execute function public.set_updated_at()', t);
    end if;

    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "Authenticated users can read" on public.%I', t);
    execute format(
      'create policy "Authenticated users can read" on public.%I
         for select to authenticated using (true)', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end;
$$;

grant select on public.storage_location_overview to authenticated, service_role;
grant select on public.warehouse_stock_overview to authenticated, service_role;
grant select on public.inventory_movement_overview to authenticated, service_role;
