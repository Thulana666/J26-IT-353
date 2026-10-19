-- Component 2 update: logistics workflow for monitored shipments.
--
--   cold_chain_drivers   drivers (licence, contact, availability)
--   cold_chain_trucks    trucks (registration, refrigeration range, installed sensor device)
--   cold_chain_shipments + trip: driver, truck, trip status and delivery record
--
-- Trip status (cold_chain_shipments.trip_status):
--   ready_for_dispatch -> allocated -> in_transit -> delivered
-- A shipment arrives as ready_for_dispatch when the warehouse hands it over
-- (POST /api/cold-chain/shipments, unchanged). Allocation assigns a driver
-- and a truck (and the truck's sensor device); starting the trip opens the
-- reading window; delivery closes it, records the final readings and frees
-- the driver and the truck. Component 4's shipments.status is not changed:
-- the pharmacy still confirms receipt itself.
--
-- Driver and truck status (available / assigned / on_trip or in_use /
-- inactive) change only through the functions below, in the same
-- transaction as the trip, with row locks; partial unique indexes make a
-- double allocation impossible even if two requests race.
--
-- Additive and backward compatible: existing rows are backfilled (see the end).

-- ---------------------------------------------------------------------------
-- Drivers and trucks
-- ---------------------------------------------------------------------------

create table if not exists public.cold_chain_drivers (
  id              uuid primary key default gen_random_uuid(),
  full_name       text not null check (length(btrim(full_name)) between 2 and 120),
  phone           text not null check (phone ~ '^\+?[0-9][0-9 ()-]{6,19}$'),
  email           text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  licence_number  text not null unique check (length(btrim(licence_number)) between 3 and 40),
  licence_expiry  date not null,
  status          text not null default 'available' check (status in ('available', 'assigned', 'on_trip', 'inactive')),
  notes           text check (length(notes) <= 500),
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.cold_chain_trucks (
  id                  uuid primary key default gen_random_uuid(),
  registration_number text not null unique check (length(btrim(registration_number)) between 2 and 20),
  truck_type          text not null
                      check (truck_type in ('refrigerated_truck', 'refrigerated_van', 'insulated_van', 'standard_truck', 'standard_van')),
  is_refrigerated     boolean not null default false,
  -- Temperature range the refrigeration unit can hold (refrigerated trucks only).
  min_temp_c          numeric(5, 2),
  max_temp_c          numeric(5, 2),
  -- Sensor logger installed in the truck; allocation assigns it to the trip.
  device_id           uuid unique references public.cold_chain_devices (id) on delete set null,
  status              text not null default 'available' check (status in ('available', 'assigned', 'in_use', 'inactive')),
  notes               text check (length(notes) <= 500),
  created_by          uuid references auth.users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (is_refrigerated = (min_temp_c is not null and max_temp_c is not null)),
  check (min_temp_c is null or min_temp_c < max_temp_c)
);

-- ---------------------------------------------------------------------------
-- Trip columns on monitored shipments
-- ---------------------------------------------------------------------------

alter table public.cold_chain_shipments
  add column if not exists trip_status         text not null default 'ready_for_dispatch',
  add column if not exists driver_id           uuid references public.cold_chain_drivers (id) on delete restrict,
  add column if not exists truck_id            uuid references public.cold_chain_trucks (id) on delete restrict,
  add column if not exists allocated_at        timestamptz,
  add column if not exists allocated_by        uuid references auth.users (id) on delete set null,
  add column if not exists trip_started_at     timestamptz,
  add column if not exists trip_started_by     uuid references auth.users (id) on delete set null,
  add column if not exists delivered_at        timestamptz,
  add column if not exists delivered_by        uuid references auth.users (id) on delete set null,
  add column if not exists delivery_notes      text,
  -- Newest sensor values when the trip was marked delivered.
  add column if not exists final_reading_at    timestamptz,
  add column if not exists final_temperature_c numeric(5, 2),
  add column if not exists final_humidity_pct  numeric(5, 2),
  add column if not exists final_latitude      numeric(9, 6),
  add column if not exists final_longitude     numeric(9, 6);

alter table public.cold_chain_shipments
  drop constraint if exists cold_chain_shipments_trip_status_check,
  add constraint cold_chain_shipments_trip_status_check
    check (trip_status in ('ready_for_dispatch', 'allocated', 'in_transit', 'delivered')),
  drop constraint if exists cold_chain_shipments_allocated_check,
  add constraint cold_chain_shipments_allocated_check
    check (trip_status <> 'allocated' or (driver_id is not null and truck_id is not null)),
  drop constraint if exists cold_chain_shipments_started_check,
  add constraint cold_chain_shipments_started_check
    check (trip_status not in ('in_transit', 'delivered') or trip_started_at is not null),
  drop constraint if exists cold_chain_shipments_delivered_check,
  add constraint cold_chain_shipments_delivered_check
    check ((trip_status = 'delivered') = (delivered_at is not null)),
  drop constraint if exists cold_chain_shipments_delivery_notes_check,
  add constraint cold_chain_shipments_delivery_notes_check check (length(delivery_notes) <= 1000);

-- A driver or truck serves one live trip at a time.
create unique index if not exists cold_chain_shipments_live_driver
  on public.cold_chain_shipments (driver_id) where trip_status in ('allocated', 'in_transit');
create unique index if not exists cold_chain_shipments_live_truck
  on public.cold_chain_shipments (truck_id) where trip_status in ('allocated', 'in_transit');
create index if not exists cold_chain_shipments_trip_idx
  on public.cold_chain_shipments (trip_status, delivered_at desc);

-- ---------------------------------------------------------------------------
-- Readings only while the trip runs (buffered uploads after delivery stay
-- possible: the backend checks they were recorded before delivery).
-- ---------------------------------------------------------------------------

create or replace function public.cold_chain_set_pharmacy()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_is_test     boolean;
  v_trip_status text;
begin
  select c.pharmacy_id, c.is_test, c.trip_status into new.pharmacy_id, v_is_test, v_trip_status
  from public.cold_chain_shipments c
  where c.shipment_id = new.shipment_id;
  if new.pharmacy_id is null then
    raise exception 'Shipment is not monitored' using errcode = 'P0002';
  end if;
  if tg_table_name = 'cold_chain_readings' then
    if new.source = 'simulator' and not v_is_test then
      raise exception 'Simulated readings can only be stored for test shipments' using errcode = 'P0001';
    end if;
    if v_trip_status not in ('in_transit', 'delivered') then
      raise exception 'The trip of this shipment has not started' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Workflow functions (backend only)
-- ---------------------------------------------------------------------------

-- Allocates (or re-allocates, before the trip starts) a driver, a truck and a
-- sensor device: p_device_id, else the truck's installed device, else the
-- device already on the shipment.
create or replace function public.cold_chain_allocate_trip(
  p_shipment_id uuid,
  p_driver_id   uuid,
  p_truck_id    uuid,
  p_device_id   uuid default null,
  p_user_id     uuid default null,
  p_today       date default ((now() at time zone 'Asia/Colombo')::date)
)
returns public.cold_chain_shipments
language plpgsql
set search_path = ''
as $$
declare
  v_trip   public.cold_chain_shipments;
  v_number text;
  v_driver public.cold_chain_drivers;
  v_truck  public.cold_chain_trucks;
  v_device public.cold_chain_devices;
  v_device_id uuid;
  v_busy   text;
begin
  select * into v_trip from public.cold_chain_shipments where shipment_id = p_shipment_id for update;
  if not found then
    raise exception 'Monitored shipment not found' using errcode = 'P0002';
  end if;
  select shipment_number into v_number from public.shipments where id = p_shipment_id;
  if v_trip.trip_status not in ('ready_for_dispatch', 'allocated') then
    raise exception 'Shipment % is %; only shipments ready for dispatch or allocated can be allocated',
      v_number, replace(v_trip.trip_status, '_', ' ');
  end if;

  select * into v_driver from public.cold_chain_drivers where id = p_driver_id for update;
  if not found then
    raise exception 'Driver not found' using errcode = 'P0002';
  end if;
  if v_driver.status = 'inactive' then
    raise exception 'Driver % is inactive', v_driver.full_name;
  end if;
  if v_driver.status <> 'available' and v_trip.driver_id is distinct from v_driver.id then
    raise exception 'Driver % is not available (%)', v_driver.full_name, replace(v_driver.status, '_', ' ');
  end if;
  if v_driver.licence_expiry < p_today then
    raise exception 'The driving licence of % expired on %', v_driver.full_name, v_driver.licence_expiry;
  end if;

  select * into v_truck from public.cold_chain_trucks where id = p_truck_id for update;
  if not found then
    raise exception 'Truck not found' using errcode = 'P0002';
  end if;
  if v_truck.status = 'inactive' then
    raise exception 'Truck % is inactive', v_truck.registration_number;
  end if;
  if v_truck.status <> 'available' and v_trip.truck_id is distinct from v_truck.id then
    raise exception 'Truck % is not available (%)', v_truck.registration_number, replace(v_truck.status, '_', ' ');
  end if;
  -- Temperature-controlled goods need a refrigerated truck that can hold their range.
  if v_trip.storage_condition <> 'ambient' then
    if not v_truck.is_refrigerated then
      raise exception 'Truck % is not refrigerated; shipment % needs % to % °C',
        v_truck.registration_number, v_number, v_trip.temp_min_c, v_trip.temp_max_c;
    end if;
    if v_truck.min_temp_c > v_trip.temp_min_c or v_truck.max_temp_c < v_trip.temp_max_c then
      raise exception 'Truck % holds % to % °C; shipment % needs % to % °C',
        v_truck.registration_number, v_truck.min_temp_c, v_truck.max_temp_c, v_number, v_trip.temp_min_c, v_trip.temp_max_c;
    end if;
  end if;

  v_device_id := coalesce(p_device_id, v_truck.device_id, v_trip.device_id);
  if v_device_id is not null then
    select * into v_device from public.cold_chain_devices where id = v_device_id;
    if not found then
      raise exception 'Device not found' using errcode = 'P0002';
    end if;
    if not v_device.is_active then
      raise exception 'Device % is deactivated', v_device.device_code;
    end if;
    if v_device.device_type = 'simulator' and not v_trip.is_test then
      raise exception 'A simulator can only be assigned to a test shipment';
    end if;
    select s.shipment_number into v_busy
    from public.cold_chain_shipments c join public.shipments s on s.id = c.shipment_id
    where c.device_id = v_device_id and c.monitoring_status = 'active' and c.shipment_id <> p_shipment_id
    limit 1;
    if v_busy is not null then
      raise exception 'Device % is already reporting for shipment %', v_device.device_code, v_busy;
    end if;
  end if;

  -- Re-allocation frees the previous driver and truck.
  if v_trip.driver_id is not null and v_trip.driver_id <> v_driver.id then
    update public.cold_chain_drivers set status = 'available' where id = v_trip.driver_id and status = 'assigned';
  end if;
  if v_trip.truck_id is not null and v_trip.truck_id <> v_truck.id then
    update public.cold_chain_trucks set status = 'available' where id = v_trip.truck_id and status = 'assigned';
  end if;

  update public.cold_chain_drivers set status = 'assigned' where id = v_driver.id;
  update public.cold_chain_trucks set status = 'assigned' where id = v_truck.id;
  update public.cold_chain_shipments
     set driver_id = v_driver.id,
         truck_id = v_truck.id,
         device_id = v_device_id,
         trip_status = 'allocated',
         allocated_at = now(),
         allocated_by = p_user_id
   where shipment_id = p_shipment_id
  returning * into v_trip;
  return v_trip;
end;
$$;

-- Starts the trip: readings are accepted from now on.
create or replace function public.cold_chain_start_trip(p_shipment_id uuid, p_user_id uuid default null)
returns public.cold_chain_shipments
language plpgsql
set search_path = ''
as $$
declare
  v_trip     public.cold_chain_shipments;
  v_shipment public.shipments;
begin
  select * into v_trip from public.cold_chain_shipments where shipment_id = p_shipment_id for update;
  if not found then
    raise exception 'Monitored shipment not found' using errcode = 'P0002';
  end if;
  select * into v_shipment from public.shipments where id = p_shipment_id;
  if v_trip.trip_status = 'in_transit' then
    return v_trip;  -- already started: repeating the request changes nothing
  end if;
  if v_trip.trip_status <> 'allocated' then
    raise exception 'Shipment % is %; allocate a driver and a truck first',
      v_shipment.shipment_number, replace(v_trip.trip_status, '_', ' ');
  end if;
  if v_trip.device_id is null then
    raise exception 'Shipment % has no sensor device: install one in the truck or choose one when allocating',
      v_shipment.shipment_number;
  end if;
  if v_shipment.status <> 'in_transit' then
    raise exception 'Shipment % was already received by the pharmacy', v_shipment.shipment_number;
  end if;

  update public.cold_chain_drivers set status = 'on_trip' where id = v_trip.driver_id;
  update public.cold_chain_trucks set status = 'in_use' where id = v_trip.truck_id;
  update public.cold_chain_shipments
     set trip_status = 'in_transit',
         trip_started_at = now(),
         trip_started_by = p_user_id,
         started_at = now(),
         monitoring_status = 'active',
         ended_at = null
   where shipment_id = p_shipment_id
  returning * into v_trip;
  return v_trip;
end;
$$;

-- Marks the trip delivered: records the newest readings, closes the reading
-- window (buffered readings recorded before now are still accepted) and frees
-- the driver and the truck. Sensor history is kept.
create or replace function public.cold_chain_deliver_trip(
  p_shipment_id uuid,
  p_user_id     uuid default null,
  p_notes       text default null
)
returns public.cold_chain_shipments
language plpgsql
set search_path = ''
as $$
declare
  v_trip   public.cold_chain_shipments;
  v_number text;
  v_last   public.cold_chain_readings;
  v_fix    public.cold_chain_readings;
begin
  select * into v_trip from public.cold_chain_shipments where shipment_id = p_shipment_id for update;
  if not found then
    raise exception 'Monitored shipment not found' using errcode = 'P0002';
  end if;
  if v_trip.trip_status = 'delivered' then
    return v_trip;  -- already delivered: repeating the request changes nothing
  end if;
  select shipment_number into v_number from public.shipments where id = p_shipment_id;
  if v_trip.trip_status <> 'in_transit' then
    raise exception 'Shipment % is %; only a trip in transit can be delivered',
      v_number, replace(v_trip.trip_status, '_', ' ');
  end if;

  select * into v_last from public.cold_chain_readings
  where shipment_id = p_shipment_id order by recorded_at desc limit 1;
  select * into v_fix from public.cold_chain_readings
  where shipment_id = p_shipment_id and latitude is not null order by recorded_at desc limit 1;

  update public.cold_chain_drivers set status = 'available' where id = v_trip.driver_id and status <> 'inactive';
  update public.cold_chain_trucks set status = 'available' where id = v_trip.truck_id and status <> 'inactive';
  update public.cold_chain_shipments
     set trip_status = 'delivered',
         delivered_at = now(),
         delivered_by = p_user_id,
         delivery_notes = nullif(btrim(p_notes), ''),
         final_reading_at = v_last.recorded_at,
         final_temperature_c = v_last.temperature_c,
         final_humidity_pct = v_last.humidity_pct,
         final_latitude = v_fix.latitude,
         final_longitude = v_fix.longitude,
         monitoring_status = 'ended',
         ended_at = greatest(now(), started_at)
   where shipment_id = p_shipment_id
  returning * into v_trip;
  return v_trip;
end;
$$;

do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('cold_chain_allocate_trip', 'cold_chain_start_trip', 'cold_chain_deliver_trip')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Shipment summaries (history): readings, limit crossings, alerts, risk.
-- ---------------------------------------------------------------------------

create or replace view public.cold_chain_shipment_summaries
with (security_invoker = true) as
select
  c.shipment_id,
  r.readings,
  r.first_reading_at,
  r.last_reading_at,
  r.temperature_min,
  r.temperature_max,
  r.temperature_avg,
  r.temperature_outside,
  r.humidity_min,
  r.humidity_max,
  r.humidity_avg,
  r.humidity_outside,
  (select count(*) from public.cold_chain_alerts a where a.shipment_id = c.shipment_id)::int as alerts,
  (select count(*) from public.cold_chain_alerts a where a.shipment_id = c.shipment_id and a.risk_level = 'high')::int as high_alerts,
  (select max(p.risk_probability) from public.cold_chain_risk_predictions p where p.shipment_id = c.shipment_id) as max_risk_probability
from public.cold_chain_shipments c
left join lateral (
  select
    count(*)::int as readings,
    min(x.recorded_at) as first_reading_at,
    max(x.recorded_at) as last_reading_at,
    min(x.temperature_c) as temperature_min,
    max(x.temperature_c) as temperature_max,
    round(avg(x.temperature_c), 2) as temperature_avg,
    count(*) filter (where x.temperature_c > c.temp_max_c or x.temperature_c < c.temp_min_c)::int as temperature_outside,
    min(x.humidity_pct) as humidity_min,
    max(x.humidity_pct) as humidity_max,
    round(avg(x.humidity_pct), 1) as humidity_avg,
    count(*) filter (where x.humidity_pct > c.humidity_max_pct or x.humidity_pct < c.humidity_min_pct)::int as humidity_outside
  from public.cold_chain_readings x
  where x.shipment_id = c.shipment_id
) r on true;

-- ---------------------------------------------------------------------------
-- Triggers, row level security, grants
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['cold_chain_drivers', 'cold_chain_trucks']
  loop
    execute format('drop trigger if exists %1$s_set_updated_at on public.%1$I', t);
    execute format(
      'create trigger %1$s_set_updated_at before update on public.%1$I
         for each row execute function public.set_updated_at()', t);
    -- Drivers hold personal data: admins and warehouse staff only.
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "Warehouse staff can read" on public.%I', t);
    execute format(
      'create policy "Warehouse staff can read" on public.%I for select to authenticated using (public.is_warehouse_staff())', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end;
$$;

grant select on public.cold_chain_shipment_summaries to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Backfill monitored shipments created before this migration
-- ---------------------------------------------------------------------------

-- Received by the pharmacy: the trip is over.
update public.cold_chain_shipments c
   set trip_status = 'delivered',
       trip_started_at = c.started_at,
       delivered_at = greatest(s.received_at, c.started_at),
       monitoring_status = 'ended',
       ended_at = greatest(s.received_at, c.started_at)
  from public.shipments s
 where s.id = c.shipment_id
   and c.trip_status = 'ready_for_dispatch'
   and s.status <> 'in_transit'
   and s.received_at is not null;

-- Already sending readings: monitoring started before allocation existed.
update public.cold_chain_shipments c
   set trip_status = 'in_transit',
       trip_started_at = c.started_at
 where c.trip_status = 'ready_for_dispatch'
   and c.monitoring_status = 'active'
   and exists (select 1 from public.cold_chain_readings r where r.shipment_id = c.shipment_id);
