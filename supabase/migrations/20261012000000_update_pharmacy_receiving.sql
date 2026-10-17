-- Component 4 update: receiving without item-by-item scanning, item-level
-- acceptance of disputed items, idempotent receipt / discrepancy reports /
-- return acceptance, and the moving-average forecast engine.
--
-- Backward compatible: adds columns and allowed check values and replaces
-- pharmacy functions. No shared table is renamed or dropped.
--
-- Receiving rules (pharmacy_confirm_receipt):
--   * Staff inspect the delivery physically. A fully matching shipment is
--     confirmed in one step: the shipped quantities and the warehouse's batch
--     details already stored on shipment_items are added to stock. Nothing is
--     taken from the browser.
--   * An item with any discrepancy report is disputed: it is never added to
--     stock by the receipt. If any report exists, the full confirmation is
--     refused and staff must explicitly "accept verified items" (partial
--     receipt), which accepts only the undisputed items.
--   * A disputed item is accepted later with pharmacy_settle_shipment_item(),
--     only after the warehouse has resolved all its reports, with the quantity
--     staff verified (never more than shipped).
--   * Repeating a confirmation, settlement, discrepancy submission (same
--     request id) or return acceptance is a no-op: stock changes at most once.

-- ---------------------------------------------------------------------------
-- Columns and check values
-- ---------------------------------------------------------------------------

-- Who accepted each shipment item into stock, and when.
-- quantity_accepted is null until an item is accepted (0 = accepted, nothing added).
alter table public.shipment_items
  add column if not exists accepted_at timestamptz,
  add column if not exists accepted_by uuid references auth.users (id) on delete set null;

-- Idempotency key of a discrepancy submission: a repeated submission returns
-- the first report; a genuinely new report gets a new key.
alter table public.shipment_discrepancies
  add column if not exists client_request_id uuid;
create unique index if not exists shipment_discrepancies_request_key
  on public.shipment_discrepancies (shipment_id, client_request_id) where client_request_id is not null;
create index if not exists shipment_discrepancies_item_idx on public.shipment_discrepancies (shipment_item_id);

-- Forecasts now come from the backend's moving average ('moving_average');
-- the earlier values stay allowed for existing rows.
alter table public.pharmacy_forecast_runs
  drop constraint if exists pharmacy_forecast_runs_engine_check,
  add constraint pharmacy_forecast_runs_engine_check
    check (engine in ('moving_average', 'ai_service', 'baseline_fallback'));

-- 'reorder': inventory position at or below the reorder point.
alter table public.pharmacy_alerts
  drop constraint if exists pharmacy_alerts_alert_type_check,
  add constraint pharmacy_alerts_alert_type_check
    check (alert_type in ('low_stock', 'reorder', 'predicted_stockout', 'near_expiry', 'expired', 'unusual_consumption'));

-- ---------------------------------------------------------------------------
-- Receiving
-- ---------------------------------------------------------------------------

-- The old receipt took counted quantities from the browser; it is replaced.
drop function if exists public.pharmacy_confirm_receipt(uuid, uuid, uuid, jsonb, jsonb, text, date);
drop function if exists public.pharmacy_report_discrepancy(uuid, uuid, uuid, text, uuid, integer, integer, text, text, text);

