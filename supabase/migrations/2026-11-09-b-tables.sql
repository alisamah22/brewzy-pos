-- Brewzy POS migration — tables. Run once (after 2026-11-09-vendor-logins.sql).
-- Supabase dashboard: SQL Editor -> New query -> paste -> Run. Safe to re-run.
--
-- Each vendor has their own tables (Table 1, Table 2, ...). A table's open
-- order is a pending order linked to the table; it's shared by every till
-- and the table is free again once the order is paid.

create table if not exists public.dining_tables (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now(),
  name       text not null,
  sort       integer not null default 0
);

alter table public.dining_tables enable row level security;
drop policy if exists "own tables" on public.dining_tables;
create policy "own tables" on public.dining_tables for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());
create index if not exists dining_tables_owner_idx on public.dining_tables (owner);

-- A table's open order. One open order per table.
alter table public.pending_orders
  add column if not exists table_id uuid references public.dining_tables(id) on delete set null;
create unique index if not exists pending_orders_one_per_table
  on public.pending_orders (table_id) where table_id is not null;

-- Brewzy starts with Table 1 to Table 5 (other vendors get theirs when they first log in).
insert into public.dining_tables (owner, name, sort)
select u.id, 'Table ' || n, n
  from auth.users u, generate_series(1, 5) n
 where u.email = 'brewzy@brewzy-pos.example.com'
   and not exists (select 1 from public.dining_tables t where t.owner = u.id);
