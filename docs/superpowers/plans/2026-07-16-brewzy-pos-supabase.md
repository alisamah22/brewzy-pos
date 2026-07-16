# Brewzy POS — Supabase Sales Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the duplicate POS files into one clean set and persist every completed sale to a Supabase `sales` table so daily reports are durable and shared across tills, while the menu stays per-device in `localStorage`.

**Architecture:** Zero-build static site (HTML/CSS/JS) on GitHub Pages. Pure POS logic lives in `pos-core.js` (browser global `PosCore`, also `require`-able in Node for tests). All Supabase network access lives in `supabase-api.js` (browser global `PosApi`). `app.js` is DOM wiring only and delegates to `PosCore` and `PosApi`. Reports aggregate line items **by product name** so items from different devices merge.

**Tech Stack:** Vanilla JS, `@supabase/supabase-js@2` (CDN), Supabase Postgres + RLS, `node --test` (built-in) for unit tests, GitHub Pages for hosting.

## Global Constraints

- Zero build step — files are served as-is by GitHub Pages. No bundler, no transpile.
- No runtime npm dependencies. Tests may use **only** Node.js built-in modules (`node:test`, `node:assert`).
- Currency is MVR, formatted as `MVR 0.00` (two decimals). Tax rate is `0.08` (8%).
- Supabase URL and **publishable (anon)** key stay in client code (safe to expose; RLS governs access). URL: `https://uxpcnpkxathduehpqkyq.supabase.co`, key: `sb_publishable_9Xou20b2C_H--LCbqEw11A_DDLvtqNQ`.
- Do not rename existing DOM element IDs in `index.html` — `app.js` binds to them.
- Menu (products) stays in `localStorage` under key `touchPosProducts`. No products table.
- Report product rows are keyed by item **name**, never by ID.
- Sale rows use device-**local** date (`localDateKey`) for `sale_date`.
- On a failed sale save, the cart MUST be preserved — never silent data loss.

## File Structure (end state)

- `index.html` — markup + dialogs (already present); loads scripts in order: supabase CDN → `pos-core.js` → `supabase-api.js` → `app.js`.
- `styles.css` — all styles including the report dialog styles (merged in).
- `pos-core.js` — **new.** Pure functions: `money`, `localDateKey`, `calcTotals`, `cartToItems`, `aggregateSales`. No DOM, no network.
- `supabase-api.js` — **new.** Supabase client + `insertSale`, `fetchSalesByDate`, `deleteSalesByDate`.
- `app.js` — DOM wiring; delegates logic to `PosCore` and network to `PosApi`.
- `tests/pos-core.test.js` — **new.** `node --test` unit tests for `pos-core.js`.
- `supabase/schema.sql` — **new.** Table + RLS DDL to run in the Supabase SQL editor.
- `README.md` — updated: features, local run, Supabase setup, GitHub Pages deploy.
- **Deleted:** `app_updated.js`, `index_updated.html`, `styles_updated.css`, `README_updated.md`.

---

### Task 1: Pure POS logic module (`pos-core.js`) with unit tests

Extract all pure logic into a testable module before touching the DOM. The key correctness change vs. the current `app_updated.js` is that `aggregateSales` rolls products up **by name**, so the same item rung from two devices (which have different local IDs) merges into one report row.

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
} = require("../pos-core.js");

test("money formats as MVR with two decimals", () => {
  assert.equal(money(20), "MVR 20.00");
  assert.equal(money(12.5), "MVR 12.50");
  assert.equal(money(0), "MVR 0.00");
});