-- Accepts p_quantity warehouse packs of one shipment item into stock (internal).
-- The caller has locked the shipment and checked the item is not accepted yet.
create or replace function public.pharmacy_accept_shipment_item(
  p_item_id  uuid,
  p_quantity integer,
  p_user_id  uuid,
  p_note     text
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_item public.shipment_items;
  v_inv  public.pharmacy_inventory;
  v_units integer;
begin
  select * into v_item from public.shipment_items where id = p_item_id for update;
  if v_item.quantity_accepted is not null then
    return 0;
  end if;
  if p_quantity < 0 or p_quantity > v_item.quantity_shipped then
    raise exception 'Accepted quantity must be between 0 and the % pack(s) shipped', v_item.quantity_shipped;
  end if;

  update public.shipment_items
  set quantity_accepted = p_quantity,
      quantity_received = coalesce(quantity_received, p_quantity),
      accepted_at       = now(),
      accepted_by       = p_user_id,
      verified_at       = coalesce(verified_at, now())
  where id = p_item_id;

  v_units := p_quantity * v_item.units_per_pack;
  if v_units > 0 then
    -- Warehouse-provided batch, cost and price from the shipment item.
    insert into public.pharmacy_inventory (pharmacy_id, batch_id, medicine_id, unit_cost, unit_price)
    values (v_item.pharmacy_id, v_item.batch_id, v_item.medicine_id, v_item.unit_cost, v_item.unit_price)
    on conflict (pharmacy_id, batch_id) do update
      set unit_cost  = coalesce(excluded.unit_cost, public.pharmacy_inventory.unit_cost),
          unit_price = coalesce(excluded.unit_price, public.pharmacy_inventory.unit_price)
    returning * into v_inv;

    perform public.pharmacy_apply_stock_change(
      v_inv.id, v_units, 0, 'receipt', 'shipment', v_item.shipment_id, p_user_id, p_note);
  end if;
  return v_units;
end;
$$;

-- Confirms receipt of a shipment after physical inspection.
-- p_accept_partial = false: every item must be undisputed; all are accepted.
-- p_accept_partial = true:  undisputed items are accepted, disputed ones held.
-- Returns { already_processed, shipment_id, shipment_number, status,
--           items_accepted, items_held, units_added }.
create or replace function public.pharmacy_confirm_receipt(
  p_shipment_id    uuid,
  p_pharmacy_id    uuid,
  p_user_id        uuid,
  p_accept_partial boolean default false,
  p_notes          text default null,
  p_today          date default ((now() at time zone 'Asia/Colombo')::date)
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_shipment public.shipments;
  v_item     record;
  v_blocked  text := null;
  v_issues   integer;
  v_accepted integer := 0;
  v_held     integer := 0;
  v_units    integer := 0;
begin
  select * into v_shipment from public.shipments where id = p_shipment_id for update;
  if not found or v_shipment.pharmacy_id <> p_pharmacy_id then
    raise exception 'Shipment not found' using errcode = 'P0002';
  end if;

  -- Already received (repeated click, retry or a second device): no change.
  if v_shipment.status <> 'in_transit' then
    return jsonb_build_object(
      'already_processed', true,
      'shipment_id', v_shipment.id,
      'shipment_number', v_shipment.shipment_number,
      'status', v_shipment.status,
      'items_accepted', (select count(*) from public.shipment_items where shipment_id = p_shipment_id and quantity_accepted is not null),
      'items_held', (select count(*) from public.shipment_items where shipment_id = p_shipment_id and quantity_accepted is null),
      'units_added', 0);
  end if;

  -- Items whose batch can no longer be stocked (expired, recalled, quarantined).
  for v_item in
    select si.id, b.batch_number, b.expiry_date, b.status as batch_status, m.name
    from public.shipment_items si
    join public.batches b on b.id = si.batch_id
    join public.medicines m on m.id = si.medicine_id
    where si.shipment_id = p_shipment_id
      and (b.expiry_date < p_today or b.status <> 'active')
      and not exists (select 1 from public.shipment_discrepancies d where d.shipment_item_id = si.id)
  loop
    if not p_accept_partial then
      v_blocked := coalesce(v_blocked || '; ', '') ||
        format('%s batch %s is %s', v_item.name, v_item.batch_number,
               case when v_item.batch_status <> 'active' then v_item.batch_status
                    else 'expired (' || v_item.expiry_date || ')' end);
    else
      perform public.pharmacy_add_discrepancy(
        v_shipment, v_item.id, (select medicine_id from public.shipment_items where id = v_item.id),
        (select batch_id from public.shipment_items where id = v_item.id),
        case when v_item.batch_status <> 'active' then 'other' else 'expired' end,
        (select quantity_shipped from public.shipment_items where id = v_item.id), null,
        format('Batch %s cannot be stocked (%s); held at receipt.', v_item.batch_number,
               case when v_item.batch_status <> 'active' then v_item.batch_status else 'expired ' || v_item.expiry_date end),
        p_user_id);
    end if;
  end loop;
  if v_blocked is not null then
    raise exception '% and cannot be accepted. Use "Accept verified items" to receive the rest; it will be reported to the warehouse.', v_blocked;
  end if;

  select count(*) into v_issues from public.shipment_discrepancies where shipment_id = p_shipment_id;
  if v_issues > 0 and not p_accept_partial then
    raise exception 'Shipment % has % discrepancy report(s), so it cannot be confirmed as fully correct. Use "Accept verified items": disputed items stay out of stock.',
      v_shipment.shipment_number, v_issues;
  end if;

  for v_item in
    select si.id, si.quantity_shipped,
           exists (select 1 from public.shipment_discrepancies d where d.shipment_item_id = si.id) as disputed
    from public.shipment_items si
    where si.shipment_id = p_shipment_id
    order by si.batch_id
  loop
    if v_item.disputed then
      update public.shipment_items set verification_status = 'discrepancy', verified_at = coalesce(verified_at, now())
      where id = v_item.id;
      v_held := v_held + 1;
    else
      update public.shipment_items set verification_status = 'matched', quantity_damaged = 0 where id = v_item.id;
      v_units := v_units + public.pharmacy_accept_shipment_item(
        v_item.id, v_item.quantity_shipped, p_user_id, format('%s: received as shipped', v_shipment.shipment_number));
      v_accepted := v_accepted + 1;
    end if;
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

  perform public.pharmacy_audit(p_user_id, p_pharmacy_id,
    case when v_held > 0 then 'shipment.received_partially' else 'shipment.received' end,
    'shipment', p_shipment_id,
    jsonb_build_object('shipment_number', v_shipment.shipment_number, 'items_accepted', v_accepted,
                       'items_held', v_held, 'units_added', v_units, 'discrepancies', v_issues));

  return jsonb_build_object(
    'already_processed', false,
    'shipment_id', v_shipment.id,
    'shipment_number', v_shipment.shipment_number,
    'status', v_shipment.status,
    'items_accepted', v_accepted,
    'items_held', v_held,
    'units_added', v_units);
end;
$$;

-- Accepts a disputed (held) item once the warehouse has resolved all its
-- reports, with the number of packs staff verified (0 .. shipped).
-- Returns { already_processed, item_id, quantity_accepted, units_added }.
create or replace function public.pharmacy_settle_shipment_item(
  p_item_id     uuid,
  p_pharmacy_id uuid,
  p_user_id     uuid,
  p_quantity    integer,
  p_notes       text default null,
  p_today       date default ((now() at time zone 'Asia/Colombo')::date)
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_item     record;
  v_shipment public.shipments;
  v_open     text;
  v_units    integer;
begin
  select si.*, b.batch_number, b.expiry_date, b.status as batch_status, m.name
  into v_item
  from public.shipment_items si
  join public.batches b on b.id = si.batch_id
  join public.medicines m on m.id = si.medicine_id
  where si.id = p_item_id;
  if not found or v_item.pharmacy_id <> p_pharmacy_id then
    raise exception 'Shipment item not found' using errcode = 'P0002';
  end if;

  -- Serialise with receipt and other settlements of this shipment.
  select * into v_shipment from public.shipments where id = v_item.shipment_id for update;
  select quantity_accepted into v_item.quantity_accepted from public.shipment_items where id = p_item_id for update;

  if v_item.quantity_accepted is not null then
    return jsonb_build_object('already_processed', true, 'item_id', p_item_id,
                              'quantity_accepted', v_item.quantity_accepted, 'units_added', 0);
  end if;
  if v_shipment.status = 'in_transit' then
    raise exception 'Record the receipt of shipment % first ("Accept verified items")', v_shipment.shipment_number;
  end if;
  select string_agg(report_number, ', ') into v_open
  from public.shipment_discrepancies
  where shipment_item_id = p_item_id and status <> 'resolved';
  if v_open is not null then
    raise exception 'The warehouse has not resolved report(s) % yet; disputed quantities stay out of stock until then', v_open;
  end if;
  if p_quantity is null or p_quantity < 0 or p_quantity > v_item.quantity_shipped then
    raise exception 'Enter the verified packs of % (between 0 and the % shipped)', v_item.name, v_item.quantity_shipped;
  end if;
  if p_quantity > 0 and (v_item.expiry_date < p_today or v_item.batch_status <> 'active') then
    raise exception '% batch % cannot be stocked (%)', v_item.name, v_item.batch_number,
      case when v_item.batch_status <> 'active' then v_item.batch_status else 'expired' end;
  end if;

  v_units := public.pharmacy_accept_shipment_item(p_item_id, p_quantity, p_user_id,
    format('%s: %s verified pack(s) accepted after discrepancy resolution', v_shipment.shipment_number, p_quantity));

  perform public.pharmacy_audit(p_user_id, p_pharmacy_id, 'shipment_item.settled', 'shipment_item', p_item_id,
    jsonb_build_object('shipment_number', v_shipment.shipment_number, 'batch_number', v_item.batch_number,
                       'quantity_accepted', p_quantity, 'units_added', v_units, 'notes', nullif(btrim(p_notes), '')));

  return jsonb_build_object('already_processed', false, 'item_id', p_item_id,
                            'quantity_accepted', p_quantity, 'units_added', v_units);
end;
$$;

-- Records a discrepancy for one disputed item (or an unknown / unexpected
-- item). The expected quantity of a shipment item comes from the shipment,
-- not from the browser. A repeated p_client_request_id returns the first
-- report. Recording a report never adds or removes stock.
-- Returns the report as JSON plus "duplicate".
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
begin
  if p_client_request_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('pharmacy_discrepancy:' || p_client_request_id::text, 0));
    select * into v_row from public.shipment_discrepancies
    where shipment_id = p_shipment_id and client_request_id = p_client_request_id;
    if found then
      return to_jsonb(v_row) || jsonb_build_object('duplicate', true);
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

  -- Before receipt the item is now disputed; after receipt the report is
  -- informational (accepted stock is corrected separately if needed).
  if v_shipment.status = 'in_transit' and v_item.id is not null then
    update public.shipment_items set verification_status = 'discrepancy' where id = v_item.id;
  end if;
  if v_shipment.status = 'received' then
    update public.shipments set status = 'received_with_discrepancies' where id = p_shipment_id;
  end if;

  perform public.pharmacy_audit(p_user_id, p_pharmacy_id, 'discrepancy.reported', 'shipment_discrepancy', v_row.id,
    jsonb_build_object('report_number', v_row.report_number, 'shipment_number', v_shipment.shipment_number,
                       'type', p_type, 'expected', v_expected, 'observed', p_observed,
                       'after_receipt', v_shipment.status <> 'in_transit'));
  return to_jsonb(v_row) || jsonb_build_object('duplicate', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- Returns: review and warehouse acceptance are idempotent
-- ---------------------------------------------------------------------------

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
    if v_return.status = 'approved' then
      return v_return;
    end if;
    if v_return.status <> 'pending' then
      raise exception 'Return % is % and cannot be approved', v_return.return_number, v_return.status;
    end if;
  elsif p_decision = 'reject' then
    if v_return.status = 'rejected' then
      return v_return;
    end if;
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

-- Warehouse confirms it received the returned stock: only now does the stock
-- leave the pharmacy (and whole packs may be restocked into warehouse
-- locations). Confirming an already received return changes nothing.
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
  v_return    public.return_requests;
  v_item      record;
  v_location  uuid;
  v_movement  public.inventory_movements;
  v_restocked integer := 0;
begin
  select * into v_return from public.return_requests where id = p_return_id for update;
  if not found then
    raise exception 'Return request not found' using errcode = 'P0002';
  end if;
  if v_return.status = 'received' then
    return v_return;
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
      and p.proname in ('pharmacy_accept_shipment_item', 'pharmacy_confirm_receipt', 'pharmacy_settle_shipment_item',
                        'pharmacy_report_discrepancy', 'pharmacy_review_return', 'pharmacy_receive_return')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
