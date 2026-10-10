-- SAMPLE DATA FOR TESTING THE PHARMACY MODULE (Component 4).
--
-- This is NOT real pharmacy data. Everything here is marked as sample:
--   * pharmacy codes start with "SAMPLE-PH-", names with "SAMPLE"
--   * batch numbers start with "SAMPLE-RX-"
--   * generated history is stored with sales.source = 'synthetic_seed' and
--     stock movement notes starting with 'SAMPLE'
-- The dashboard labels analytics computed from synthetic sales as synthetic.
--
-- What it creates:
--   1. Pharmacy details for the sample medicines (brand, pack size, prices)
--      and sample barcodes (EAN-13 numbers in the in-store 200 range).
--   2. Two sample pharmacies supplied by the SAMPLE-CMB warehouse, with
--      different demand profiles (pharmacy-specific burn rates).
--   3. 180 days of simulated daily sales and replenishment per pharmacy:
--      weekly pattern, seasonality, noise, a supply disruption that causes
--      a stockout, a recent demand spike, a near-expiry and an expired batch.
--   4. Live examples made with the real workflow functions: a submitted
--      order, a dispatched shipment waiting to be received and a pending return.
--
-- Run once in the Supabase SQL editor AFTER
--   20261010000000_create_pharmacy_schema.sql,
--   20261010000001_create_pharmacy_functions.sql and
--   supabase/seed/sample_warehouse.sql (medicines, warehouse and its stock).
-- Safe to re-run: the history and the examples are created only once.
-- To remove the sample data, run the DELETE block at the bottom. To remove
-- only the generated history (keeping current stock), run
-- supabase/seed/remove_synthetic_history.sql.

-- 1. Product details and barcodes ---------------------------------------------
update public.medicines m
set brand_name      = coalesce(m.brand_name, d.brand_name),
    manufacturer    = coalesce(m.manufacturer, d.manufacturer),
    dispensing_unit = coalesce(m.dispensing_unit, d.dispensing_unit),
    units_per_pack  = case when m.units_per_pack = 1 then d.units_per_pack else m.units_per_pack end,
    unit_cost       = coalesce(m.unit_cost, d.unit_cost),
    retail_price    = coalesce(m.retail_price, d.retail_price)
from (values
  ('Paracetamol',            '500 mg',       'SAMPLE Panadol',     'SAMPLE GSK Consumer Healthcare', 'strip of 10 tablets',  100,   24.00,   35.00),
  ('Amoxicillin',            '500 mg',       'SAMPLE Amoxil',      'SAMPLE State Pharmaceuticals',   'strip of 10 capsules',  50,  128.00,  180.00),
  ('Oral Rehydration Salts', '20.5 g',       'SAMPLE Jeevanee',    'SAMPLE State Pharmaceuticals',   'sachet',               100,   30.00,   45.00),
  ('Salbutamol',             '100 mcg/dose', 'SAMPLE Ventolin',    'SAMPLE GSK',                     'inhaler',               20,  690.00,  950.00),
  ('Metformin',              '500 mg',       'SAMPLE Glucophage',  'SAMPLE Merck',                   'strip of 10 tablets',  100,   28.00,   40.00),
  ('Sodium Chloride 0.9%',   '500 mL',       'SAMPLE NS Infusion', 'SAMPLE Baxter',                  'bottle',                20,  158.00,  220.00),
  ('Insulin (soluble)',      '100 IU/mL',    'SAMPLE Actrapid',    'SAMPLE Novo Nordisk',            'vial (10 mL)',          10, 1290.00, 1650.00),
  ('Tetanus Toxoid Vaccine', '0.5 mL dose',  'SAMPLE TT Vaccine',  'SAMPLE Serum Institute',         'single-dose vial',      10,  245.00,  350.00),
  ('Oxytocin',               '10 IU/mL',     'SAMPLE Syntocinon',  'SAMPLE Novartis',                'ampoule',               50,   84.00,  120.00),
  ('Morphine Sulfate',       '10 mg/mL',     'SAMPLE Morphine',    'SAMPLE Martindale',              'ampoule',               10,  215.00,  300.00)
) as d(name, strength, brand_name, manufacturer, dispensing_unit, units_per_pack, unit_cost, retail_price)
where m.name = d.name and m.strength = d.strength;

