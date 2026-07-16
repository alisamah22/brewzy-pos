-- Brewzy POS — tables + open (anon) RLS policies.
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> Run.
--
-- Troubleshooting: if you get "column ... does not exist" (e.g. sale_date),
-- a `sales` or `products` table already exists from earlier experimentation.
-- `create table if not exists` skips it, keeping the old (wrong) columns.
-- If those tables hold no data you need, reset them first, then re-run this
-- script from the top:
--   drop table if exists public.sales cascade;
--   drop table if exists public.products cascade;

-- Products (the shared menu)
create table if not exists public.products (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name       text not null,
  price      numeric not null,
  category   text not null,
  emoji      text
);

alter table public.products enable row level security;
create policy "anon read products"   on public.products for select to anon using (true);
create policy "anon insert products" on public.products for insert to anon with check (true);
create policy "anon update products" on public.products for update to anon using (true) with check (true);
create policy "anon delete products" on public.products for delete to anon using (true);

-- Sales
create table if not exists public.sales (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  sale_date      date not null,
  payment_method text not null,
  subtotal       numeric not null,
  tax            numeric not null,
  total          numeric not null,
  items          jsonb not null
);

alter table public.sales enable row level security;
create policy "anon read sales"   on public.sales for select to anon using (true);
create policy "anon insert sales" on public.sales for insert to anon with check (true);
create policy "anon delete sales" on public.sales for delete to anon using (true);

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
