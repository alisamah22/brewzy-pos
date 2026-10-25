-- Brewzy POS migration — run once on an EXISTING database.
-- Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Safe to re-run; it keeps all existing products and sales.

-- 1. Stock quantity on menu items (existing items start at 0 — set the real
--    quantity in Manage Items).
alter table public.products add column if not exists stock_qty integer not null default 0;

-- 2. Discarded stock. Each row is one discard of one item on one date. The
--    stock and selling price are saved with the row so later price changes
--    don't rewrite past losses. Rows can be edited and deleted from the app.
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
drop policy if exists "anon read discards"   on public.discards;
drop policy if exists "anon insert discards" on public.discards;
drop policy if exists "anon update discards" on public.discards;
drop policy if exists "anon delete discards" on public.discards;
create policy "anon read discards"   on public.discards for select to anon using (true);
create policy "anon insert discards" on public.discards for insert to anon with check (true);
create policy "anon update discards" on public.discards for update to anon using (true) with check (true);
create policy "anon delete discards" on public.discards for delete to anon using (true);

create index if not exists discards_discard_date_idx on public.discards (discard_date);
create index if not exists discards_product_id_idx on public.discards (product_id);
