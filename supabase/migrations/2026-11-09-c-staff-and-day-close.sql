-- Brewzy POS migration — staff logins (admin / cashier) and day close.
-- Run once, after 2026-11-09-b-tables.sql.
-- Supabase dashboard: SQL Editor -> New query -> paste -> Run. Safe to re-run.
--
-- A vendor's main login (e.g. brewzy) is an admin. In the app, an admin can
-- add staff logins under the vendor:
--   admin   – everything: reports, items and prices, tables, staff, bills
--   cashier – sell (tables, counter, pay later, discount button) and close the day
-- Everyone under a vendor works on the vendor's data. The database enforces
-- the roles, not just the app.

-- 1. Staff belonging to a vendor.
create table if not exists public.vendor_members (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  vendor_id  uuid not null references auth.users(id) on delete cascade,
  username   text not null,
  role       text not null check (role in ('admin', 'cashier')),
  created_at timestamptz not null default now()
);
alter table public.vendor_members enable row level security;
-- Read and changed only through the functions below.

-- 2. Who is logged in: their vendor and role. A login that isn't staff is a
--    vendor's main login (an admin of its own data).
create or replace function public.my_vendor() returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce((select vendor_id from public.vendor_members where user_id = auth.uid()), auth.uid())
$$;

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select role from public.vendor_members where user_id = auth.uid()), 'admin')
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select public.my_role() = 'admin'
$$;

revoke all on function public.my_vendor() from public, anon;
revoke all on function public.my_role() from public, anon;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.my_vendor() to authenticated;
grant execute on function public.my_role() to authenticated;
grant execute on function public.is_admin() to authenticated;

-- 3. Day close: the counted cash / transfer / card against the system, per day.
create table if not exists public.day_closes (
  id                uuid primary key default gen_random_uuid(),
  owner             uuid not null references auth.users(id) default public.my_vendor(),
  close_date        date not null,
  closed_by         text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  cash_expected     numeric not null default 0,
  cash_counted      numeric not null default 0,
  cash_breakdown    jsonb not null default '{}'::jsonb,
  transfer_expected numeric not null default 0,
  transfer_counted  numeric not null default 0,
  card_expected     numeric not null default 0,
  card_counted      numeric not null default 0,
  note              text,
  unique (owner, close_date)
);
alter table public.day_closes enable row level security;

-- 4. Everything belongs to the vendor (not the individual staff login).
alter table public.products       alter column owner set default public.my_vendor();
alter table public.sales          alter column owner set default public.my_vendor();
alter table public.discards       alter column owner set default public.my_vendor();
alter table public.expenses       alter column owner set default public.my_vendor();
alter table public.pending_orders alter column owner set default public.my_vendor();
alter table public.dining_tables  alter column owner set default public.my_vendor();

-- 5. Access rules: everyone in the vendor can read and sell; admins change the rest.
drop policy if exists "own products"       on public.products;
drop policy if exists "own sales read"     on public.sales;
drop policy if exists "own sales insert"   on public.sales;
drop policy if exists "own sales void"     on public.sales;
drop policy if exists "own discards"       on public.discards;
drop policy if exists "own expenses"       on public.expenses;
drop policy if exists "own pending orders" on public.pending_orders;
drop policy if exists "own tables"         on public.dining_tables;
drop policy if exists "vendor read products"   on public.products;
drop policy if exists "admin write products"   on public.products;
drop policy if exists "vendor read sales"      on public.sales;
drop policy if exists "vendor add sales"       on public.sales;
drop policy if exists "admin void sales"       on public.sales;
drop policy if exists "vendor read discards"   on public.discards;
drop policy if exists "admin write discards"   on public.discards;
drop policy if exists "vendor read expenses"   on public.expenses;
drop policy if exists "admin write expenses"   on public.expenses;
drop policy if exists "vendor pending orders"  on public.pending_orders;
drop policy if exists "vendor read tables"     on public.dining_tables;
drop policy if exists "admin write tables"     on public.dining_tables;
drop policy if exists "vendor read day closes" on public.day_closes;
drop policy if exists "vendor close day"       on public.day_closes;
drop policy if exists "vendor reclose day"     on public.day_closes;
drop policy if exists "admin delete day close" on public.day_closes;

create policy "vendor read products" on public.products for select to authenticated
  using (owner = (select public.my_vendor()));
create policy "admin write products" on public.products for all to authenticated
  using (owner = (select public.my_vendor()) and (select public.is_admin()))
  with check (owner = (select public.my_vendor()) and (select public.is_admin()));

create policy "vendor read sales" on public.sales for select to authenticated
  using (owner = (select public.my_vendor()));
create policy "vendor add sales" on public.sales for insert to authenticated
  with check (owner = (select public.my_vendor()));
create policy "admin void sales" on public.sales for update to authenticated
  using (owner = (select public.my_vendor()) and (select public.is_admin()))
  with check (owner = (select public.my_vendor()) and (select public.is_admin()));

create policy "vendor read discards" on public.discards for select to authenticated
  using (owner = (select public.my_vendor()));
