# Brewzy POS — Supabase Sales Backend Design

**Date:** 2026-07-16
**Status:** Approved (design)

## Summary

Brewzy POS is a simple, touch-friendly point-of-sale web app for a small food
counter (prices in MVR). It runs as static files on GitHub Pages with no build
step. Today it exists as two diverging file sets and stores everything in the
browser. This design consolidates it to a single file set and adds a Supabase
backend that stores **completed sales** so daily reports are durable and shared
across multiple tills ringing up orders concurrently.

The **menu (products) intentionally stays per-device in `localStorage`** — each
till manages its own item list, exactly as today. Only sales are sent to the
backend.

## Goals

- Persist every completed sale to Supabase so daily reports survive cache
  clears and are shared across all tills.
- Support multiple tills ringing up sales at the same time.
- Consolidate the confusing `_updated` duplicate files into one clean set.
- Keep the app a zero-build static site deployable to GitHub Pages.

## Non-goals

- No shared/server-side menu — products remain local to each device.
- No authentication/login (open access, by explicit choice).
- No real-time push sync between tills (load/refresh is sufficient).
- No real card processing — payment method is recorded, not charged.
- No offline sale queue — saving a sale requires connectivity (failure is
  surfaced, never silent).

## Access & security posture

Open access (no login), by explicit user choice. The app is a public GitHub
Pages URL and the Supabase **publishable (anon) key** is visible in client code
— which is normal and safe; Row Level Security governs what that key can do.

RLS on the `sales` table grants the anon role **`insert`, `select`, and
`delete`**. Consequence, accepted by the user: anyone with the URL can read,
add, or delete sales. A shared login can be added later to close this without
changing the data model.

## Architecture

- **Static site, no build step.** `index.html`, `app.js`, `styles.css` served
  from the repo root by GitHub Pages. Supabase JS loaded from CDN (as today).
- **File cleanup.** Fold the working sales-report code (currently only in the
  `_updated` files) into the mainline files, then delete `index_updated.html`,
  `app_updated.js`, `styles_updated.css`, and `README_updated.md`. End state is
  one canonical file set.
- **Menu (products):** `localStorage` per device, seeded with the default item
  list on first run — unchanged from today.
- **Sales:** written to a Supabase `sales` table; the daily report reads from
  it.

## Data model

Single table, `sales`. One completed order = one row. Line items are stored as
JSON, avoiding a second table.

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

Line items are keyed by product **name**, not ID, because each device generates
its own local product IDs. Reports aggregate quantities by name so identical
items from different tills roll up into one row.

### SQL (table + RLS)

```sql
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

create policy "anon can read sales"   on public.sales for select to anon using (true);
create policy "anon can insert sales" on public.sales for insert to anon with check (true);
create policy "anon can delete sales" on public.sales for delete to anon using (true);

create index if not exists sales_sale_date_idx on public.sales (sale_date);
```

## Runtime flows

### App startup
1. Load menu from `localStorage`; seed with the default item list on first run.
2. Initialize the Supabase client. If init fails, the app still rings up orders;
   only cloud save/report is affected.

### Completing a sale (`payBtn`)
1. Validate cash-received (unchanged: cash must be ≥ total).
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

### Menu management
Unchanged — add/edit/delete products in `localStorage`, local to the device.

## Error handling & edge cases

- **Save fails (offline):** insert error → inline error, cart preserved, retry.
- **Startup with Supabase down:** app still rings orders; report shows an error
  if opened.
- **Report query fails:** explicit error state, not a silent zeroed report.
- **Local date:** `sale_date` uses the device's local date (existing
  `localDateKey`), so an 11pm sale counts toward that local day, not UTC.
- **Concurrent tills:** each sale is an independent insert — no conflicts.
- **Empty day:** report shows zeros and "No sales recorded for this date."

## Deployment

- Plain static files served by GitHub Pages from the repo root — no build.
- Supabase URL + publishable (anon) key remain in `app.js`.
- README updated with: the SQL snippet above, and steps to enable GitHub Pages.

## Testing / verification

Plain JS, no framework — verify by driving the real app in a browser:

- Ring a sale for each payment method (Cash / Card / Transfer); confirm a row
  lands in Supabase with correct totals and `sale_date`.
- Confirm the report aggregates by name across two devices with different local
  product IDs (same item name rolls into one row).
- Confirm cash validation and change calculation still work.
- Confirm "Clear This Day" deletes that date's rows and the report updates.
- Confirm a simulated save failure keeps the cart and surfaces an error.
