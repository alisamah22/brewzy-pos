-- Brewzy POS — tables + per-vendor (login) RLS policies.
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> Run.
--
-- Already have the tables from an earlier version? Don't re-run this file —
-- run the files in supabase/migrations/ (oldest first) instead.
-- They add the new columns and tables without touching your data.

-- Products (the shared menu)
create table if not exists public.products (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null references auth.users(id) default auth.uid(),  -- the vendor's login
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

-- Sales. Rows are permanent: the app can add sales and mark them void, but
-- cannot edit or delete them.
create table if not exists public.sales (
  id             uuid primary key default gen_random_uuid(),
  owner      uuid not null references auth.users(id) default auth.uid(),  -- the vendor's login
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

-- Only the void columns may be updated; nothing may be deleted.
revoke update, delete, truncate on public.sales from anon, authenticated;
grant update (voided, voided_at) on public.sales to authenticated;

create index if not exists sales_sale_date_idx on public.sales (sale_date);

-- Discarded stock. Each row is one discard of one item on one date. The
-- stock and selling price are saved with the row so later price changes
-- don't rewrite past losses. Rows can be edited and deleted from the app.
create table if not exists public.discards (
  id           uuid primary key default gen_random_uuid(),
  owner      uuid not null references auth.users(id) default auth.uid(),  -- the vendor's login
  created_at   timestamptz not null default now(),
  product_id   uuid references public.products(id) on delete set null,
  product_name text not null,
  qty          integer not null check (qty > 0),
  cost         numeric not null default 0,  -- stock (buying) price per unit
  price        numeric not null default 0,  -- selling price per unit
  discard_date date not null
);

alter table public.discards enable row level security;

create index if not exists discards_discard_date_idx on public.discards (discard_date);
create index if not exists discards_product_id_idx on public.discards (product_id);

-- Bills (expenses) such as Expo prep shopping. "scope" says which report
-- they belong to ('Expo' for now). Rows can be edited and deleted.
create table if not exists public.expenses (
  id           uuid primary key default gen_random_uuid(),
  owner      uuid not null references auth.users(id) default auth.uid(),  -- the vendor's login
  created_at   timestamptz not null default now(),
  expense_date date not null,
  description  text not null,
  amount       numeric not null check (amount >= 0),
  scope        text not null default 'Expo'
);

alter table public.expenses enable row level security;

create index if not exists expenses_expense_date_idx on public.expenses (expense_date);

-- Named "pay later" orders (e.g. "Mippe Boss"), shared by every till until
-- they're paid. "items" holds the lines: [{ id, name, qty, discounted }].
create table if not exists public.pending_orders (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null references auth.users(id) default auth.uid(),  -- the vendor's login
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name       text not null,
  items      jsonb not null default '[]'::jsonb
);

alter table public.pending_orders enable row level security;

-- Each vendor reaches only their own rows (log in to the app first).
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

create index if not exists products_owner_idx       on public.products (owner);
create index if not exists sales_owner_date_idx     on public.sales (owner, sale_date);
create index if not exists discards_owner_idx       on public.discards (owner);
create index if not exists expenses_owner_idx       on public.expenses (owner);
create index if not exists pending_orders_owner_idx on public.pending_orders (owner);

-- Vendors are logins: Authentication -> Users -> Add user, email
-- <username>@brewzy-pos.example.com, "Auto Confirm User". They then add their
-- menu in the app (Manage Items).
