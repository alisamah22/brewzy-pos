# Brewzy POS

A simple, touch-friendly point-of-sale web app for a small food counter
(prices in MVR). Runs as static files on GitHub Pages. The menu and all
completed sales are stored in Supabase, so every till shares one menu and
daily reports are shared across devices.

## Features
- Touch-friendly menu with search, category filters, and an "in order" badge on each item
- Shared menu stored in Supabase: add / edit / delete items from any till, each with a
  **buying price** and **selling price** (the form shows the profit per item as you type)
- Cart with +/− controls, per-line totals, and quick-cash buttons (Exact, 50, 100…)
  that show the change to give, or how much cash is short
- Cash / Transfer / Card payment, itemised receipt with a Print button
- **Sales are permanent.** Every sale is saved to Supabase and cannot be deleted from the
  app. A sale entered by mistake can be *voided*: it drops out of report totals but stays on record
- **Works through connection drops.** If the internet is down, the sale is kept on the
  till and uploaded automatically when the connection is back (see the status pill in the top bar)
- Sales report for Today / Yesterday / Last 7 days / This month / Last month / any custom range:
  total sales, profit and margin, buying cost, transactions, items sold, average sale,
  **best sellers** (by quantity, sales or profit), items not sold, payment-method split,
  sales by hour or by day, a sortable product table, a transaction list, and **CSV export**

## Supabase setup
**New database:** open **SQL Editor → New query**, paste
[`supabase/schema.sql`](supabase/schema.sql), and click **Run**. (Re-running the seed block
at the bottom duplicates the menu items, so run it only once.)

**Existing database (upgrading from the earlier version):** run
[`supabase/migrations/2026-09-24-buying-price-and-keep-sales.sql`](supabase/migrations/2026-09-24-buying-price-and-keep-sales.sql)
once. It keeps all your data and:
- adds the `cost` (buying price) column to `products`; existing items start at 0, so set their
  buying prices in **Manage Items**
- adds the `voided` / `voided_at` columns to `sales`
- removes the database permission that allowed sales to be deleted

Until the migration is run, selling still works, but saving items with a buying price and
voiding sales will show a "database needs a one-time update" message.

### Keeping the project awake
Supabase **pauses free-tier projects after about a week with no activity**. A paused project
can't be reached (the app shows "Offline") until it's restored from the Supabase dashboard,
and a project left paused for too long may not be restorable. The workflow in
[`.github/workflows/keep-alive.yml`](.github/workflows/keep-alive.yml) makes one small read
every 3 days to prevent this. GitHub turns off scheduled workflows in repos with no commits
for 60 days, so check the repo's **Actions** tab now and then.

The Supabase URL and publishable (anon) key live in `supabase-api.js`. These are
safe to expose in client code; row-level security governs access. Access is
open (no login): anyone with the site URL can read the menu and sales, edit the menu,
add sales, and void sales, but nobody can delete sales through the app.

## Run locally
Use a small local server (needed so the browser can load Supabase):
- Python: `python -m http.server 8000`, then open `http://localhost:8000`
- VS Code: the Live Server extension, then open `index.html`

## Deploy (GitHub Pages)
1. Push to the default branch of your GitHub repo.
2. Repo **Settings → Pages → Build and deployment**: Source = *Deploy from a
   branch*, Branch = your default branch, Folder = `/ (root)`.
3. Wait for the Pages build; open the published URL.

## Tests
Pure logic in `pos-core.js` has unit tests (Node 18+):
```
node --test tests/pos-core.test.js
```

## Notes
- Card payments are recorded, not charged — there is no real card processing.
- The menu is loaded from Supabase on startup and cached in the browser
  (`localStorage`) so a brief connection drop doesn't empty the till's menu.
- Sales made offline are stored in that browser until they upload. Don't clear the
  browser's site data on a till that shows sales waiting to upload.
- Profit uses the buying price saved with each sale, so changing an item's buying price
  later doesn't change past reports. Sales from before buying prices existed count as zero
  cost, and the report says when that affects the profit figure.
