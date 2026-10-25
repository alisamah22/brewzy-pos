-- Brewzy POS migration — run once on an EXISTING database.
-- Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Safe to re-run; it keeps all existing data.

-- Stock quantity is optional: empty (null) means the item's stock isn't
-- counted. New items left empty are saved as null instead of 0.
alter table public.products alter column stock_qty drop not null;
alter table public.products alter column stock_qty set default null;
