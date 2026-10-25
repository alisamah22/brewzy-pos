-- Brewzy POS migration — run once on an EXISTING database.
-- Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Safe to re-run; it keeps all existing products and sales.

-- Discount (sale) price on menu items. Empty (null) means no discount; when
-- set, the till charges this price instead of the regular selling price.
alter table public.products add column if not exists sale_price numeric
  check (sale_price is null or sale_price >= 0);