insert into public.product_barcodes (medicine_id, barcode, symbology, packaging_level, is_primary)
select m.id, b.barcode, 'EAN13', b.level, b.level = 'unit'
from (values
  ('Paracetamol',            '500 mg',       '2001000000012', 'unit'), ('Paracetamol',            '500 mg',       '2002000000019', 'pack'),
  ('Amoxicillin',            '500 mg',       '2001000000029', 'unit'), ('Amoxicillin',            '500 mg',       '2002000000026', 'pack'),
  ('Oral Rehydration Salts', '20.5 g',       '2001000000036', 'unit'), ('Oral Rehydration Salts', '20.5 g',       '2002000000033', 'pack'),
  ('Salbutamol',             '100 mcg/dose', '2001000000043', 'unit'), ('Salbutamol',             '100 mcg/dose', '2002000000040', 'pack'),
  ('Metformin',              '500 mg',       '2001000000050', 'unit'), ('Metformin',              '500 mg',       '2002000000057', 'pack'),
  ('Sodium Chloride 0.9%',   '500 mL',       '2001000000067', 'unit'), ('Sodium Chloride 0.9%',   '500 mL',       '2002000000064', 'pack'),
  ('Insulin (soluble)',      '100 IU/mL',    '2001000000074', 'unit'), ('Insulin (soluble)',      '100 IU/mL',    '2002000000071', 'pack'),
  ('Tetanus Toxoid Vaccine', '0.5 mL dose',  '2001000000081', 'unit'), ('Tetanus Toxoid Vaccine', '0.5 mL dose',  '2002000000088', 'pack'),
  ('Oxytocin',               '10 IU/mL',     '2001000000098', 'unit'), ('Oxytocin',               '10 IU/mL',     '2002000000095', 'pack'),
  ('Morphine Sulfate',       '10 mg/mL',     '2001000000104', 'unit'), ('Morphine Sulfate',       '10 mg/mL',     '2002000000101', 'pack')
) as b(name, strength, barcode, level)
join public.medicines m on m.name = b.name and m.strength = b.strength
on conflict (barcode) do nothing;

-- 2. Pharmacies ----------------------------------------------------------------
insert into public.pharmacies
  (code, name, warehouse_id, location_id, address, phone, license_number,
   default_lead_time_days, default_review_period_days, default_service_level, tax_rate_percent, max_discount_percent)
select p.code, p.name,
       (select id from public.warehouses where code = 'SAMPLE-CMB'),
       (select id from public.locations where name = p.district and location_type = 'district' limit 1),
       p.address, p.phone, p.license, p.lead, 7, 0.95, 0, 10
from (values
  ('SAMPLE-PH-COL', 'SAMPLE - PharmaTwin Pharmacy, Colombo 07', 'Colombo', 'Sample address, Colombo 07', '+94 11 000 0001', 'SAMPLE-NMRA-0001', 2),
  ('SAMPLE-PH-KDY', 'SAMPLE - PharmaTwin Pharmacy, Kandy',      'Kandy',   'Sample address, Kandy',      '+94 81 000 0002', 'SAMPLE-NMRA-0002', 4)
) as p(code, name, district, address, phone, license, lead)
on conflict (code) do nothing;

-- Per-product reorder settings (others use the pharmacy defaults).
insert into public.reorder_settings
  (pharmacy_id, medicine_id, safety_stock_method, service_level, safety_stock_days, min_order_packs, max_stock_units)
