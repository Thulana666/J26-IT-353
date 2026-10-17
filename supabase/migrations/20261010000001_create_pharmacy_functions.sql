-- Component 4: transactional pharmacy operations.
--
-- Each function runs in one transaction: it locks the rows it changes, checks
-- the business rules, updates stock and writes stock_movements and audit_logs,
-- so concurrent requests cannot corrupt inventory. Business-rule violations
-- raise P0001 (the message is meant for users), missing rows raise P0002.
--
-- Only the backend (service role) may execute them. It passes the acting user
-- and has already checked that user's role and pharmacy; the functions still
-- check that every record belongs to the given pharmacy.
--
-- p_today is the pharmacy's local date (the backend uses Asia/Colombo).

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------

create or replace function public.pharmacy_audit(
  p_actor_id    uuid,
  p_pharmacy_id uuid,
  p_action      text,
  p_entity_type text,
  p_entity_id   uuid,
  p_details     jsonb default '{}'::jsonb
)
returns void
language sql
set search_path = ''
as $$
  insert into public.audit_logs (actor_id, pharmacy_id, action, entity_type, entity_id, details)
  values (p_actor_id, p_pharmacy_id, p_action, p_entity_type, p_entity_id, coalesce(p_details, '{}'::jsonb));
$$;

-- Changes one inventory row and appends the matching stock movement.
create or replace function public.pharmacy_apply_stock_change(
  p_inventory_id    uuid,
  p_on_hand_change  integer,
  p_reserved_change integer,
  p_movement_type   text,
  p_reference_type  text,
  p_reference_id    uuid,
  p_user_id         uuid,
  p_notes           text default null,
  p_at              timestamptz default now()
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
     or v_inv.quantity_reserved + p_reserved_change > v_inv.quantity_on_hand + p_on_hand_change then
    raise exception 'Reserved stock would be inconsistent (% on hand, % reserved)',
      v_inv.quantity_on_hand + p_on_hand_change, v_inv.quantity_reserved + p_reserved_change;
  end if;

  update public.pharmacy_inventory
  set quantity_on_hand  = quantity_on_hand + p_on_hand_change,
      quantity_reserved = quantity_reserved + p_reserved_change,
      first_received_at = case when p_movement_type in ('receipt', 'opening_balance')
                               then coalesce(first_received_at, p_at) else first_received_at end,
      last_received_at  = case when p_movement_type in ('receipt', 'opening_balance')
                               then p_at else last_received_at end
  where id = p_inventory_id
  returning * into v_inv;

  insert into public.stock_movements (
    pharmacy_id, inventory_id, medicine_id, batch_id, movement_type,
    on_hand_change, reserved_change, on_hand_after, reserved_after,
    reference_type, reference_id, notes, performed_by, created_at
  )
  values (
    v_inv.pharmacy_id, v_inv.id, v_inv.medicine_id, v_inv.batch_id, p_movement_type,
    p_on_hand_change, p_reserved_change, v_inv.quantity_on_hand, v_inv.quantity_reserved,
    p_reference_type, p_reference_id, p_notes, p_user_id, p_at
  );

  return v_inv;
end;
$$;

create or replace function public.pharmacy_add_discrepancy(
  p_shipment public.shipments,
  p_item_id  uuid,
  p_medicine uuid,
  p_batch    uuid,
  p_type     text,
  p_expected integer,
  p_actual   integer,
  p_notes    text,
  p_user_id  uuid,
  p_barcode  text default null,
  p_batch_no text default null
)
returns public.shipment_discrepancies
language plpgsql
set search_path = ''
as $$
declare
  v_row public.shipment_discrepancies;
begin
  insert into public.shipment_discrepancies (
    shipment_id, shipment_item_id, order_id, pharmacy_id, medicine_id, batch_id,
    observed_barcode, observed_batch_number, discrepancy_type,
    expected_quantity, actual_quantity, notes, reported_by
  )
  values (
    p_shipment.id, p_item_id, p_shipment.order_id, p_shipment.pharmacy_id, p_medicine, p_batch,
    nullif(btrim(p_barcode), ''), nullif(btrim(p_batch_no), ''), p_type,
    p_expected, p_actual, nullif(btrim(p_notes), ''), p_user_id
  )
  returning * into v_row;
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Stock adjustments (opening balances, physical count corrections)
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

  if p_change < 0 and v_inv.quantity_on_hand - v_inv.quantity_reserved < -p_change then
    raise exception 'Cannot remove % unit(s): only % available (the rest is held for returns)',
      -p_change, v_inv.quantity_on_hand - v_inv.quantity_reserved;
  end if;

  v_inv := public.pharmacy_apply_stock_change(
    v_inv.id, p_change, 0, p_movement_type, 'adjustment', null, p_user_id, btrim(p_reason), p_at);

  perform public.pharmacy_audit(p_user_id, p_pharmacy_id, 'stock.' || p_movement_type, 'pharmacy_inventory', v_inv.id,
    jsonb_build_object('batch_id', p_batch_id, 'change', p_change, 'reason', btrim(p_reason)));
  return v_inv;
end;
$$;

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------

-- p_items: [{ "medicineId", "quantity" (warehouse packs), "recommendationId"?, "notes"? }]
-- An item with a recommendationId records the decision on that recommendation
-- (accepted when the quantity is unchanged, otherwise edited).
create or replace function public.pharmacy_create_order(
  p_pharmacy_id uuid,
  p_user_id     uuid,
  p_items       jsonb,
  p_notes       text default null
)
returns public.purchase_orders
language plpgsql
set search_path = ''
as $$
declare
  v_pharmacy public.pharmacies;
  v_order    public.purchase_orders;
  v_item     record;
  v_rec      public.reorder_recommendations;
  v_count    integer := 0;
begin
  select * into v_pharmacy from public.pharmacies where id = p_pharmacy_id;
  if not found then
    raise exception 'Pharmacy not found' using errcode = 'P0002';
  end if;
  if not v_pharmacy.is_active then
    raise exception 'Pharmacy % is inactive', v_pharmacy.name;
  end if;
  if v_pharmacy.warehouse_id is null then
    raise exception 'Pharmacy % has no supplying warehouse; set one in Settings', v_pharmacy.name;
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one product to the order';
  end if;
  if (select count(distinct e ->> 'medicineId') from jsonb_array_elements(p_items) e) <> jsonb_array_length(p_items) then
    raise exception 'Each product can appear only once in an order';
  end if;

  insert into public.purchase_orders (pharmacy_id, warehouse_id, notes, created_by)
  values (p_pharmacy_id, v_pharmacy.warehouse_id, nullif(btrim(p_notes), ''), p_user_id)
  returning * into v_order;

  for v_item in
    select (e ->> 'medicineId')::uuid                    as medicine_id,
           (e ->> 'quantity')::integer                   as quantity,
           nullif(e ->> 'recommendationId', '')::uuid    as recommendation_id,
           nullif(btrim(e ->> 'notes'), '')              as notes
    from jsonb_array_elements(p_items) e
  loop
    if v_item.quantity is null or v_item.quantity <= 0 then
      raise exception 'Order quantities must be positive whole numbers';
    end if;
    if not exists (select 1 from public.medicines where id = v_item.medicine_id and is_active) then
      raise exception 'A product in the order does not exist or is inactive' using errcode = 'P0002';
    end if;

    if v_item.recommendation_id is not null then
      select * into v_rec from public.reorder_recommendations where id = v_item.recommendation_id for update;
      if not found or v_rec.pharmacy_id <> p_pharmacy_id or v_rec.medicine_id <> v_item.medicine_id then
        raise exception 'A recommendation does not match this pharmacy and product';
      end if;
      if v_rec.status <> 'pending' then
        raise exception 'A recommendation in this order was already %', v_rec.status;
      end if;
      update public.reorder_recommendations
      set status        = case when v_item.quantity = v_rec.recommended_packs then 'accepted' else 'edited' end,
          decided_packs = v_item.quantity,
          decided_by    = p_user_id,
          decided_at    = now(),
          order_id      = v_order.id
      where id = v_rec.id;
    end if;

    insert into public.purchase_order_items (order_id, pharmacy_id, medicine_id, quantity_ordered, recommendation_id, notes)
    values (v_order.id, p_pharmacy_id, v_item.medicine_id, v_item.quantity, v_item.recommendation_id, v_item.notes);
    v_count := v_count + 1;
  end loop;

  perform public.pharmacy_audit(p_user_id, p_pharmacy_id, 'order.submitted', 'purchase_order', v_order.id,
    jsonb_build_object('order_number', v_order.order_number, 'items', v_count));
  return v_order;
end;
$$;

-- Pharmacy staff cancel their own submitted order; warehouse staff decline one.
create or replace function public.pharmacy_cancel_order(
  p_order_id uuid,
  p_user_id  uuid,
  p_reason   text,
  p_pharmacy_id uuid default null
)
returns public.purchase_orders
language plpgsql
set search_path = ''
as $$
declare
  v_order public.purchase_orders;
begin
  select * into v_order from public.purchase_orders where id = p_order_id for update;
  if not found or (p_pharmacy_id is not null and v_order.pharmacy_id <> p_pharmacy_id) then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;
  if v_order.status <> 'submitted' then
    raise exception 'Order % is % and can no longer be cancelled', v_order.order_number, v_order.status;
  end if;

  update public.purchase_orders
  set status = 'cancelled', cancelled_at = now(), cancelled_by = p_user_id,
      cancel_reason = nullif(btrim(p_reason), '')
  where id = p_order_id
  returning * into v_order;

  perform public.pharmacy_audit(p_user_id, v_order.pharmacy_id, 'order.cancelled', 'purchase_order', v_order.id,
    jsonb_build_object('order_number', v_order.order_number, 'reason', v_order.cancel_reason));
  return v_order;
end;
$$;

-- Warehouse dispatch: picks every order item from warehouse stock in FEFO
-- order (Component 3's rules: active batch, storage zone, earliest expiry,
-- then older manufacture, earlier receipt, nearer dispatch) and records each
-- pick with record_inventory_movement(), so warehouse stock and its movement
-- history stay consistent. Batches with less than p_min_shelf_days of shelf
-- life are not sent to pharmacies; skipping them is logged as a FEFO override.
--
-- p_items (optional): [{ "orderItemId", "quantity" }] to ship less than
-- ordered (0 skips an item). Items not listed ship the ordered quantity.
create or replace function public.pharmacy_dispatch_order(
  p_order_id       uuid,
  p_user_id        uuid,
  p_items          jsonb default null,
  p_notes          text default null,
  p_today          date default ((now() at time zone 'Asia/Colombo')::date),
  p_min_shelf_days integer default 30
)
returns public.shipments
language plpgsql
set search_path = ''
as $$
declare
  v_order     public.purchase_orders;
  v_shipment  public.shipments;
  v_item      record;
  v_pick      record;
  v_qty       integer;
  v_remaining integer;
  v_take      integer;
  v_skipped   date;
  v_total     integer := 0;
begin
  select * into v_order from public.purchase_orders where id = p_order_id for update;
  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;
  if v_order.status <> 'submitted' then
    raise exception 'Order % is % and cannot be dispatched', v_order.order_number, v_order.status;
  end if;
  if v_order.warehouse_id is null then
    raise exception 'Order % has no supplying warehouse', v_order.order_number;
  end if;
  if p_items is not null and exists (
    select 1 from jsonb_array_elements(p_items) e
    where not exists (
      select 1 from public.purchase_order_items oi
      where oi.order_id = p_order_id and oi.id = (e ->> 'orderItemId')::uuid
    )
  ) then
    raise exception 'A dispatch line does not belong to order %', v_order.order_number;
  end if;

  insert into public.shipments (order_id, pharmacy_id, warehouse_id, dispatched_by, notes)
  values (p_order_id, v_order.pharmacy_id, v_order.warehouse_id, p_user_id, nullif(btrim(p_notes), ''))
  returning * into v_shipment;

  for v_item in
    select oi.id, oi.medicine_id, oi.quantity_ordered,
           m.name, m.units_per_pack, m.unit_cost, m.retail_price
    from public.purchase_order_items oi
    join public.medicines m on m.id = oi.medicine_id
    where oi.order_id = p_order_id
    order by oi.created_at, oi.id
  loop
    v_qty := v_item.quantity_ordered;
    if p_items is not null then
      select coalesce((e ->> 'quantity')::integer, v_item.quantity_ordered) into v_qty
      from jsonb_array_elements(p_items) e
      where (e ->> 'orderItemId')::uuid = v_item.id;
      v_qty := coalesce(v_qty, v_item.quantity_ordered);
    end if;
    if v_qty < 0 or v_qty > v_item.quantity_ordered then
      raise exception 'Ship between 0 and % pack(s) of %', v_item.quantity_ordered, v_item.name;
    end if;
    continue when v_qty = 0;

    -- Short-dated stock that plain FEFO would send first.
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
      and b.expiry_date >= p_today
      and b.expiry_date < p_today + p_min_shelf_days;

    v_remaining := v_qty;
    for v_pick in
      select st.batch_id, st.storage_location_id, st.quantity
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
               r.distance_to_dispatch_m, st.created_at
    loop
      exit when v_remaining = 0;
      v_take := least(v_remaining, v_pick.quantity);

      perform public.record_inventory_movement(
        v_pick.batch_id, 'dispatch', v_take, v_pick.storage_location_id, null, p_user_id, 'system',
        v_skipped is null,
        case when v_skipped is not null
             then format('Pharmacy supply rule: at least %s days of shelf life (earlier batch expires %s)',
                         p_min_shelf_days, v_skipped)
        end,
        v_shipment.shipment_number,
        format('Pharmacy order %s', v_order.order_number),
        p_today);

      insert into public.shipment_items (
        shipment_id, pharmacy_id, order_item_id, medicine_id, batch_id,
        quantity_shipped, units_per_pack, unit_cost, unit_price
      )
      values (
        v_shipment.id, v_order.pharmacy_id, v_item.id, v_item.medicine_id, v_pick.batch_id,
        v_take, v_item.units_per_pack, v_item.unit_cost, v_item.retail_price
      )
      on conflict (shipment_id, batch_id) do update
        set quantity_shipped = public.shipment_items.quantity_shipped + excluded.quantity_shipped;

      v_remaining := v_remaining - v_take;
      v_total := v_total + v_take;
    end loop;

    if v_remaining > 0 then
      raise exception 'Not enough stock of % to dispatch: % of % pack(s) available with at least % days of shelf life',
        v_item.name, v_qty - v_remaining, v_qty, p_min_shelf_days;
    end if;
  end loop;

  if v_total = 0 then
    raise exception 'Nothing to dispatch: every quantity is zero';
  end if;

  update public.purchase_orders set status = 'dispatched', dispatched_at = now() where id = p_order_id;

  perform public.pharmacy_audit(p_user_id, v_order.pharmacy_id, 'shipment.dispatched', 'shipment', v_shipment.id,
    jsonb_build_object('shipment_number', v_shipment.shipment_number, 'order_number', v_order.order_number,
                       'packs', v_total));
  return v_shipment;
end;
$$;

-- ---------------------------------------------------------------------------
-- Receiving and discrepancies
-- ---------------------------------------------------------------------------

-- p_items: one entry per shipment item:
--   [{ "shipmentItemId", "quantityReceived", "quantityDamaged"?, "scanCount"?, "notes"? }]
-- p_extra: things found that are not shipment items:
--   [{ "type", "quantity", "medicineId"?, "barcode"?, "batchNumber"?, "notes"? }]
--
-- Only verified, undamaged packs up to the shipped quantity of an active,
-- unexpired batch are added to stock. Shortages, excess, damage and
-- expired/blocked batches become discrepancy reports for the warehouse.
create or replace function public.pharmacy_confirm_receipt(
  p_shipment_id uuid,
  p_pharmacy_id uuid,
  p_user_id     uuid,
  p_items       jsonb,
  p_extra       jsonb default '[]'::jsonb,
  p_notes       text default null,
  p_today       date default ((now() at time zone 'Asia/Colombo')::date)
)
returns public.shipments
language plpgsql
set search_path = ''
as $$
declare
  v_shipment public.shipments;
  v_item     record;
  v_in       jsonb;
  v_received integer;
  v_damaged  integer;
  v_accepted integer;
  v_blocked  text;
  v_inv      public.pharmacy_inventory;
  v_units    integer := 0;
  v_extra    record;
  v_issues   integer;
begin
  select * into v_shipment from public.shipments where id = p_shipment_id for update;
  if not found or v_shipment.pharmacy_id <> p_pharmacy_id then
    raise exception 'Shipment not found' using errcode = 'P0002';
  end if;
  if v_shipment.status <> 'in_transit' then
    raise exception 'Shipment % was already received', v_shipment.shipment_number;
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Receipt lines are missing';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) e
    where not exists (
      select 1 from public.shipment_items si
      where si.shipment_id = p_shipment_id and si.id = (e ->> 'shipmentItemId')::uuid
    )
  ) then
    raise exception 'A receipt line does not belong to shipment %', v_shipment.shipment_number;
  end if;
  if (select count(distinct e ->> 'shipmentItemId') from jsonb_array_elements(p_items) e) <> jsonb_array_length(p_items) then
    raise exception 'Each shipment item can be verified only once';
  end if;
  if jsonb_array_length(p_items) <> (select count(*) from public.shipment_items where shipment_id = p_shipment_id) then
    raise exception 'Verify every item of shipment % before confirming receipt', v_shipment.shipment_number;
  end if;

  for v_item in
    select si.*, b.batch_number, b.expiry_date, b.status as batch_status, m.name as medicine_name
    from public.shipment_items si
    join public.batches b on b.id = si.batch_id
    join public.medicines m on m.id = si.medicine_id
    where si.shipment_id = p_shipment_id
    order by si.batch_id
    for update of si
  loop
    select e into v_in from jsonb_array_elements(p_items) e where (e ->> 'shipmentItemId')::uuid = v_item.id;
    v_received := (v_in ->> 'quantityReceived')::integer;
    v_damaged  := coalesce((v_in ->> 'quantityDamaged')::integer, 0);
    if v_received is null or v_received < 0 then
      raise exception 'Enter the received quantity of % (batch %)', v_item.medicine_name, v_item.batch_number;
    end if;
    if v_damaged < 0 or v_damaged > v_received then
      raise exception 'Damaged packs of % (batch %) must be between 0 and the received quantity',
        v_item.medicine_name, v_item.batch_number;
    end if;

    v_accepted := least(v_received - v_damaged, v_item.quantity_shipped);
    v_blocked := case
      when v_item.expiry_date < p_today then 'expired'
      when v_item.batch_status <> 'active' then v_item.batch_status
    end;
    if v_blocked is not null then
      v_accepted := 0;
    end if;

    update public.shipment_items
    set quantity_received   = v_received,
        quantity_damaged    = v_damaged,
        quantity_accepted   = v_accepted,
        scan_count          = greatest(coalesce((v_in ->> 'scanCount')::integer, 0), 0),
        verified_at         = now(),
        verification_status = case
          when v_received = quantity_shipped and v_damaged = 0 and v_blocked is null then 'matched'
          else 'discrepancy' end
    where id = v_item.id;

    if v_received < v_item.quantity_shipped then
      perform public.pharmacy_add_discrepancy(v_shipment, v_item.id, v_item.medicine_id, v_item.batch_id,
        'missing', v_item.quantity_shipped, v_received, v_in ->> 'notes', p_user_id);
    elsif v_received > v_item.quantity_shipped then
      perform public.pharmacy_add_discrepancy(v_shipment, v_item.id, v_item.medicine_id, v_item.batch_id,
        'excess', v_item.quantity_shipped, v_received,
        concat_ws(' ', nullif(btrim(v_in ->> 'notes'), ''), '(Excess packs were not added to stock.)'), p_user_id);
    end if;
    if v_damaged > 0 then
      perform public.pharmacy_add_discrepancy(v_shipment, v_item.id, v_item.medicine_id, v_item.batch_id,
        'damaged', 0, v_damaged, v_in ->> 'notes', p_user_id);
    end if;
    if v_blocked = 'expired' then
      perform public.pharmacy_add_discrepancy(v_shipment, v_item.id, v_item.medicine_id, v_item.batch_id,
        'expired', v_item.quantity_shipped, v_received,
        format('Batch %s expired on %s; not added to stock.', v_item.batch_number, v_item.expiry_date), p_user_id);
    elsif v_blocked is not null then
      perform public.pharmacy_add_discrepancy(v_shipment, v_item.id, v_item.medicine_id, v_item.batch_id,
        'other', v_item.quantity_shipped, v_received,
        format('Batch %s is %s; not added to stock.', v_item.batch_number, v_blocked), p_user_id);
    end if;

    if v_accepted > 0 then
      insert into public.pharmacy_inventory (pharmacy_id, batch_id, medicine_id, unit_cost, unit_price)
      values (p_pharmacy_id, v_item.batch_id, v_item.medicine_id, v_item.unit_cost, v_item.unit_price)
      on conflict (pharmacy_id, batch_id) do update
        set unit_cost  = coalesce(excluded.unit_cost, public.pharmacy_inventory.unit_cost),
            unit_price = coalesce(excluded.unit_price, public.pharmacy_inventory.unit_price)
      returning * into v_inv;

      perform public.pharmacy_apply_stock_change(
        v_inv.id, v_accepted * v_item.units_per_pack, 0, 'receipt', 'shipment', p_shipment_id, p_user_id,
        format('%s: %s pack(s) x %s', v_shipment.shipment_number, v_accepted, v_item.units_per_pack));
      v_units := v_units + v_accepted * v_item.units_per_pack;
    end if;
  end loop;

  for v_extra in
    select e ->> 'type'                        as type,
           (e ->> 'quantity')::integer         as quantity,
           nullif(e ->> 'medicineId', '')::uuid as medicine_id,
           e ->> 'barcode'                     as barcode,
           e ->> 'batchNumber'                 as batch_number,
           e ->> 'notes'                       as notes
    from jsonb_array_elements(coalesce(p_extra, '[]'::jsonb)) e
  loop
    if v_extra.type not in ('incorrect_item', 'incorrect_batch', 'excess', 'damaged', 'other') then
      raise exception 'Unknown discrepancy type %', v_extra.type;
    end if;
    if v_extra.quantity is null or v_extra.quantity < 0 then
      raise exception 'Discrepancy quantities must be zero or more';
    end if;
    if v_extra.medicine_id is not null and not exists (select 1 from public.medicines where id = v_extra.medicine_id) then
      raise exception 'Product not found' using errcode = 'P0002';
    end if;
    perform public.pharmacy_add_discrepancy(v_shipment, null, v_extra.medicine_id, null,
      v_extra.type, 0, v_extra.quantity, v_extra.notes, p_user_id, v_extra.barcode, v_extra.batch_number);
  end loop;

  select count(*) into v_issues from public.shipment_discrepancies where shipment_id = p_shipment_id;

  update public.shipments
  set status        = case when v_issues > 0 then 'received_with_discrepancies' else 'received' end,
      received_by   = p_user_id,
      received_at   = now(),
      receipt_notes = nullif(btrim(p_notes), '')
  where id = p_shipment_id
  returning * into v_shipment;

  update public.purchase_orders set status = 'received', received_at = now() where id = v_shipment.order_id;

  perform public.pharmacy_audit(p_user_id, p_pharmacy_id, 'shipment.received', 'shipment', p_shipment_id,
    jsonb_build_object('shipment_number', v_shipment.shipment_number, 'units_added', v_units,
                       'discrepancies', v_issues));
  return v_shipment;
