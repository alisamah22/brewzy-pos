-- Brewzy POS — tables + open (anon) RLS policies.
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> Run.
--
-- Already have the tables from an earlier version? Don't re-run this file —
-- run the files in supabase/migrations/ (oldest first) instead.
-- They add the new columns and tables without touching your data.

-- Products (the shared menu)
create table if not exists public.products (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name       text not null,
  price      numeric not null,            -- selling price
  sale_price numeric check (sale_price is null or sale_price >= 0), -- discount price; null = no discount
  cost       numeric not null default 0,  -- stock (buying) price
  stock_qty  integer not null default 0,  -- quantity in stock
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

-- Discarded stock. Each row is one discard of one item on one date. The
-- stock and selling price are saved with the row so later price changes
-- don't rewrite past losses. Rows can be edited and deleted from the app.
create table if not exists public.discards (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  product_id   uuid references public.products(id) on delete set null,
  product_name text not null,
  qty          integer not null check (qty > 0),
  cost         numeric not null default 0,  -- stock (buying) price per unit
  price        numeric not null default 0,  -- selling price per unit
  discard_date date not null
);

alter table public.discards enable row level security;
create policy "anon read discards"   on public.discards for select to anon using (true);
create policy "anon insert discards" on public.discards for insert to anon with check (true);
create policy "anon update discards" on public.discards for update to anon using (true) with check (true);
create policy "anon delete discards" on public.discards for delete to anon using (true);

create index if not exists discards_discard_date_idx on public.discards (discard_date);
create index if not exists discards_product_id_idx on public.discards (product_id);

-- Bills (expenses) such as Expo prep shopping. "scope" says which report
-- they belong to ('Expo' for now). Rows can be edited and deleted.
create table if not exists public.expenses (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  expense_date date not null,
  description  text not null,
  amount       numeric not null check (amount >= 0),
  scope        text not null default 'Expo'
);

alter table public.expenses enable row level security;
create policy "anon read expenses"   on public.expenses for select to anon using (true);
create policy "anon insert expenses" on public.expenses for insert to anon with check (true);
create policy "anon update expenses" on public.expenses for update to anon using (true) with check (true);
create policy "anon delete expenses" on public.expenses for delete to anon using (true);

create index if not exists expenses_expense_date_idx on public.expenses (expense_date);

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
