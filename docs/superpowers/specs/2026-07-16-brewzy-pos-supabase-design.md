# Brewzy POS — Supabase Backend Design

**Date:** 2026-07-16
**Status:** Approved (design), revised to put the menu on Supabase

## Summary

Brewzy POS is a simple, touch-friendly point-of-sale web app for a small food
counter (prices in MVR). It runs as static files on GitHub Pages with no build
step. Today it exists as two diverging file sets and stores everything in the
browser. This design consolidates it to a single file set and moves both the
**menu (products)** and **completed sales** into Supabase, so every till shares
one menu and daily reports are durable and shared across tills ringing up
orders concurrently.

The menu is managed in-app (add / edit / delete) and those changes write to
Supabase. `localStorage` is kept only as an offline read-through cache of the
last-loaded menu.

## Goals

- Shared menu across all devices — products live in Supabase; add/edit/delete
  from any till updates the shared menu.
- Persist every completed sale to Supabase so daily reports survive cache
  clears and are shared across all tills.
- Support multiple tills ringing up sales at the same time.
- Consolidate the confusing `_updated` duplicate files into one clean set.
- Keep the app a zero-build static site deployable to GitHub Pages.

## Non-goals

- No authentication/login (open access, by explicit choice).
- No real-time push sync between tills (load/refresh is sufficient — a menu
  change on one till appears on another after it reloads or refreshes).
- No real card processing — payment method is recorded, not charged.
- No offline sale queue — saving a sale requires connectivity (failure is
  surfaced, never silent).

## Access & security posture

Open access (no login), by explicit user choice. The app is a public GitHub
Pages URL and the Supabase **publishable (anon) key** is visible in client code
— which is normal and safe; Row Level Security governs what that key can do.

RLS grants the anon role broad access:
- `products`: `select`, `insert`, `update`, `delete`.
- `sales`: `select`, `insert`, `delete`.

Consequence, accepted by the user: anyone with the URL can read, add, edit, or
delete the menu and sales. A shared login can be added later to close this
without changing the data model.

## Architecture

- **Static site, no build step.** `index.html`, `app.js`, `styles.css` served
  from the repo root by GitHub Pages. Supabase JS loaded from CDN (as today).
- **File cleanup.** Fold the working sales-report code (currently only in the
  `_updated` files) into the mainline files, then delete `index_updated.html`,
  `app_updated.js`, `styles_updated.css`, and `README_updated.md`. End state is
  one canonical file set.
- **Menu (products):** stored in a Supabase `products` table, shared by all
  devices. Loaded on startup and after each edit. `localStorage` (key
  `touchPosProducts`) holds a read-through cache used only when Supabase is
  briefly unreachable.
- **Sales:** written to a Supabase `sales` table; the daily report reads from
  it.

## Data model

Two tables. Sale line items are stored as JSON on the sale row, so there is no
separate line-item table.

### `products`

| Column       | Type          | Notes                                    |
|--------------|---------------|------------------------------------------|
| `id`         | `uuid`        | primary key, default `gen_random_uuid()` |
| `created_at` | `timestamptz` | default `now()` — also the grid sort key |
| `name`       | `text`        |                                          |
| `price`      | `numeric`     |                                          |
| `category`   | `text`        |                                          |
| `emoji`      | `text`        | may be empty; UI falls back to 🍽️        |

Loaded ordered by `created_at` ascending, so newly added items appear at the
end of the grid (matching the previous append behavior).

### `sales`

One completed order = one row.

| Column           | Type          | Notes                                                      |
|------------------|---------------|------------------------------------------------------------|
| `id`             | `uuid`        | primary key, default `gen_random_uuid()`                   |
| `created_at`     | `timestamptz` | default `now()` — authoritative timestamp                  |
| `sale_date`      | `date`        | device-local date key (e.g. `2026-07-16`) for day queries  |
| `payment_method` | `text`        | `'Cash'` / `'Card'` / `'Transfer'`                         |
| `subtotal`       | `numeric`     |                                                            |
| `tax`            | `numeric`     |                                                            |
| `total`          | `numeric`     |                                                            |
| `items`          | `jsonb`       | array of `{ name, price, qty }` — **name-keyed**           |

Sale line items snapshot the product `name`/`price`/`qty` at sale time (not a
product foreign key), so reports remain correct even if a product is later
renamed, re-priced, or deleted. Reports aggregate quantities **by name**.