end;
$$;

-- A discrepancy found after receipt (e.g. damage noticed when unpacking).
-- It is a report only; stock is corrected separately if needed.
create or replace function public.pharmacy_report_discrepancy(
  p_shipment_id      uuid,
  p_pharmacy_id      uuid,
  p_user_id          uuid,
  p_type             text,
  p_shipment_item_id uuid default null,
  p_expected         integer default null,
  p_actual           integer default null,
  p_notes            text default null,
  p_barcode          text default null,
  p_batch_number     text default null
)
returns public.shipment_discrepancies
language plpgsql
set search_path = ''
as $$
declare
  v_shipment public.shipments;
  v_item     public.shipment_items;
  v_row      public.shipment_discrepancies;
begin
  select * into v_shipment from public.shipments where id = p_shipment_id for update;
  if not found or v_shipment.pharmacy_id <> p_pharmacy_id then
    raise exception 'Shipment not found' using errcode = 'P0002';
  end if;
  if p_type not in ('missing', 'excess', 'damaged', 'incorrect_item', 'incorrect_batch', 'expired', 'other') then
    raise exception 'Unknown discrepancy type %', p_type;
  end if;
  if nullif(btrim(p_notes), '') is null then
    raise exception 'Describe the discrepancy in the notes';
  end if;
  if p_shipment_item_id is not null then
    select * into v_item from public.shipment_items where id = p_shipment_item_id and shipment_id = p_shipment_id;
    if not found then
      raise exception 'The item is not part of shipment %', v_shipment.shipment_number;
    end if;
  end if;

  v_row := public.pharmacy_add_discrepancy(v_shipment, v_item.id, v_item.medicine_id, v_item.batch_id,
    p_type, p_expected, p_actual, p_notes, p_user_id, p_barcode, p_batch_number);

  if v_shipment.status = 'received' then
    update public.shipments set status = 'received_with_discrepancies' where id = p_shipment_id;
  end if;

  perform public.pharmacy_audit(p_user_id, p_pharmacy_id, 'discrepancy.reported', 'shipment_discrepancy', v_row.id,
    jsonb_build_object('report_number', v_row.report_number, 'shipment_number', v_shipment.shipment_number,
                       'type', p_type));
  return v_row;
