-- Brewzy POS migration — vendor logins. Run once on an EXISTING database.
--
-- BEFORE running this, create the Brewzy login in the SQL Editor:
--   1. run 2026-11-09-a-vendor-login-functions.sql
--   2. run:  select create_vendor_login('brewzy', '<Brewzy''s password>');
-- Then: SQL Editor -> New query -> paste this file -> Run.
--
-- What it does:
--   * every table gets an "owner" (the vendor's login); all existing data
--     becomes Brewzy's
--   * the open (no login) access is removed: a vendor that's logged in can
--     only see and change their own menu, sales, bills, discards and
--     pending orders
--   * sales stay permanent: they can be added and voided, never edited or deleted
-- Safe to re-run.

-- 1. Owner column on every table (new rows get the logged-in vendor).
alter table public.products       add column if not exists owner uuid references auth.users(id) default auth.uid();
alter table public.sales          add column if not exists owner uuid references auth.users(id) default auth.uid();
alter table public.discards       add column if not exists owner uuid references auth.users(id) default auth.uid();
alter table public.expenses       add column if not exists owner uuid references auth.users(id) default auth.uid();
alter table public.pending_orders add column if not exists owner uuid references auth.users(id) default auth.uid();

-- 2. Everything that exists today belongs to Brewzy.
do $$
declare
  brewzy uuid;
begin
  select id into brewzy from auth.users where email = 'brewzy@brewzy-pos.example.com';
  if brewzy is null then
    raise exception 'Create the Brewzy login first: run 2026-11-09-a-vendor-login-functions.sql, then select create_vendor_login(''brewzy'', ''<password>'');';
  end if;
  update public.products       set owner = brewzy where owner is null;
  update public.sales          set owner = brewzy where owner is null;
  update public.discards       set owner = brewzy where owner is null;
  update public.expenses       set owner = brewzy where owner is null;
  update public.pending_orders set owner = brewzy where owner is null;
end $$;

alter table public.products       alter column owner set not null;
alter table public.sales          alter column owner set not null;
alter table public.discards       alter column owner set not null;
alter table public.expenses       alter column owner set not null;
alter table public.pending_orders alter column owner set not null;

create index if not exists products_owner_idx       on public.products (owner);
create index if not exists sales_owner_date_idx     on public.sales (owner, sale_date);
create index if not exists discards_owner_idx       on public.discards (owner);
create index if not exists expenses_owner_idx       on public.expenses (owner);
create index if not exists pending_orders_owner_idx on public.pending_orders (owner);

-- 3. Remove the open (no login) access.
drop policy if exists "anon read products"   on public.products;
drop policy if exists "anon insert products" on public.products;
drop policy if exists "anon update products" on public.products;
drop policy if exists "anon delete products" on public.products;
drop policy if exists "anon read sales"   on public.sales;
drop policy if exists "anon insert sales" on public.sales;
drop policy if exists "anon void sales"   on public.sales;
drop policy if exists "anon read discards"   on public.discards;
drop policy if exists "anon insert discards" on public.discards;
drop policy if exists "anon update discards" on public.discards;
drop policy if exists "anon delete discards" on public.discards;
drop policy if exists "anon read expenses"   on public.expenses;
drop policy if exists "anon insert expenses" on public.expenses;
drop policy if exists "anon update expenses" on public.expenses;
drop policy if exists "anon delete expenses" on public.expenses;
drop policy if exists "anon read pending orders"   on public.pending_orders;
drop policy if exists "anon insert pending orders" on public.pending_orders;
drop policy if exists "anon update pending orders" on public.pending_orders;
drop policy if exists "anon delete pending orders" on public.pending_orders;

-- 4. A logged-in vendor reaches only their own rows.
drop policy if exists "own products"       on public.products;
drop policy if exists "own sales read"     on public.sales;
drop policy if exists "own sales insert"   on public.sales;
drop policy if exists "own sales void"     on public.sales;
drop policy if exists "own discards"       on public.discards;
drop policy if exists "own expenses"       on public.expenses;
drop policy if exists "own pending orders" on public.pending_orders;

create policy "own products" on public.products for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());
create policy "own sales read" on public.sales for select to authenticated
  using (owner = auth.uid());
create policy "own sales insert" on public.sales for insert to authenticated
  with check (owner = auth.uid());
create policy "own sales void" on public.sales for update to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());
create policy "own discards" on public.discards for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());
create policy "own expenses" on public.expenses for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());
create policy "own pending orders" on public.pending_orders for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());

-- 5. Sales stay permanent: only the void columns may change; nothing is deleted.
revoke update, delete, truncate on public.sales from anon, authenticated;
grant update (voided, voided_at) on public.sales to authenticated;
