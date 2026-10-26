# Brewzy POS

A simple, touch-friendly point-of-sale web app for a small food counter
(prices in MVR). Runs as static files on GitHub Pages. The menu and all
completed sales are stored in Supabase, so every till shares one menu and
daily reports are shared across devices.

## Features
- Touch-friendly menu with search, category filters, and an "in order" badge on each item
- Shared menu stored in Supabase: add / edit / delete items from any till, each with a
  **stock (buying) price**, **selling price** and **stock quantity** (the form shows the profit per item as you type)
- **Discounts:** give any item a discount price from Manage Items (**🏷️ Discount** on the item, or **Edit**).
  Tap 10% / 15% / 20% / 25% / 30% / 50% off or type the discounted price; the form shows the old and new
  price, what the customer saves and your profit at the new price. On the till the item has a 🏷️ tag and rings
  up at the **regular price**; tap **🏷️ Discount** on its line in the order to charge the discount price
  (tap **Regular price** to switch back; tapping the item again adds a new regular-price line, so one order can
  mix both). The receipt shows "You saved", and the report shows the total discount given plus each item's
  **discount price** and **quantity sold at discount**. Clear the price (**Remove discount**) and save to end it
- **Discarded stock:** record how many of an item were thrown away and on which date; each record
  can be edited or deleted later (Manage Items → **Discard**, or **Edit** on an item)
- **Several open orders:** tap **＋ New order** to keep the current order and start another; tap an order's
  tab (#1, #2…) to switch between them before payment. Each keeps its own items, payment method and cash.
  Paying or cancelling one leaves the others open; open orders are saved on the till through a reload
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
- **Expo report:** Reports has a **🏪 Main sales / 🎪 Expo** switch. Items in the **Expo** category are
  reported on their own; add each Expo prep bill (date, what it was for, amount) in the Expo report and it
  shows **Expo profit = Expo sales − item cost (cost price × qty sold) − prep bills** (prep bills are
  ingredients, decor and other expenses, separate from item cost prices). Use **All time** to see the whole event. If one sale mixes
  Expo and main items, each report counts only its own items. Every sale during an Expo
  (25 Oct 2026 16:00 – 2 Nov 2026, set in `EXPOS` in `pos-core.js`) counts as Expo, whatever the items;
  sales earlier on 25 Oct were test runs: they count in reports until 16:00 (so the reports can be tried
  out), then they're shown as TEST but left out of every total. Expo items don't track stock or discards
- **Cost prices added later count backwards:** a sale made before an item had a stock (cost) price uses
  the item's current cost price in reports and the CSV, so entering cost prices later fixes past profit too.
  The All products table shows each item's cost price, total cost and profit (also in the Expo report)
- **Stock & discards report:** total stock quantity and its value at stock and selling price, the
  difference between them, discarded quantity in the period, the discard loss (stock price × quantity
  discarded), what that stock would have sold for, and profit after discards, with a per-item table

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

**Stock and discards:** run
[`supabase/migrations/2026-10-12-stock-and-discards.sql`](supabase/migrations/2026-10-12-stock-and-discards.sql)
once. It adds the `stock_qty` column to `products` (existing items start at 0) and the `discards`
table. Until it is run, the till and sales report keep working, but stock quantities can't be saved
and the report shows a "database needs a one-time update" note in the Stock & discards section.

**Discounts:** run
[`supabase/migrations/2026-10-25-discount-price.sql`](supabase/migrations/2026-10-25-discount-price.sql)
once. It adds the `sale_price` column to `products` (empty = no discount). Until it is run, everything
else keeps working, but saving a discount shows a "database needs a one-time update" message.

**Expo prep bills:** run
[`supabase/migrations/2026-10-25-expo-bills.sql`](supabase/migrations/2026-10-25-expo-bills.sql)
once. It adds the `expenses` table. Until it is run, the Expo report shows sales but bills can't be saved.

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
4. When you change `app.js`, `pos-core.js`, `supabase-api.js` or `styles.css`, bump the
   `?v=` number on their tags in `index.html` so browsers don't mix old and new files.

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
- Discards work the same way: the stock and selling price are saved with each discard record.
- Stock quantity is a number you set in Manage Items. Sales and discards don't change it
  automatically, so update it when you restock or count.