end;
$$;

-- Warehouse staff: open -> acknowledged -> resolved (open -> resolved allowed).
create or replace function public.pharmacy_update_discrepancy(
  p_discrepancy_id uuid,
  p_user_id        uuid,
  p_status         text,
  p_notes          text default null
)
returns public.shipment_discrepancies
language plpgsql
set search_path = ''
as $$
declare
  v_row public.shipment_discrepancies;
begin
  select * into v_row from public.shipment_discrepancies where id = p_discrepancy_id for update;
  if not found then
    raise exception 'Discrepancy report not found' using errcode = 'P0002';
  end if;
  if p_status = 'acknowledged' and v_row.status <> 'open' then
    raise exception 'Report % is already %', v_row.report_number, v_row.status;
  end if;
  if p_status = 'resolved' then
    if v_row.status = 'resolved' then
      raise exception 'Report % is already resolved', v_row.report_number;
    end if;
    if nullif(btrim(p_notes), '') is null then
      raise exception 'Describe how the discrepancy was resolved';
    end if;
  end if;
  if p_status not in ('acknowledged', 'resolved') then
    raise exception 'Unknown status %', p_status;
  end if;

  update public.shipment_discrepancies
  set status           = p_status,
      acknowledged_by  = coalesce(acknowledged_by, p_user_id),
      acknowledged_at  = coalesce(acknowledged_at, now()),
      resolved_by      = case when p_status = 'resolved' then p_user_id end,
      resolved_at      = case when p_status = 'resolved' then now() end,
      resolution_notes = coalesce(nullif(btrim(p_notes), ''), resolution_notes)
  where id = p_discrepancy_id
  returning * into v_row;

  perform public.pharmacy_audit(p_user_id, v_row.pharmacy_id, 'discrepancy.' || p_status, 'shipment_discrepancy',
    v_row.id, jsonb_build_object('report_number', v_row.report_number, 'notes', nullif(btrim(p_notes), '')));
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Sales (POS checkout)
-- ---------------------------------------------------------------------------

