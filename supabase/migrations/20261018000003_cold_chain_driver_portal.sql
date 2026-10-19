-- Component 2 update: Driver Portal.
--
-- Drivers sign in with the existing Supabase accounts (profiles); there is no
-- second authentication system:
--   * profiles.role gains 'driver' (additive; existing roles unchanged)
--   * cold_chain_drivers.profile_id links a driver record to the driver's account
--     (set by admins / warehouse staff in Cold Chain -> Drivers)
--   * cold_chain_issues: problems a driver reports during a trip
--   * cold_chain_deliver_trip(): only the assigned driver's account can confirm
--     delivery (warehouse staff and admins cannot; the backend checks it too)
--   * drivers can read their own trips, readings, alerts, predictions and
--     issues (row level security; used for Realtime on the portal)

-- ---------------------------------------------------------------------------
-- Driver accounts
-- ---------------------------------------------------------------------------

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin', 'user', 'pharmacy_staff', 'warehouse_staff', 'driver'));

alter table public.cold_chain_drivers
  add column if not exists profile_id uuid unique references public.profiles (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Issues reported by drivers
-- ---------------------------------------------------------------------------

create table if not exists public.cold_chain_issues (
  id               uuid primary key default gen_random_uuid(),
  shipment_id      uuid not null references public.cold_chain_shipments (shipment_id) on delete cascade,
  -- Copied from the monitored shipment (trigger), for row level security.
  pharmacy_id      uuid not null references public.pharmacies (id) on delete cascade,
  driver_id        uuid references public.cold_chain_drivers (id) on delete set null,
  reported_by      uuid references auth.users (id) on delete set null,
  issue_type       text not null
                   check (issue_type in ('vehicle', 'temperature', 'gps', 'delay', 'pharmacy_unavailable',
                                         'damaged', 'route', 'other')),
  description      text not null check (length(btrim(description)) between 3 and 1000),
  -- Snapshot of the truck sensor's newest reading when the issue was reported.
  reading_at       timestamptz,
  latitude         numeric(9, 6),
  longitude        numeric(9, 6),
  temperature_c    numeric(5, 2),
  humidity_pct     numeric(5, 2),
  status           text not null default 'open' check (status in ('open', 'in_review', 'resolved')),
  resolution_notes text check (length(resolution_notes) <= 1000),
  resolved_by      uuid references auth.users (id) on delete set null,
  resolved_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check ((status = 'resolved') = (resolved_at is not null))
);

create index if not exists cold_chain_issues_shipment_idx on public.cold_chain_issues (shipment_id, created_at desc);

drop trigger if exists cold_chain_issues_set_pharmacy on public.cold_chain_issues;
create trigger cold_chain_issues_set_pharmacy
  before insert or update of shipment_id on public.cold_chain_issues
  for each row execute function public.cold_chain_set_pharmacy();

drop trigger if exists cold_chain_issues_set_updated_at on public.cold_chain_issues;
create trigger cold_chain_issues_set_updated_at
  before update on public.cold_chain_issues
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Delivery: only the assigned driver
-- ---------------------------------------------------------------------------

-- Same as in 20261018000002, plus: p_user_id must be the account linked to
-- the trip's driver.
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
  v_trip    public.cold_chain_shipments;
  v_number  text;
  v_profile uuid;
  v_last    public.cold_chain_readings;
  v_fix     public.cold_chain_readings;
begin
  select * into v_trip from public.cold_chain_shipments where shipment_id = p_shipment_id for update;
  if not found then
    raise exception 'Monitored shipment not found' using errcode = 'P0002';
  end if;
  select profile_id into v_profile from public.cold_chain_drivers where id = v_trip.driver_id;
  if p_user_id is null or v_profile is distinct from p_user_id then
    raise exception 'Only the driver assigned to this shipment can confirm its delivery';
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

revoke execute on function public.cold_chain_deliver_trip(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.cold_chain_deliver_trip(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Row level security: drivers read their own trips
-- ---------------------------------------------------------------------------

-- The signed-in user is the driver of this trip.
create or replace function public.is_trip_driver(p_shipment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.cold_chain_shipments c
    join public.cold_chain_drivers d on d.id = c.driver_id
    join public.profiles p on p.id = d.profile_id
    where c.shipment_id = p_shipment_id
      and d.profile_id = (select auth.uid())
      and p.status = 'active'
      and p.role = 'driver'
  );
$$;

grant execute on function public.is_trip_driver(uuid) to authenticated, service_role;

alter table public.cold_chain_issues enable row level security;
drop policy if exists "Pharmacy and warehouse staff can read" on public.cold_chain_issues;
create policy "Pharmacy and warehouse staff can read" on public.cold_chain_issues
  for select to authenticated
  using (public.can_access_pharmacy(pharmacy_id) or public.is_warehouse_staff());
grant select on public.cold_chain_issues to authenticated;
grant all on public.cold_chain_issues to service_role;

do $$
declare
  t text;
begin
  foreach t in array array['cold_chain_shipments', 'cold_chain_readings', 'cold_chain_alerts',
                           'cold_chain_risk_predictions', 'cold_chain_issues']
  loop
    execute format('drop policy if exists "Drivers can read their trips" on public.%I', t);
    execute format(
      'create policy "Drivers can read their trips" on public.%I for select to authenticated
         using (public.is_trip_driver(shipment_id))', t);
  end loop;
end;
$$;

drop policy if exists "Drivers can read their own record" on public.cold_chain_drivers;
create policy "Drivers can read their own record" on public.cold_chain_drivers
  for select to authenticated using (profile_id = (select auth.uid()));

-- Realtime: the portal refreshes when a trip changes.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'cold_chain_issues'
     ) then
    alter publication supabase_realtime add table public.cold_chain_issues;
  end if;
end;
$$;
