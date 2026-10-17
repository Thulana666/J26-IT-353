-- SAMPLE DATA FOR TESTING THE WAREHOUSE MODULE (Component 3).
--
-- This is NOT real stock. Every stock-related row is marked as sample:
--   * the warehouse code/name start with "SAMPLE"
--   * batch numbers start with "SAMPLE-"
--   * batches and movements have notes 'SAMPLE seed data'
-- The medicines are plain catalogue entries (no stock claims) and are linked
-- to medicine_categories only when a category with that name already exists.
--
-- Expiry dates are relative to the day you run this, so every FEFO state
-- (expired, critical, near expiry, ok) is present. Two sample dispatches are
-- included: one FEFO-compliant and one FEFO override.
--
-- Run once in the Supabase SQL editor after
-- 20261008000000_create_warehouse_schema.sql. Safe to re-run (duplicates are
-- skipped). To remove the sample data again, run the DELETE block at the bottom.

-- Medicines ------------------------------------------------------------------
insert into public.medicines
  (name, generic_name, medicine_category_id, dosage_form, strength, unit, storage_condition, is_controlled)
select m.name, m.generic_name, c.id, m.dosage_form, m.strength, m.unit, m.storage_condition, m.is_controlled
from (values
  ('Paracetamol',            'Paracetamol',          'Analgesic',   'tablet',       '500 mg',      'carton', 'ambient',      false),
  ('Amoxicillin',            'Amoxicillin',          'Antibiotic',  'capsule',      '500 mg',      'carton', 'ambient',      false),
  ('Oral Rehydration Salts', 'ORS',                  'Electrolyte', 'sachet',       '20.5 g',      'carton', 'ambient',      false),
  ('Salbutamol',             'Salbutamol',           'Respiratory', 'inhaler',      '100 mcg/dose','carton', 'ambient',      false),
  ('Metformin',              'Metformin',            'Antidiabetic','tablet',       '500 mg',      'carton', 'ambient',      false),
  ('Sodium Chloride 0.9%',   'Normal saline',        'IV fluid',    'IV infusion',  '500 mL',      'carton', 'ambient',      false),
  ('Insulin (soluble)',      'Human insulin',        'Antidiabetic','injection',    '100 IU/mL',   'carton', 'refrigerated', false),
  ('Tetanus Toxoid Vaccine', 'Tetanus toxoid',       'Vaccine',     'injection',    '0.5 mL dose', 'carton', 'refrigerated', false),
  ('Oxytocin',               'Oxytocin',             'Uterotonic',  'injection',    '10 IU/mL',    'carton', 'refrigerated', false),
  ('Morphine Sulfate',       'Morphine',             'Analgesic',   'injection',    '10 mg/mL',    'carton', 'ambient',      true)
) as m(name, generic_name, category, dosage_form, strength, unit, storage_condition, is_controlled)
left join public.medicine_categories c on lower(c.name) = lower(m.category)
on conflict (name, strength, dosage_form) do nothing;

-- Warehouse, zones, racks, storage locations ----------------------------------
insert into public.warehouses (code, name, location_id, address, near_expiry_days, critical_expiry_days)
select 'SAMPLE-CMB', 'SAMPLE - Colombo Central Medical Warehouse',
       (select id from public.locations where name = 'Colombo' and location_type = 'district' limit 1),
       'Sample address, Colombo', 90, 30
on conflict (code) do nothing;

insert into public.warehouse_zones
  (warehouse_id, code, name, zone_type, storage_condition, min_temp_c, max_temp_c, is_secure)
select w.id, z.code, z.name, z.zone_type, z.storage_condition, z.min_t, z.max_t, z.is_secure
from public.warehouses w
cross join (values
  ('A',  'Ambient storage',           'storage',    'ambient',      15, 30, false),
  ('R',  'Cold room (2-8 °C)',        'storage',    'refrigerated',  2,  8, false),
  ('S',  'Secure store (controlled)', 'storage',    'ambient',      15, 30, true),
  ('Q',  'Quarantine (ambient)',      'quarantine', 'ambient',      15, 30, true),
  ('QC', 'Quarantine (cold)',         'quarantine', 'refrigerated',  2,  8, false)
) as z(code, name, zone_type, storage_condition, min_t, max_t, is_secure)
where w.code = 'SAMPLE-CMB'
on conflict (warehouse_id, code) do nothing;