-- p_items: [{ "batchId", "quantity" }] in dispensing units. Prices, discount,
-- tax and totals are computed here from stored data, never taken from the
-- client. A repeated p_client_request_id returns the sale it created.
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
    if v_inv.quantity_on_hand - v_inv.quantity_reserved < v_line.quantity then
      raise exception 'Not enough stock of % (batch %): % available, % on the bill',
        v_name, v_batch.batch_number, v_inv.quantity_on_hand - v_inv.quantity_reserved, v_line.quantity;
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
      and i.quantity_on_hand - i.quantity_reserved > 0
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

-- ---------------------------------------------------------------------------
-- Returns
-- ---------------------------------------------------------------------------

-- p_items: [{ "inventoryId", "quantity", "reason", "notes"? }] in dispensing units.
-- The quantity is reserved (held, not sellable) until the warehouse receives
-- it or rejects the request, so it cannot be sold or returned twice.
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
    if v_inv.quantity_on_hand - v_inv.quantity_reserved < v_line.quantity then
      select m.name || ' (batch ' || b.batch_number || ')' into v_label
      from public.medicines m, public.batches b where m.id = v_inv.medicine_id and b.id = v_inv.batch_id;
      raise exception 'Only % unit(s) of % can be returned; % already held for other returns',
        v_inv.quantity_on_hand - v_inv.quantity_reserved, v_label, v_inv.quantity_reserved;
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

