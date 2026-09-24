-- Brewzy POS migration — run once on an EXISTING database.
-- Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Safe to re-run; it keeps all existing products and sales.

-- 1. Buying price on menu items (existing items start at 0 — edit them in
--    Manage Items to set the real buying price).
alter table public.products add column if not exists cost numeric not null default 0;

-- 2. Void flag on sales (a mistaken sale is voided, never deleted).
alter table public.sales add column if not exists voided boolean not null default false;
alter table public.sales add column if not exists voided_at timestamptz;

-- 3. Make sales permanent: the app may add sales and set the void flag,
--    but can no longer edit or delete them.
drop policy if exists "anon delete sales" on public.sales;
drop policy if exists "anon void sales" on public.sales;
create policy "anon void sales" on public.sales for update to anon using (true) with check (true);
revoke update, delete, truncate on public.sales from anon, authenticated;
grant update (voided, voided_at) on public.sales to anon;
