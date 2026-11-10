-- Brewzy POS migration — brewzy_bot bills in the POS database.
-- Run once. Supabase dashboard: SQL Editor -> New query -> paste -> Run. Safe to re-run.
--
-- brewzy_bot (the Telegram bills bot) moves onto this database: these are the
-- bot's own tables (same columns as its schema.sql), so the bot works
-- unchanged once its SUPABASE_URL / SUPABASE_KEY point here. The bot uses the
-- service_role key and bypasses these rules; in the POS app only Brewzy's
-- admins can see (and add) the bills, which the Main sales report subtracts
-- for the profit after bills.

create table if not exists public.bills (
  id bigint generated always as identity primary key,
  chat_id bigint not null,
  item text not null,
  price numeric not null,
  date_paid date not null,
  where_paid text not null,
  created_at timestamptz not null default now()
);
create index if not exists bills_chat_id_date_idx on public.bills (chat_id, date_paid);
create index if not exists bills_chat_id_item_idx on public.bills (chat_id, item);
create index if not exists bills_date_paid_idx on public.bills (date_paid);
alter table public.bills enable row level security;

create table if not exists public.short_eats (
  id bigint generated always as identity primary key,
  chat_id bigint not null,
  item text not null,
  price numeric not null,
  selling_price numeric not null default 0,
  pieces numeric not null default 0,
  discarded_amount numeric not null,
  date date not null,
  profit numeric generated always as ((selling_price - price) * pieces - discarded_amount) stored,
  created_at timestamptz not null default now()
);
create index if not exists short_eats_chat_id_date_idx on public.short_eats (chat_id, date);
create index if not exists short_eats_chat_id_item_idx on public.short_eats (chat_id, item);
alter table public.short_eats enable row level security;

-- The bot's bills belong to Brewzy.
create or replace function public.bot_vendor() returns uuid
language sql stable security definer set search_path = public, auth as $$
  select id from auth.users where email = 'brewzy@brewzy-pos.example.com'
$$;
revoke all on function public.bot_vendor() from public, anon;
grant execute on function public.bot_vendor() to authenticated;

drop policy if exists "brewzy admins read bills" on public.bills;
drop policy if exists "brewzy admins add bills"  on public.bills;
create policy "brewzy admins read bills" on public.bills for select to authenticated
  using ((select public.my_vendor()) = (select public.bot_vendor()) and (select public.is_admin()));
create policy "brewzy admins add bills" on public.bills for insert to authenticated
  with check ((select public.my_vendor()) = (select public.bot_vendor()) and (select public.is_admin()));