-- Warehouse review: approve (stock stays reserved) or reject (reservation released).
create or replace function public.pharmacy_review_return(
  p_return_id uuid,
  p_user_id   uuid,
  p_decision  text,
  p_notes     text default null
)
returns public.return_requests
language plpgsql
set search_path = ''
as $$
declare
  v_return public.return_requests;
  v_item   record;
begin
  select * into v_return from public.return_requests where id = p_return_id for update;
  if not found then
    raise exception 'Return request not found' using errcode = 'P0002';
  end if;

  if p_decision = 'approve' then
    if v_return.status <> 'pending' then
      raise exception 'Return % is % and cannot be approved', v_return.return_number, v_return.status;
    end if;
  elsif p_decision = 'reject' then
    if v_return.status not in ('pending', 'approved') then
      raise exception 'Return % is % and cannot be rejected', v_return.return_number, v_return.status;
    end if;
    if nullif(btrim(p_notes), '') is null then
      raise exception 'Give a reason for rejecting the return';
    end if;
    for v_item in
      select * from public.return_items where return_id = p_return_id order by inventory_id
    loop
      perform public.pharmacy_apply_stock_change(
        v_item.inventory_id, 0, -v_item.quantity, 'return_release', 'return_request', p_return_id, p_user_id,
        v_return.return_number || ' rejected');
    end loop;
  else
    raise exception 'Unknown decision %', p_decision;
  end if;

  update public.return_requests
  set status       = case when p_decision = 'approve' then 'approved' else 'rejected' end,
      reviewed_by  = p_user_id,
      reviewed_at  = now(),
      review_notes = nullif(btrim(p_notes), '')
  where id = p_return_id
  returning * into v_return;

  perform public.pharmacy_audit(p_user_id, v_return.pharmacy_id, 'return.' || v_return.status, 'return_request',
    v_return.id, jsonb_build_object('return_number', v_return.return_number, 'notes', v_return.review_notes));
  return v_return;