select ph.id, m.id, s.method, s.service_level, s.safety_days, s.min_packs, s.max_units
from (values
  ('SAMPLE-PH-COL', 'Insulin (soluble)', 'days_of_cover', null::numeric, 7::numeric, 1, 60),
  ('SAMPLE-PH-COL', 'Paracetamol',       'service_level', 0.98,          null,        1, 2000),
  ('SAMPLE-PH-KDY', 'Salbutamol',        'service_level', 0.97,          null,        1, null)
) as s(pharmacy_code, medicine_name, method, service_level, safety_days, min_packs, max_units)
join public.pharmacies ph on ph.code = s.pharmacy_code
join public.medicines m on m.name = s.medicine_name
on conflict (pharmacy_id, medicine_id) do nothing;

-- Batches used by the simulated pharmacy history (shared batches table).
-- A: near expiry, B: mid shelf life, C: long shelf life, X: expired 3 days ago.
insert into public.batches (medicine_id, batch_number, manufacturing_date, expiry_date, supplier, status, notes, created_by)
select m.id, format('SAMPLE-RX-%s-%s', s.code, v.suffix),
       current_date + v.expiry_offset - 730, current_date + v.expiry_offset,
       'SAMPLE Supplier Ltd', 'active', 'SAMPLE pharmacy seed data', null
from (values
  ('Paracetamol', 'PCM'), ('Amoxicillin', 'AMX'), ('Oral Rehydration Salts', 'ORS'), ('Salbutamol', 'SAL'),
  ('Metformin', 'MET'), ('Sodium Chloride 0.9%', 'NS'), ('Insulin (soluble)', 'INS')
) as s(name, code)
join public.medicines m on m.name = s.name
cross join (values ('A', 40), ('B', 220), ('C', 520), ('X', -3)) as v(suffix, expiry_offset)
where v.suffix <> 'X' or s.code = 'NS'
on conflict (medicine_id, batch_number) do nothing;

-- 3. Simulated history (180 days) ------------------------------------------------
do $$
declare
  v_start   date := current_date - 180;
  v_end     date := current_date - 1;
  v_ph      record;
  v_p       record;
  v_day     date;
  v_t       integer;
  v_sale    public.sales;
  v_sold_at timestamptz;
  v_rx_at   timestamptz;
  v_demand  integer;
  v_left    integer;
  v_take    integer;
  v_inv     record;
  v_batch   uuid;
  v_onhand  integer;
  v_order   integer;
  v_subtotal numeric(14, 2);
  -- Sunday .. Saturday
  v_weekly  numeric[] := array[0.62, 1.15, 1.06, 1.00, 1.02, 1.12, 0.88];
