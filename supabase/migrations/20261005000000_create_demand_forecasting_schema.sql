-- Global Event Analysis & Demand Forecasting: core tables.
--
-- Reuses public.set_updated_at() from the profiles migration. Does not touch
-- auth.users, public.profiles or their triggers.
--
-- Access model:
--   * Signed-in users can read everything.
--   * Only active admins (profiles.role = 'admin') can write from the app.
--   * Backend jobs using the service-role key bypass RLS (e.g. article ingestion).

-- ---------------------------------------------------------------------------
-- Helper: is the current user an active admin?
-- security definer so it can read profiles regardless of the caller's RLS.
-- ---------------------------------------------------------------------------
create or replace function public.is_admin()
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
      and role = 'admin'
      and status = 'active'
  );
$$;

-- ---------------------------------------------------------------------------
-- Reference tables
-- ---------------------------------------------------------------------------

-- Where articles come from (news sites, government bulletins, WHO, ...).
create table if not exists public.data_sources (
  id                uuid primary key default gen_random_uuid(),
  name              text not null unique,
  source_type       text not null default 'news'
                    check (source_type in ('news', 'government', 'international', 'social_media', 'other')),
  base_url          text,
  country_code      char(2) default 'LK',
  -- Manual trust rating, 0 (unreliable) to 1 (authoritative).
  reliability_score numeric(3, 2) check (reliability_score between 0 and 1),
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Places events affect: Sri Lanka, its provinces and districts, ports, and
-- other countries for global events. parent_id builds the hierarchy.
create table if not exists public.locations (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  location_type text not null
                check (location_type in ('country', 'province', 'district', 'city', 'port', 'region', 'other')),
  parent_id     uuid references public.locations (id) on delete set null,
  country_code  char(2) default 'LK',
  latitude      numeric(9, 6) check (latitude between -90 and 90),
  longitude     numeric(9, 6) check (longitude between -180 and 180),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique nulls not distinct (name, location_type, parent_id)
);

create table if not exists public.diseases (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  icd10_code  text,
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Groups such as Analgesic, Antibiotic, IV fluid, Electrolyte.
create table if not exists public.medicine_categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Events and their sources
-- ---------------------------------------------------------------------------

create table if not exists public.events (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  description text,
  event_type  text not null
              check (event_type in ('disease_outbreak', 'natural_disaster', 'supply_disruption',
                                    'seasonal', 'policy', 'economic', 'other')),
  severity    text not null default 'medium'
              check (severity in ('low', 'medium', 'high', 'critical')),
  status      text not null default 'active'
              check (status in ('active', 'monitoring', 'resolved')),
  scope       text not null default 'local'
              check (scope in ('local', 'global')),
  disease_id  uuid references public.diseases (id) on delete set null,
  started_at  date not null default current_date,
  ended_at    date,
  created_by  uuid references auth.users (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (ended_at is null or ended_at >= started_at)
);

-- Articles collected from data sources. event_id stays null until the
-- article is linked to an event.
create table if not exists public.event_articles (
  id             uuid primary key default gen_random_uuid(),
  data_source_id uuid not null references public.data_sources (id) on delete restrict,
  event_id       uuid references public.events (id) on delete set null,
  title          text not null,
  url            text unique,
  summary        text,
  content        text,
  author         text,
  language       text not null default 'en',
  relevance      text check (relevance in ('low', 'medium', 'high')),
  published_at   timestamptz,
  fetched_at     timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Many-to-many: an event can affect several locations.
create table if not exists public.event_locations (
  event_id    uuid not null references public.events (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  is_primary  boolean not null default false,
  created_at  timestamptz not null default now(),
  primary key (event_id, location_id)
);

-- ---------------------------------------------------------------------------
-- Impact and demand
-- ---------------------------------------------------------------------------

-- Expected effect of an event on a medicine category (optionally a specific
-- medicine). medicine_name is free text until a shared medicines table exists.
create table if not exists public.event_medicine_impacts (
  id                   uuid primary key default gen_random_uuid(),
  event_id             uuid not null references public.events (id) on delete cascade,
  medicine_category_id uuid not null references public.medicine_categories (id) on delete restrict,
  disease_id           uuid references public.diseases (id) on delete set null,
  medicine_name        text,
  impact_direction     text not null
                       check (impact_direction in ('increase', 'decrease', 'no_change')),
  expected_change_pct  numeric(6, 2),
  impact_level         text not null default 'medium'
                       check (impact_level in ('low', 'medium', 'high', 'critical')),
  -- Reserved for a future model; null while impacts are entered manually.
  confidence           numeric(3, 2) check (confidence between 0 and 1),
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique nulls not distinct (event_id, medicine_category_id, medicine_name)
);

-- Historical demand (units dispensed/ordered) per medicine, place and period.
-- This is the input for demand comparisons and, later, forecasting.
create table if not exists public.demand_records (
  id                   uuid primary key default gen_random_uuid(),
  medicine_category_id uuid not null references public.medicine_categories (id) on delete restrict,
  medicine_name        text not null,
  location_id          uuid references public.locations (id) on delete set null,
  period_start         date not null,
  period_end           date not null,
  quantity             numeric(14, 2) not null check (quantity >= 0),
  unit                 text not null,
  source               text not null default 'manual'
                       check (source in ('manual', 'import', 'system', 'mock')),
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (period_end >= period_start),
  -- Prevents importing the same period twice.
  unique nulls not distinct (medicine_category_id, medicine_name, location_id, period_start, period_end)
);

-- ---------------------------------------------------------------------------
-- Indexes for foreign keys and common filters
-- ---------------------------------------------------------------------------
create index if not exists locations_parent_id_idx on public.locations (parent_id);
create index if not exists events_status_started_at_idx on public.events (status, started_at desc);
create index if not exists events_disease_id_idx on public.events (disease_id);
create index if not exists event_articles_event_id_idx on public.event_articles (event_id);
create index if not exists event_articles_data_source_id_idx on public.event_articles (data_source_id);
create index if not exists event_articles_published_at_idx on public.event_articles (published_at desc);
create index if not exists event_locations_location_id_idx on public.event_locations (location_id);
create index if not exists event_medicine_impacts_category_idx on public.event_medicine_impacts (medicine_category_id);
create index if not exists event_medicine_impacts_disease_idx on public.event_medicine_impacts (disease_id);
create index if not exists demand_records_location_id_idx on public.demand_records (location_id);
create index if not exists demand_records_period_idx on public.demand_records (period_start, period_end);

-- ---------------------------------------------------------------------------
-- updated_at triggers, row level security, policies and grants
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'data_sources', 'locations', 'diseases', 'medicine_categories', 'events',
    'event_articles', 'event_locations', 'event_medicine_impacts', 'demand_records'
  ]
  loop
    -- event_locations has no updated_at column.
    if t <> 'event_locations' then
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

    -- Newer Supabase projects don't auto-grant table access to API roles.
    -- RLS above still decides which rows/operations are allowed.
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end;
$$;

grant execute on function public.is_admin() to authenticated;