end;
$$;

-- Warehouse confirms it received the returned stock (the handover): only now
-- does it leave the pharmacy's stock. Items listed in p_restock
-- ([{ "returnItemId", "locationId" }]) are put back into warehouse stock with
-- record_inventory_movement(), which applies Component 3's storage, quarantine
-- and capacity rules; only whole packs can be restocked. Other items (e.g.
-- expired or damaged) are received for disposal without adding warehouse stock.
create or replace function public.pharmacy_receive_return(
  p_return_id uuid,
  p_user_id   uuid,
  p_restock   jsonb default '[]'::jsonb,
  p_notes     text default null,
  p_today     date default ((now() at time zone 'Asia/Colombo')::date)
)
returns public.return_requests
language plpgsql
set search_path = ''
as $$
declare
  v_return   public.return_requests;
  v_item     record;
  v_location uuid;
  v_movement public.inventory_movements;
  v_restocked integer := 0;
begin
  select * into v_return from public.return_requests where id = p_return_id for update;
  if not found then
    raise exception 'Return request not found' using errcode = 'P0002';
  end if;
  if v_return.status not in ('pending', 'approved') then
    raise exception 'Return % is % and cannot be received', v_return.return_number, v_return.status;
  end if;
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_restock, '[]'::jsonb)) e
    where not exists (
      select 1 from public.return_items ri
      where ri.return_id = p_return_id and ri.id = (e ->> 'returnItemId')::uuid
    )
  ) then
    raise exception 'A restock line does not belong to return %', v_return.return_number;
  end if;

  for v_item in
    select ri.*, m.name, m.units_per_pack, b.batch_number
    from public.return_items ri
    join public.medicines m on m.id = ri.medicine_id
    join public.batches b on b.id = ri.batch_id
    where ri.return_id = p_return_id
    order by ri.inventory_id
    for update of ri
  loop
    perform public.pharmacy_apply_stock_change(
      v_item.inventory_id, -v_item.quantity, -v_item.quantity, 'return_dispatch', 'return_request', p_return_id,
      p_user_id, v_return.return_number || ' received by warehouse');

    v_location := null;
    select nullif(e ->> 'locationId', '')::uuid into v_location
    from jsonb_array_elements(coalesce(p_restock, '[]'::jsonb)) e
    where (e ->> 'returnItemId')::uuid = v_item.id;

    if v_location is not null then
      if v_item.quantity % v_item.units_per_pack <> 0 then
        raise exception 'Only whole packs can be restocked: % unit(s) of % (batch %) is not a multiple of % per pack',
          v_item.quantity, v_item.name, v_item.batch_number, v_item.units_per_pack;
      end if;
      v_movement := public.record_inventory_movement(
        v_item.batch_id, 'receive', v_item.quantity / v_item.units_per_pack, null, v_location, p_user_id, 'system',
        null, null, v_return.return_number, format('Pharmacy return (%s)', v_item.reason), p_today);
      update public.return_items
      set restocked_packs = v_item.quantity / v_item.units_per_pack, warehouse_movement_id = v_movement.id
      where id = v_item.id;
      v_restocked := v_restocked + v_item.quantity / v_item.units_per_pack;
    else
      update public.return_items set restocked_packs = 0 where id = v_item.id;
    end if;
  end loop;

  update public.return_requests
  set status        = 'received',
      reviewed_by   = coalesce(reviewed_by, p_user_id),
      reviewed_at   = coalesce(reviewed_at, now()),
      received_by   = p_user_id,
      received_at   = now(),
      receipt_notes = nullif(btrim(p_notes), '')
  where id = p_return_id
  returning * into v_return;

  perform public.pharmacy_audit(p_user_id, v_return.pharmacy_id, 'return.received', 'return_request', v_return.id,
    jsonb_build_object('return_number', v_return.return_number, 'restocked_packs', v_restocked));
  return v_return;
