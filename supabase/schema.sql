-- Brewzy POS — tables + open (anon) RLS policies.
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> Run.
--
-- Already have the tables from an earlier version? Don't re-run this file —
-- run supabase/migrations/2026-09-24-buying-price-and-keep-sales.sql instead.
-- It adds the new columns without touching your data.

-- Products (the shared menu)
create table if not exists public.products (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name       text not null,
  price      numeric not null,            -- selling price
  cost       numeric not null default 0,  -- buying price
  category   text not null,
  emoji      text
);

alter table public.products enable row level security;
create policy "anon read products"   on public.products for select to anon using (true);
create policy "anon insert products" on public.products for insert to anon with check (true);
create policy "anon update products" on public.products for update to anon using (true) with check (true);
create policy "anon delete products" on public.products for delete to anon using (true);

-- Sales. Rows are permanent: the app can add sales and mark them void, but
-- cannot edit or delete them.
create table if not exists public.sales (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  sale_date      date not null,
  payment_method text not null,
  subtotal       numeric not null,
  tax            numeric not null,
  total          numeric not null,
  items          jsonb not null,
  voided         boolean not null default false,
  voided_at      timestamptz
);

alter table public.sales enable row level security;
create policy "anon read sales"   on public.sales for select to anon using (true);
create policy "anon insert sales" on public.sales for insert to anon with check (true);
create policy "anon void sales"   on public.sales for update to anon using (true) with check (true);

-- Only the void columns may be updated; nothing may be deleted.
revoke update, delete, truncate on public.sales from anon, authenticated;
grant update (voided, voided_at) on public.sales to anon;

create index if not exists sales_sale_date_idx on public.sales (sale_date);

-- Optional one-time seed of the starting menu.
-- Run this block ONCE; re-running it duplicates the items.
insert into public.products (name, price, category, emoji) values
  ('Submarine', 20, 'Kulhi', '🍔'),
  ('Boava', 25, 'Kulhi', '🍔'),
  ('Rihaakuru roshi', 12, 'Kulhi', '🍫'),
  ('Brownie bits', 65, 'Desserts', '🍫'),
  ('Brownie', 35, 'Desserts', '🍫'),
  ('Cookie Bits', 50, 'Desserts', '🍫'),
  ('Tres leches', 40, 'Desserts', '🍫'),
  ('Sausage', 10, 'Kulhi', '🍔'),
  ('Metaa gandu', 20, 'Desserts', '🍰'),
  ('Ice Cream', 35, 'Desserts', '🍨');