test("localDateKey returns local YYYY-MM-DD (not UTC)", () => {
  // 16 July 2026, 23:30 local time; month arg is 0-based
  const d = new Date(2026, 6, 16, 23, 30);
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
  // sorted by qty desc: Brownie (2) before Sausage (2)? tie -> name asc
  assert.equal(r.productRows[0].name, "Brownie");
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
  // NAME so identical items rung from different devices merge into one row.
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

  const api = { TAX_RATE, money, localDateKey, calcTotals, cartToItems, aggregateSales };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PosCore = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/pos-core.test.js`
Expected: PASS — 5 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add pos-core.js tests/pos-core.test.js
git commit -m "Add pos-core pure logic module with unit tests"
```

---

### Task 2: Supabase schema + documentation

Provide the DDL the shop owner runs once in the Supabase SQL editor, and update the README with setup and deployment steps. This is a committed artifact plus a manual apply step; it has no automated test.

**Files:**
- Create: `supabase/schema.sql`
- Modify: `README.md` (full rewrite)

**Interfaces:**
- Produces: a `public.sales` table with columns `id, created_at, sale_date, payment_method, subtotal, tax, total, items` and anon `select`/`insert`/`delete` RLS policies. Task 3's `supabase-api.js` depends on exactly these column names.

- [ ] **Step 1: Create the schema file**

Create `supabase/schema.sql`:

```sql
-- Brewzy POS — sales table + open (anon) RLS policies.
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> Run.

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

create policy "anon can read sales"
  on public.sales for select to anon using (true);

create policy "anon can insert sales"
  on public.sales for insert to anon with check (true);

create policy "anon can delete sales"
  on public.sales for delete to anon using (true);

create index if not exists sales_sale_date_idx on public.sales (sale_date);
```

- [ ] **Step 2: Rewrite `README.md`**

Replace the entire contents of `README.md` with:

````markdown
# Brewzy POS

A simple, touch-friendly point-of-sale web app for a small food counter
(prices in MVR). Runs as static files on GitHub Pages. Completed sales are
saved to Supabase so daily reports are shared across tills; the menu is kept
per-device in the browser.

## Features
- Touch-friendly item buttons, search, and category filters
- Add / edit / delete menu items (stored per-device in `localStorage`)
- Cart with quantity controls, automatic subtotal, 8% tax, and total
- Cash / Transfer / Card payment, with cash-received and change calculation
- Every completed sale saved to Supabase
- Daily sales report (per payment method, transactions, items sold, and
  per-product quantities) read from Supabase, with a "Clear This Day" action

## Supabase setup (once)
1. In your Supabase project, open **SQL Editor → New query**.
2. Paste the contents of [`supabase/schema.sql`](supabase/schema.sql) and click **Run**.
3. That creates the `sales` table and open row-level-security policies.

The Supabase URL and publishable (anon) key live in `supabase-api.js`. These are
safe to expose in client code — row-level security governs access. Access is
open (no login): anyone with the site URL can read, add, and delete sales.

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
````

- [ ] **Step 3: Apply the schema in Supabase (manual)**

Open the Supabase dashboard for project `uxpcnpkxathduehpqkyq`, go to SQL Editor, paste `supabase/schema.sql`, and Run.
Expected: "Success. No rows returned." Then **Table Editor** shows a `sales` table.

> If you do not have dashboard access, hand `supabase/schema.sql` to whoever does. Task 3's end-to-end verification cannot pass until this table exists.

- [ ] **Step 4: Commit**

```bash
git add supabase/schema.sql README.md
git commit -m "Add Supabase sales schema and update README"
```

---

### Task 3: Integrate — Supabase API, app rewrite, style merge, delete duplicates

Wire everything together: a network module, an `app.js` that uses `PosCore` + `PosApi`, the merged report styles, corrected script tags, and removal of the duplicate files. Verified end-to-end in a browser against the live Supabase table from Task 2.

**Files:**
- Create: `supabase-api.js`
- Modify: `app.js` (full replace), `styles.css` (append report styles), `index.html` (script tags)
- Delete: `app_updated.js`, `index_updated.html`, `styles_updated.css`, `README_updated.md`

**Interfaces:**
- Consumes: `PosCore` from Task 1; the `sales` table from Task 2.
- Produces (browser global `PosApi`):
  - `insertSale(sale: {sale_date, payment_method, subtotal, tax, total, items}) => Promise<void>` (throws on error)
  - `fetchSalesByDate(dateKey: string) => Promise<sale[]>` (throws on error)
  - `deleteSalesByDate(dateKey: string) => Promise<void>` (throws on error)

- [ ] **Step 1: Create `supabase-api.js`**

```js
// supabase-api.js — all Supabase network access for sales.
// Exposes window.PosApi. Requires the supabase-js UMD global (loaded before this).
const SUPABASE_URL = "https://uxpcnpkxathduehpqkyq.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_9Xou20b2C_H--LCbqEw11A_DDLvtqNQ";

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

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

window.PosApi = { insertSale, fetchSalesByDate, deleteSalesByDate };
```

- [ ] **Step 2: Replace `app.js`**

Replace the entire contents of `app.js` with:

```js
// app.js — DOM wiring for Brewzy POS.
// Pure logic: pos-core.js (PosCore). Supabase access: supabase-api.js (PosApi).

const { money, localDateKey, calcTotals, cartToItems, aggregateSales } = PosCore;

const defaultProducts = [
  { id: crypto.randomUUID(), name: "Submarine", price: 20, category: "Kulhi", emoji: "🍔" },
  { id: crypto.randomUUID(), name: "Boava", price: 25, category: "Kulhi", emoji: "🍔" },
  { id: crypto.randomUUID(), name: "Rihaakuru roshi", price: 12, category: "Kulhi", emoji: "🍫" },
  { id: crypto.randomUUID(), name: "Brownie bits", price: 65, category: "Desserts", emoji: "🍫" },
  { id: crypto.randomUUID(), name: "Brownie", price: 35, category: "Desserts", emoji: "🍫" },
  { id: crypto.randomUUID(), name: "Cookie Bits", price: 50, category: "Desserts", emoji: "🍫" },
  { id: crypto.randomUUID(), name: "Tres leches", price: 40, category: "Desserts", emoji: "🍫" },
  { id: crypto.randomUUID(), name: "Sausage", price: 10, category: "Kulhi", emoji: "🍔" },
  { id: crypto.randomUUID(), name: "Metaa gandu", price: 20, category: "Desserts", emoji: "🍰" },
  { id: crypto.randomUUID(), name: "Ice Cream", price: 35, category: "Desserts", emoji: "🍨" }
];

let products = JSON.parse(localStorage.getItem("touchPosProducts")) || defaultProducts;
let cart = [];
let activeCategory = "All";
let paymentMethod = "Cash";

const $ = (id) => document.getElementById(id);

function saveProducts() {
  localStorage.setItem("touchPosProducts", JSON.stringify(products));
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
    btn.addEventListener("click", () => {
      const product = products.find(p => p.id === btn.dataset.id);
      if (product && confirm(`Delete "${product.name}"?`)) {
        products = products.filter(p => p.id !== btn.dataset.id);
        cart = cart.filter(i => i.id !== btn.dataset.id);
        saveProducts();
        renderAll();
      }
    });
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

function saveItem() {
  const name = $("itemName").value.trim();
  const price = Number($("itemPrice").value);
  const category = $("itemCategory").value.trim();
  const emoji = $("itemEmoji").value.trim() || "🍽️";
  const editingId = $("editingId").value;

  if (!name || !category || !Number.isFinite(price) || price < 0) {
    alert("Please enter a valid name, category, and price.");
    return;
  }

  if (editingId) {
    const product = products.find(p => p.id === editingId);
    Object.assign(product, { name, price, category, emoji });
    const cartItem = cart.find(i => i.id === editingId);
    if (cartItem) Object.assign(cartItem, { name, price, category, emoji });
  } else {
    products.push({ id: crypto.randomUUID(), name, price, category, emoji });
  }

  saveProducts();
  resetItemForm();
  renderAll();
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

renderAll();
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

Replace the single line:

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
1. **Loads clean:** product grid renders, categories show, no console errors. `window.PosCore` and `window.PosApi` are defined (type them in the console).
2. **Cart math:** tap items; subtotal, 8% tax, total, and the Pay button label update. Quantity +/− works; removing all of an item drops the row.
3. **Menu management (local):** open Manage Items, add an item, confirm it appears in the grid; reload the page and confirm it persists (localStorage).
4. **Payment method toggle:** Cash shows the cash-received field with live change; Transfer/Card hide it.
5. **Save a Cash sale:** add items, enter enough cash, press Pay → receipt dialog shows correct total and change; cart clears. In Supabase **Table Editor → sales**, a new row appears with matching `total`, `payment_method='Cash'`, today's `sale_date`, and an `items` array of `{name,price,qty}`.
6. **Save Card and Transfer sales:** repeat for each; rows appear with the right `payment_method`.
7. **Report aggregates by name across IDs:** open Daily Report for today. Totals per method, transaction count, and items sold match what you rang. To prove name-keyed merge: in devtools run `localStorage.removeItem('touchPosProducts'); location.reload();` (regenerates product IDs), ring another sale of an item you sold before, reopen the report — that product shows as **one** row with the combined quantity, not two.
8. **Clear This Day:** press it, confirm → the report re-queries and shows zeros / "No sales recorded"; the rows are gone from the Supabase table.
9. **Save-failure keeps the cart:** in devtools go offline (Network tab → Offline), add items, press Pay → an alert appears, the cart is still populated, and Pay is re-enabled. Go back online and Pay succeeds.

All nine must pass. If any fails, fix before committing.

- [ ] **Step 7: Commit**

```bash
git add supabase-api.js app.js styles.css index.html
git commit -m "Integrate Supabase sales persistence; consolidate duplicate files"
```

---

## Self-Review

**Spec coverage:**
- Consolidate to one file set / delete `_updated` → Task 3 (steps 4–5). ✓
- Menu stays in `localStorage` → Task 3 `app.js` unchanged product logic. ✓
- `sales` table + insert/select/delete RLS for anon → Task 2. ✓
- Sale saved on payment, cart preserved on failure → Task 3 `processPayment`. ✓
- Report reads from Supabase, aggregates by name → Task 1 `aggregateSales` + Task 3 `renderSalesReport`. ✓
- Clear This Day deletes server rows → Task 3 `clearReportBtn` handler. ✓
- Error states (save/startup/report) → Task 3 `processPayment`, `setReportError`. ✓
- Local date key → Task 1 `localDateKey`, used in `processPayment`. ✓
- README with SQL + GitHub Pages steps → Task 2. ✓
- Keys client-side → Task 3 `supabase-api.js`. ✓

**Placeholder scan:** No TBD/TODO; all code blocks are complete.

**Type consistency:** `insertSale` receives `{sale_date, payment_method, subtotal, tax, total, items}` — matches the `sales` columns (Task 2) and `aggregateSales` input shape (`payment_method`, `total`, `items[].{name,price,qty}`) (Task 1). `PosCore` destructuring in `app.js` matches the exports in `pos-core.js`. Script load order in `index.html` satisfies dependencies (`supabase` → `PosCore`/`PosApi` → `app.js`).