end;
$$;

-- ---------------------------------------------------------------------------
-- Forecasting support
-- ---------------------------------------------------------------------------

-- Daily units sold per product and the closing stock of that day (from the
-- movement ledger; null when no movement had happened yet). Days in the
-- pharmacy's time zone. Used for burn rates, forecasts and stockout detection.
create or replace function public.pharmacy_daily_demand(
  p_pharmacy_id uuid,
  p_from        date,
  p_to          date,
  p_time_zone   text default 'Asia/Colombo'
)
returns table (medicine_id uuid, day date, quantity_sold integer, closing_on_hand integer)
language sql
stable
set search_path = ''
as $$
  with days as (
    select generate_series(p_from, p_to, interval '1 day')::date as day
  ),
  products as (
    select distinct i.medicine_id from public.pharmacy_inventory i where i.pharmacy_id = p_pharmacy_id
  ),
  sold as (
    select si.medicine_id, (si.sold_at at time zone p_time_zone)::date as day, sum(si.quantity)::integer as qty
    from public.sale_items si
    where si.pharmacy_id = p_pharmacy_id
      and si.sold_at >= (p_from::timestamp at time zone p_time_zone)
      and si.sold_at < ((p_to + 1)::timestamp at time zone p_time_zone)
    group by 1, 2
  ),
  closing as (
    select i.medicine_id, d.day,
           sum(last_mv.on_hand_after)::integer as on_hand,
           count(last_mv.on_hand_after)        as known
    from public.pharmacy_inventory i
    cross join days d
    left join lateral (
      select sm.on_hand_after
      from public.stock_movements sm
      where sm.inventory_id = i.id
        and sm.created_at < ((d.day + 1)::timestamp at time zone p_time_zone)
      order by sm.created_at desc, sm.entry_no desc
      limit 1
    ) last_mv on true
    where i.pharmacy_id = p_pharmacy_id
    group by i.medicine_id, d.day
  )
  select p.medicine_id, d.day, coalesce(s.qty, 0), case when c.known > 0 then c.on_hand end
  from products p
  cross join days d
  left join sold s on s.medicine_id = p.medicine_id and s.day = d.day
  left join closing c on c.medicine_id = p.medicine_id and c.day = d.day
  order by 1, 2;
