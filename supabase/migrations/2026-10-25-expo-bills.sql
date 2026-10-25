-- Brewzy POS migration — run once on an EXISTING database.
-- Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Safe to re-run; it keeps all existing data.

-- Bills (expenses) such as Expo prep shopping. Each row is one bill on one
-- date. "scope" says which report it belongs to ('Expo' for now). Rows can
-- be edited and deleted from the app.
create table if not exists public.expenses (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  expense_date date not null,
  description  text not null,
  amount       numeric not null check (amount >= 0),
  scope        text not null default 'Expo'
);

alter table public.expenses enable row level security;
drop policy if exists "anon read expenses"   on public.expenses;
drop policy if exists "anon insert expenses" on public.expenses;
drop policy if exists "anon update expenses" on public.expenses;
drop policy if exists "anon delete expenses" on public.expenses;
create policy "anon read expenses"   on public.expenses for select to anon using (true);
create policy "anon insert expenses" on public.expenses for insert to anon with check (true);
create policy "anon update expenses" on public.expenses for update to anon using (true) with check (true);
create policy "anon delete expenses" on public.expenses for delete to anon using (true);

create index if not exists expenses_expense_date_idx on public.expenses (expense_date);
