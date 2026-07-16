# Brewzy POS

A simple, touch-friendly point-of-sale web app for a small food counter
(prices in MVR). Runs as static files on GitHub Pages. The menu and all
completed sales are stored in Supabase, so every till shares one menu and
daily reports are shared across devices.

## Features
- Touch-friendly item buttons, search, and category filters
- Shared menu stored in Supabase — add / edit / delete items from any till
- Cart with quantity controls and automatic total
- Cash / Transfer / Card payment, with cash-received and change calculation
- Every completed sale saved to Supabase
- Daily sales report (per payment method, transactions, items sold, and
  per-product quantities) read from Supabase, with a "Clear This Day" action

## Supabase setup (once)
1. In your Supabase project, open **SQL Editor → New query**.
2. Paste the contents of [`supabase/schema.sql`](supabase/schema.sql) and click **Run**.
3. That creates the `products` and `sales` tables, open row-level-security
   policies, and seeds a starting menu. (Re-running the seed block duplicates
   the menu items — run it only once.)

The Supabase URL and publishable (anon) key live in `supabase-api.js`. These are
safe to expose in client code — row-level security governs access. Access is
open (no login): anyone with the site URL can read, add, edit, and delete the
menu and sales.

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
Pure logic in `pos-core.js` has unit tests:
```
node --test tests/pos-core.test.js
```

## Notes
- Card payments are recorded, not charged — there is no real card processing.
- The menu is loaded from Supabase on startup and cached in the browser
  (`localStorage`) so a brief connection drop doesn't empty the till's menu.