$$;

-- Replaces the pending recommendations of the products in p_rows (one row per
-- product, column names as keys) in one step, keeping one pending row each.
create or replace function public.pharmacy_publish_recommendations(
  p_pharmacy_id uuid,
  p_rows        jsonb
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.reorder_recommendations
  set status = 'superseded'
  where pharmacy_id = p_pharmacy_id
    and status = 'pending'
    and medicine_id in (select (e ->> 'medicine_id')::uuid from jsonb_array_elements(p_rows) e);

  insert into public.reorder_recommendations (
    run_id, pharmacy_id, medicine_id, model_name, is_provisional, burn_rate, forecast_daily_demand,
    lead_time_days, review_period_days, lead_time_demand, review_period_demand, safety_stock,
    reorder_point, target_stock, on_hand_usable, reserved, incoming, inventory_position,
    days_of_cover, projected_stockout_date, stockout_risk, expiry_risk_units, needs_reorder,
    raw_quantity, recommended_units, recommended_packs, constraints_applied, explanation, assumptions
  )
  select
    r.run_id, p_pharmacy_id, r.medicine_id, r.model_name, r.is_provisional, r.burn_rate, r.forecast_daily_demand,
    r.lead_time_days, r.review_period_days, r.lead_time_demand, r.review_period_demand, r.safety_stock,
    r.reorder_point, r.target_stock, r.on_hand_usable, r.reserved, r.incoming, r.inventory_position,
    r.days_of_cover, r.projected_stockout_date, r.stockout_risk, coalesce(r.expiry_risk_units, 0), r.needs_reorder,
    r.raw_quantity, r.recommended_units, r.recommended_packs, coalesce(r.constraints_applied, '[]'::jsonb),
    r.explanation, coalesce(r.assumptions, '{}'::jsonb)
  from jsonb_populate_recordset(null::public.reorder_recommendations, p_rows) r;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.pharmacy_reject_recommendation(
  p_recommendation_id uuid,
  p_pharmacy_id       uuid,
  p_user_id           uuid,
  p_notes             text default null
)
returns public.reorder_recommendations
language plpgsql
set search_path = ''
as $$
declare
  v_rec public.reorder_recommendations;
begin
  select * into v_rec from public.reorder_recommendations where id = p_recommendation_id for update;
  if not found or v_rec.pharmacy_id <> p_pharmacy_id then
    raise exception 'Recommendation not found' using errcode = 'P0002';
  end if;
  if v_rec.status <> 'pending' then
    raise exception 'This recommendation was already %', v_rec.status;
  end if;

  update public.reorder_recommendations
  set status = 'rejected', decided_packs = 0, decided_by = p_user_id, decided_at = now(),
      decision_notes = nullif(btrim(p_notes), '')
  where id = p_recommendation_id
  returning * into v_rec;

  perform public.pharmacy_audit(p_user_id, p_pharmacy_id, 'recommendation.rejected', 'reorder_recommendation',
    v_rec.id, jsonb_build_object('medicine_id', v_rec.medicine_id, 'recommended_packs', v_rec.recommended_packs,
                                 'notes', v_rec.decision_notes));
  return v_rec;
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
      and p.proname in (
        'pharmacy_audit', 'pharmacy_apply_stock_change', 'pharmacy_add_discrepancy', 'pharmacy_adjust_stock',
        'pharmacy_create_order', 'pharmacy_cancel_order', 'pharmacy_dispatch_order', 'pharmacy_confirm_receipt',
        'pharmacy_report_discrepancy', 'pharmacy_update_discrepancy', 'pharmacy_checkout',
        'pharmacy_create_return', 'pharmacy_review_return', 'pharmacy_receive_return',
        'pharmacy_daily_demand', 'pharmacy_publish_recommendations', 'pharmacy_reject_recommendation'
      )
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
