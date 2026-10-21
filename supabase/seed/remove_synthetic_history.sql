-- REMOVE THE SYNTHETIC PHARMACY HISTORY (Component 4) BEFORE EVALUATION.
--
-- supabase/seed/sample_pharmacy.sql generates 180 days of simulated sales and
-- replenishment for the SAMPLE pharmacies (sales.source = 'synthetic_seed',
-- stock movement notes starting with 'SAMPLE synthetic'). This script removes
-- that generated history so analytics and evaluation use real transactions only.
--
-- What it keeps:
--   * current stock (on hand, reserved, held) of every batch, unchanged
--   * real POS sales, receipts, returns, discrepancy holds and adjustments,
--     including the live workflow examples created by the sample seed
--   * the sample pharmacies, products, batches, orders and shipments
-- What it does:
--   1. deletes the synthetic sales (their sale items are deleted with them)
--   2. deletes the synthetic stock movements
--   3. adds one opening-balance movement per affected batch so the stock
--      ledger still adds up to the current quantities (dated at the end of
--      the removed history, before any real movement of that batch)
--
-- Run it once in the Supabase SQL editor, after all pharmacy migrations.
-- Safe to re-run: when there is no synthetic history it changes nothing.
-- Afterwards press "Recalculate" on the Analytics page (or wait for the
-- scheduled run) so forecasts, reorder recommendations and alerts are rebuilt
-- from the remaining data. Earlier forecast runs stay as history; their
-- data_note records that they used synthetic sales.

do $$
declare
  v_sales     integer;
  v_movements integer;
  v_openings  integer;
begin
  -- Synthetic movements: the generated opening balances, replenishments and
  -- sales (also matched by the synthetic sale they belong to).
  create temp table synthetic_movements on commit drop as
  select m.id, m.inventory_id, m.created_at, m.entry_no
  from public.stock_movements m
  where m.notes like 'SAMPLE synthetic%'
     or (m.reference_type = 'sale'
         and m.reference_id in (select s.id from public.sales s where s.source = 'synthetic_seed'));

  select count(*) into v_sales from public.sales where source = 'synthetic_seed';
  if v_sales = 0 and not exists (select 1 from synthetic_movements) then
    raise notice 'No synthetic pharmacy history found; nothing changed.';
    return;
  end if;

  -- Stop sales, receipts and adjustments of these batches while the ledger is rewritten.
  perform 1 from public.pharmacy_inventory i
  where i.id in (select inventory_id from synthetic_movements)
  for update;

  delete from public.stock_movements where id in (select id from synthetic_movements);
  get diagnostics v_movements = row_count;

  delete from public.sales where source = 'synthetic_seed';

  -- Opening balance = current quantity minus what the remaining (real)
  -- movements of the batch account for.
  insert into public.stock_movements
    (pharmacy_id, inventory_id, medicine_id, batch_id, movement_type,
     on_hand_change, reserved_change, held_change, on_hand_after, reserved_after, held_after,
     reference_type, notes, created_at)
  select i.pharmacy_id, i.id, i.medicine_id, i.batch_id, 'opening_balance',
         o.on_hand, o.reserved, o.held, o.on_hand, o.reserved, o.held,
         'seed', 'Opening balance after removing the synthetic history', o.at
  from public.pharmacy_inventory i
  join lateral (
    select i.quantity_on_hand  - coalesce(sum(m.on_hand_change), 0)  as on_hand,
           i.quantity_reserved - coalesce(sum(m.reserved_change), 0) as reserved,
           i.quantity_held     - coalesce(sum(m.held_change), 0)     as held,
           -- End of the removed history, never after the first real movement.
           least(
             (select max(s.created_at) from synthetic_movements s where s.inventory_id = i.id),
             coalesce(min(m.created_at) - interval '1 second', 'infinity')
           ) as at
    from public.stock_movements m
    where m.inventory_id = i.id
  ) o on true
  where i.id in (select inventory_id from synthetic_movements)
    and (o.on_hand <> 0 or o.reserved <> 0 or o.held <> 0);
  get diagnostics v_openings = row_count;

  raise notice 'Removed % synthetic sale(s) and % synthetic stock movement(s); added % opening balance(s).',
    v_sales, v_movements, v_openings;
end;
$$;