create policy "admin write discards" on public.discards for all to authenticated
  using (owner = (select public.my_vendor()) and (select public.is_admin()))
  with check (owner = (select public.my_vendor()) and (select public.is_admin()));

create policy "vendor read expenses" on public.expenses for select to authenticated
  using (owner = (select public.my_vendor()));
create policy "admin write expenses" on public.expenses for all to authenticated
  using (owner = (select public.my_vendor()) and (select public.is_admin()))
  with check (owner = (select public.my_vendor()) and (select public.is_admin()));

create policy "vendor pending orders" on public.pending_orders for all to authenticated
  using (owner = (select public.my_vendor())) with check (owner = (select public.my_vendor()));

create policy "vendor read tables" on public.dining_tables for select to authenticated
  using (owner = (select public.my_vendor()));
create policy "admin write tables" on public.dining_tables for all to authenticated
  using (owner = (select public.my_vendor()) and (select public.is_admin()))
  with check (owner = (select public.my_vendor()) and (select public.is_admin()));

create policy "vendor read day closes" on public.day_closes for select to authenticated
  using (owner = (select public.my_vendor()));
create policy "vendor close day" on public.day_closes for insert to authenticated
  with check (owner = (select public.my_vendor()));
create policy "vendor reclose day" on public.day_closes for update to authenticated
  using (owner = (select public.my_vendor())) with check (owner = (select public.my_vendor()));
create policy "admin delete day close" on public.day_closes for delete to authenticated
  using (owner = (select public.my_vendor()) and (select public.is_admin()));

-- 6. Functions the app calls.

-- Who is logged in: { user_id, username, vendor_id, vendor_username, role }.
create or replace function public.whoami() returns json
language sql stable security definer set search_path = public, auth as $$
  select json_build_object(
    'user_id', auth.uid(),
    'username', split_part((select email from auth.users where id = auth.uid()), '@', 1),
    'vendor_id', public.my_vendor(),
    'vendor_username', split_part((select email from auth.users where id = public.my_vendor()), '@', 1),
    'role', public.my_role()
  )
$$;

-- Staff of the logged-in admin's vendor.
create or replace function public.list_staff()
returns table (username text, role text, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only an admin can see staff.'; end if;
  return query select m.username, m.role, m.created_at from public.vendor_members m
    where m.vendor_id = public.my_vendor() order by m.created_at;
end $$;

create or replace function public.create_staff(username text, password text, role text)
returns void
language plpgsql security definer set search_path = public, extensions, auth as $$
declare
  uid uuid;
begin
  if not public.is_admin() then raise exception 'Only an admin can add staff.'; end if;
  if role not in ('admin', 'cashier') then raise exception 'Role must be admin or cashier.'; end if;
  uid := public.create_vendor_login(username, password);
  insert into public.vendor_members (user_id, vendor_id, username, role)
    values (uid, public.my_vendor(), lower(trim(username)), role);
end $$;

create or replace function public.set_staff_role(username text, role text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only an admin can change staff.'; end if;
  if role not in ('admin', 'cashier') then raise exception 'Role must be admin or cashier.'; end if;
  update public.vendor_members m set role = set_staff_role.role
   where m.username = lower(trim(set_staff_role.username)) and m.vendor_id = public.my_vendor();
  if not found then raise exception 'No staff login named "%".', lower(trim(username)); end if;
end $$;

create or replace function public.reset_staff_password(username text, password text)
returns void
language plpgsql security definer set search_path = public, extensions, auth as $$
begin
  if not public.is_admin() then raise exception 'Only an admin can change passwords.'; end if;
  if not exists (select 1 from public.vendor_members m
                  where m.username = lower(trim(reset_staff_password.username)) and m.vendor_id = public.my_vendor()) then
    raise exception 'No staff login named "%".', lower(trim(username));
  end if;
  perform public.set_vendor_password(username, password);
end $$;

create or replace function public.remove_staff(username text)
returns void
language plpgsql security definer set search_path = public, auth as $$
declare
  uid uuid;
begin
  if not public.is_admin() then raise exception 'Only an admin can remove staff.'; end if;
  select m.user_id into uid from public.vendor_members m
   where m.username = lower(trim(remove_staff.username)) and m.vendor_id = public.my_vendor();
  if uid is null then raise exception 'No staff login named "%".', lower(trim(username)); end if;
  if uid = auth.uid() then raise exception 'You can''t remove your own login.'; end if;
  delete from auth.users where id = uid;
end $$;

revoke all on function public.whoami() from public, anon;
revoke all on function public.list_staff() from public, anon;
revoke all on function public.create_staff(text, text, text) from public, anon;
revoke all on function public.set_staff_role(text, text) from public, anon;
revoke all on function public.reset_staff_password(text, text) from public, anon;
revoke all on function public.remove_staff(text) from public, anon;
grant execute on function public.whoami() to authenticated;
grant execute on function public.list_staff() to authenticated;
grant execute on function public.create_staff(text, text, text) to authenticated;
grant execute on function public.set_staff_role(text, text) to authenticated;
grant execute on function public.reset_staff_password(text, text) to authenticated;
grant execute on function public.remove_staff(text) to authenticated;