insert into public.warehouse_racks (zone_id, code, distance_to_dispatch_m)
select z.id, r.code, r.distance
from public.warehouse_zones z
join public.warehouses w on w.id = z.warehouse_id and w.code = 'SAMPLE-CMB'
join (values
  ('A', 'A01', 8), ('A', 'A02', 16), ('A', 'A03', 24), ('A', 'A04', 32),
  ('R', 'R01', 20), ('R', 'R02', 26),
  ('S', 'S01', 30),
  ('Q', 'Q01', 40), ('QC', 'QC01', 44)
) as r(zone_code, code, distance) on r.zone_code = z.code
on conflict (zone_id, code) do nothing;

-- Ambient racks: 4 levels x 3 positions; other racks: 3 levels x 2 positions.
-- Level 2 is waist height (high accessibility), level 4 the top shelf (low).
insert into public.storage_locations (rack_id, code, level, capacity_units, accessibility)
select r.id,
       format('%s-L%s-P%s', r.code, lvl, pos),
       lvl,
       case z.code when 'A' then 120 when 'S' then 40 when 'Q' then 100 when 'QC' then 60 else 80 end,
       case lvl when 2 then 'high' when 4 then 'low' else 'medium' end
from public.warehouse_racks r
join public.warehouse_zones z on z.id = r.zone_id
join public.warehouses w on w.id = z.warehouse_id and w.code = 'SAMPLE-CMB'
cross join generate_series(1, 4) as lvl
cross join generate_series(1, 3) as pos
where lvl <= case when z.code = 'A' then 4 else 3 end
  and pos <= case when z.code = 'A' then 3 else 2 end
on conflict (rack_id, code) do nothing;

-- Batches (expiry relative to today) ----------------------------------------
insert into public.batches
  (medicine_id, batch_number, manufacturing_date, expiry_date, supplier, status, notes, created_by, created_at)
select m.id, b.batch_number,
       current_date + b.expiry_offset - 730,
       current_date + b.expiry_offset,
       'Sample Supplier Ltd', b.status, 'SAMPLE seed data', null,
       now() - make_interval(days => b.received_days_ago)
from (values
  ('Paracetamol',            '500 mg',       'SAMPLE-PCM-2401',  -10, 'active',      200),
  ('Paracetamol',            '500 mg',       'SAMPLE-PCM-2405',   20, 'active',      150),
  ('Paracetamol',            '500 mg',       'SAMPLE-PCM-2409',   75, 'active',        5),
  -- Received before 2409 but expires later: FIFO would pick it, FEFO must not.
  ('Paracetamol',            '500 mg',       'SAMPLE-PCM-2502',  400, 'active',       40),
  ('Amoxicillin',            '500 mg',       'SAMPLE-AMX-2410',   45, 'active',       90),
  ('Amoxicillin',            '500 mg',       'SAMPLE-AMX-2503',  150, 'active',       30),
  ('Amoxicillin',            '500 mg',       'SAMPLE-AMX-2311',  200, 'quarantined',  60),
  ('Oral Rehydration Salts', '20.5 g',       'SAMPLE-ORS-2501',  600, 'active',       20),
  ('Salbutamol',             '100 mcg/dose', 'SAMPLE-SAL-2408',   25, 'active',      120),
  ('Salbutamol',             '100 mcg/dose', 'SAMPLE-SAL-2504',  300, 'active',       15),
  ('Metformin',              '500 mg',       'SAMPLE-MET-2503',  500, 'active',       25),
  ('Sodium Chloride 0.9%',   '500 mL',       'SAMPLE-NS-2502',   200, 'active',       35),
  ('Insulin (soluble)',      '100 IU/mL',    'SAMPLE-INS-2409',   60, 'active',       70),
  ('Insulin (soluble)',      '100 IU/mL',    'SAMPLE-INS-2503',  250, 'active',       10),
  ('Tetanus Toxoid Vaccine', '0.5 mL dose',  'SAMPLE-TT-2502',   120, 'active',       45),
  ('Oxytocin',               '10 IU/mL',     'SAMPLE-OXY-2402',   -5, 'active',      300),
  ('Morphine Sulfate',       '10 mg/mL',     'SAMPLE-MOR-2503',  365, 'active',       50)
) as b(medicine_name, strength, batch_number, expiry_offset, status, received_days_ago)
join public.medicines m on m.name = b.medicine_name and m.strength = b.strength
on conflict (medicine_id, batch_number) do nothing;

