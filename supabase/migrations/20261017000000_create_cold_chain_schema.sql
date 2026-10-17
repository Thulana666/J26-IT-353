-- Component 2: IoT Cold-Chain Tracking & Logistics Risk Prediction - schema.
--
-- Builds on Component 4's shipments (warehouse -> pharmacy); nothing there is
-- altered. A shipment is monitored when it has a cold_chain_shipments row,
-- whose primary key is the shipment's id, so both components use one id.
-- Origin (shipments.warehouse_id), destination (shipments.pharmacy_id),
-- delivery status and actual delivery time (shipments.received_at), and the
-- medicines and batches carried (shipment_items) all stay in Component 4.
--
--   cold_chain_devices           ESP32 loggers, or the development simulator
--   cold_chain_shipments         monitoring settings: device, limits, expected delivery
--   cold_chain_readings          sensor readings (temperature, humidity, GPS, speed, vibration)
--   cold_chain_alerts            observed and predicted risks, one active alert per condition
--   cold_chain_risk_predictions  risk model output, with the model that produced it
--
-- Access model (same as shipments):
--   * Admins and warehouse staff read every monitored shipment; pharmacy staff
--     read the shipments to their own pharmacy.
--   * Nothing is writable from the browser. The backend (service role)
--     authenticates users and devices, validates readings and writes.
--   * Devices are not readable from the browser at all: they hold key hashes.
--     Only the SHA-256 hash of a device key is stored.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.cold_chain_devices (
  id           uuid primary key default gen_random_uuid(),
  -- Sent by the device in the X-Device-Id header, e.g. 'ESP32-001'.
  device_code  text not null unique check (device_code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$'),
  name         text,
  -- 'simulator' generates development test data; it may only report for test shipments.
  device_type  text not null default 'esp32' check (device_type in ('esp32', 'simulator')),
  -- SHA-256 (hex) of the device key. The key itself is shown once, when created or rotated.
  key_hash     text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  is_active    boolean not null default true,
  last_seen_at timestamptz,
  notes        text,
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.cold_chain_shipments (
  shipment_id              uuid primary key references public.shipments (id) on delete cascade,
  -- Copied from the shipment (trigger) for row level security and Realtime filters.
  pharmacy_id              uuid not null references public.pharmacies (id) on delete cascade,
  device_id                uuid references public.cold_chain_devices (id) on delete set null,
  -- The storage condition the default limits came from (strictest item).
  storage_condition        text not null
                           check (storage_condition in ('ambient', 'cool', 'refrigerated', 'frozen')),
  temp_min_c               numeric(5, 2) not null,
  temp_max_c               numeric(5, 2) not null,
  humidity_min_pct         numeric(5, 2) check (humidity_min_pct between 0 and 100),
  humidity_max_pct         numeric(5, 2) check (humidity_max_pct between 0 and 100),
  expected_delivery_at     timestamptz,
  -- How often the device reports; longer silences are communication gaps.
  reading_interval_seconds integer not null default 60 check (reading_interval_seconds between 5 and 3600),
  -- Test shipments hold simulated data and are kept out of research results.
  is_test                  boolean not null default false,
  monitoring_status        text not null default 'active' check (monitoring_status in ('active', 'ended')),
  -- Readings are accepted from started_at until ended_at.
  started_at               timestamptz not null default now(),
  ended_at                 timestamptz,
  created_by               uuid references auth.users (id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  check (temp_min_c < temp_max_c),
  check (humidity_min_pct is null or humidity_max_pct is null or humidity_min_pct < humidity_max_pct),
  check ((monitoring_status = 'ended') = (ended_at is not null)),
  check (ended_at is null or ended_at >= started_at)
);

-- A device reports for one active shipment at a time.
create unique index if not exists cold_chain_shipments_active_device
  on public.cold_chain_shipments (device_id) where monitoring_status = 'active' and device_id is not null;
create index if not exists cold_chain_shipments_pharmacy_idx
  on public.cold_chain_shipments (pharmacy_id, started_at desc);

create table if not exists public.cold_chain_readings (
  id            bigint generated always as identity primary key,
  shipment_id   uuid not null references public.cold_chain_shipments (shipment_id) on delete cascade,
  pharmacy_id   uuid not null references public.pharmacies (id) on delete cascade,
  device_id     uuid references public.cold_chain_devices (id) on delete set null,
  -- 'device': sensor hardware; 'simulator': development test data.
  source        text not null check (source in ('device', 'simulator')),
  -- When the sensor took the reading (device clock) and when the backend received it.
  recorded_at   timestamptz not null,
  received_at   timestamptz not null default now(),
  -- Null = not measured (sensor fault, no GPS fix). Values are stored as sent;
  -- out-of-range values are rejected by the backend, never adjusted.
  temperature_c numeric(5, 2) check (temperature_c between -60 and 85),
  humidity_pct  numeric(5, 2) check (humidity_pct between 0 and 100),
  latitude      numeric(9, 6) check (latitude between -90 and 90),
  longitude     numeric(9, 6) check (longitude between -180 and 180),
  speed_kmh     numeric(6, 2) check (speed_kmh between 0 and 250),
  -- Peak acceleration (g) since the previous reading, from an optional MPU6050.
  vibration_g   numeric(6, 3) check (vibration_g between 0 and 16),
  -- Data-quality notes from the backend, e.g. 'delayed_upload', 'gps_jump'.
  quality_flags text[] not null default '{}',
  -- A resent reading (same shipment and time) is a duplicate and is ignored.
  unique (shipment_id, recorded_at),
  check ((latitude is null) = (longitude is null)),
  check (temperature_c is not null or humidity_pct is not null or latitude is not null)
);

create table if not exists public.cold_chain_alerts (
  id                uuid primary key default gen_random_uuid(),
  shipment_id       uuid not null references public.cold_chain_shipments (shipment_id) on delete cascade,
  pharmacy_id       uuid not null references public.pharmacies (id) on delete cascade,
  risk_type         text not null
                    check (risk_type in ('temperature_excursion', 'humidity_deviation', 'delivery_delay',
                                         'route_anomaly', 'communication_gap', 'combined')),
  risk_level        text not null check (risk_level in ('low', 'medium', 'high')),
  -- 'observed': a measured value crossed or neared a configured limit.
  -- 'predicted': the risk model expects the condition (probability set).
  basis             text not null check (basis in ('observed', 'predicted')),
  risk_probability  numeric(5, 4) check (risk_probability between 0 and 1),
  title             text not null,
  message           text not null,
  details           jsonb not null default '{}'::jsonb,
  -- Identifies the condition, e.g. 'temperature_excursion:above'; one active alert per key.
  dedupe_key        text not null,
  first_detected_at timestamptz not null,
  last_detected_at  timestamptz not null,
  -- Readings (or predictions) that reported the condition while the alert was active.
  occurrences       integer not null default 1 check (occurrences > 0),
  status            text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  acknowledged_by   uuid references auth.users (id) on delete set null,
  acknowledged_at   timestamptz,
  resolved_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (basis = 'observed' or risk_probability is not null),
  check (last_detected_at >= first_detected_at)
);

create unique index if not exists cold_chain_alerts_active_key
  on public.cold_chain_alerts (shipment_id, dedupe_key) where status <> 'resolved';
create index if not exists cold_chain_alerts_shipment_idx
  on public.cold_chain_alerts (shipment_id, status, last_detected_at desc);

create table if not exists public.cold_chain_risk_predictions (
  id               uuid primary key default gen_random_uuid(),
  shipment_id      uuid not null references public.cold_chain_shipments (shipment_id) on delete cascade,
  pharmacy_id      uuid not null references public.pharmacies (id) on delete cascade,
  -- The predictor, e.g. the temporary rule-based prototype or a trained CNN-LSTM.
  model_name       text not null,
  model_version    text not null,
  -- True for the temporary prototype predictor (not a trained model).
  is_prototype     boolean not null,
  risk_level       text not null check (risk_level in ('low', 'medium', 'high')),
  risk_probability numeric(5, 4) not null check (risk_probability between 0 and 1),
  -- Main contributing risk; null when the overall risk is low.
  risk_type        text check (risk_type in ('temperature_excursion', 'humidity_deviation', 'delivery_delay',
                                             'route_anomaly', 'communication_gap', 'combined')),
  explanation      text not null,
  -- Per-risk probabilities and the inputs behind them.
  factors          jsonb not null default '{}'::jsonb,
  -- How far ahead the prediction looks.
  horizon_minutes  integer not null check (horizon_minutes > 0),
  readings_used    integer not null check (readings_used >= 0),
  -- recorded_at of the newest reading used.
  data_until       timestamptz,
  predicted_at     timestamptz not null default now()
);

create index if not exists cold_chain_risk_predictions_shipment_idx
  on public.cold_chain_risk_predictions (shipment_id, predicted_at desc);

-- ---------------------------------------------------------------------------
-- Views: the newest reading and prediction of each monitored shipment.
-- security_invoker so the caller's row level security applies.
-- ---------------------------------------------------------------------------

create or replace view public.cold_chain_latest_readings
with (security_invoker = true) as
select distinct on (r.shipment_id) r.*
from public.cold_chain_readings r
order by r.shipment_id, r.recorded_at desc;

create or replace view public.cold_chain_latest_predictions
with (security_invoker = true) as
select distinct on (p.shipment_id) p.*
from public.cold_chain_risk_predictions p
order by p.shipment_id, p.predicted_at desc;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

-- Monitored shipments take the pharmacy of their shipment.
create or replace function public.cold_chain_shipments_set_pharmacy()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  select s.pharmacy_id into new.pharmacy_id from public.shipments s where s.id = new.shipment_id;
  if new.pharmacy_id is null then
    raise exception 'Shipment not found' using errcode = 'P0002';
  end if;
  return new;
end;
$$;

-- Readings, alerts and predictions take the pharmacy of their monitored
-- shipment. Simulated readings are only stored for test shipments, so test
-- data never mixes with real sensor data.
create or replace function public.cold_chain_set_pharmacy()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_is_test boolean;
begin
  select c.pharmacy_id, c.is_test into new.pharmacy_id, v_is_test
  from public.cold_chain_shipments c
  where c.shipment_id = new.shipment_id;
  if new.pharmacy_id is null then
    raise exception 'Shipment is not monitored' using errcode = 'P0002';
  end if;
  if tg_table_name = 'cold_chain_readings' then
    if new.source = 'simulator' and not v_is_test then
      raise exception 'Simulated readings can only be stored for test shipments' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists cold_chain_shipments_set_pharmacy on public.cold_chain_shipments;
create trigger cold_chain_shipments_set_pharmacy
  before insert or update of shipment_id on public.cold_chain_shipments
  for each row execute function public.cold_chain_shipments_set_pharmacy();

do $$
declare
  t text;
begin
  foreach t in array array['cold_chain_readings', 'cold_chain_alerts', 'cold_chain_risk_predictions']
  loop
    execute format('drop trigger if exists %1$s_set_pharmacy on public.%1$I', t);
    execute format(
      'create trigger %1$s_set_pharmacy before insert or update of shipment_id on public.%1$I
         for each row execute function public.cold_chain_set_pharmacy()', t);
  end loop;

  foreach t in array array['cold_chain_devices', 'cold_chain_shipments', 'cold_chain_alerts']
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

do $$
declare
  t text;
begin
  foreach t in array array['cold_chain_shipments', 'cold_chain_readings', 'cold_chain_alerts',
                           'cold_chain_risk_predictions']
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

-- Devices: backend only (no policies, no grants to browser roles).
alter table public.cold_chain_devices enable row level security;
grant all on public.cold_chain_devices to service_role;

grant select on public.cold_chain_latest_readings, public.cold_chain_latest_predictions to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Realtime: the dashboard refreshes when readings, alerts or predictions
-- arrive (RLS still applies per user).
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['cold_chain_shipments', 'cold_chain_readings', 'cold_chain_alerts',
                             'cold_chain_risk_predictions']
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
