# Brewzy POS — Supabase Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the duplicate POS files into one clean set and move both the menu (products) and completed sales into Supabase, so every till shares one menu (add/edit/delete) and daily reports are durable and shared across tills.

**Architecture:** Zero-build static site (HTML/CSS/JS) on GitHub Pages. Pure POS logic lives in `pos-core.js` (browser global `PosCore`, also `require`-able in Node for tests). All Supabase network access lives in `supabase-api.js` (browser global `PosApi`). `app.js` is DOM wiring only and delegates to `PosCore` and `PosApi`. Products load from Supabase on startup (with a `localStorage` read-through cache for offline resilience); reports aggregate line items **by product name**.

**Tech Stack:** Vanilla JS, `@supabase/supabase-js@2` (CDN), Supabase Postgres + RLS, `node --test` (built-in) for unit tests, GitHub Pages for hosting.

## Global Constraints

- Zero build step — files are served as-is by GitHub Pages. No bundler, no transpile.
- No runtime npm dependencies. Tests may use **only** Node.js built-in modules (`node:test`, `node:assert`).
- Currency is MVR, formatted as `MVR 0.00` (two decimals). Tax rate is `0.08` (8%).
- Supabase URL and **publishable (anon)** key stay in client code (safe to expose; RLS governs access). URL: `https://uxpcnpkxathduehpqkyq.supabase.co`, key: `sb_publishable_9Xou20b2C_H--LCbqEw11A_DDLvtqNQ`.
- Do not rename existing DOM element IDs in `index.html` — `app.js` binds to them.
- Products live in a Supabase `products` table; `localStorage` key `touchPosProducts` is only a read-through cache.
- Sale line `items` and report product rows are keyed by item **name**, never by ID.
- Sale rows use device-**local** date (`localDateKey`) for `sale_date`.
- On a failed sale save, the cart MUST be preserved — never silent data loss. On a failed product write, do not mutate local state optimistically.

## File Structure (end state)

- `index.html` — markup + dialogs (already present); loads scripts in order: supabase CDN → `pos-core.js` → `supabase-api.js` → `app.js`.
- `styles.css` — all styles including the report dialog styles (merged in).
- `pos-core.js` — **new.** Pure functions: `money`, `localDateKey`, `calcTotals`, `cartToItems`, `aggregateSales`, `productError`. No DOM, no network.
- `supabase-api.js` — **new.** Supabase client + product CRUD (`fetchProducts`, `insertProduct`, `updateProduct`, `deleteProduct`) + sales (`insertSale`, `fetchSalesByDate`, `deleteSalesByDate`).
- `app.js` — DOM wiring; delegates logic to `PosCore` and network to `PosApi`.
- `tests/pos-core.test.js` — **new.** `node --test` unit tests for `pos-core.js`.
- `supabase/schema.sql` — **new.** Tables + RLS + optional seed to run in the Supabase SQL editor.
- `README.md` — updated: features, local run, Supabase setup, GitHub Pages deploy.
- **Deleted:** `app_updated.js`, `index_updated.html`, `styles_updated.css`, `README_updated.md`.

---

### Task 1: Pure POS logic module (`pos-core.js`) with unit tests

Extract all pure logic into a testable module before touching the DOM. The key correctness point vs. the old `app_updated.js` is that `aggregateSales` rolls products up **by name**, so the same item sold via different product rows still merges into one report row. `productError` centralizes the Manage-Items validation.

**Files:**
- Create: `pos-core.js`
- Test: `tests/pos-core.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces (browser global `PosCore`, and CommonJS export for tests):
  - `TAX_RATE: number` — `0.08`
  - `money(value: number) => string` — `"MVR 0.00"` format
  - `localDateKey(date?: Date) => string` — local `"YYYY-MM-DD"`
  - `calcTotals(cart: {price:number, qty:number}[], taxRate?: number) => {subtotal:number, tax:number, total:number}`
  - `cartToItems(cart: {name:string, price:number, qty:number}[]) => {name:string, price:number, qty:number}[]`
  - `aggregateSales(sales: {payment_method:string, total:number, items:{name:string,price:number,qty:number}[]}[]) => {paymentTotals:{Cash:number,Card:number,Transfer:number}, grandTotal:number, transactionCount:number, itemCount:number, productRows:{name:string,qty:number,sales:number}[]}`
  - `productError(fields: {name:string, price:number, category:string}) => string|null` — returns an error message, or `null` if valid

- [ ] **Step 1: Write the failing tests**

Create `tests/pos-core.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  money,
  localDateKey,
  calcTotals,
  cartToItems,
  aggregateSales,
  productError,
} = require("../pos-core.js");