### SQL (tables + RLS + seed)

```sql
-- Products
create table if not exists public.products (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name       text not null,
  price      numeric not null,
  category   text not null,
  emoji      text
);

alter table public.products enable row level security;
create policy "anon read products"   on public.products for select to anon using (true);
create policy "anon insert products" on public.products for insert to anon with check (true);
create policy "anon update products" on public.products for update to anon using (true) with check (true);
create policy "anon delete products" on public.products for delete to anon using (true);

-- Sales
create table if not exists public.sales (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  sale_date      date not null,
  payment_method text not null,
  subtotal       numeric not null,
  tax            numeric not null,
  total          numeric not null,
  items          jsonb not null
);

alter table public.sales enable row level security;
create policy "anon read sales"   on public.sales for select to anon using (true);
create policy "anon insert sales" on public.sales for insert to anon with check (true);
create policy "anon delete sales" on public.sales for delete to anon using (true);

create index if not exists sales_sale_date_idx on public.sales (sale_date);

-- Optional one-time seed of the starting menu (run once; re-running duplicates).
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
```

## Runtime flows

### App startup
1. Initialize the Supabase client.
2. Fetch products (ordered by `created_at`). On success → cache to
   `localStorage` and render. On failure → fall back to the `localStorage`
   cache (if any) and show a non-blocking "couldn't reach server" notice; the
   grid shows an empty/error state if there is no cache.

### Menu management (add / edit / delete)
1. Add: validate fields → `insert` into `products` → reload products → render.
2. Edit: `update` the row → reload products → render.
3. Delete: confirm → `delete` the row → reload products → render.
4. On any failure → alert and keep the dialog open; do not mutate local state
   optimistically for writes that failed.

### Completing a sale (`payBtn`)
1. Validate cash-received (cash must be ≥ total).
2. `insert` one row into `sales` with `sale_date` = today's local date and the
   cart mapped to `items` (`{ name, price, qty }`).
3. On success → show the receipt dialog and clear the cart.
4. On failure → show a clear inline error, **keep the cart intact**, re-enable
   Pay so the cashier can retry. No silent data loss.

### Daily report
1. `select * from sales where sale_date = <picked date>`.
2. Aggregate in-browser: totals per payment method, transaction count, total
   items sold, and a per-product table rolled up **by name**.
3. "Clear This Day" → confirm → `delete from sales where sale_date = <date>` →
   re-query and re-render.
4. If the query fails, show an error in the dialog rather than blank/zero
   values (so a failure is not mistaken for "no sales").

## Error handling & edge cases

- **Product load fails at startup:** fall back to the `localStorage` cache and
  notify; empty/error grid state if no cache exists.
- **Product write fails:** alert, keep the Manage Items dialog open, no
  optimistic local change.
- **Sale save fails (offline):** insert error → inline error, cart preserved,
  retry.
- **Report query fails:** explicit error state, not a silent zeroed report.
- **Local date:** `sale_date` uses the device's local date (existing
  `localDateKey`), so an 11pm sale counts toward that local day, not UTC.
- **Concurrent tills:** each sale is an independent insert — no conflicts.
  Product edits are last-write-wins (acceptable for infrequent menu changes).
- **Empty day:** report shows zeros and "No sales recorded for this date."
- **Deleting a product mid-cart:** an in-progress cart line keeps its snapshot;
  the sale still records the item name/price it was rung at.

## Deployment

- Plain static files served by GitHub Pages from the repo root — no build.
- Supabase URL + publishable (anon) key live in `supabase-api.js` (client-side,
  safe to expose; RLS governs access).
- README updated with: the SQL above, and steps to enable GitHub Pages.

## Testing / verification

Pure logic (totals, date key, report aggregation, product validation) is unit
tested with `node --test`. The rest is verified by driving the real app in a
browser:

- Add a product from one browser; confirm it appears in Supabase and shows up
  in a second browser after reload (shared menu).
- Edit and delete a product; confirm the change persists and syncs on reload.
- Ring a sale for each payment method (Cash / Card / Transfer); confirm a row
  lands in Supabase with correct totals and `sale_date`.
- Confirm the report aggregates by name (same item name rolls into one row).
- Confirm cash validation and change calculation still work.
- Confirm "Clear This Day" deletes that date's rows and the report updates.
- Confirm a simulated save failure keeps the cart and surfaces an error.
- Confirm a simulated product-load failure falls back to the cached menu.