-- Current stock ---------------------------------------------------------------
insert into public.warehouse_stock (batch_id, storage_location_id, quantity, created_at)
select b.id, l.storage_location_id, s.quantity, b.created_at
from (values
  ('SAMPLE-PCM-2401', 'A03-L1-P1',  15),
  ('SAMPLE-PCM-2405', 'A01-L2-P1',  60),
  ('SAMPLE-PCM-2409', 'A01-L2-P2',  90),
  ('SAMPLE-PCM-2502', 'A04-L3-P1', 110),
  ('SAMPLE-PCM-2502', 'A04-L4-P1',  80),
  ('SAMPLE-AMX-2410', 'A01-L1-P1',  40),
  ('SAMPLE-AMX-2503', 'A02-L2-P1', 100),
  ('SAMPLE-AMX-2311', 'Q01-L1-P1',  30),
  ('SAMPLE-ORS-2501', 'A03-L2-P2', 120),
  ('SAMPLE-SAL-2408', 'A01-L3-P1',  25),
  ('SAMPLE-SAL-2504', 'A02-L3-P2',  70),
  ('SAMPLE-MET-2503', 'A04-L2-P2', 100),
  ('SAMPLE-NS-2502',  'A02-L1-P3', 110),
  ('SAMPLE-INS-2409', 'R01-L2-P1',  30),
  ('SAMPLE-INS-2503', 'R02-L2-P1',  50),
  ('SAMPLE-TT-2502',  'R01-L1-P2',  40),
  ('SAMPLE-OXY-2402', 'R02-L3-P2',  12),
  ('SAMPLE-MOR-2503', 'S01-L2-P1',  20)
) as s(batch_number, location_code, quantity)
join public.batches b on b.batch_number = s.batch_number
join public.storage_location_overview l
  on l.location_code = s.location_code and l.warehouse_code = 'SAMPLE-CMB'
on conflict (batch_id, storage_location_id) do nothing;

-- Movement history consistent with the stock above ---------------------------
-- Sample dispatches: (batch, location, quantity, FEFO compliant, override reason).
with dispatches (batch_number, location_code, quantity, fefo_compliant, reason) as (
  values
    ('SAMPLE-PCM-2405', 'A01-L2-P1', 20, true,  null),
    ('SAMPLE-AMX-2503', 'A02-L2-P1', 10, false, 'SAMPLE: customer asked for longer remaining shelf life')
),
dispatch_rows as (
  select b.id as batch_id, l.storage_location_id, d.quantity, d.fefo_compliant, d.reason
  from dispatches d
  join public.batches b on b.batch_number = d.batch_number
  join public.storage_location_overview l
    on l.location_code = d.location_code and l.warehouse_code = 'SAMPLE-CMB'
),
receipts as (
  insert into public.inventory_movements
    (batch_id, movement_type, quantity, to_location_id, performed_via, notes, created_at)
  select st.batch_id, 'receive',
         st.quantity + coalesce((select sum(d.quantity) from dispatch_rows d
                                 where d.batch_id = st.batch_id
                                   and d.storage_location_id = st.storage_location_id), 0),
         st.storage_location_id, 'system', 'SAMPLE seed data', st.created_at
  from public.warehouse_stock st
  join public.batches b on b.id = st.batch_id
  where b.batch_number like 'SAMPLE-%'
    and not exists (
      select 1 from public.inventory_movements mv
      where mv.batch_id = st.batch_id and mv.notes = 'SAMPLE seed data'
    )
  returning batch_id, to_location_id
)
insert into public.inventory_movements
  (batch_id, movement_type, quantity, from_location_id, performed_via,
   fefo_compliant, fefo_override_reason, reference, notes, created_at)
select d.batch_id, 'dispatch', d.quantity, d.storage_location_id, 'system',
       d.fefo_compliant, d.reason, 'SAMPLE-DN-0001', 'SAMPLE seed data', now() - interval '2 days'
from dispatch_rows d
-- Only together with their receipts, so re-runs add nothing.
where exists (select 1 from receipts r where r.batch_id = d.batch_id and r.to_location_id = d.storage_location_id);

-- ---------------------------------------------------------------------------
-- To remove the sample data, run:
--
-- delete from public.inventory_movements
--   where batch_id in (select id from public.batches where batch_number like 'SAMPLE-%');
-- delete from public.warehouse_stock
--   where batch_id in (select id from public.batches where batch_number like 'SAMPLE-%');
-- delete from public.batches where batch_number like 'SAMPLE-%';  -- also removes their QR codes
-- delete from public.warehouses where code = 'SAMPLE-CMB';        -- also removes zones, racks, locations
-- delete from public.medicines m
--   where m.name in ('Paracetamol', 'Amoxicillin', 'Oral Rehydration Salts', 'Salbutamol', 'Metformin',
--                    'Sodium Chloride 0.9%', 'Insulin (soluble)', 'Tetanus Toxoid Vaccine', 'Oxytocin',
--                    'Morphine Sulfate')
--     and not exists (select 1 from public.batches b where b.medicine_id = m.id);