test("money formats as MVR with two decimals", () => {
  assert.equal(money(20), "MVR 20.00");
  assert.equal(money(12.5), "MVR 12.50");
  assert.equal(money(0), "MVR 0.00");
});

test("localDateKey returns local YYYY-MM-DD (not UTC)", () => {
  const d = new Date(2026, 6, 16, 23, 30); // 16 Jul 2026 23:30 local; month is 0-based
  assert.equal(localDateKey(d), "2026-07-16");
});

test("calcTotals sums subtotal, 8% tax, and total", () => {
  const cart = [
    { price: 20, qty: 2 },
    { price: 10, qty: 1 },
  ];
  const t = calcTotals(cart, 0.08);
  assert.equal(t.subtotal, 50);
  assert.equal(t.tax, 4);
  assert.equal(t.total, 54);
});

test("cartToItems strips everything except name/price/qty", () => {
  const cart = [{ id: "x", name: "Brownie", price: 35, qty: 2, emoji: "🍫" }];
  assert.deepEqual(cartToItems(cart), [{ name: "Brownie", price: 35, qty: 2 }]);
});

test("aggregateSales merges products by name across sales", () => {
  const sales = [
    {
      payment_method: "Cash",
      total: 55,
      items: [
        { name: "Brownie", price: 35, qty: 1 },
        { name: "Sausage", price: 10, qty: 2 },
      ],
    },
    {
      payment_method: "Card",
      total: 35,
      items: [{ name: "Brownie", price: 35, qty: 1 }],
    },
  ];
  const r = aggregateSales(sales);
  assert.equal(r.paymentTotals.Cash, 55);
  assert.equal(r.paymentTotals.Card, 35);
  assert.equal(r.paymentTotals.Transfer, 0);
  assert.equal(r.grandTotal, 90);
  assert.equal(r.transactionCount, 2);
  assert.equal(r.itemCount, 4);
  const brownie = r.productRows.find((p) => p.name === "Brownie");
  assert.equal(brownie.qty, 2);
  assert.equal(brownie.sales, 70);
  assert.equal(r.productRows[0].name, "Brownie"); // qty tie -> name asc
});

