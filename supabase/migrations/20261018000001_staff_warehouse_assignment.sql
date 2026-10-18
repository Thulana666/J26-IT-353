-- Component 3: the warehouse a warehouse staff member (or an admin) works in.
--
-- Shared table profiles, additive: warehouse_id next to Component 4's
-- pharmacy_id. Only admins and warehouse staff have a warehouse; a role change
-- to any other role (from any page or API) clears it, so the assignment never
-- contradicts the role. Assigned in Warehouse -> Staff (admins only).

alter table public.profiles
  add column if not exists warehouse_id uuid references public.warehouses (id) on delete set null;
create index if not exists profiles_warehouse_id_idx on public.profiles (warehouse_id);

create or replace function public.profiles_clear_warehouse_for_other_roles()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.role not in ('admin', 'warehouse_staff') then
    new.warehouse_id := null;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_clear_warehouse_for_other_roles on public.profiles;
create trigger profiles_clear_warehouse_for_other_roles
  before insert or update of role, warehouse_id on public.profiles
  for each row execute function public.profiles_clear_warehouse_for_other_roles();