begin
  if exists (select 1 from public.sales where source = 'synthetic_seed') then
    raise notice 'Synthetic pharmacy history already exists; skipped.';
    return;
  end if;

  -- Simulation parameters: base demand (dispensing units/day) per pharmacy,
  -- seasonal amplitude and trend over the 180 days.
  create temp table sim_products on commit drop as
  select ph.id as pharmacy_id, ph.code as pharmacy_code, ph.default_lead_time_days as lead_time,
         m.id as medicine_id, s.code, m.units_per_pack, m.retail_price, s.base, s.season, s.trend,
         0::integer as pending_units, null::date as arrival_day
  from (values
    ('SAMPLE-PH-COL', 'Paracetamol',            'PCM', 30.0, 0.25,  0.10),
    ('SAMPLE-PH-COL', 'Amoxicillin',            'AMX',  8.0, 0.15,  0.05),
    ('SAMPLE-PH-COL', 'Oral Rehydration Salts', 'ORS',  6.0, 0.35,  0.00),
    ('SAMPLE-PH-COL', 'Salbutamol',             'SAL',  1.5, 0.10,  0.00),
    ('SAMPLE-PH-COL', 'Metformin',              'MET', 16.0, 0.00,  0.15),
    ('SAMPLE-PH-COL', 'Sodium Chloride 0.9%',   'NS',   1.2, 0.20,  0.00),
    ('SAMPLE-PH-COL', 'Insulin (soluble)',      'INS',  0.9, 0.00,  0.10),
    ('SAMPLE-PH-KDY', 'Paracetamol',            'PCM', 20.0, 0.30,  0.00),
    ('SAMPLE-PH-KDY', 'Amoxicillin',            'AMX',  5.0, 0.20, -0.05),
    ('SAMPLE-PH-KDY', 'Oral Rehydration Salts', 'ORS',  9.0, 0.45,  0.05),
    ('SAMPLE-PH-KDY', 'Salbutamol',             'SAL',  2.5, 0.25,  0.10),
    ('SAMPLE-PH-KDY', 'Metformin',              'MET',  9.0, 0.00,  0.05),
    ('SAMPLE-PH-KDY', 'Sodium Chloride 0.9%',   'NS',   0.8, 0.10,  0.00),
    ('SAMPLE-PH-KDY', 'Insulin (soluble)',      'INS',  0.5, 0.00,  0.00)
  ) as s(pharmacy_code, medicine_name, code, base, season, trend)
  join public.pharmacies ph on ph.code = s.pharmacy_code
  join public.medicines m on m.name = s.medicine_name;

  -- Opening balance: three weeks of demand in batch A.
  for v_p in select * from sim_products loop
    perform public.pharmacy_adjust_stock(
      v_p.pharmacy_id,
      (select id from public.batches where batch_number = format('SAMPLE-RX-%s-A', v_p.code)),
      greatest(ceil(v_p.base * 21)::integer, 5), null, 'SAMPLE synthetic opening balance', 'opening_balance',
      null, null, (v_start + time '07:00') at time zone 'Asia/Colombo');
  end loop;

  for v_ph in select distinct pharmacy_id, pharmacy_code from sim_products order by pharmacy_code loop
    for v_day in select generate_series(v_start, v_end, interval '1 day')::date loop
      v_t := v_day - v_start;
      v_rx_at := (v_day + time '08:00') at time zone 'Asia/Colombo';
      v_sold_at := (v_day + time '18:00') at time zone 'Asia/Colombo';

      -- Deliveries arriving today.
      for v_p in
        select * from sim_products
        where pharmacy_id = v_ph.pharmacy_id and arrival_day = v_day and pending_units > 0
      loop
        v_batch := (select id from public.batches where batch_number = format('SAMPLE-RX-%s-%s', v_p.code,
          case
            -- Keep a near-expiry batch on the shelf in these two cases.
            when v_t >= 160 and (v_ph.pharmacy_code, v_p.code) in (('SAMPLE-PH-COL', 'AMX'), ('SAMPLE-PH-KDY', 'ORS')) then 'A'
            when v_t < 90 then 'A'
            when v_t < 140 then 'B'
            else 'C'
          end));
        perform public.pharmacy_adjust_stock(v_ph.pharmacy_id, v_batch, v_p.pending_units, null,
          'SAMPLE synthetic replenishment', 'adjustment', null, null, v_rx_at);
        update sim_products set pending_units = 0, arrival_day = null
        where pharmacy_id = v_p.pharmacy_id and medicine_id = v_p.medicine_id;
      end loop;

      -- A slow-moving batch that expires before it sells out (Kandy saline).
      if v_ph.pharmacy_code = 'SAMPLE-PH-KDY' and v_t = 150 then
        perform public.pharmacy_adjust_stock(v_ph.pharmacy_id,
          (select id from public.batches where batch_number = 'SAMPLE-RX-NS-X'), 30, null,
          'SAMPLE synthetic replenishment (short-dated)', 'adjustment', null, null, v_rx_at);
      end if;

      -- Weekly review: order up to (lead time + review + 7 days) of base demand.
      if v_t % 7 = (case when v_ph.pharmacy_code = 'SAMPLE-PH-COL' then 0 else 3 end) then
        for v_p in select * from sim_products where pharmacy_id = v_ph.pharmacy_id and pending_units = 0 loop
          -- Supply disruption: no Salbutamol deliveries to Kandy for three weeks.
          continue when v_ph.pharmacy_code = 'SAMPLE-PH-KDY' and v_p.code = 'SAL' and v_t between 95 and 116;
          select coalesce(sum(i.quantity_on_hand - i.quantity_reserved), 0) into v_onhand
          from public.pharmacy_inventory i join public.batches b on b.id = i.batch_id
          where i.pharmacy_id = v_ph.pharmacy_id and i.medicine_id = v_p.medicine_id and b.expiry_date >= v_day;
          if v_onhand < v_p.base * (v_p.lead_time + 7) then
            v_order := ceil((v_p.base * (v_p.lead_time + 14) - v_onhand) / v_p.units_per_pack)::integer * v_p.units_per_pack;
            update sim_products set pending_units = v_order, arrival_day = v_day + v_p.lead_time
            where pharmacy_id = v_p.pharmacy_id and medicine_id = v_p.medicine_id;
          end if;
        end loop;
      end if;

      -- Sales of the day: one synthetic bill per pharmacy and day.
      v_sale := null;
      v_subtotal := 0;
      for v_p in select * from sim_products where pharmacy_id = v_ph.pharmacy_id order by code loop
        v_demand := greatest(0, round(
          v_p.base
          * v_weekly[extract(dow from v_day)::integer + 1]
          * (1 + v_p.season * sin(2 * pi() * (extract(doy from v_day) - 100) / 365.0))
          * (1 + v_p.trend * v_t / 180.0)
          * (0.55 + 0.9 * ((abs(hashtext(v_ph.pharmacy_code || v_p.code || v_day::text)::bigint) % 10000) / 10000.0))
          -- Recent demand spike (unusual consumption) for Colombo amoxicillin.
          * case when v_ph.pharmacy_code = 'SAMPLE-PH-COL' and v_p.code = 'AMX' and v_t >= 175 then 2.4 else 1 end
        )::integer);
        v_left := v_demand;
        continue when v_left = 0;

        -- FEFO across the batches on the shelf; demand beyond stock is lost.
        for v_inv in
          select i.id, i.batch_id, i.quantity_on_hand - i.quantity_reserved as available, i.unit_price
          from public.pharmacy_inventory i join public.batches b on b.id = i.batch_id
          where i.pharmacy_id = v_ph.pharmacy_id and i.medicine_id = v_p.medicine_id
            and b.expiry_date >= v_day and i.quantity_on_hand - i.quantity_reserved > 0
          order by b.expiry_date, b.batch_number
        loop
          exit when v_left = 0;
          v_take := least(v_left, v_inv.available);
          if v_sale.id is null then
            insert into public.sales (pharmacy_id, source, subtotal, total_amount, payment_method, sold_at, created_at)
            values (v_ph.pharmacy_id, 'synthetic_seed', 0, 0, 'cash', v_sold_at, v_sold_at)
            returning * into v_sale;
          end if;
          insert into public.sale_items
            (sale_id, pharmacy_id, inventory_id, medicine_id, batch_id, quantity, unit_price, line_total,
             fefo_compliant, sold_at, created_at)
          values (v_sale.id, v_ph.pharmacy_id, v_inv.id, v_p.medicine_id, v_inv.batch_id, v_take, v_inv.unit_price,
                  round(v_inv.unit_price * v_take, 2), true, v_sold_at, v_sold_at);
          perform public.pharmacy_apply_stock_change(v_inv.id, -v_take, 0, 'sale', 'sale', v_sale.id, null,
            'SAMPLE synthetic sale', v_sold_at);
          v_subtotal := v_subtotal + round(v_inv.unit_price * v_take, 2);
          v_left := v_left - v_take;
        end loop;
      end loop;

      if v_sale.id is not null then
        update public.sales
        set subtotal = v_subtotal, total_amount = v_subtotal, amount_tendered = v_subtotal, change_due = 0
        where id = v_sale.id;
      end if;
    end loop;
  end loop;
