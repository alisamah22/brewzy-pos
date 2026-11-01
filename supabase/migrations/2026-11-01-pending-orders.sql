-- Brewzy POS migration — run once on an EXISTING database.
-- Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Safe to re-run; it keeps all existing data.

-- Named "pay later" orders (e.g. "Mippe Boss"), shared by every till until
-- they're paid. "items" holds the lines: [{ id, name, qty, discounted }].
create table if not exists public.pending_orders (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name       text not null,
  items      jsonb not null default '[]'::jsonb
);

alter table public.pending_orders enable row level security;
drop policy if exists "anon read pending orders"   on public.pending_orders;
drop policy if exists "anon insert pending orders" on public.pending_orders;
drop policy if exists "anon update pending orders" on public.pending_orders;
drop policy if exists "anon delete pending orders" on public.pending_orders;
create policy "anon read pending orders"   on public.pending_orders for select to anon using (true);
create policy "anon insert pending orders" on public.pending_orders for insert to anon with check (true);
create policy "anon update pending orders" on public.pending_orders for update to anon using (true) with check (true);
create policy "anon delete pending orders" on public.pending_orders for delete to anon using (true);