test("productError returns null for valid input, message for invalid", () => {
  assert.equal(productError({ name: "Latte", price: 30, category: "Drinks" }), null);
  assert.equal(typeof productError({ name: "", price: 30, category: "Drinks" }), "string");
  assert.equal(typeof productError({ name: "X", price: -1, category: "Drinks" }), "string");
  assert.equal(typeof productError({ name: "X", price: NaN, category: "Drinks" }), "string");
  assert.equal(typeof productError({ name: "X", price: 30, category: "" }), "string");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/pos-core.test.js`
Expected: FAIL — cannot find module `../pos-core.js`.

- [ ] **Step 3: Implement `pos-core.js`**

Create `pos-core.js`:

```js
// pos-core.js — pure POS logic. No DOM, no network.
// Exposed as window.PosCore in the browser and module.exports in Node.
(function (root) {
  const TAX_RATE = 0.08;

  function money(value) {
    return `MVR ${Number(value).toFixed(2)}`;
  }

  function localDateKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function calcTotals(cart, taxRate = TAX_RATE) {
    const subtotal = cart.reduce((sum, item) => sum + item.price * item.qty, 0);
    const tax = subtotal * taxRate;
    return { subtotal, tax, total: subtotal + tax };
  }

  function cartToItems(cart) {
    return cart.map((item) => ({
      name: item.name,
      price: item.price,
      qty: item.qty,
    }));
  }

  // Roll an array of sale rows up into report figures. Products are keyed by
  // NAME so identical items merge into one row.
  function aggregateSales(sales) {
    const paymentTotals = { Cash: 0, Card: 0, Transfer: 0 };
    const products = new Map();
    let itemCount = 0;
    let grandTotal = 0;

    for (const sale of sales) {
      const method = sale.payment_method;
      paymentTotals[method] = (paymentTotals[method] || 0) + Number(sale.total || 0);
      grandTotal += Number(sale.total || 0);

      for (const item of sale.items || []) {
        const qty = Number(item.qty || 0);
        itemCount += qty;
        const current = products.get(item.name) || { name: item.name, qty: 0, sales: 0 };
        current.qty += qty;
        current.sales += Number(item.price || 0) * qty;
        products.set(item.name, current);
      }
    }

    const productRows = [...products.values()].sort(
      (a, b) => b.qty - a.qty || a.name.localeCompare(b.name)
    );

    return {
      paymentTotals,
      grandTotal,
      transactionCount: sales.length,
      itemCount,
      productRows,
    };
  }

  function productError(fields) {
    const name = (fields.name || "").trim();
    const category = (fields.category || "").trim();
    const price = Number(fields.price);
    if (!name || !category || !Number.isFinite(price) || price < 0) {
      return "Please enter a valid name, category, and price.";
    }
    return null;
  }

  const api = {
    TAX_RATE, money, localDateKey, calcTotals, cartToItems, aggregateSales, productError,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PosCore = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/pos-core.test.js`
Expected: PASS — 6 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add pos-core.js tests/pos-core.test.js
git commit -m "Add pos-core pure logic module with unit tests"
```

---

### Task 2: Supabase schema + documentation

Provide the DDL the shop owner runs once in the Supabase SQL editor (products + sales tables, RLS, and an optional starting-menu seed), and update the README with setup and deployment steps. This is a committed artifact plus a manual apply step; it has no automated test.

**Files:**
- Create: `supabase/schema.sql`
- Modify: `README.md` (full rewrite)

**Interfaces:**
- Produces: a `public.products` table (`id, created_at, name, price, category, emoji`) with anon `select`/`insert`/`update`/`delete`, and a `public.sales` table (`id, created_at, sale_date, payment_method, subtotal, tax, total, items`) with anon `select`/`insert`/`delete`. Task 3's `supabase-api.js` depends on exactly these column names.

- [ ] **Step 1: Create the schema file**

Create `supabase/schema.sql`:

```sql
-- Brewzy POS — tables + open (anon) RLS policies.
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> Run.

-- Products (the shared menu)
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

-- Optional one-time seed of the starting menu.
-- Run this block ONCE; re-running it duplicates the items.
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

- [ ] **Step 2: Rewrite `README.md`**

Replace the entire contents of `README.md` with:

````markdown
# Brewzy POS

A simple, touch-friendly point-of-sale web app for a small food counter
(prices in MVR). Runs as static files on GitHub Pages. The menu and all
completed sales are stored in Supabase, so every till shares one menu and
daily reports are shared across devices.

## Features
- Touch-friendly item buttons, search, and category filters
- Shared menu stored in Supabase — add / edit / delete items from any till
- Cart with quantity controls, automatic subtotal, 8% tax, and total
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
- Changing the tax rate: edit `TAX_RATE` in `pos-core.js`.
- The menu is loaded from Supabase on startup and cached in the browser
  (`localStorage`) so a brief connection drop doesn't empty the till's menu.
````

- [ ] **Step 3: Apply the schema in Supabase (manual)**

Open the Supabase dashboard for project `uxpcnpkxathduehpqkyq`, go to SQL Editor, paste `supabase/schema.sql`, and Run.
Expected: "Success. No rows returned." Then **Table Editor** shows `products` (10 seeded rows) and `sales` tables.

> If you do not have dashboard access, hand `supabase/schema.sql` to whoever does. Task 3's end-to-end verification cannot pass until these tables exist.

- [ ] **Step 4: Commit**

```bash
git add supabase/schema.sql README.md
git commit -m "Add Supabase products + sales schema and update README"
```

---

### Task 3: Integrate — Supabase API, app rewrite, style merge, delete duplicates

Wire everything together: a network module with product + sales access, an `app.js` that loads the menu from Supabase (with a cache fallback) and reads/writes products and sales, merged report styles, corrected script tags, and removal of the duplicate files. Verified end-to-end in a browser against the live Supabase tables from Task 2.

**Files:**
- Create: `supabase-api.js`
- Modify: `app.js` (full replace), `styles.css` (append report styles), `index.html` (script tags)
- Delete: `app_updated.js`, `index_updated.html`, `styles_updated.css`, `README_updated.md`

**Interfaces:**
- Consumes: `PosCore` from Task 1; the `products` and `sales` tables from Task 2.
- Produces (browser global `PosApi`):
  - `fetchProducts() => Promise<product[]>` — ordered by `created_at` asc (throws on error)
  - `insertProduct(product: {name, price, category, emoji}) => Promise<void>` (throws on error)
  - `updateProduct(id: string, fields: {name, price, category, emoji}) => Promise<void>` (throws on error)
  - `deleteProduct(id: string) => Promise<void>` (throws on error)
  - `insertSale(sale: {sale_date, payment_method, subtotal, tax, total, items}) => Promise<void>` (throws on error)
  - `fetchSalesByDate(dateKey: string) => Promise<sale[]>` (throws on error)
  - `deleteSalesByDate(dateKey: string) => Promise<void>` (throws on error)

- [ ] **Step 1: Create `supabase-api.js`**

```js
// supabase-api.js — all Supabase network access.
// Exposes window.PosApi. Requires the supabase-js UMD global (loaded before this).
const SUPABASE_URL = "https://uxpcnpkxathduehpqkyq.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_9Xou20b2C_H--LCbqEw11A_DDLvtqNQ";

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// --- Products ---
async function fetchProducts() {
  const { data, error } = await supabaseClient
    .from("products")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

async function insertProduct(product) {
  const { error } = await supabaseClient.from("products").insert(product);
  if (error) throw error;
}

async function updateProduct(id, fields) {
  const { error } = await supabaseClient.from("products").update(fields).eq("id", id);
  if (error) throw error;
}

async function deleteProduct(id) {
  const { error } = await supabaseClient.from("products").delete().eq("id", id);
  if (error) throw error;
}

// --- Sales ---
async function insertSale(sale) {
  const { error } = await supabaseClient.from("sales").insert(sale);
  if (error) throw error;
}

async function fetchSalesByDate(dateKey) {
  const { data, error } = await supabaseClient
    .from("sales")
    .select("*")
    .eq("sale_date", dateKey)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

async function deleteSalesByDate(dateKey) {
  const { error } = await supabaseClient.from("sales").delete().eq("sale_date", dateKey);
  if (error) throw error;
}

window.PosApi = {
  fetchProducts, insertProduct, updateProduct, deleteProduct,
  insertSale, fetchSalesByDate, deleteSalesByDate,
};
```

- [ ] **Step 2: Replace `app.js`**

Replace the entire contents of `app.js` with:

```js
// app.js — DOM wiring for Brewzy POS.
// Pure logic: pos-core.js (PosCore). Supabase access: supabase-api.js (PosApi).

const { money, localDateKey, calcTotals, cartToItems, aggregateSales, productError } = PosCore;

const PRODUCTS_CACHE_KEY = "touchPosProducts";

let products = JSON.parse(localStorage.getItem(PRODUCTS_CACHE_KEY)) || [];
let cart = [];
let activeCategory = "All";
let paymentMethod = "Cash";

const $ = (id) => document.getElementById(id);

function cacheProducts() {
  localStorage.setItem(PRODUCTS_CACHE_KEY, JSON.stringify(products));
}

// Load the shared menu from Supabase; fall back to the cached copy if offline.
async function loadProducts() {
  try {
    const rows = await PosApi.fetchProducts();
    products = rows.map((p) => ({ ...p, price: Number(p.price) }));
    cacheProducts();
  } catch (err) {
    console.error("Failed to load products:", err);
    products = JSON.parse(localStorage.getItem(PRODUCTS_CACHE_KEY)) || [];
    if (!products.length) {
      alert("Couldn't load the menu and no cached copy is available. Check your connection and reload.");
    }
  }
  renderAll();
}

function renderCategories() {
  const categories = ["All", ...new Set(products.map(p => p.category))];
  $("categoryFilters").innerHTML = categories.map(category => `
    <button class="category-btn ${activeCategory === category ? "active" : ""}" data-category="${category}">
      ${category}
    </button>
  `).join("");

  document.querySelectorAll(".category-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      activeCategory = btn.dataset.category;
      renderCategories();
      renderProducts();
    });
  });
}

function renderProducts() {
  const query = $("searchInput").value.trim().toLowerCase();
  const filtered = products.filter(product => {
    const matchesCategory = activeCategory === "All" || product.category === activeCategory;
    const matchesSearch = product.name.toLowerCase().includes(query);
    return matchesCategory && matchesSearch;
  });

  $("productGrid").innerHTML = filtered.length ? filtered.map(product => `
    <button class="product-card" data-id="${product.id}">
      <div class="product-emoji">${product.emoji || "🍽️"}</div>
      <span class="product-name">${escapeHtml(product.name)}</span>
      <span class="product-category">${escapeHtml(product.category)}</span>
      <span class="product-price">${money(product.price)}</span>
    </button>
  `).join("") : `<div class="empty-state"><strong>No matching items</strong></div>`;

  document.querySelectorAll(".product-card").forEach(card => {
    card.addEventListener("click", () => addToCart(card.dataset.id));
  });
}

function addToCart(id) {
  const existing = cart.find(item => item.id === id);
  if (existing) existing.qty += 1;
  else {
    const product = products.find(p => p.id === id);
    if (product) cart.push({ ...product, qty: 1 });
  }
  renderCart();
}

function updateQty(id, change) {
  const item = cart.find(i => i.id === id);
  if (!item) return;
  item.qty += change;
  if (item.qty <= 0) cart = cart.filter(i => i.id !== id);
  renderCart();
}

function renderCart() {
  const count = cart.reduce((sum, item) => sum + item.qty, 0);
  $("itemCount").textContent = `${count} item${count === 1 ? "" : "s"}`;

  $("cartItems").innerHTML = cart.length ? cart.map(item => `
    <div class="cart-row">
      <div>
        <h4>${escapeHtml(item.name)}</h4>
        <small>${money(item.price * item.qty)}</small>
      </div>
      <div class="qty-controls">
        <button class="qty-btn" data-id="${item.id}" data-change="-1">−</button>
        <span class="qty">${item.qty}</span>
        <button class="qty-btn" data-id="${item.id}" data-change="1">＋</button>
      </div>
    </div>
  `).join("") : `
    <div class="empty-state">
      <div class="empty-icon">🛒</div>
      <strong>No items added</strong>
      <span>Tap a food item to begin</span>
    </div>`;

  document.querySelectorAll(".qty-btn").forEach(btn => {
    btn.addEventListener("click", () => updateQty(btn.dataset.id, Number(btn.dataset.change)));
  });

  const t = calcTotals(cart);
  $("subtotal").textContent = money(t.subtotal);
  $("tax").textContent = money(t.tax);
  $("total").textContent = money(t.total);
  $("payBtn").textContent = `Pay ${money(t.total)}`;
  $("payBtn").disabled = cart.length === 0;
  updateChange();
}

function updateChange() {
  const total = calcTotals(cart).total;
  const received = Number($("cashReceived").value || 0);
  $("changeDue").textContent = money(Math.max(0, received - total));
}

function renderManageList() {
  $("manageItemList").innerHTML = products.map(product => `
    <div class="manage-row">
      <div>
        <strong>${product.emoji || "🍽️"} ${escapeHtml(product.name)}</strong>
        <small>${escapeHtml(product.category)} · ${money(product.price)}</small>
      </div>
      <button type="button" class="small-btn edit-item" data-id="${product.id}">Edit</button>
      <button type="button" class="small-btn delete delete-item" data-id="${product.id}">Delete</button>
    </div>
  `).join("");

  document.querySelectorAll(".edit-item").forEach(btn => {
    btn.addEventListener("click", () => loadItemForEdit(btn.dataset.id));
  });

  document.querySelectorAll(".delete-item").forEach(btn => {
    btn.addEventListener("click", () => deleteItem(btn.dataset.id));
  });
}

function loadItemForEdit(id) {
  const product = products.find(p => p.id === id);
  if (!product) return;
  $("editingId").value = product.id;
  $("itemName").value = product.name;
  $("itemPrice").value = product.price;
  $("itemCategory").value = product.category;
  $("itemEmoji").value = product.emoji || "";
}

function resetItemForm() {
  $("editingId").value = "";
  $("itemName").value = "";
  $("itemPrice").value = "";
  $("itemCategory").value = "";
  $("itemEmoji").value = "";
  $("itemName").focus();
}

async function saveItem() {
  const name = $("itemName").value.trim();
  const price = Number($("itemPrice").value);
  const category = $("itemCategory").value.trim();
  const emoji = $("itemEmoji").value.trim() || "🍽️";
  const editingId = $("editingId").value;

  const error = productError({ name, price, category });
  if (error) {
    alert(error);
    return;
  }

  const saveBtn = $("saveItemBtn");
  saveBtn.disabled = true;
  try {
    if (editingId) {
      await PosApi.updateProduct(editingId, { name, price, category, emoji });
    } else {
      await PosApi.insertProduct({ name, price, category, emoji });
    }
  } catch (err) {
    console.error("Failed to save product:", err);
    alert("Couldn't save the item — check your connection and try again.");
    saveBtn.disabled = false;
    return;
  }

  saveBtn.disabled = false;
  resetItemForm();
  await loadProducts(); // re-renders everything, including the manage list
}

async function deleteItem(id) {
  const product = products.find(p => p.id === id);
  if (!product || !confirm(`Delete "${product.name}"?`)) return;
  try {
    await PosApi.deleteProduct(id);
  } catch (err) {
    console.error("Failed to delete product:", err);
    alert("Couldn't delete the item — check your connection and try again.");
    return;
  }
  cart = cart.filter(i => i.id !== id);
  await loadProducts();
}

async function processPayment() {
  if (!cart.length) return;
  const t = calcTotals(cart);

  if (paymentMethod === "Cash") {
    const received = Number($("cashReceived").value || 0);
    if (received < t.total) {
      alert(`Cash received must be at least ${money(t.total)}.`);
      $("cashReceived").focus();
      return;
    }
  }

  const payBtn = $("payBtn");
  const originalLabel = payBtn.textContent;
  payBtn.disabled = true;
  payBtn.textContent = "Saving…";

  const sale = {
    sale_date: localDateKey(),
    payment_method: paymentMethod,
    subtotal: t.subtotal,
    tax: t.tax,
    total: t.total,
    items: cartToItems(cart),
  };

  try {
    await PosApi.insertSale(sale);
  } catch (err) {
    console.error("Failed to save sale:", err);
    alert("Couldn't save the sale — check your internet connection and try again.");
    payBtn.disabled = false;
    payBtn.textContent = originalLabel;
    return; // keep cart intact — no data loss
  }

  const count = cart.reduce((sum, item) => sum + item.qty, 0);
  let message = `${count} item${count === 1 ? "" : "s"} paid by ${paymentMethod}.<br><strong>Total: ${money(t.total)}</strong>`;
  if (paymentMethod === "Cash") {
    const change = Number($("cashReceived").value) - t.total;
    message += `<br>Change: ${money(change)}`;
  }

  cart = [];
  $("cashReceived").value = "";
  renderCart(); // resets pay button label + disabled state
  $("receiptText").innerHTML = message;
  $("receiptDialog").showModal();
}

async function openSalesReport() {
  $("reportDate").value = localDateKey();
  $("salesReportDialog").showModal();
  await renderSalesReport();
}

function setReportLoading() {
  $("productSalesBody").innerHTML = `<tr><td colspan="3" class="report-empty">Loading…</td></tr>`;
}

function setReportError() {
  ["reportCash", "reportCard", "reportTransfer", "reportTotal"].forEach(id => {
    $(id).textContent = money(0);
  });
  $("reportTransactions").textContent = "0";
  $("reportItems").textContent = "0";
  $("productSalesBody").innerHTML = `<tr><td colspan="3" class="report-empty">Couldn't load sales — check your connection and try again.</td></tr>`;
}

async function renderSalesReport() {
  const selectedDate = $("reportDate").value || localDateKey();
  setReportLoading();

  let sales;
  try {
    sales = await PosApi.fetchSalesByDate(selectedDate);
  } catch (err) {
    console.error("Failed to load report:", err);
    setReportError();
    return;
  }

  const r = aggregateSales(sales);
  $("reportCash").textContent = money(r.paymentTotals.Cash || 0);
  $("reportCard").textContent = money(r.paymentTotals.Card || 0);
  $("reportTransfer").textContent = money(r.paymentTotals.Transfer || 0);
  $("reportTotal").textContent = money(r.grandTotal);
  $("reportTransactions").textContent = r.transactionCount;
  $("reportItems").textContent = r.itemCount;

  $("productSalesBody").innerHTML = r.productRows.length ? r.productRows.map(item => `
    <tr>
      <td>${escapeHtml(item.name)}</td>
      <td>${item.qty}</td>
      <td>${money(item.sales)}</td>
    </tr>
  `).join("") : `<tr><td colspan="3" class="report-empty">No sales recorded for this date.</td></tr>`;
}

function renderAll() {
  if (activeCategory !== "All" && !products.some(p => p.category === activeCategory)) {
    activeCategory = "All";
  }
  renderCategories();
  renderProducts();
  renderCart();
  renderManageList();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[char]));
}

$("searchInput").addEventListener("input", renderProducts);
$("clearCartBtn").addEventListener("click", () => {
  if (!cart.length || confirm("Clear the current order?")) {
    cart = [];
    $("cashReceived").value = "";
    renderCart();
  }
});

$("salesReportBtn").addEventListener("click", openSalesReport);
$("closeSalesReportBtn").addEventListener("click", () => $("salesReportDialog").close());
$("reportDate").addEventListener("change", renderSalesReport);
$("clearReportBtn").addEventListener("click", async () => {
  const selectedDate = $("reportDate").value || localDateKey();
  if (!confirm(`Clear all saved sales for ${selectedDate}?`)) return;
  try {
    await PosApi.deleteSalesByDate(selectedDate);
  } catch (err) {
    console.error("Failed to clear sales:", err);
    alert("Couldn't clear sales — check your connection and try again.");
    return;
  }
  await renderSalesReport();
});

$("manageItemsBtn").addEventListener("click", () => {
  renderManageList();
  $("itemDialog").showModal();
});

$("saveItemBtn").addEventListener("click", saveItem);
$("resetFormBtn").addEventListener("click", resetItemForm);
$("cashReceived").addEventListener("input", updateChange);
$("payBtn").addEventListener("click", processPayment);

document.querySelectorAll(".payment").forEach(btn => {
  btn.addEventListener("click", () => {
    paymentMethod = btn.dataset.method;
    document.querySelectorAll(".payment").forEach(b => b.classList.toggle("active", b === btn));
    $("cashSection").style.display = paymentMethod === "Cash" ? "block" : "none";
  });
});

$("newOrderBtn").addEventListener("click", () => {
  $("receiptDialog").close();
  cart = [];
  $("cashReceived").value = "";
  renderCart();
});

renderAll();     // instant paint from cached menu (if any)
loadProducts();  // refresh the shared menu from Supabase
```

- [ ] **Step 3: Append the report styles to `styles.css`**

Append the following to the end of `styles.css` (these are the styles currently only in `styles_updated.css`):

```css
.topbar-actions {
  display: flex;
  gap: 10px;
  align-items: center;
}

.report-modal { max-width: 820px; margin: auto; }
.report-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: end;
  gap: 12px;
  margin: 18px 0;
}
.report-toolbar label { font-size: 12px; font-weight: 800; }
.report-toolbar input { margin-top: 6px; min-width: 180px; }
.report-cards {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.report-card {
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 15px;
  background: #f8fafb;
}
.report-card span { display: block; color: var(--muted); font-size: 12px; margin-bottom: 6px; }
.report-card strong { font-size: 18px; }
.report-card.highlight { background: #fff4ef; border-color: rgba(239,108,53,.35); }
.report-table-wrap { border: 1px solid var(--line); border-radius: 13px; overflow: auto; }
.report-table { width: 100%; border-collapse: collapse; }
.report-table th, .report-table td { padding: 12px 14px; border-bottom: 1px solid var(--line); text-align: left; }
.report-table th { background: #f8fafb; font-size: 12px; }
.report-table td:nth-child(2), .report-table td:nth-child(3),
.report-table th:nth-child(2), .report-table th:nth-child(3) { text-align: right; }
.report-table tbody tr:last-child td { border-bottom: 0; }
.report-empty { text-align: center !important; color: var(--muted); padding: 24px !important; }

@media (max-width: 620px) {
  .topbar { height: auto; min-height: 82px; padding-top: 12px; padding-bottom: 12px; gap: 10px; }
  .topbar-actions { flex-direction: column; align-items: stretch; }
  .topbar-actions button { padding: 8px 10px; font-size: 12px; }
  .report-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .report-toolbar { align-items: stretch; flex-direction: column; }
}
```

- [ ] **Step 4: Fix the script tags in `index.html`**

Replace the single block:

```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script src="app.js"></script>
```

with (load order matters — supabase global first, then core, then api, then app):

```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script src="pos-core.js"></script>
<script src="supabase-api.js"></script>
<script src="app.js"></script>
```

- [ ] **Step 5: Delete the duplicate files**

```bash
git rm app_updated.js index_updated.html styles_updated.css README_updated.md
```

- [ ] **Step 6: End-to-end verification in a browser**

Start a local server and open the app (Supabase blocks `file://` origins, so a server is required):

Run: `python -m http.server 8000` (from the repo root), then open `http://localhost:8000`.

Verify each, watching the browser devtools Console for errors:
1. **Loads clean:** the seeded menu (10 items) renders from Supabase, categories show, no console errors. `window.PosCore` and `window.PosApi` are defined (type them in the console).
2. **Add a product:** open Manage Items → add a new item (e.g. "Latte", 30, "Drinks", ☕) → it appears in the grid and manage list. In Supabase **Table Editor → products**, the row exists.
3. **Shared menu:** open the app in a second browser/incognito window → the new item is present (loaded from Supabase, not local).
4. **Edit a product:** change its price → after save, the grid and manage list show the new price; the Supabase row is updated; a reload keeps it.
5. **Delete a product:** delete it → it disappears from the grid/list and from the Supabase table; reload confirms.
6. **Offline menu fallback:** with the menu loaded once, open devtools Network → Offline, then reload → the app still shows the cached menu (from `localStorage`), no empty grid.
7. **Cart math:** tap items; subtotal, 8% tax, total, and the Pay button label update. Quantity +/− works; removing all of an item drops the row.
8. **Payment method toggle:** Cash shows the cash-received field with live change; Transfer/Card hide it.
9. **Save a Cash sale:** add items, enter enough cash, press Pay → receipt dialog shows correct total and change; cart clears. In **Table Editor → sales**, a new row appears with matching `total`, `payment_method='Cash'`, today's `sale_date`, and an `items` array of `{name,price,qty}`.
10. **Save Card and Transfer sales:** repeat for each; rows appear with the right `payment_method`.
11. **Report aggregates by name:** open Daily Report for today. Totals per method, transaction count, and items sold match what you rang; the same item rung twice shows as one row with combined quantity.
12. **Clear This Day:** press it, confirm → the report re-queries and shows zeros / "No sales recorded"; the rows are gone from the Supabase `sales` table.
13. **Sale-failure keeps the cart:** in devtools go Offline, add items, press Pay → an alert appears, the cart is still populated, and Pay is re-enabled. Go back online and Pay succeeds.

All thirteen must pass. If any fails, fix before committing.

- [ ] **Step 7: Commit**

```bash
git add supabase-api.js app.js styles.css index.html
git commit -m "Move menu + sales to Supabase; consolidate duplicate files"
```

---

## Self-Review

**Spec coverage:**
- Shared menu in Supabase, add/edit/delete → Task 2 `products` table + Task 3 `loadProducts`/`saveItem`/`deleteItem`. ✓
- `localStorage` as read-through cache only → Task 3 `cacheProducts`/`loadProducts` fallback. ✓
- Consolidate to one file set / delete `_updated` → Task 3 (steps 4–5). ✓
- `sales` table + insert/select/delete RLS; `products` select/insert/update/delete RLS → Task 2. ✓
- Sale saved on payment, cart preserved on failure → Task 3 `processPayment`. ✓
- Product write failure not applied optimistically → Task 3 `saveItem`/`deleteItem` (reload only on success). ✓
- Report reads from Supabase, aggregates by name → Task 1 `aggregateSales` + Task 3 `renderSalesReport`. ✓
- Clear This Day deletes server rows → Task 3 `clearReportBtn` handler. ✓
- Error states (product load, product write, sale save, report) → Task 3 `loadProducts`, `saveItem`, `deleteItem`, `processPayment`, `setReportError`. ✓
- Local date key → Task 1 `localDateKey`, used in `processPayment`. ✓
- README with SQL + GitHub Pages steps → Task 2. ✓
- Keys client-side → Task 3 `supabase-api.js`. ✓

**Placeholder scan:** No TBD/TODO; all code blocks are complete.

**Type consistency:** `insertProduct`/`updateProduct` receive `{name, price, category, emoji}` — matching the `products` columns (Task 2). `fetchProducts` rows are normalized (`price: Number(...)`) before use in `calcTotals`/`money`. `insertSale` receives `{sale_date, payment_method, subtotal, tax, total, items}` — matches `sales` columns (Task 2) and `aggregateSales` input shape (Task 1). `productError` is called with `{name, price, category}` matching its signature. `PosCore` destructuring in `app.js` matches the exports in `pos-core.js`. Script load order in `index.html` satisfies dependencies (`supabase` → `PosCore`/`PosApi` → `app.js`).