end;
$$;

-- 4. Live workflow examples (real functions, so stock and history stay consistent)
do $$
declare
  v_col   uuid := (select id from public.pharmacies where code = 'SAMPLE-PH-COL');
  v_kdy   uuid := (select id from public.pharmacies where code = 'SAMPLE-PH-KDY');
  v_order public.purchase_orders;
  v_inv   record;
begin
  if v_col is null or exists (select 1 from public.purchase_orders where notes like 'SAMPLE%') then
    return;
  end if;

  -- Dispatched by the warehouse and waiting to be received at Colombo.
  v_order := public.pharmacy_create_order(v_col, null, jsonb_build_array(
    jsonb_build_object('medicineId', (select id from public.medicines where name = 'Paracetamol' and strength = '500 mg'), 'quantity', 3),
    jsonb_build_object('medicineId', (select id from public.medicines where name = 'Oral Rehydration Salts'), 'quantity', 1)
  ), 'SAMPLE order: restock before the monsoon');
  perform public.pharmacy_dispatch_order(v_order.id, null, null, 'SAMPLE dispatch');

  -- Submitted and waiting for the warehouse.
  perform public.pharmacy_create_order(v_col, null, jsonb_build_array(
    jsonb_build_object('medicineId', (select id from public.medicines where name = 'Metformin'), 'quantity', 2),
    jsonb_build_object('medicineId', (select id from public.medicines where name = 'Salbutamol'), 'quantity', 1)
  ), 'SAMPLE order: monthly chronic-care restock');

  -- Return of the expired saline at Kandy, waiting for the warehouse.
  select i.id, i.quantity_on_hand - i.quantity_reserved as available into v_inv
  from public.pharmacy_inventory i join public.batches b on b.id = i.batch_id
  where i.pharmacy_id = v_kdy and b.batch_number = 'SAMPLE-RX-NS-X';
  if v_inv.available > 0 then
    perform public.pharmacy_create_return(v_kdy, null, jsonb_build_array(
      jsonb_build_object('inventoryId', v_inv.id, 'quantity', v_inv.available, 'reason', 'expired',
                         'notes', 'SAMPLE: expired on the shelf')
    ), 'SAMPLE return');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- To remove the pharmacy sample data (run BEFORE the warehouse cleanup, as
-- pharmacy rows reference sample warehouse batches):
--
-- delete from public.audit_logs where pharmacy_id in (select id from public.pharmacies where code like 'SAMPLE-PH-%');
-- delete from public.pharmacy_alerts where pharmacy_id in (select id from public.pharmacies where code like 'SAMPLE-PH-%');
-- delete from public.pharmacy_forecast_runs where pharmacy_id in (select id from public.pharmacies where code like 'SAMPLE-PH-%');
-- delete from public.reorder_recommendations where pharmacy_id in (select id from public.pharmacies where code like 'SAMPLE-PH-%');
-- delete from public.shipment_discrepancies where pharmacy_id in (select id from public.pharmacies where code like 'SAMPLE-PH-%');
-- delete from public.shipments where pharmacy_id in (select id from public.pharmacies where code like 'SAMPLE-PH-%');
-- delete from public.purchase_orders where pharmacy_id in (select id from public.pharmacies where code like 'SAMPLE-PH-%');
-- delete from public.return_requests where pharmacy_id in (select id from public.pharmacies where code like 'SAMPLE-PH-%');
-- delete from public.sales where pharmacy_id in (select id from public.pharmacies where code like 'SAMPLE-PH-%');
-- delete from public.stock_movements where pharmacy_id in (select id from public.pharmacies where code like 'SAMPLE-PH-%');
-- delete from public.pharmacy_inventory where pharmacy_id in (select id from public.pharmacies where code like 'SAMPLE-PH-%');
-- update public.profiles set pharmacy_id = null where pharmacy_id in (select id from public.pharmacies where code like 'SAMPLE-PH-%');
-- delete from public.pharmacies where code like 'SAMPLE-PH-%';   -- also removes reorder_settings
-- delete from public.batches where batch_number like 'SAMPLE-RX-%';
-- delete from public.product_barcodes where barcode like '200_000000%';
-- (Warehouse stock taken by the sample dispatch is restored only by re-running
--  the warehouse seed after its own cleanup.)
