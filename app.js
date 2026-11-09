// app.js — DOM wiring for Brewzy POS.
// Pure logic: pos-core.js (PosCore). Supabase access: supabase-api.js (PosApi).

const {
  money, localDateKey, parseDateKey, addDays, dateRange, calcTotals, cartToItems, margin,
  quickCashOptions, aggregateSales, bestSellers, productError, salesToCsv,
  discardError, stockSummary, aggregateDiscards,
  hasDiscount, sellingPrice, discountPercent, priceAfterPercentOff, tracksStock,
  scopeSales, expenseError, sumExpenses, isTestSale, testModeUntil, expoPeriod,
  toPendingItems, mergePendingItems, pendingSummary, setVendor,
  CASH_DENOMINATIONS, cashCountTotal, dayExpected,
} = PosCore;

const PRODUCTS_CACHE_KEY = "touchPosProducts";
const PENDING_SALES_KEY = "brewzyPendingSales";
const REPORT_SCOPE_KEY = "brewzyReportScope";
const OPEN_ORDERS_KEY = "brewzyOpenOrders";
const PENDING_DELETES_KEY = "brewzyPaidPendingOrders"; // paid pay-later orders still to remove
const EMOJI_PICKS = ["🍔", "🌭", "🥪", "🍕", "🍟", "🥐", "🍩", "🍪", "🍫", "🍰", "🧁", "🍨",
  "☕", "🧋", "🥤", "🧃", "🍵", "🥗", "🍛", "🐟"];

const $ = (id) => document.getElementById(id);

// The logged-in vendor ({ id, username, name }); null until login.
let vendor = null;

// Each vendor's data on a till is kept under their own keys.
function storeKey(key) {
  return vendor ? `${key}:${vendor.id}` : key;
}

// localStorage can throw (private mode, blocked storage) or hold bad JSON.
function readStore(key, fallback) {
  try {
    const raw = localStorage.getItem(storeKey(key));
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(storeKey(key), JSON.stringify(value));
  } catch (err) {
    console.warn("Couldn't write to local storage:", err);
  }
}

let products = []; // loaded for the vendor at login
let pendingSales = []; // sales not yet uploaded
let menuLoaded = false;
let cart = []; // lines of the order on screen (the active open order)
let activeCategory = "All";
let paymentMethod = "Cash";
let online = null; // null = not checked yet
let saving = false;

const report = {
  preset: "today",
  scope: "main", // remembered per vendor (set at login)
  allSales: [], // every sale in the range
  sales: [], // the Main or Expo part of each sale (see applyScope)
  bills: [],
  billsFailed: false,
  discards: [],
  discardsFailed: false,
  stockSortKey: "loss",
  stockSortDir: -1,
  bestBy: "qty",
  sortKey: "qty",
  sortDir: -1,
  showAllTransactions: false,
  token: 0,
};

// ---------- Small helpers ----------

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[char]));
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Database errors carry a code; a failed request (offline, DNS, paused
// project) doesn't.
function isNetworkError(err) {
  if (navigator.onLine === false) return true;
  const msg = String((err && err.message) || err || "");
  return !(err && err.code) || /fetch|network|load failed|timeout/i.test(msg);
}

function describeError(err) {
  const msg = String((err && (err.message || err.details)) || "");
  if ((/column/i.test(msg) && /cost|voided|stock_qty|sale_price/i.test(msg)) || /discards|expenses|pending_orders|dining_tables|table_id|day_closes|whoami|my_vendor/i.test(msg)) {
    return "The database needs a one-time update: run the migration SQL from the README.";
  }
  if (/permission denied|row-level security|only an admin/i.test(msg)) {
    return vendor && vendor.role === "cashier"
      ? "Only an admin can do this."
      : "The database refused this change. Run the latest migration SQL from the README.";
  }
  return "Couldn't reach the database. Check the internet connection and try again.";
}

function openDialogEl() {
  return [...document.querySelectorAll("dialog[open]")].pop() || null;
}

// Toasts replace alert() popups. The host moves into any open modal dialog,
// since modals render above everything else on the page.
function toast(message, type = "info", ms = 3500) {
  const host = $("toastHost");
  const parent = openDialogEl() || document.body;
  if (host.parentElement !== parent) parent.appendChild(host);
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, ms);
}

function productFor(name) {
  return products.find(p => p.name === name);
}

// Current cost price of a menu item, used in reports for sales made before
// the item had a cost price.
function currentCost(name) {
  return productFor(name)?.cost || 0;
}

// ---------- Connection status & offline sales ----------

function setOnline(value) {
  online = value;
  renderStatus();
}

function renderStatus() {
  const pill = $("syncStatus");
  const n = pendingSales.length;
  let text = "Connecting…";
  let cls = "";
  if (n) {
    text = `⏳ ${plural(n, "sale")} to upload`;
    cls = "warn";
  } else if (online === false) {
    text = "⚠️ Offline";
    cls = "bad";
  } else if (online) {
    text = "✓ Online";
    cls = "good";
  }
  pill.textContent = text;
  pill.className = `status-pill ${cls}`;
  pill.title = n
    ? "These sales are saved on this device and will upload automatically when the connection is back."
    : online === false ? "Can't reach the database. Sales are kept on this device until it's back." : "";
}

function savePending() {
  writeStore(PENDING_SALES_KEY, pendingSales);
  renderStatus();
}

let flushing = false;
async function flushPending() {
  if (flushing || !pendingSales.length) return;
  flushing = true;
  let uploaded = 0;
  try {
    while (pendingSales.length) {
      try {
        await PosApi.insertSale(pendingSales[0]);
      } catch (err) {
        console.error("Failed to upload saved sale:", err);
        if (isNetworkError(err)) setOnline(false);
        else toast(`A saved sale couldn't upload. ${describeError(err)}`, "error", 8000);
        break;
      }
      pendingSales.shift();
      uploaded += 1;
      savePending();
      setOnline(true);
    }
  } finally {
    flushing = false;
    renderStatus();
  }
  if (uploaded && !pendingSales.length) toast(`${plural(uploaded, "saved sale")} uploaded ✓`, "success");
}

async function checkConnection() {
  if (!vendor) return;
  refreshPendingOrders();
  flushPaidPendingOrders();
  if (pendingSales.length) return flushPending();
  try {
    await PosApi.ping();
    setOnline(true);
  } catch {
    setOnline(false);
  }
}

// ---------- Menu ----------

function normaliseProduct(p) {
  // stock_qty / sale_price stay undefined on a database without their
  // migration; sale_price is null when the item has no discount.
  return {
    ...p, price: Number(p.price), cost: Number(p.cost || 0),
    stock_qty: p.stock_qty === undefined || p.stock_qty === null ? undefined : Number(p.stock_qty),
    sale_price: p.sale_price === undefined ? undefined : p.sale_price === null ? null : Number(p.sale_price),
  };
}

// A cart line charges the regular price until the cashier taps "Discount" on
// it; a discounted line charges the discount price and remembers the regular
// price for the receipt and reports. "line" tells the two apart in the cart.
function cartLine(product, qty, discounted = false) {
  const d = discounted && hasDiscount(product);
  return {
    ...product, line: `${product.id}${d ? ":d" : ""}`, discounted: d,
    regular_price: product.price, price: d ? sellingPrice(product) : product.price, qty,
  };
}

// Add qty to the cart line for this product and price, merging with an
// existing line at the same price.
function putInCart(product, qty, discounted) {
  const line = cartLine(product, qty, discounted);
  const existing = cart.find(i => i.line === line.line);
  if (existing) existing.qty += qty;
  else cart.push(line);
}

// Load the shared menu from Supabase; fall back to the cached copy if offline.
async function loadProducts() {
  try {
    const rows = await PosApi.fetchProducts();
    products = rows.map(normaliseProduct);
    writeStore(PRODUCTS_CACHE_KEY, products);
    setOnline(true);
  } catch (err) {
    console.error("Failed to load products:", err);
    setOnline(false);
    if (!products.length) {
      toast("Couldn't load the menu and there's no saved copy on this device. Check the connection and reload.", "error", 10000);
    }
  }
  menuLoaded = true;
  // Keep every open order's lines in step with menu edits; drop deleted items.
  for (const order of orders) {
    const lines = order.id === activeOrderId ? cart : order.cart;
    cart = [];
    for (const item of lines) {
      const p = products.find(x => x.id === item.id);
      if (p) putInCart(p, item.qty, item.discounted);
    }
    order.cart = cart;
  }
  cart = activeOrder().cart;
  renderAll();
}

function renderCategories() {
  const counts = new Map();
  products.forEach(p => counts.set(p.category, (counts.get(p.category) || 0) + 1));
  const categories = [["All", products.length], ...counts];
  $("categoryFilters").innerHTML = categories.map(([category, n]) => `
    <button class="category-btn ${activeCategory === category ? "active" : ""}" role="tab"
      aria-selected="${activeCategory === category}" data-category="${escapeHtml(category)}">
      ${escapeHtml(category)} <span class="count">${n}</span>
    </button>
  `).join("");
}

function renderProducts() {
  const query = $("searchInput").value.trim().toLowerCase();
  const inCart = new Map();
  cart.forEach(i => inCart.set(i.id, (inCart.get(i.id) || 0) + i.qty));
  const filtered = products.filter(product => {
    const matchesCategory = activeCategory === "All" || product.category === activeCategory;
    const matchesSearch = !query || product.name.toLowerCase().includes(query) ||
      product.category.toLowerCase().includes(query);
    return matchesCategory && matchesSearch;
  });

  let empty = "";
  if (!menuLoaded) {
    empty = `<div class="empty-state"><div class="spinner"></div><span>Loading menu…</span></div>`;
  } else if (!products.length) {
    empty = `<div class="empty-state"><div class="empty-icon">🍽️</div><strong>No menu items yet</strong>
      <button class="primary" type="button" data-action="open-manage">＋ Add your first item</button></div>`;
  } else if (!filtered.length) {
    empty = `<div class="empty-state"><div class="empty-icon">🔍</div><strong>No matching items</strong>
      <button class="secondary" type="button" data-action="clear-search">Show all items</button></div>`;
  }

  $("productGrid").innerHTML = empty || filtered.map(product => {
    const qty = inCart.get(product.id);
    const onSale = hasDiscount(product);
    return `
    <button class="product-card ${qty ? "in-cart" : ""} ${onSale ? "on-sale" : ""}" data-id="${escapeHtml(product.id)}"
      aria-label="Add ${escapeHtml(product.name)}, ${money(product.price)}${onSale ? ", discount available" : ""}${qty ? `, ${qty} in order` : ""}">
      ${onSale ? `<span class="sale-badge">🏷️ Discount</span>` : ""}
      ${qty ? `<span class="qty-badge">${qty}</span>` : ""}
      <div class="product-emoji">${escapeHtml(product.emoji || "🍽️")}</div>
      <span class="product-name">${escapeHtml(product.name)}</span>
      <span class="product-category">${escapeHtml(product.category)}</span>
      <span class="product-price">${money(product.price)}</span>
    </button>`;
  }).join("");
}

// ---------- Cart ----------

function addToCart(id) {
  const product = products.find(p => p.id === id);
  if (!product) return;
  putInCart(product, 1, false); // regular price until "Discount" is tapped
  renderCart();
  renderProducts();
  const card = document.querySelector(`.product-card[data-id="${CSS.escape(id)}"]`);
  if (card) card.classList.add("bump");
}

function updateQty(line, change) {
  const item = cart.find(i => i.line === line);
  if (!item) return;
  item.qty += change;
  if (item.qty <= 0) cart = cart.filter(i => i !== item);
  renderCart();
  renderProducts();
}

// Switch a whole cart line between the regular and the discount price.
function toggleLineDiscount(line) {
  const item = cart.find(i => i.line === line);
  const product = item && products.find(p => p.id === item.id);
  if (!product) return;
  cart = cart.filter(i => i !== item);
  putInCart(product, item.qty, !item.discounted);
  renderCart();
}

function clearCart() {
  cart = [];
  $("cashReceived").value = "";
  renderCart();
  renderProducts();
}

// ---------- Open (held) orders ----------
// Several orders can be open at once; one is on screen. Each keeps its own
// lines, payment method and cash typed. They're saved on this till so a
// reload doesn't lose them.

let orders = [];
let activeOrderId = "";

function blankOrder(no) {
  return { id: newId(), no, cart: [], paymentMethod: "Cash", cash: "" };
}

function activeOrder() {
  return orders.find(o => o.id === activeOrderId);
}

function nextOrderNo() {
  const counter = orders.filter(o => !o.tableId);
  return counter.length ? Math.max(...counter.map(o => o.no)) + 1 : 1;
}

function restoreOrders() {
  const saved = readStore(OPEN_ORDERS_KEY, null);
  const list = saved && Array.isArray(saved.orders) ? saved.orders.filter(o => o && o.id && Array.isArray(o.cart)) : [];
  orders = list.length ? list : [blankOrder(1)];
  activeOrderId = orders.some(o => o.id === saved?.active) ? saved.active : orders[0].id;
}

// Copy what's on screen into the active order and save all open orders.
function saveOrders() {
  const order = activeOrder();
  if (order) {
    order.cart = cart;
    order.paymentMethod = paymentMethod;
    order.cash = $("cashReceived").value;
  }
  writeStore(OPEN_ORDERS_KEY, { orders, active: activeOrderId });
}

function showActiveOrder() {
  const order = activeOrder();
  cart = order.cart;
  $("cashReceived").value = order.cash || "";
  setPaymentMethod(order.paymentMethod || "Cash");
  renderCart();
  renderProducts();
}

function switchOrder(id) {
  if (saving || id === activeOrderId || !orders.some(o => o.id === id)) return;
  saveOrders();
  // An empty order is dropped when you leave it.
  const leaving = activeOrder();
  if (leaving && !leaving.cart.length) orders = orders.filter(o => o !== leaving);
  activeOrderId = id;
  showActiveOrder();
}

function newOrder() {
  if (saving) return;
  saveOrders();
  const current = activeOrder();
  if (!current.cart.length) {
    toast("This order is empty: add items to it, or switch to another order.", "info");
    return;
  }
  const order = blankOrder(nextOrderNo());
  orders.push(order);
  activeOrderId = order.id;
  showActiveOrder();
  toast(`Order #${current.no} kept. Started order #${order.no}.`, "success");
}

// The active order is paid or cancelled: remove it and show an empty order
// (reusing one that's already open), keeping the other held orders.
function closeActiveOrder() {
  orders = orders.filter(o => o.id !== activeOrderId);
  const empty = orders.find(o => !o.cart.length && !o.tableId);
  const next = empty || blankOrder(nextOrderNo());
  if (!empty) orders.push(next);
  activeOrderId = next.id;
  showActiveOrder();
}

function renderOrderTabs() {
  const tabs = orders.filter(o => !o.tableId).map(o => {
    const lines = o.id === activeOrderId ? cart : o.cart;
    const count = lines.reduce((sum, i) => sum + i.qty, 0);
    const active = o.id === activeOrderId;
    return `
    <button type="button" class="order-tab ${active ? "active" : ""} ${o.name ? "named" : ""}" role="tab" aria-selected="${active}" data-order="${escapeHtml(o.id)}">
      <strong>${o.name ? `🕒 ${escapeHtml(o.name)}` : `#${o.no}`}</strong>
      <span>${count ? `${plural(count, "item")} · ${money(calcTotals(lines).total)}` : "Empty"}</span>
    </button>`;
  }).join("");
  $("orderTabs").innerHTML = tabs +
    `<button type="button" class="order-tab new" id="newOrderTabBtn" title="Keep this order and start another">＋ New order</button>` +
    `<button type="button" class="order-tab pending-tab" id="pendingTabBtn" title="Unpaid orders saved under a name">🕒 Pending${namedPending().length ? ` · ${namedPending().length}` : ""}</button>`;
  const order = activeOrder();
  $("orderTabs").hidden = Boolean(order.tableId); // a table's order has no tabs
  $("orderContextTitle").textContent = order.tableId ? `🪑 ${order.name}` : "🥡 Counter / Takeaway";
  const counterOrders = orders.filter(o => !o.tableId).length;
  $("orderTitle").textContent = order.tableId ? `🪑 ${order.name}` : order.name ? `🕒 ${order.name}`
    : counterOrders > 1 ? `Order #${order.no}` : "Current Order";
  $("payLaterBtn").hidden = !cart.length;
  $("payLaterBtn").textContent = order.tableId ? "🕒 Pay later · move to a name"
    : order.pendingId ? `🕒 Update ${order.name}'s pending order (pay later)` : "🕒 Pay later · save under a name";
}

function renderCart() {
  const count = cart.reduce((sum, item) => sum + item.qty, 0);
  const t = calcTotals(cart);
  const others = orders.filter(o => !o.tableId).length - 1;
  $("itemCount").textContent = plural(count, "item") +
    (!activeOrder().tableId && others > 0 ? ` · ${plural(others, "other order")} open` : "");
  $("clearCartBtn").hidden = !cart.length;
  $("clearCartBtn").textContent = activeOrder().tableId ? "Clear table"
    : activeOrder().pendingId ? "Close here" : orders.length > 1 ? "Cancel order" : "Clear all";
  renderOrderTabs();
  saveOrders();
  if (activeOrder().tableId) scheduleTableSave(activeOrder());

  $("cartItems").innerHTML = cart.length ? cart.map(item => `
    <div class="cart-row">
      <div class="cart-emoji" aria-hidden="true">${escapeHtml(item.emoji || "🍽️")}</div>
      <div class="cart-info">
        <h4>${escapeHtml(item.name)}</h4>
        <small>${money(item.price)} each${item.discounted
          ? ` <s class="was-price">${money(item.regular_price)}</s> <span class="sale-tag">🏷️ ${discountPercent(item.regular_price, item.price)}% off</span>` : ""}</small>
        ${hasDiscount({ ...item, price: item.regular_price }) ? `<button type="button" class="price-toggle ${item.discounted ? "on" : ""}" data-line="${escapeHtml(item.line)}"
          aria-pressed="${item.discounted}">${item.discounted ? "↩ Regular price" : "🏷️ Discount"}</button>` : ""}
      </div>
      <div class="qty-controls">
        <button class="qty-btn ${item.qty === 1 ? "remove" : ""}" data-line="${escapeHtml(item.line)}" data-change="-1"
          aria-label="${item.qty === 1 ? "Remove" : "One less"} ${escapeHtml(item.name)}">${item.qty === 1 ? "🗑" : "−"}</button>
        <span class="qty">${item.qty}</span>
        <button class="qty-btn" data-line="${escapeHtml(item.line)}" data-change="1" aria-label="One more ${escapeHtml(item.name)}">＋</button>
      </div>
      <strong class="line-total">${money(item.price * item.qty)}</strong>
    </div>
  `).join("") : `
    <div class="empty-state">
      <div class="empty-icon">🛒</div>
      <strong>No items yet</strong>
      <span>Tap a menu item to add it</span>
    </div>`;

  $("total").textContent = money(t.total);
  $("mobileCartCount").textContent = plural(count, "item") + (orders.length > 1 ? ` · #${activeOrder().no}` : "");
  $("mobileCartTotal").textContent = money(t.total);
  updateMobileBar();
  renderQuickCash();
  updateChange();
}

function renderQuickCash() {
  const total = calcTotals(cart).total;
  const options = quickCashOptions(total);
  $("quickCash").innerHTML = options.map((value, i) => `
    <button type="button" class="chip" data-cash="${value}">${i === 0 ? "Exact" : money(value).replace("MVR ", "")}</button>
  `).join("");
}

// Updates the change line and the pay button together, since whether the
// sale can be paid depends on the cash typed.
function updateChange() {
  const total = calcTotals(cart).total;
  const raw = $("cashReceived").value;
  const received = Number(raw || 0);
  const row = $("changeRow");
  let payable = cart.length > 0;

  row.className = "change-row";
  $("changeLabel").textContent = "Change to give";
  $("changeDue").textContent = money(0);

  if (paymentMethod === "Cash" && cart.length && raw !== "") {
    if (received < total) {
      row.classList.add("short");
      $("changeLabel").textContent = "⚠️ Short by";
      $("changeDue").textContent = money(total - received);
      payable = false;
    } else {
      row.classList.add("ok");
      $("changeDue").textContent = money(received - total);
    }
  }

  document.querySelectorAll("#quickCash .chip").forEach(chip => {
    chip.classList.toggle("active", raw !== "" && Number(chip.dataset.cash) === received);
  });

  const payBtn = $("payBtn");
  payBtn.disabled = saving || !payable;
  if (saving) payBtn.textContent = "Saving…";
  else if (!cart.length) payBtn.textContent = "Add items to start";
  else if (!payable) payBtn.textContent = "Not enough cash";
  else payBtn.textContent = `Charge ${money(total)} · ${paymentMethod}${testModeUntil() ? " · TEST" : ""}`;
}

function setPaymentMethod(method) {
  paymentMethod = method;
  document.querySelectorAll(".payment").forEach(b => {
    const active = b.dataset.method === method;
    b.classList.toggle("active", active);
    b.setAttribute("aria-checked", String(active));
  });
  $("cashSection").hidden = method !== "Cash";
  updateChange();
  if (activeOrder()) saveOrders();
}

function updateMobileBar() {
  const bar = $("mobileCartBar");
  bar.hidden = !cart.length || cartInView;
}

let cartInView = false;
if ("IntersectionObserver" in window) {
  new IntersectionObserver(entries => {
    cartInView = entries[0].isIntersecting;
    updateMobileBar();
  }, { threshold: 0.25 }).observe($("cartPanel"));
}

// ---------- Payment ----------

async function processPayment() {
  if (!cart.length || saving) return;
  const t = calcTotals(cart);
  const raw = $("cashReceived").value;
  // Blank cash received means the customer paid the exact amount.
  const received = paymentMethod === "Cash" ? (raw === "" ? t.total : Number(raw)) : null;
  if (paymentMethod === "Cash" && received < t.total) {
    toast(`Cash received must be at least ${money(t.total)}.`, "error");
    $("cashReceived").focus();
    return;
  }

  const sale = {
    id: newId(),
    created_at: new Date().toISOString(),
    sale_date: localDateKey(),
    payment_method: paymentMethod,
    subtotal: t.subtotal,
    tax: t.tax,
    total: t.total,
    items: cartToItems(cart),
  };

  saving = true;
  updateChange();
  let uploaded = true;
  try {
    await PosApi.insertSale(sale);
    setOnline(true);
  } catch (err) {
    console.error("Failed to save sale:", err);
    if (!isNetworkError(err)) {
      saving = false;
      updateChange();
      toast(`The sale was not saved. ${describeError(err)}`, "error", 8000);
      return; // keep cart intact — nothing lost
    }
    // No connection: keep the sale on this device and upload it later.
    pendingSales.push(sale);
    savePending();
    setOnline(false);
    uploaded = false;
  }
  saving = false;

  const paidOrder = activeOrder();
  if (paidOrder.tableId) cancelTableSave(paidOrder);
  showReceipt(sale, received, uploaded);
  closeActiveOrder();
  if (paidOrder.pendingId) removePaidPendingOrder(paidOrder.pendingId);
  if (paidOrder.tableId) showTables(); // the table is free again
}

// ---------- Pay later: named pending orders shared by every till ----------

// Pending orders saved under a name (not a table's open order).
function namedPending() {
  return pendingOrders.filter(p => !p.table_id);
}

let pendingOrders = [];
let pendingFailed = false;
let pendingDeletes = []; // set at login

async function refreshPendingOrders() {
  try {
    pendingOrders = await PosApi.fetchPendingOrders();
    pendingFailed = false;
  } catch (err) {
    console.error("Failed to load pending orders:", err);
    pendingFailed = describeError(err);
  }
  // Paid on this till but not yet removed (offline): keep them out of the list.
  pendingOrders = pendingOrders.filter(p => !pendingDeletes.includes(p.id));
  renderOrderTabs();
  if ($("pendingDialog").open) renderPendingList();
  if (document.body.classList.contains("tables-mode")) renderTables();
}

// A paid pay-later order leaves the shared list. If the till is offline it's
// remembered and removed once the connection is back.
async function removePaidPendingOrder(id) {
  pendingDeletes = [...new Set([...pendingDeletes, id])];
  writeStore(PENDING_DELETES_KEY, pendingDeletes);
  pendingOrders = pendingOrders.filter(p => p.id !== id);
  renderOrderTabs();
  await flushPaidPendingOrders();
}

async function flushPaidPendingOrders() {
  for (const id of [...pendingDeletes]) {
    try {
      await PosApi.deletePendingOrder(id);
    } catch (err) {
      console.error("Couldn't remove paid pending order:", err);
      return;
    }
    pendingDeletes = pendingDeletes.filter(x => x !== id);
    writeStore(PENDING_DELETES_KEY, pendingDeletes);
  }
}

function openPayLater() {
  if (!cart.length || saving) return;
  const order = activeOrder();
  // Opened from the Pending list: save straight back into the same order.
  if (order.pendingId && !order.tableId) return savePayLater(order.name);
  $("payLaterName").value = order.tableId ? "" : order.name || "";
  $("pendingPicks").innerHTML = order.pendingId && !order.tableId ? "" : namedPending().map(p =>
    `<button type="button" class="chip" data-pick="${escapeHtml(p.name)}">＋ ${escapeHtml(p.name)}</button>`).join("");
  const count = cart.reduce((sum, i) => sum + i.qty, 0);
  $("payLaterSummary").textContent = `${plural(count, "item")} · ${money(calcTotals(cart).total)}` +
    (order.pendingId && !order.tableId ? "" : namedPending().length ? " · tap a name above to add to their pending order" : "");
  $("payLaterDialog").showModal();
  $("payLaterName").focus();
}

async function savePayLater(knownName) {
  const name = (typeof knownName === "string" ? knownName : $("payLaterName").value).trim().replace(/\s+/g, " ");
  if (!name) {
    toast("Please type a name, e.g. Mippe Boss.", "error");
    $("payLaterName").focus();
    return;
  }
  const order = activeOrder();
  const items = toPendingItems(cart);
  const btn = $("savePayLaterBtn");
  btn.disabled = true;
  let message;
  if (order.tableId) cancelTableSave(order);
  try {
    const now = new Date().toISOString();
    const same = namedPending().find(p => p.id !== order.pendingId && p.name.toLowerCase() === name.toLowerCase());
    if (order.tableId && !same) {
      // A table's order moves to a name; the table becomes free.
      if (order.savedRow) await PosApi.deletePendingOrder(order.pendingId);
      await PosApi.insertPendingOrder({ id: newId(), name, items, updated_at: now });
      message = `Moved ${order.name}'s order to ${name} (pay later) ✓ · ${order.name} is free`;
    } else if (order.pendingId && !same) {
      // Brought back from the pending list: save its lines (and any new name).
      const found = await PosApi.updatePendingOrder(order.pendingId, { name, items, updated_at: now });
      if (!found) await PosApi.insertPendingOrder({ id: order.pendingId, name, items, updated_at: now });
      message = `Updated ${name}'s pending order ✓`;
    } else if (same) {
      // That name already has a pending order: add these items to it.
      if (!confirm(`"${same.name}" already has a pending order. Add these items to it?`)) {
        btn.disabled = false;
        return;
      }
      await PosApi.updatePendingOrder(same.id, { items: mergePendingItems(same.items || [], items), updated_at: now });
      if (order.pendingId && order.pendingId !== same.id && (!order.tableId || order.savedRow)) await PosApi.deletePendingOrder(order.pendingId);
      message = `Added to ${same.name}'s pending order ✓`;
    } else {
      await PosApi.insertPendingOrder({ id: newId(), name, items, updated_at: now });
      message = `Saved ${name}'s order as pending ✓`;
    }
  } catch (err) {
    console.error("Failed to save pending order:", err);
    toast(`Couldn't save the pending order. ${describeError(err)}`, "error", 8000);
    btn.disabled = false;
    return;
  }
  btn.disabled = false;
  if ($("payLaterDialog").open) $("payLaterDialog").close();
  closeActiveOrder();
  if (order.tableId) showTables();
  toast(message, "success");
  await refreshPendingOrders();
}

function openPendingList() {
  $("pendingDialog").showModal();
  renderPendingList();
  refreshPendingOrders();
}

function renderPendingList() {
  const notice = $("pendingNotice");
  notice.hidden = !pendingFailed;
  notice.innerHTML = pendingFailed ? `<div class="notice error">⚠️ Couldn't load pending orders. ${escapeHtml(pendingFailed)}</div>` : "";
  const openHere = new Set(orders.map(o => o.pendingId).filter(Boolean));
  $("pendingList").innerHTML = namedPending().length ? namedPending().map(p => {
    const sum = pendingSummary(p.items, products);
    const lines = (p.items || []).map(l => `${l.qty}× ${l.name}${l.discounted ? " 🏷️" : ""}`).join(", ");
    const when = new Date(p.updated_at || p.created_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    return `
    <div class="pending-row ${openHere.has(p.id) ? "here" : ""}">
      <div>
        <strong>🕒 ${escapeHtml(p.name)}</strong>
        <small>${escapeHtml(lines)}</small>
        <small>${plural(sum.count, "item")} · saved ${escapeHtml(when)}${sum.missing ? ` · ${plural(sum.missing, "item")} no longer on the menu` : ""}${openHere.has(p.id) ? " · open on this till" : ""}</small>
      </div>
      <div class="total">${money(sum.total)}</div>
      <div class="pending-actions">
        <button type="button" class="small-btn delete" data-pending-delete="${escapeHtml(p.id)}">🗑 Delete</button>
        <button type="button" class="primary" data-pending-open="${escapeHtml(p.id)}">Open to add items / pay</button>
      </div>
    </div>`;
  }).join("") : `<div class="empty-state small"><span>No pending orders. Use "🕒 Pay later" on an order to save one under a name.</span></div>`;
}

// Bring a pending order onto this till as an open order tab.
function openPendingOrder(id) {
  const p = pendingOrders.find(x => x.id === id);
  if (!p) return;
  $("pendingDialog").close();
  showOrderView();
  const here = orders.find(o => o.pendingId === id);
  if (here) return switchOrder(here.id);
  saveOrders();
  cart = [];
  let dropped = 0;
  for (const line of p.items || []) {
    const product = products.find(x => x.id === line.id);
    if (product) putInCart(product, line.qty, line.discounted);
    else dropped += line.qty;
  }
  const lines = cart;
  const current = activeOrder();
  const order = current && !current.cart.length && !current.pendingId && !current.tableId ? current : blankOrder(nextOrderNo());
  Object.assign(order, { cart: lines, name: p.name, pendingId: p.id });
  if (order !== current) orders.push(order);
  if (current && current !== order && !current.cart.length) orders = orders.filter(o => o !== current);
  activeOrderId = order.id;
  showActiveOrder();
  toast(`Opened ${p.name}'s order. Add items, then pay or tap "Pay later" again.` +
    (dropped ? ` (${plural(dropped, "item")} no longer on the menu left out)` : ""), "info", 6000);
}

async function deletePendingEntry(id) {
  if (!isAdmin()) return;
  const p = pendingOrders.find(x => x.id === id);
  if (!p || !confirm(`Delete ${p.name}'s pending order? It hasn't been paid.`)) return;
  try {
    await PosApi.deletePendingOrder(id);
  } catch (err) {
    console.error("Failed to delete pending order:", err);
    toast(`Couldn't delete the pending order. ${describeError(err)}`, "error", 8000);
    return;
  }
  // Unlink it from an open tab on this till, so paying later doesn't touch it.
  orders.forEach(o => { if (o.pendingId === id) { delete o.pendingId; delete o.name; } });
  saveOrders();
  toast(`Deleted ${p.name}'s pending order`, "info");
  await refreshPendingOrders();
  renderCart();
}

function showReceipt(sale, received, uploaded) {
  const time = new Date(sale.created_at).toLocaleString("en-GB", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
  const lines = sale.items.map(item => `
    <div class="r-line"><span>${item.qty} × ${escapeHtml(item.name)}${item.regular_price > item.price
      ? ` <small class="r-discount">(${discountPercent(item.regular_price, item.price)}% off ${money(item.regular_price)})</small>` : ""}</span><span>${money(item.price * item.qty)}</span></div>
  `).join("");
  const saved = PosCore.round2(sale.items.reduce((sum, item) =>
    sum + (item.regular_price > item.price ? (item.regular_price - item.price) * item.qty : 0), 0));
  const cash = sale.payment_method === "Cash" ? `
    <div class="r-line"><span>Cash received</span><span>${money(received)}</span></div>
    <div class="r-line r-change"><span>Change</span><strong>${money(received - sale.total)}</strong></div>` : "";

  $("receiptBody").innerHTML = `
    <div class="r-head"><strong>${escapeHtml(vendor ? vendor.name : "Brewzy")}</strong><span>${escapeHtml(time)}</span></div>
    ${lines}
    <div class="r-line r-total"><span>Total</span><strong>${money(sale.total)}</strong></div>
    ${saved > 0 ? `<div class="r-line r-saved"><span>🏷️ You saved</span><strong>${money(saved)}</strong></div>` : ""}
    <div class="r-line"><span>Paid by</span><span>${escapeHtml(sale.payment_method)}</span></div>
    ${cash}
    ${isTestSale(sale) ? `<div class="notice warn">🧪 Test sale: it shows in reports until the Expo opens, then it's cleared.</div>` : ""}
    ${uploaded ? "" : `<div class="notice warn">⏳ No internet. The sale is saved on this device and will upload automatically when the connection is back.</div>`}
  `;
  $("receiptDialog").showModal();
  $("newOrderBtn").focus();
}

// ---------- Manage items ----------

function openManageItems() {
  if (!isAdmin()) return;
  resetItemForm(false);
  $("manageSearch").value = "";
  renderManageList();
  $("itemDialog").showModal();
  $("itemName").focus();
}

function renderManageList() {
  const query = $("manageSearch").value.trim().toLowerCase();
  const editingId = $("editingId").value;
  const list = products.filter(p => !query || p.name.toLowerCase().includes(query) ||
    p.category.toLowerCase().includes(query));
  $("manageCount").textContent = `(${products.length})`;

  $("categoryOptions").innerHTML = [...new Set(products.map(p => p.category))]
    .map(c => `<option value="${escapeHtml(c)}"></option>`).join("");

  $("manageItemList").innerHTML = list.length ? list.map(product => {
    const m = margin(product.price, product.cost);
    const profitChip = product.cost > 0
      ? `<span class="chip-tag ${m.profit < 0 ? "loss" : "gain"}">${m.profit < 0 ? "▼" : "▲"} ${money(m.profit)} · ${m.percent.toFixed(0)}%</span>`
      : `<span class="chip-tag muted">No stock price</span>`;
    const tracked = tracksStock(product);
    const stockChip = product.stock_qty === undefined || !tracked ? ""
      : `<span class="chip-tag ${product.stock_qty > 0 ? "" : "warn"}">Qty ${product.stock_qty}</span>`;
    const onSale = hasDiscount(product);
    const saleChip = onSale
      ? `<span class="chip-tag sale">🏷️ ${discountPercent(product.price, product.sale_price)}% off · now ${money(product.sale_price)}</span>` : "";
    return `
    <div class="manage-row ${product.id === editingId ? "editing" : ""}">
      <div class="manage-emoji" aria-hidden="true">${escapeHtml(product.emoji || "🍽️")}</div>
      <div class="manage-info">
        <strong>${escapeHtml(product.name)}</strong>
        <small>${escapeHtml(product.category)} · Stock ${money(product.cost)} · Sell ${onSale
          ? `<s>${money(product.price)}</s> ${money(product.sale_price)}` : money(product.price)}</small>
        ${saleChip} ${profitChip} ${stockChip}
      </div>
      <div class="manage-actions">
        <button type="button" class="small-btn" data-edit="${escapeHtml(product.id)}">Edit</button>
        <button type="button" class="small-btn ${onSale ? "sale" : ""}" data-discount="${escapeHtml(product.id)}"
          aria-label="${onSale ? "Change the discount on" : "Add a discount to"} ${escapeHtml(product.name)}">🏷️ ${onSale ? "On sale" : "Discount"}</button>
        ${tracked ? `<button type="button" class="small-btn" data-discard="${escapeHtml(product.id)}" aria-label="Record discarded ${escapeHtml(product.name)}">Discard</button>` : ""}
        <button type="button" class="small-btn delete" data-delete="${escapeHtml(product.id)}" aria-label="Delete ${escapeHtml(product.name)}">🗑</button>
      </div>
    </div>`;
  }).join("") : `<div class="empty-state small"><span>${products.length ? "No items match." : "No items yet — add one on the left."}</span></div>`;
}

function renderEmojiPicks() {
  $("emojiPicks").innerHTML = EMOJI_PICKS.map(e =>
    `<button type="button" class="emoji-pick" data-emoji="${e}" aria-label="Use ${e}">${e}</button>`
  ).join("");
}

function updateMarginPreview() {
  const priceRaw = $("itemPrice").value;
  const costRaw = $("itemCost").value;
  const el = $("marginPreview");
  el.className = "margin-preview";
  if (priceRaw === "") {
    el.textContent = "Enter both prices to see the profit per item.";
    return;
  }
  if (costRaw === "") {
    el.textContent = "Add the stock price to track profit in reports.";
    return;
  }
  const m = margin(priceRaw, costRaw);
  if (m.profit < 0) {
    el.classList.add("loss");
    el.textContent = `⚠️ Selling below stock price: a loss of ${money(-m.profit)} on each one.`;
  } else {
    el.classList.add("gain");
    el.textContent = `Profit per item: ${money(m.profit)} (${m.percent.toFixed(1)}% margin)`;
  }
}

// ---------- Discount (in the Manage Items form) ----------

function updateDiscountPreview() {
  const priceRaw = $("itemPrice").value;
  const saleRaw = $("itemSalePrice").value.trim();
  const costRaw = $("itemCost").value;
  const price = Number(priceRaw);
  const sale = Number(saleRaw);
  const el = $("discountPreview");
  el.className = "discount-preview";
  $("removeDiscountBtn").hidden = saleRaw === "";
  $("discountBox").classList.toggle("active", saleRaw !== "");

  let on = false;
  if (saleRaw === "") {
    el.textContent = "";
  } else if (priceRaw === "" || !(price > 0)) {
    el.classList.add("loss");
    el.textContent = "Enter the selling price first.";
  } else if (!Number.isFinite(sale) || sale < 0) {
    el.classList.add("loss");
    el.textContent = "Please enter a valid discount price.";
  } else if (sale >= price) {
    el.classList.add("loss");
    el.textContent = `⚠️ The discount price must be lower than the selling price (${money(price)}).`;
  } else {
    on = true;
    const m = margin(sale, costRaw);
    const belowCost = costRaw !== "" && m.profit < 0;
    let profit = "";
    if (costRaw !== "") {
      profit = belowCost
        ? ` ⚠️ Below stock price: a loss of ${money(-m.profit)} on each one.`
        : ` Profit per item: ${money(m.profit)}.`;
    }
    el.classList.add(belowCost ? "loss" : "gain");
    el.textContent = `Was ${money(price)} → now ${money(sale)} (${discountPercent(price, sale)}% off). ` +
      `Customer saves ${money(price - sale)} on each one.${profit}`;
  }
  const state = $("discountState");
  state.textContent = on ? `${discountPercent(price, sale)}% off` : "Off";
  state.className = `chip-tag ${on ? "sale" : "muted"}`;

  document.querySelectorAll("#discountPicks .chip").forEach(chip => {
    chip.classList.toggle("active", on && priceAfterPercentOff(price, chip.dataset.percent) === PosCore.round2(sale));
  });
}

function pickDiscount(percent) {
  const price = Number($("itemPrice").value);
  if ($("itemPrice").value === "" || !(price > 0)) {
    toast("Enter the selling price first.", "error");
    $("itemPrice").focus();
    return;
  }
  $("itemSalePrice").value = priceAfterPercentOff(price, percent);
  updateDiscountPreview();
}

function removeDiscount() {
  $("itemSalePrice").value = "";
  updateDiscountPreview();
  if ($("editingId").value) toast("Discount removed. Tap Save Changes to keep this.", "info");
}

// Stock quantity and discards only apply to items outside the Expo tab.
function updateStockFields() {
  const tracked = tracksStock({ category: $("itemCategory").value });
  $("itemStockField").hidden = !tracked;
  $("noStockNote").hidden = tracked;
  const product = products.find(p => p.id === $("editingId").value);
  if (product && tracked) openDiscardPanel(product);
  else closeDiscardPanel();
}

function loadItemForEdit(id) {
  const product = products.find(p => p.id === id);
  if (!product) return;
  $("editingId").value = product.id;
  $("itemName").value = product.name;
  $("itemPrice").value = product.price;
  $("itemCost").value = product.cost || "";
  $("itemStock").value = product.stock_qty === undefined ? "" : product.stock_qty;
  $("itemSalePrice").value = hasDiscount(product) ? product.sale_price : "";
  $("itemCategory").value = product.category;
  $("itemEmoji").value = product.emoji || "";
  $("formTitle").textContent = `Editing: ${product.name}`;
  $("saveItemBtn").textContent = "Save Changes";
  $("resetFormBtn").hidden = false;
  $("itemForm").classList.add("editing");
  updateMarginPreview();
  updateDiscountPreview();
  renderManageList();
  updateStockFields();
  $("itemForm").scrollIntoView({ block: "nearest", behavior: "smooth" });
  $("itemName").focus();
}

function resetItemForm(focus = true) {
  ["editingId", "itemName", "itemPrice", "itemCost", "itemStock", "itemSalePrice", "itemCategory", "itemEmoji"]
    .forEach(id => { $(id).value = ""; });
  $("formTitle").textContent = "Add a new item";
  $("saveItemBtn").textContent = "Add Item";
  $("resetFormBtn").hidden = true;
  $("itemForm").classList.remove("editing");
  updateStockFields();
  updateMarginPreview();
  updateDiscountPreview();
  renderManageList();
  if (focus) $("itemName").focus();
}

async function saveItem() {
  const fields = {
    name: $("itemName").value.trim(),
    category: $("itemCategory").value.trim(),
    price: $("itemPrice").value,
    cost: $("itemCost").value,
    stock: $("itemStock").value.trim(),
    salePrice: $("itemSalePrice").value.trim(),
  };
  const editingId = $("editingId").value;
  if (!tracksStock(fields)) fields.stock = ""; // Expo items don't keep a stock quantity

  const error = productError(fields);
  if (error) {
    toast(error, "error");
    return;
  }
  const row = {
    name: fields.name,
    category: fields.category,
    price: Number(fields.price),
    cost: fields.cost === "" ? 0 : Number(fields.cost),
    emoji: $("itemEmoji").value.trim() || "🍽️",
  };
  // Left out when blank so items still save before the stock migration is run.
  if (fields.stock !== "") row.stock_qty = Number(fields.stock);
  // Same for the discount: only sent when one is set, or to clear one.
  const existing = products.find(p => p.id === editingId);
  if (fields.salePrice !== "") row.sale_price = Number(fields.salePrice);
  else if (existing && existing.sale_price !== undefined && existing.sale_price !== null) row.sale_price = null;

  const saveBtn = $("saveItemBtn");
  saveBtn.disabled = true;
  try {
    if (editingId) await PosApi.updateProduct(editingId, row);
    else await PosApi.insertProduct(row);
  } catch (err) {
    console.error("Failed to save product:", err);
    toast(`Couldn't save the item. ${describeError(err)}`, "error", 8000);
    saveBtn.disabled = false;
    return;
  }
  saveBtn.disabled = false;
  let note = "";
  if (typeof row.sale_price === "number") note = ` · now ${discountPercent(row.price, row.sale_price)}% off`;
  else if (row.sale_price === null) note = " · discount removed";
  toast(`${editingId ? "Updated" : "Added"} “${row.name}” ✓${note}`, "success");
  resetItemForm();
  await loadProducts(); // re-renders everything, including the manage list
}

async function deleteItem(id) {
  const product = products.find(p => p.id === id);
  if (!product || !confirm(`Delete "${product.name}" from the menu?\n\nPast sales of this item stay in the reports.`)) return;
  try {
    await PosApi.deleteProduct(id);
  } catch (err) {
    console.error("Failed to delete product:", err);
    toast(`Couldn't delete the item. ${describeError(err)}`, "error", 8000);
    return;
  }
  if ($("editingId").value === id) resetItemForm(false);
  toast(`Deleted “${product.name}”`, "info");
  await loadProducts();
}

// ---------- Discarded stock (per item, in the Manage Items form) ----------

const discardState = { productId: "", entries: [], loading: false, failed: false, token: 0 };

function openDiscardPanel(product) {
  $("discardPanel").hidden = false;
  if (discardState.productId === product.id) return; // already showing this item
  discardState.productId = product.id;
  resetDiscardForm();
  loadDiscards();
}

function closeDiscardPanel() {
  $("discardPanel").hidden = true;
  discardState.productId = "";
  discardState.entries = [];
  discardState.token += 1; // ignore any load still in flight
}

async function loadDiscards() {
  const productId = discardState.productId;
  const token = ++discardState.token;
  discardState.loading = true;
  discardState.failed = false;
  renderDiscardList();
  let entries = [];
  try {
    entries = await PosApi.fetchDiscardsForProduct(productId);
  } catch (err) {
    console.error("Failed to load discards:", err);
    discardState.failed = describeError(err);
  }
  if (token !== discardState.token) return;
  discardState.entries = entries;
  discardState.loading = false;
  renderDiscardList();
}

function renderDiscardList() {
  const product = products.find(p => p.id === discardState.productId);
  const editingId = $("discardEditingId").value;
  const { entries, loading, failed } = discardState;
  let html;
  if (loading) {
    html = `<div class="empty-state small"><span>Loading discards…</span></div>`;
  } else if (failed) {
    html = `<div class="notice error">⚠️ Couldn't load discards. ${escapeHtml(failed)}</div>`;
  } else if (!entries.length) {
    html = `<div class="empty-state small"><span>Nothing discarded for this item yet.</span></div>`;
  } else {
    const total = aggregateDiscards(entries);
    html = `<div class="discard-total">Total discarded: <strong>${total.qty}</strong> · Loss ${money(total.loss)}</div>` +
      entries.map(d => `
      <div class="discard-row ${d.id === editingId ? "editing" : ""}">
        <div>
          <strong>${d.qty} discarded</strong>
          <small>${escapeHtml(formatDay(d.discard_date, { weekday: "short", day: "numeric", month: "short", year: "numeric" }))}
            · Loss ${money(Number(d.cost || 0) * d.qty)}</small>
        </div>
        <div class="manage-actions">
          <button type="button" class="small-btn" data-discard-edit="${escapeHtml(d.id)}">Edit</button>
          <button type="button" class="small-btn delete" data-discard-delete="${escapeHtml(d.id)}" aria-label="Delete this discard">🗑</button>
        </div>
      </div>`).join("");
  }
  $("discardTitle").textContent = product ? `Discarded stock: ${product.name}` : "Discarded stock";
  $("discardList").innerHTML = html;
}

function updateDiscardPreview() {
  const el = $("discardPreview");
  const product = products.find(p => p.id === discardState.productId);
  const qty = Number($("discardQty").value);
  if (!product || !(qty > 0)) {
    el.textContent = "";
    return;
  }
  // An edited entry keeps the prices saved with it.
  const entry = discardState.entries.find(d => d.id === $("discardEditingId").value);
  const cost = entry ? Number(entry.cost || 0) : product.cost;
  const price = entry ? Number(entry.price || 0) : product.price;
  el.textContent = cost > 0
    ? `Loss ${money(cost * qty)} at stock price (would have sold for ${money(price * qty)})`
    : `No stock price set for this item, so the loss will show as ${money(0)}.`;
}

function resetDiscardForm() {
  $("discardEditingId").value = "";
  $("discardQty").value = "";
  $("discardDate").value = localDateKey();
  $("saveDiscardBtn").textContent = "Add discard";
  $("cancelDiscardBtn").hidden = true;
  updateDiscardPreview();
  renderDiscardList();
}

function loadDiscardForEdit(id) {
  const entry = discardState.entries.find(d => d.id === id);
  if (!entry) return;
  $("discardEditingId").value = entry.id;
  $("discardQty").value = entry.qty;
  $("discardDate").value = entry.discard_date;
  $("saveDiscardBtn").textContent = "Save discard";
  $("cancelDiscardBtn").hidden = false;
  updateDiscardPreview();
  renderDiscardList();
  $("discardQty").focus();
}

async function saveDiscard() {
  const product = products.find(p => p.id === discardState.productId);
  if (!product) return;
  const fields = { qty: $("discardQty").value.trim(), date: $("discardDate").value };
  const error = discardError(fields);
  if (error) {
    toast(error, "error");
    return;
  }
  const editingId = $("discardEditingId").value;
  const btn = $("saveDiscardBtn");
  btn.disabled = true;
  try {
    if (editingId) {
      await PosApi.updateDiscard(editingId, { qty: Number(fields.qty), discard_date: fields.date });
    } else {
      // Prices are saved with the discard so later price changes don't
      // rewrite past losses.
      await PosApi.insertDiscard({
        product_id: product.id,
        product_name: product.name,
        qty: Number(fields.qty),
        cost: product.cost,
        price: product.price,
        discard_date: fields.date,
      });
    }
  } catch (err) {
    console.error("Failed to save discard:", err);
    toast(`Couldn't save the discard. ${describeError(err)}`, "error", 8000);
    btn.disabled = false;
    return;
  }
  btn.disabled = false;
  toast(editingId ? "Discard updated ✓" : `Recorded ${fields.qty} discarded ${product.name} ✓`, "success");
  resetDiscardForm();
  await loadDiscards();
}

async function deleteDiscardEntry(id) {
  const entry = discardState.entries.find(d => d.id === id);
  if (!entry || !confirm(`Delete this record of ${entry.qty} discarded ${entry.product_name}?`)) return;
  try {
    await PosApi.deleteDiscard(id);
  } catch (err) {
    console.error("Failed to delete discard:", err);
    toast(`Couldn't delete the discard. ${describeError(err)}`, "error", 8000);
    return;
  }
  if ($("discardEditingId").value === id) resetDiscardForm();
  toast("Discard deleted", "info");
  await loadDiscards();
}

// ---------- Reports ----------

function formatDay(key, opts = { weekday: "short", day: "numeric", month: "short" }) {
  return parseDateKey(key).toLocaleDateString("en-GB", opts);
}

function openSalesReport() {
  if (!isAdmin()) return;
  report.showAllTransactions = false;
  markScope();
  resetBillForm();
  $("salesReportDialog").showModal();
  setPreset(report.preset === "custom" ? "today" : report.preset);
}

function setPreset(preset) {
  report.preset = preset;
  const range = dateRange(preset);
  $("reportFrom").value = range.from;
  $("reportTo").value = range.to;
  markPreset();
  loadReport();
}

// ---------- Main / Expo report switch ----------

function setScope(scope) {
  report.scope = scope;
  writeStore(REPORT_SCOPE_KEY, scope);
  report.showAllTransactions = false;
  markScope();
  applyScope();
  renderReport();
}

function markScope() {
  const expo = report.scope === "expo";
  document.querySelectorAll("#reportScope [data-scope]").forEach(b => {
    const active = b.dataset.scope === report.scope;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", String(active));
  });
  $("reportDialogBody").classList.toggle("expo", expo);
  $("reportTitle").textContent = expo ? "🎪 Expo Report" : "Sales Report";
  $("billsSection").hidden = !expo;
  $("stockSection").hidden = expo;
  // Expo shows Item cost and Prep bills; Average sale makes room for them.
  $("reportItemCostCard").hidden = !expo;
  $("reportCostCard").hidden = expo;
  $("expoTotalsSection").hidden = !expo;
}

function applyScope() {
  report.sales = scopeSales(report.allSales, report.scope);
}

function markPreset() {
  document.querySelectorAll("#rangePresets button").forEach(b => {
    b.classList.toggle("active", b.dataset.preset === report.preset);
  });
}

function reportRange() {
  const today = localDateKey();
  let from = $("reportFrom").value || today;
  let to = $("reportTo").value || from;
  if (from > to) [from, to] = [to, from];
  return { from, to };
}

async function loadReport() {
  const { from, to } = reportRange();
  const token = ++report.token;
  $("reportSubtitle").textContent = from === to
    ? formatDay(from, { weekday: "long", day: "numeric", month: "long", year: "numeric" })
    : `${formatDay(from, { day: "numeric", month: "short", year: "numeric" })} – ${formatDay(to, { day: "numeric", month: "short", year: "numeric" })}`;
  $("reportDialogBody").classList.add("loading");

  let sales = [];
  let failed = false;
  let discards = [];
  let discardsFailed = false;
  // Discards load separately so a database without the discards table
  // still shows the sales report.
  const discardsRequest = PosApi.fetchDiscardsInRange(from, to).catch(err => {
    console.error("Failed to load discards:", err);
    discardsFailed = describeError(err);
    return [];
  });
  // Bills load separately too, so the report works before their migration.
  let billsFailed = false;
  // Every Expo prep bill, whatever dates are picked: they cover the whole event.
  const billsRequest = PosApi.fetchExpensesInRange("2000-01-01", "2999-12-31", "Expo").catch(err => {
    console.error("Failed to load bills:", err);
    billsFailed = describeError(err);
    return [];
  });
  // The whole Expo's sales, for its totals against all prep bills.
  const period = expoPeriod();
  const expoSalesRequest = (period ? PosApi.fetchSalesInRange(period.from, period.to) : Promise.resolve([])).catch(err => {
    console.error("Failed to load Expo sales:", err);
    return null;
  });
  try {
    sales = await PosApi.fetchSalesInRange(from, to);
    setOnline(true);
  } catch (err) {
    console.error("Failed to load report:", err);
    failed = true;
    if (isNetworkError(err)) setOnline(false);
  }
  discards = await discardsRequest;
  const bills = await billsRequest;
  const expoSales = await expoSalesRequest;
  if (token !== report.token) return; // a newer request replaced this one
  report.discards = discards;
  report.discardsFailed = discardsFailed;
  report.bills = bills;
  report.billsFailed = billsFailed;

  // Include sales still waiting to upload from this till.
  const ids = new Set(sales.map(s => s.id));
  const waiting = pendingSales
    .filter(s => s.sale_date >= from && s.sale_date <= to && !ids.has(s.id))
    .map(s => ({ ...s, pending: true }));
  report.allSales = sales.concat(waiting).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  if (expoSales) {
    const expoIds = new Set(expoSales.map(s => s.id));
    report.expoSales = expoSales.concat(pendingSales.filter(s =>
      period && s.sale_date >= period.from && s.sale_date <= period.to && !expoIds.has(s.id)));
  } else {
    report.expoSales = null;
  }
  applyScope();
  report.failed = failed;
  $("reportDialogBody").classList.remove("loading");
  renderReport();
}

function renderReport() {
  const { from, to } = reportRange();
  const r = aggregateSales(report.sales, currentCost);

  $("reportTotal").textContent = money(r.grandTotal);
  $("reportDiscount").textContent = r.discountTotal > 0
    ? `🏷️ ${money(r.discountTotal)} discounts given on ${plural(r.discountedQty, "item")}` : "";
  const expo = report.scope === "expo";
  let profit = r.profitTotal;
  if (expo) {
    // For the picked dates: sales − item cost. Prep bills cover the whole
    // Expo, so they're only subtracted in the Whole Expo totals.
    profit = PosCore.round2(r.grandTotal - r.costTotal);
    $("reportProfitLabel").textContent = "Profit";
    $("reportProfit").textContent = signedMoney(profit);
    $("reportMargin").textContent = r.grandTotal
      ? `${((profit / r.grandTotal) * 100).toFixed(1)}% margin · sales − item cost` : "Sales − item cost";
    $("reportItemCost").textContent = money(r.costTotal);
    $("reportItemCostNote").textContent = r.itemsMissingCost
      ? `${plural(r.itemsMissingCost, "item")} sold without a cost price` : "Cost price × qty sold";
  } else {
    // With no buying prices at all, "profit" would just repeat total sales.
    const noCosts = r.itemCount > 0 && r.itemsMissingCost === r.itemCount;
    $("reportProfitLabel").textContent = "Profit";
    $("reportProfit").textContent = noCosts ? "Not tracked" : money(r.profitTotal);
    $("reportMargin").textContent = noCosts ? "No stock prices yet"
      : r.grandTotal ? `${r.marginPercent.toFixed(1)}% margin` : "";
    $("reportCostLabel").textContent = "Stock cost";
    $("reportCost").textContent = money(r.costTotal);
    $("reportCostNote").textContent = "";
  }
  $("reportTransactions").textContent = r.transactionCount;
  $("reportVoided").textContent = [r.voidedCount ? `${r.voidedCount} voided` : "",
    r.testCount ? `${r.testCount} test` : ""].filter(Boolean).join(" · ");
  $("reportItems").textContent = r.itemCount;
  $("reportAverage").textContent = money(r.averageSale);
  document.querySelector(".report-card.profit").classList.toggle("negative", profit < 0);

  const notices = [];
  if (report.failed) notices.push(["error", "⚠️ Couldn't load sales from the database. Check the connection. Only sales saved on this device are shown."]);
  const waiting = report.sales.filter(s => s.pending).length;
  if (waiting) notices.push(["warn", `⏳ Includes ${plural(waiting, "sale")} saved on this device that haven't uploaded yet.`]);
  if (r.testCount) notices.push(["info", `🧪 ${plural(r.testCount, "test sale")} made before the Expo opened (25 Oct, 16:00) ${r.testCount === 1 ? "is" : "are"} not counted.`]);
  const liveTests = report.sales.filter(s => s.testRun && !s.test && !s.voided).length;
  if (liveTests) notices.push(["warn", `🧪 Test mode: ${plural(liveTests, "test sale")} ${liveTests === 1 ? "is" : "are"} counted for now so you can check the report. At 16:00 ${liveTests === 1 ? "it's" : "they're"} cleared and the Expo starts from zero.`]);
  if (r.itemsMissingCost) notices.push(["info", `ℹ️ ${plural(r.itemsMissingCost, "item")} sold had no stock price, so the profit shown is higher than the real profit. Add stock prices in Manage Items.`]);
  const notice = $("reportNotice");
  notice.hidden = !notices.length;
  notice.innerHTML = notices.map(([cls, text]) => `<div class="notice ${cls}">${escapeHtml(text)}</div>`).join("");

  renderBestSellers(r);
  renderPaymentBreakdown(r);
  renderTimeChart(r, from, to);
  renderProductTable(r);
  if (expo) {
    renderExpoTotals();
    renderBills();
  } else {
    renderStockReport(r);
  }
  $("dayClosesSection").hidden = expo;
  if (!expo) loadDayCloses(from, to);
  renderTransactions();
}

// Signed money: "−MVR 5.00" for losses.
function signedMoney(value) {
  return `${value < 0 ? "−" : ""}${money(Math.abs(value))}`;
}

// One row per menu item (current stock and prices) plus any item that was
// discarded in the period but has since been removed from the menu.
function stockRows() {
  const stock = stockSummary(products.filter(tracksStock));
  const discards = aggregateDiscards(report.discards);
  const rows = stock.rows.map(row => {
    const d = discards.byProduct.get(row.name);
    return { ...row, discarded: d ? d.qty : 0, loss: d ? d.loss : 0, lostSales: d ? d.lostSales : 0 };
  });
  const onMenu = new Set(rows.map(r => r.name));
  for (const d of discards.byProduct.values()) {
    if (onMenu.has(d.name)) continue;
    rows.push({ name: d.name, qty: null, cost: null, price: null, difference: null,
      discarded: d.qty, loss: d.loss, lostSales: d.lostSales, removed: true });
  }
  return { stock, discards, rows };
}

function renderStockReport(r) {
  const { stock, discards, rows } = stockRows();
  const stockTracked = products.some(p => p.stock_qty !== undefined);

  $("stockQty").textContent = stockTracked ? stock.totalQty : "Not set up";
  $("stockValue").textContent = stockTracked ? `Worth ${money(stock.costValue)} at stock price` : "";
  $("stockDifference").textContent = stockTracked ? signedMoney(stock.difference) : "—";
  $("stockSellValue").textContent = stockTracked ? `Sells for ${money(stock.sellValue)}` : "";
  $("discardQtyTotal").textContent = discards.qty;
  $("discardCount").textContent = report.discards.length ? plural(report.discards.length, "record") : "";
  $("discardLoss").textContent = money(discards.loss);
  $("discardLostSales").textContent = discards.qty ? `Would have sold for ${money(discards.lostSales)}` : "";
  const net = PosCore.round2(r.profitTotal - discards.loss);
  $("netProfit").textContent = signedMoney(net);
  $("netProfit").classList.toggle("loss-text", net < 0);

  const notices = [];
  if (report.discardsFailed) notices.push(["error", `⚠️ Couldn't load discards. ${report.discardsFailed}`]);
  else if (!stockTracked && products.length) notices.push(["warn", "The database needs a one-time update for stock: run the migration SQL from the README."]);
  if (discards.qtyMissingCost) notices.push(["info", `ℹ️ ${plural(discards.qtyMissingCost, "discarded item")} had no stock price, so the discard loss shown is lower than the real loss.`]);
  const notice = $("stockNotice");
  notice.hidden = !notices.length;
  notice.innerHTML = notices.map(([cls, text]) => `<div class="notice ${cls}">${escapeHtml(text)}</div>`).join("");

  const { stockSortKey: key, stockSortDir: dir } = report;
  const val = row => (row[key] === null ? -Infinity : row[key]);
  rows.sort((a, b) => {
    const cmp = key === "name" ? a.name.localeCompare(b.name) : val(a) - val(b);
    return cmp * dir || a.name.localeCompare(b.name);
  });
  document.querySelectorAll("#stockTable th").forEach(th => {
    const active = th.dataset.sort === key;
    th.classList.toggle("sorted", active);
    th.setAttribute("aria-sort", active ? (dir > 0 ? "ascending" : "descending") : "none");
    th.dataset.arrow = active ? (dir > 0 ? "▲" : "▼") : "";
  });

  const cell = (value, fmt) => (value === null ? `<span class="muted">—</span>` : fmt(value));
  $("stockBody").innerHTML = rows.length ? rows.map(row => `
    <tr>
      <td>${escapeHtml(productFor(row.name)?.emoji || "🍽️")} ${escapeHtml(row.name)}${row.removed ? ` <span class="chip-tag muted">removed</span>` : ""}</td>
      <td>${cell(row.qty, q => (stockTracked ? q : "—"))}</td>
      <td>${cell(row.cost, money)}</td>
      <td>${cell(row.price, money)}</td>
      <td class="${row.difference < 0 ? "loss-text" : ""}">${cell(row.difference, signedMoney)}</td>
      <td>${row.discarded || ""}</td>
      <td class="${row.loss > 0 ? "loss-text" : ""}">${row.loss > 0 ? money(row.loss) : ""}</td>
    </tr>
  `).join("") : `<tr><td colspan="7" class="report-empty">${products.length
    ? "No items to track: Expo items don't keep stock. Items in other tabs show here." : "No menu items yet."}</td></tr>`;

  $("stockFoot").innerHTML = rows.length ? `
    <tr>
      <td>Total</td>
      <td>${stockTracked ? stock.totalQty : "—"}</td>
      <td>${stockTracked ? money(stock.costValue) : "—"}</td>
      <td>${stockTracked ? money(stock.sellValue) : "—"}</td>
      <td class="${stock.difference < 0 ? "loss-text" : ""}">${stockTracked ? signedMoney(stock.difference) : "—"}</td>
      <td>${discards.qty}</td>
      <td class="${discards.loss > 0 ? "loss-text" : ""}">${money(discards.loss)}</td>
    </tr>` : "";
}

function barRow({ rank, label, value, share, tip }) {
  return `
    <div class="bar-row" tabindex="0" data-tip="${escapeHtml(tip)}">
      ${rank ? `<span class="rank rank-${rank}">${rank}</span>` : ""}
      <span class="bar-label">${label}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(share, 0.5).toFixed(1)}%"></div></div>
      <span class="bar-value">${escapeHtml(value)}</span>
    </div>`;
}

function renderBestSellers(r) {
  const by = report.bestBy;
  const top = bestSellers(r.productRows, by, 5);
  const max = top.length ? top[0][by] : 0;
  const fmt = row => by === "qty" ? `${row.qty} sold` : money(row[by]);

  const soldNames = new Set(r.productRows.map(p => p.name));
  const inScope = p => tracksStock(p) !== (report.scope === "expo");
  const unsold = products.filter(p => inScope(p) && !soldNames.has(p.name)).map(p => p.name);

  $("bestSellers").innerHTML = top.length ? top.map((row, i) => barRow({
    rank: i + 1,
    label: `${escapeHtml(productFor(row.name)?.emoji || "🍽️")} ${escapeHtml(row.name)}`,
    value: fmt(row),
    share: max > 0 ? (row[by] / max) * 100 : 0,
    tip: `${row.name}: ${row.qty} sold · ${money(row.sales)} sales · ${money(row.profit)} profit`,
  })).join("") + (unsold.length && r.transactionCount ? `
    <p class="unsold"><strong>Not sold in this period:</strong> ${unsold.map(escapeHtml).join(", ")}</p>` : "")
    : `<div class="empty-state small"><span>No sales in this period.</span></div>`;
}

function renderPaymentBreakdown(r) {
  const methods = [["Cash", "💵"], ["Transfer", "📱"], ["Card", "💳"]];
  $("paymentBreakdown").innerHTML = methods.map(([m, icon]) => {
    const amount = r.paymentTotals[m] || 0;
    const count = r.paymentCounts[m] || 0;
    const share = r.grandTotal ? (amount / r.grandTotal) * 100 : 0;
    return barRow({
      label: `${icon} ${m} <small>${r.grandTotal ? `${share.toFixed(0)}%` : ""}</small>`,
      value: money(amount),
      share,
      tip: `${m}: ${money(amount)} from ${plural(count, "sale")} (${share.toFixed(1)}% of sales)`,
    });
  }).join("");
}

function renderTimeChart(r, from, to) {
  let points;
  let peakText = "";
  if (from === to) {
    $("timeChartTitle").textContent = "⏰ Sales by hour";
    const withSales = r.byHour.map((v, h) => (v > 0 ? h : -1)).filter(h => h >= 0);
    const lo = Math.min(7, ...withSales);
    const hi = Math.max(22, ...withSales);
    points = [];
    for (let h = lo; h <= hi; h++) {
      points.push({
        label: String(h).padStart(2, "0"),
        value: r.byHour[h],
        tip: `${String(h).padStart(2, "0")}:00–${String(h + 1).padStart(2, "0")}:00`,
      });
    }
    const peak = points.reduce((a, b) => (b.value > a.value ? b : a), points[0]);
    if (peak && peak.value > 0) peakText = `Busiest: ${peak.tip} (${money(peak.value)})`;
  } else {
    $("timeChartTitle").textContent = "📅 Sales by day";
    const totals = new Map(r.byDay.map(d => [d.date, d.total]));
    // Long ranges (e.g. All time) start at the first day with sales.
    const first = r.byDay.length && r.byDay[0].date > from ? r.byDay[0].date : from;
    points = [];
    for (let d = first; d <= to && points.length < 400; d = addDays(d, 1)) {
      points.push({
        label: String(parseDateKey(d).getDate()),
        value: totals.get(d) || 0,
        tip: formatDay(d, { weekday: "short", day: "numeric", month: "short", year: "numeric" }),
      });
    }
    const peak = points.reduce((a, b) => (b.value > a.value ? b : a), points[0]);
    if (peak && peak.value > 0) peakText = `Best day: ${peak.tip} (${money(peak.value)})`;
  }
  $("timeChartNote").textContent = peakText;

  const max = Math.max(0, ...points.map(p => p.value));
  const labelEvery = points.length > 16 ? Math.ceil(points.length / 12) : 1;
  const chart = $("timeChart");
  chart.setAttribute("aria-label", `${$("timeChartTitle").textContent.slice(2).trim()}. ${peakText || "No sales."}`);
  chart.innerHTML = max > 0 ? `
    <div class="col-gridline"><span>${money(max)}</span></div>
    <div class="cols">
      ${points.map((p, i) => `
        <div class="col" tabindex="0" data-tip="${escapeHtml(`${p.tip}: ${money(p.value)}`)}">
          <div class="col-bar-wrap"><div class="col-bar" style="height:${((p.value / max) * 100).toFixed(1)}%"></div></div>
          <span class="col-label">${i % labelEvery === 0 ? escapeHtml(p.label) : ""}</span>
        </div>`).join("")}
    </div>` : `<div class="empty-state small"><span>No sales in this period.</span></div>`;
}

// The discount price(s) an item sold at; otherwise its current discount
// price on the menu, or a dash when it has none.
function discountPriceCell(row) {
  if (row.discountPrices.length) return row.discountPrices.map(money).join(" / ");
  const p = productFor(row.name);
  return p && hasDiscount(p) ? `<span class="muted">${money(p.sale_price)}</span>` : `<span class="muted">—</span>`;
}

function renderProductTable(r) {
  const { sortKey, sortDir } = report;
  const rows = [...r.productRows].sort((a, b) => {
    const val = row => (sortKey === "discountPrice" ? row.discountPrices[0] || 0
      : sortKey === "unitCost" ? (row.qty ? row.cost / row.qty : 0) : row[sortKey]);
    const cmp = sortKey === "name" ? a.name.localeCompare(b.name) : val(a) - val(b);
    return cmp * sortDir || a.name.localeCompare(b.name);
  });
  document.querySelectorAll("#productTable th").forEach(th => {
    const active = th.dataset.sort === sortKey;
    th.classList.toggle("sorted", active);
    th.setAttribute("aria-sort", active ? (sortDir > 0 ? "ascending" : "descending") : "none");
    th.dataset.arrow = active ? (sortDir > 0 ? "▲" : "▼") : "";
  });
  const disc = (n, text) => (n ? `<strong class="sale-tag">${text}</strong>` : `<span class="muted">${text}</span>`);
  $("productSalesBody").innerHTML = rows.length ? rows.map(item => `
    <tr>
      <td>${escapeHtml(productFor(item.name)?.emoji || "🍽️")} ${escapeHtml(item.name)}</td>
      <td><strong>${item.qty}</strong></td>
      <td>${item.regularQty}</td>
      <td>${disc(item.discountQty, item.discountQty)}</td>
      <td>${discountPriceCell(item)}</td>
      <td>${disc(item.discountQty, money(item.discountSales))}</td>
      <td>${money(item.sales)}</td>
      <td class="col-cost">${item.cost > 0 ? money(PosCore.round2(item.cost / item.qty)) : `<span class="muted">Not set</span>`}</td>
      <td class="col-cost">${money(item.cost)}</td>
      <td class="col-cost ${item.profit < 0 ? "loss-text" : ""}">${item.profit < 0 ? "−" : ""}${money(Math.abs(item.profit))}</td>
    </tr>
  `).join("") : `<tr><td colspan="10" class="report-empty">No sales recorded for this period.</td></tr>`;

  $("productSalesFoot").innerHTML = rows.length ? `
    <tr>
      <td>Total</td>
      <td>${r.itemCount}</td>
      <td>${r.regularQty}</td>
      <td>${r.discountedQty}</td>
      <td></td>
      <td>${money(r.discountSales)}</td>
      <td>${money(r.grandTotal)}</td>
      <td class="col-cost"></td>
      <td class="col-cost">${money(r.costTotal)}</td>
      <td class="col-cost">${signedMoney(r.profitTotal)}</td>
    </tr>` : "";

  $("priceSplit").innerHTML = r.itemCount ? `
    <div class="split-box"><span>Sold at regular price</span><strong>${plural(r.regularQty, "item")}</strong><small>${money(r.regularSales)}</small></div>
    <div class="split-box disc"><span>🏷️ Sold at discount price</span><strong>${plural(r.discountedQty, "item")}</strong>
      <small>${money(r.discountSales)}${r.discountTotal > 0 ? ` · ${money(r.discountTotal)} given off` : ""}</small></div>` : "";
}

// ---------- Whole Expo totals ----------

// The whole Expo's sales against all its prep bills: the Expo's final profit.
function renderExpoTotals() {
  const period = expoPeriod();
  if (!period) {
    $("expoPeriodText").textContent = "";
    $("expoTotals").innerHTML = `<div class="empty-state small"><span>No Expo dates set for ${escapeHtml(vendor.name)}. Items in the Expo tab are still reported here.</span></div>`;
    return;
  }
  const fmt = key => formatDay(key, { day: "numeric", month: "short", year: "numeric" });
  $("expoPeriodText").textContent = `${fmt(period.from)} – ${fmt(period.to)} · all days together`;
  if (!report.expoSales) {
    $("expoTotals").innerHTML = `<div class="notice error">⚠️ Couldn't load the Expo's sales. Check the connection.</div>`;
    return;
  }
  const r = aggregateSales(scopeSales(report.expoSales, "expo"), currentCost);
  const bills = sumExpenses(report.bills);
  const profit = PosCore.round2(r.grandTotal - r.costTotal - bills);
  const box = (label, value, note, cls = "") =>
    `<div class="expo-total ${cls}"><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`;
  $("expoTotals").innerHTML =
    box("Expo sales", money(r.grandTotal), `${plural(r.transactionCount, "sale")} · ${plural(r.itemCount, "item")}`, "sales") +
    box("− Item cost", money(r.costTotal), r.itemsMissingCost ? `${plural(r.itemsMissingCost, "item")} without a cost price` : "Cost price × qty sold") +
    box("− Prep bills", money(bills), report.billsFailed ? "Couldn't load bills" : report.bills.length ? plural(report.bills.length, "bill") : "None added yet") +
    box("= Expo profit", signedMoney(profit),
      r.grandTotal ? `${((profit / r.grandTotal) * 100).toFixed(1)}% margin` : "", profit < 0 ? "profit negative" : "profit");
}

// ---------- Expo prep bills ----------

function renderBills() {
  const { bills, billsFailed } = report;
  const editingId = $("billEditingId").value;
  const notice = $("billNotice");
  notice.hidden = !billsFailed;
  notice.innerHTML = billsFailed ? `<div class="notice error">⚠️ Couldn't load bills. ${escapeHtml(billsFailed)}</div>` : "";
  $("billList").innerHTML = bills.length ? `
    <div class="bill-total"><span>${plural(bills.length, "bill")}</span><span>${money(sumExpenses(bills))}</span></div>` +
    bills.map(b => `
    <div class="bill-row ${b.id === editingId ? "editing" : ""}">
      <span class="bill-date">${escapeHtml(formatDay(b.expense_date, { weekday: "short", day: "numeric", month: "short" }))}</span>
      <span class="bill-what">${b.description ? escapeHtml(b.description) : `<span class="muted">—</span>`}</span>
      <strong>${money(b.amount)}</strong>
      <span class="manage-actions">
        <button type="button" class="small-btn" data-bill-edit="${escapeHtml(b.id)}">Edit</button>
        <button type="button" class="small-btn delete" data-bill-delete="${escapeHtml(b.id)}" aria-label="Delete this bill">🗑</button>
      </span>
    </div>`).join("")
    : `<div class="empty-state small"><span>No prep bills for these dates yet. Add each bill above.</span></div>`;
}

// New bills default to today, or the last day of the report when it ends earlier.
function defaultBillDate() {
  return localDateKey();
}

function resetBillForm() {
  $("billEditingId").value = "";
  $("billDate").value = defaultBillDate();
  $("billDesc").value = "";
  $("billAmount").value = "";
  $("saveBillBtn").textContent = "Add bill";
  $("cancelBillBtn").hidden = true;
  $("billForm").classList.remove("editing");
  if (report.scope === "expo") renderBills();
}

function loadBillForEdit(id) {
  const bill = report.bills.find(b => b.id === id);
  if (!bill) return;
  $("billEditingId").value = bill.id;
  $("billDate").value = bill.expense_date;
  $("billDesc").value = bill.description;
  $("billAmount").value = bill.amount;
  $("saveBillBtn").textContent = "Save bill";
  $("cancelBillBtn").hidden = false;
  $("billForm").classList.add("editing");
  renderBills();
  $("billForm").scrollIntoView({ block: "nearest", behavior: "smooth" });
  $("billDesc").focus();
}

async function saveBill() {
  const fields = { date: $("billDate").value, description: $("billDesc").value.trim(), amount: $("billAmount").value.trim() };
  const error = expenseError(fields);
  if (error) {
    toast(error, "error");
    return;
  }
  const row = { expense_date: fields.date, description: fields.description, amount: Number(fields.amount) };
  const editingId = $("billEditingId").value;
  const btn = $("saveBillBtn");
  btn.disabled = true;
  try {
    if (editingId) await PosApi.updateExpense(editingId, row);
    else await PosApi.insertExpense({ ...row, scope: "Expo" });
  } catch (err) {
    console.error("Failed to save bill:", err);
    toast(`Couldn't save the bill. ${describeError(err)}`, "error", 8000);
    btn.disabled = false;
    return;
  }
  btn.disabled = false;
  toast(`${editingId ? "Bill updated" : `Added ${money(row.amount)} bill`} ✓`, "success");
  resetBillForm();
  await loadReport();
}

async function deleteBill(id) {
  const bill = report.bills.find(b => b.id === id);
  if (!bill || !confirm(`Delete the ${money(bill.amount)} bill${bill.description ? ` for "${bill.description}"` : ` of ${formatDay(bill.expense_date)}`}?`)) return;
  try {
    await PosApi.deleteExpense(id);
  } catch (err) {
    console.error("Failed to delete bill:", err);
    toast(`Couldn't delete the bill. ${describeError(err)}`, "error", 8000);
    return;
  }
  if ($("billEditingId").value === id) resetBillForm();
  toast("Bill deleted", "info");
  await loadReport();
}

function renderTransactions() {
  const { from, to } = reportRange();
  const multiDay = from !== to;
  const all = [...report.sales].reverse();
  const shown = report.showAllTransactions ? all : all.slice(0, 30);

  $("transactionList").innerHTML = shown.length ? shown.map(sale => {
    const when = new Date(sale.created_at);
    const time = when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const date = multiDay ? when.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) + " · " : "";
    const summary = (sale.items || []).map(i => `${i.qty}× ${i.name}`).join(", ");
    let action = "";
    if (sale.pending) action = `<span class="chip-tag warn">⏳ Not uploaded</span>`;
    else if (sale.testRun) action = `<span class="chip-tag muted">🧪 Test</span>`;
    else if (sale.voided) action = `<button type="button" class="small-btn" data-unvoid="${escapeHtml(sale.id)}">Restore</button>`;
    else action = `<button type="button" class="small-btn delete" data-void="${escapeHtml(sale.id)}">Void</button>`;
    return `
    <div class="txn ${sale.voided || sale.test ? "voided" : ""}">
      <div class="txn-time">${escapeHtml(date + time)}</div>
      <div class="txn-items">${escapeHtml(summary)}${sale.voided ? ` <span class="chip-tag muted">VOID</span>` : ""}${sale.testRun ? ` <span class="chip-tag muted">TEST</span>` : ""}</div>
      <div class="txn-method">${escapeHtml(sale.payment_method)}</div>
      <strong class="txn-total">${money(sale.total)}${sale.full_total > sale.total
        ? `<small class="muted" title="The rest of this sale is in the other report"> of ${money(sale.full_total)}</small>` : ""}</strong>
      <div class="txn-action">${action}</div>
    </div>`;
  }).join("") + (all.length > shown.length
    ? `<button type="button" class="secondary full" data-action="all-transactions">Show all ${all.length} transactions</button>` : "")
    : `<div class="empty-state small"><span>No transactions in this period.</span></div>`;
}

async function toggleVoid(id, voided) {
  const sale = report.sales.find(s => s.id === id);
  if (!sale) return;
  const question = voided
    ? `Void this ${money(sale.full_total)} sale?\n\nIt will be left out of report totals but kept on record. You can restore it later.`
    : `Restore this ${money(sale.full_total)} sale into the report totals?`;
  if (!confirm(question)) return;
  try {
    await PosApi.setSaleVoided(id, voided);
  } catch (err) {
    console.error("Failed to void sale:", err);
    toast(`Couldn't update the sale. ${describeError(err)}`, "error", 8000);
    return;
  }
  const full = report.allSales.find(s => s.id === id);
  if (full) full.voided = voided;
  applyScope();
  toast(voided ? "Sale voided" : "Sale restored", "success");
  renderReport();
}

function exportCsv() {
  const { from, to } = reportRange();
  if (!report.sales.length) {
    toast("No sales to export for this period.", "info");
    return;
  }
  const blob = new Blob(["﻿" + salesToCsv(report.sales, currentCost)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const name = report.scope === "expo" ? "brewzy-expo-sales" : "brewzy-sales";
  a.download = from === to ? `${name}-${from}.csv` : `${name}-${from}-to-${to}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Hover / focus tooltip for chart marks. Text only (textContent).
function setupTooltip(container) {
  const tip = $("tooltip");
  container.appendChild(tip);
  const show = target => {
    const el = target.closest("[data-tip]");
    if (!el || !container.contains(el)) return hide();
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    const box = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const left = Math.min(window.innerWidth - w - 8, Math.max(8, box.left + box.width / 2 - w / 2));
    const top = box.top - tip.offsetHeight - 8;
    tip.style.left = `${left}px`;
    tip.style.top = `${top < 8 ? box.bottom + 8 : top}px`;
  };
  const hide = () => { tip.hidden = true; };
  container.addEventListener("pointerover", e => show(e.target));
  container.addEventListener("pointerleave", hide);
  container.addEventListener("focusin", e => show(e.target));
  container.addEventListener("focusout", hide);
  container.addEventListener("scroll", hide, true);
}

// ---------- Rendering & events ----------

function renderAll() {
  if (activeCategory !== "All" && !products.some(p => p.category === activeCategory)) {
    activeCategory = "All";
  }
  renderCategories();
  renderProducts();
  renderCart();
  if ($("itemDialog").open) renderManageList();
}

function tickClockTables() {
  if (vendor && document.body.classList.contains("tables-mode")) renderTables();
}

function tickClock() {
  $("clock").textContent = new Date().toLocaleString("en-GB", {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
  updateTestBanner();
}

// Before the Expo opens, every sale is a test run: say so on the till.
let wasTestMode = false;
function updateTestBanner() {
  const until = testModeUntil();
  const banner = $("testBanner");
  if (until) {
    const mins = Math.max(1, Math.ceil((until - Date.now()) / 60000));
    const left = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins} min`;
    const at = until.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    banner.innerHTML = `<strong>🧪 TEST MODE</strong> Sales before ${at} today are test sales: they show in reports until ${at}, then they're cleared.` +
      ` <span>The Expo opens at ${at} (in ${left}).</span>`;
  } else if (wasTestMode) {
    toast("🎪 The Expo is open! Test sales are cleared and sales now count.", "success", 8000);
    if ($("salesReportDialog").open) loadReport(); // drop the test sales from an open report
  }
  banner.hidden = !until;
  if (Boolean(until) !== wasTestMode) {
    wasTestMode = Boolean(until);
    updateChange(); // the pay button says when a sale is a test
  }
}

$("searchInput").addEventListener("input", renderProducts);
$("searchInput").addEventListener("keydown", e => {
  if (e.key === "Escape") {
    e.target.value = "";
    renderProducts();
  }
});

$("categoryFilters").addEventListener("click", e => {
  const btn = e.target.closest(".category-btn");
  if (!btn) return;
  activeCategory = btn.dataset.category;
  renderCategories();
  renderProducts();
});

$("productGrid").addEventListener("click", e => {
  const card = e.target.closest(".product-card");
  if (card) return addToCart(card.dataset.id);
  const action = e.target.closest("[data-action]")?.dataset.action;
  if (action === "open-manage") openManageItems();
  if (action === "clear-search") {
    $("searchInput").value = "";
    activeCategory = "All";
    renderCategories();
    renderProducts();
  }
});

$("cartItems").addEventListener("click", e => {
  const btn = e.target.closest(".qty-btn");
  if (btn) return updateQty(btn.dataset.line, Number(btn.dataset.change));
  const toggle = e.target.closest(".price-toggle");
  if (toggle) toggleLineDiscount(toggle.dataset.line);
});

$("clearCartBtn").addEventListener("click", () => {
  if (!cart.length) return;
  const open = activeOrder();
  if (open.tableId) {
    if (confirm(`Remove all items from ${open.name}? The table becomes free.`)) {
      cart = [];
      renderCart(); // saves the empty order, which frees the table
      renderProducts();
      backToTables();
    }
    return;
  }
  if (open.pendingId) {
    if (confirm(`Close ${open.name}'s order on this till? It stays pending as it was last saved.`)) closeActiveOrder();
    return;
  }
  if (orders.length > 1) {
    if (confirm(`Cancel order #${activeOrder().no}? Its items will be removed.`)) closeActiveOrder();
  } else if (confirm("Clear the current order?")) clearCart();
});

$("orderTabs").addEventListener("click", e => {
  if (e.target.closest("#newOrderTabBtn")) return newOrder();
  if (e.target.closest("#pendingTabBtn")) return openPendingList();
  const tab = e.target.closest("[data-order]");
  if (tab) switchOrder(tab.dataset.order);
});

document.querySelectorAll(".payment").forEach(btn => {
  btn.addEventListener("click", () => setPaymentMethod(btn.dataset.method));
});

$("quickCash").addEventListener("click", e => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  $("cashReceived").value = chip.dataset.cash;
  updateChange();
});
$("cashReceived").addEventListener("input", () => {
  updateChange();
  saveOrders();
});
$("cashReceived").addEventListener("keydown", e => {
  if (e.key === "Enter") processPayment();
});
$("payBtn").addEventListener("click", processPayment);
$("payLaterBtn").addEventListener("click", openPayLater);
$("savePayLaterBtn").addEventListener("click", savePayLater);
$("cancelPayLaterBtn").addEventListener("click", () => $("payLaterDialog").close());
$("closePayLaterBtn").addEventListener("click", () => $("payLaterDialog").close());
$("payLaterName").addEventListener("keydown", e => {
  if (e.key === "Enter") savePayLater();
});
$("pendingPicks").addEventListener("click", e => {
  const pick = e.target.closest("[data-pick]");
  if (pick) $("payLaterName").value = pick.dataset.pick;
});
$("closePendingBtn").addEventListener("click", () => $("pendingDialog").close());
$("pendingList").addEventListener("click", e => {
  const open = e.target.closest("[data-pending-open]");
  if (open) return openPendingOrder(open.dataset.pendingOpen);
  const del = e.target.closest("[data-pending-delete]");
  if (del) deletePendingEntry(del.dataset.pendingDelete);
});
$("mobileCartBar").addEventListener("click", () => $("cartPanel").scrollIntoView({ behavior: "smooth" }));

$("newOrderBtn").addEventListener("click", () => $("receiptDialog").close());
$("printReceiptBtn").addEventListener("click", () => window.print());

// Manage items
$("manageItemsBtn").addEventListener("click", openManageItems);
$("closeItemDialogBtn").addEventListener("click", () => $("itemDialog").close());
$("saveItemBtn").addEventListener("click", saveItem);
$("resetFormBtn").addEventListener("click", () => resetItemForm());
$("manageSearch").addEventListener("input", renderManageList);
$("itemCategory").addEventListener("input", updateStockFields);
["itemPrice", "itemCost"].forEach(id => $(id).addEventListener("input", () => {
  updateMarginPreview();
  updateDiscountPreview();
}));
$("itemSalePrice").addEventListener("input", updateDiscountPreview);
$("discountPicks").addEventListener("click", e => {
  const chip = e.target.closest("[data-percent]");
  if (chip) pickDiscount(Number(chip.dataset.percent));
});
$("removeDiscountBtn").addEventListener("click", removeDiscount);
$("itemForm").addEventListener("keydown", e => {
  if (e.key === "Enter" && e.target.tagName === "INPUT") {
    e.preventDefault();
    if (e.target.closest("#discardPanel")) saveDiscard();
    else saveItem();
  }
});
$("emojiPicks").addEventListener("click", e => {
  const pick = e.target.closest(".emoji-pick");
  if (pick) $("itemEmoji").value = pick.dataset.emoji;
});
$("manageItemList").addEventListener("click", e => {
  const edit = e.target.closest("[data-edit]");
  if (edit) return loadItemForEdit(edit.dataset.edit);
  const discount = e.target.closest("[data-discount]");
  if (discount) {
    loadItemForEdit(discount.dataset.discount);
    $("discountBox").scrollIntoView({ block: "center", behavior: "smooth" });
    return $("itemSalePrice").focus();
  }
  const discard = e.target.closest("[data-discard]");
  if (discard) {
    loadItemForEdit(discard.dataset.discard);
    $("discardPanel").scrollIntoView({ block: "nearest", behavior: "smooth" });
    return $("discardQty").focus();
  }
  const del = e.target.closest("[data-delete]");
  if (del) deleteItem(del.dataset.delete);
});
$("saveDiscardBtn").addEventListener("click", saveDiscard);
$("cancelDiscardBtn").addEventListener("click", resetDiscardForm);
$("discardQty").addEventListener("input", updateDiscardPreview);
$("discardList").addEventListener("click", e => {
  const edit = e.target.closest("[data-discard-edit]");
  if (edit) return loadDiscardForEdit(edit.dataset.discardEdit);
  const del = e.target.closest("[data-discard-delete]");
  if (del) deleteDiscardEntry(del.dataset.discardDelete);
});

// Reports
$("salesReportBtn").addEventListener("click", openSalesReport);
$("closeSalesReportBtn").addEventListener("click", () => $("salesReportDialog").close());
$("rangePresets").addEventListener("click", e => {
  const btn = e.target.closest("[data-preset]");
  if (btn) setPreset(btn.dataset.preset);
});
["reportFrom", "reportTo"].forEach(id => $(id).addEventListener("change", () => {
  report.preset = "custom";
  markPreset();
  loadReport();
}));
$("bestBy").addEventListener("click", e => {
  const btn = e.target.closest("[data-by]");
  if (!btn) return;
  report.bestBy = btn.dataset.by;
  document.querySelectorAll("#bestBy button").forEach(b => b.classList.toggle("active", b === btn));
  renderBestSellers(aggregateSales(report.sales, currentCost));
});
$("productTable").querySelector("thead").addEventListener("click", e => {
  const th = e.target.closest("th[data-sort]");
  if (!th) return;
  const key = th.dataset.sort;
  report.sortDir = report.sortKey === key ? -report.sortDir : (key === "name" ? 1 : -1);
  report.sortKey = key;
  renderProductTable(aggregateSales(report.sales, currentCost));
});
$("stockTable").querySelector("thead").addEventListener("click", e => {
  const th = e.target.closest("th[data-sort]");
  if (!th) return;
  const key = th.dataset.sort;
  report.stockSortDir = report.stockSortKey === key ? -report.stockSortDir : (key === "name" ? 1 : -1);
  report.stockSortKey = key;
  renderStockReport(aggregateSales(report.sales, currentCost));
});
$("transactionList").addEventListener("click", e => {
  const v = e.target.closest("[data-void]");
  if (v) return toggleVoid(v.dataset.void, true);
  const u = e.target.closest("[data-unvoid]");
  if (u) return toggleVoid(u.dataset.unvoid, false);
  if (e.target.closest('[data-action="all-transactions"]')) {
    report.showAllTransactions = true;
    renderTransactions();
  }
});
$("exportCsvBtn").addEventListener("click", exportCsv);
$("reportScope").addEventListener("click", e => {
  const btn = e.target.closest("[data-scope]");
  if (btn && btn.dataset.scope !== report.scope) setScope(btn.dataset.scope);
});
$("saveBillBtn").addEventListener("click", saveBill);
$("cancelBillBtn").addEventListener("click", resetBillForm);
$("billForm").addEventListener("keydown", e => {
  if (e.key === "Enter" && e.target.tagName === "INPUT") {
    e.preventDefault();
    saveBill();
  }
});
$("billList").addEventListener("click", e => {
  const edit = e.target.closest("[data-bill-edit]");
  if (edit) return loadBillForEdit(edit.dataset.billEdit);
  const del = e.target.closest("[data-bill-delete]");
  if (del) deleteBill(del.dataset.billDelete);
});
setupTooltip($("salesReportDialog"));

// Keyboard: "/" jumps to search.
document.addEventListener("keydown", e => {
  if (e.key === "/" && !openDialogEl() && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
    e.preventDefault();
    $("searchInput").focus();
  }
});

window.addEventListener("online", () => { if (vendor) { flushPending(); loadProducts(); } });
window.addEventListener("offline", () => setOnline(false));

// ---------- Day closes in the report ----------

async function loadDayCloses(from, to) {
  let rows = [];
  let failed = "";
  try {
    rows = await PosApi.fetchDayClosesInRange(from, to);
  } catch (err) {
    console.error("Failed to load day closes:", err);
    failed = describeError(err);
  }
  const diff = (counted, expected) => {
    const d = PosCore.round2(Number(counted) - Number(expected));
    return `<span class="${d < 0 ? "loss-text" : ""}">${d === 0 ? "✓ 0.00" : signedMoney(d)}</span>`;
  };
  $("dayClosesBody").innerHTML = failed
    ? `<tr><td colspan="7" class="report-empty">⚠️ ${escapeHtml(failed)}</td></tr>`
    : rows.length ? rows.map(c => `
      <tr>
        <td>${escapeHtml(formatDay(c.close_date, { weekday: "short", day: "numeric", month: "short" }))}</td>
        <td>${money(c.cash_counted)}</td>
        <td>${money(c.cash_expected)}</td>
        <td>${diff(c.cash_counted, c.cash_expected)}</td>
        <td>${diff(c.transfer_counted, c.transfer_expected)}</td>
        <td>${diff(c.card_counted, c.card_expected)}</td>
        <td>${escapeHtml(c.closed_by || "")}${c.note ? ` <span class="muted" title="${escapeHtml(c.note)}">📝</span>` : ""}</td>
      </tr>`).join("")
    : `<tr><td colspan="7" class="report-empty">No day closed in these dates.</td></tr>`;
}

// ---------- Close day: count the cash, check transfer and card ----------

const closeDay = { date: "", expected: { Cash: 0, Transfer: 0, Card: 0, count: 0 }, counts: {}, existing: null };

function openCloseDay() {
  $("closeDate").value = localDateKey();
  $("closeDayDialog").showModal();
  loadCloseDay();
}

async function loadCloseDay() {
  const date = $("closeDate").value || localDateKey();
  closeDay.date = date;
  $("closeDayInfo").textContent = "Loading the day's sales…";
  let sales = [];
  let existing = null;
  try {
    sales = await PosApi.fetchSalesInRange(date, date);
    const closes = await PosApi.fetchDayClosesInRange(date, date).catch(() => []);
    existing = closes[0] || null;
  } catch (err) {
    console.error("Failed to load the day:", err);
    $("closeDayInfo").textContent = `⚠️ Couldn't load the day's sales. ${describeError(err)}`;
  }
  const ids = new Set(sales.map(s => s.id));
  sales = sales.concat(pendingSales.filter(s => s.sale_date === date && !ids.has(s.id)));
  closeDay.expected = dayExpected(sales);
  closeDay.existing = existing;
  closeDay.counts = existing ? { ...(existing.cash_breakdown.counts || {}) } : {};
  $("cashSmall").value = existing && existing.cash_breakdown.small ? existing.cash_breakdown.small : "";
  $("closeNote").value = existing ? existing.note || "" : "";
  if (sales.length || !$("closeDayInfo").textContent.startsWith("⚠️")) {
    $("closeDayInfo").textContent = `${plural(closeDay.expected.count, "sale")} on ${formatDay(date, { weekday: "long", day: "numeric", month: "long" })}.` +
      (existing ? ` Already closed by ${existing.closed_by || "someone"} at ${new Date(existing.updated_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}: saving again updates it.` : "");
  }
  renderCashRows();
  renderChecks(existing);
  renderCloseSummary();
}

function renderCashRows() {
  $("cashRows").innerHTML = CASH_DENOMINATIONS.map(d => {
    const n = Number(closeDay.counts[d.value]) || 0;
    return `
    <div class="cash-row" data-value="${d.value}">
      <span class="cash-chip ${d.kind}">${d.value}</span>
      <button type="button" class="step" data-step="-1" aria-label="One less ${d.value}">−</button>
      <input type="number" inputmode="numeric" min="0" step="1" value="${n || ""}" placeholder="0" aria-label="Number of ${d.value} ${d.kind}s" />
      <button type="button" class="step" data-step="1" aria-label="One more ${d.value}">＋</button>
      <span class="line">${money(d.value * n)}</span>
    </div>`;
  }).join("");
}

function renderChecks(existing) {
  const check = (method, label) => {
    const expected = closeDay.expected[method];
    const counted = existing ? existing[`${method.toLowerCase()}_counted`] : "";
    return `
      <div class="row"><span>System (${label} sales)</span><strong>${money(expected)}</strong></div>
      <label>${label} received <input type="number" inputmode="decimal" min="0" step="0.01" data-method="${method}" value="${counted === "" ? "" : counted}" placeholder="${expected.toFixed(2)}" /></label>
      <button type="button" class="secondary" data-match="${method}">✓ Matches the system</button>
      <span class="diff" data-diff="${method}"></span>`;
  };
  $("transferCheck").innerHTML = check("Transfer", "Transfer");
  $("cardCheck").innerHTML = check("Card", "Card");
  updateChecks();
}

function counted(method) {
  if (method === "Cash") return cashCountTotal(closeDay.counts, $("cashSmall").value);
  const input = document.querySelector(`#closeDayDialog input[data-method="${method}"]`);
  return input && input.value !== "" ? Number(input.value) : null;
}

function diffLabel(d) {
  if (Math.abs(d) < 0.005) return ["ok", "✓ Matches"];
  return d < 0 ? ["short", `Short by ${money(-d)}`] : ["over", `Over by ${money(d)}`];
}

function updateChecks() {
  for (const method of ["Transfer", "Card"]) {
    const el = document.querySelector(`[data-diff="${method}"]`);
    const c = counted(method);
    if (!el) continue;
    if (c === null) { el.className = "diff"; el.textContent = "Type what you received, or tap ✓ if it matches."; continue; }
    const [cls, text] = diffLabel(PosCore.round2(c - closeDay.expected[method]));
    el.className = `diff ${cls}`;
    el.textContent = text;
  }
}

function renderCloseSummary() {
  const cash = counted("Cash");
  const expected = closeDay.expected.Cash;
  const [cls, text] = diffLabel(PosCore.round2(cash - expected));
  $("cdSummary").innerHTML = `
    <div class="cd-box"><span>Cash counted</span><strong>${money(cash)}</strong></div>
    <div class="cd-box"><span>Cash sales (system)</span><strong>${money(expected)}</strong></div>
    <div class="cd-box ${cls}"><span>Difference</span><strong>${text}</strong></div>`;
}

async function saveCloseDay() {
  const transfer = counted("Transfer");
  const card = counted("Card");
  if (transfer === null || card === null) {
    toast("Please enter the transfer and card amounts received (or tap ✓ Matches the system).", "error", 5000);
    return;
  }
  const now = new Date().toISOString();
  const row = {
    owner: vendor.id,
    close_date: closeDay.date,
    closed_by: vendor.user || vendor.username,
    updated_at: now,
    cash_expected: closeDay.expected.Cash,
    cash_counted: counted("Cash"),
    cash_breakdown: { counts: closeDay.counts, small: Number($("cashSmall").value) || 0 },
    transfer_expected: closeDay.expected.Transfer,
    transfer_counted: transfer,
    card_expected: closeDay.expected.Card,
    card_counted: card,
    note: $("closeNote").value.trim() || null,
  };
  const btn = $("saveCloseDayBtn");
  btn.disabled = true;
  try {
    await PosApi.saveDayClose(row);
  } catch (err) {
    console.error("Failed to save the day close:", err);
    toast(`Couldn't save the day close. ${describeError(err)}`, "error", 8000);
    btn.disabled = false;
    return;
  }
  btn.disabled = false;
  $("closeDayDialog").close();
  const [, cashText] = diffLabel(PosCore.round2(row.cash_counted - row.cash_expected));
  toast(`Day closed ✓ Cash: ${cashText}`, "success", 6000);
}

$("closeDayBtn").addEventListener("click", openCloseDay);
$("closeCloseDayBtn").addEventListener("click", () => $("closeDayDialog").close());
$("cancelCloseDayBtn").addEventListener("click", () => $("closeDayDialog").close());
$("saveCloseDayBtn").addEventListener("click", saveCloseDay);
$("closeDate").addEventListener("change", loadCloseDay);
$("cashRows").addEventListener("click", e => {
  const step = e.target.closest("[data-step]");
  if (!step) return;
  const value = step.closest("[data-value]").dataset.value;
  closeDay.counts[value] = Math.max(0, (Number(closeDay.counts[value]) || 0) + Number(step.dataset.step));
  const row = step.closest(".cash-row");
  row.querySelector("input").value = closeDay.counts[value] || "";
  row.querySelector(".line").textContent = money(Number(value) * closeDay.counts[value]);
  renderCloseSummary();
});
$("cashRows").addEventListener("input", e => {
  const row = e.target.closest("[data-value]");
  if (!row) return;
  const value = row.dataset.value;
  closeDay.counts[value] = Math.max(0, Math.floor(Number(e.target.value) || 0));
  row.querySelector(".line").textContent = money(Number(value) * closeDay.counts[value]);
  renderCloseSummary();
});
$("cashSmall").addEventListener("input", renderCloseSummary);
$("clearCountBtn").addEventListener("click", () => {
  closeDay.counts = {};
  $("cashSmall").value = "";
  renderCashRows();
  renderCloseSummary();
});
$("closeDayDialog").addEventListener("input", e => {
  if (e.target.matches("input[data-method]")) updateChecks();
});
$("closeDayDialog").addEventListener("click", e => {
  const match = e.target.closest("[data-match]");
  if (!match) return;
  const method = match.dataset.match;
  document.querySelector(`#closeDayDialog input[data-method="${method}"]`).value = closeDay.expected[method].toFixed(2);
  updateChecks();
});

// ---------- Staff (admin only) ----------

let staffRole = "cashier";

async function openStaff() {
  if (!isAdmin()) return;
  $("staffUser").value = `${vendor.username}.`;
  $("staffPassword").value = "";
  $("staffDialog").showModal();
  await renderStaff();
}

async function renderStaff() {
  const notice = $("staffNotice");
  let rows = [];
  try {
    rows = await PosApi.listStaff();
    notice.hidden = true;
  } catch (err) {
    console.error("Failed to load staff:", err);
    notice.hidden = false;
    notice.innerHTML = `<div class="notice error">⚠️ Couldn't load staff. ${escapeHtml(describeError(err))}</div>`;
  }
  $("staffList").innerHTML = rows.length ? rows.map(s => `
    <div class="staff-row">
      <div>
        <strong>${s.role === "admin" ? "⭐" : "🧑‍💼"} ${escapeHtml(s.username)}</strong>
        <small>${s.role === "admin" ? "Admin" : "Cashier"}</small>
      </div>
      <div class="staff-actions">
        <button type="button" class="small-btn" data-staff-role="${escapeHtml(s.username)}" data-to="${s.role === "admin" ? "cashier" : "admin"}">Make ${s.role === "admin" ? "cashier" : "admin"}</button>
        <button type="button" class="small-btn" data-staff-password="${escapeHtml(s.username)}">🔑 New password</button>
        <button type="button" class="small-btn delete" data-staff-remove="${escapeHtml(s.username)}">🗑</button>
      </div>
    </div>`).join("")
    : `<div class="empty-state small"><span>No staff yet. ${escapeHtml(vendor.name)}'s main login is the admin.</span></div>`;
}

async function staffAction(fn, okText) {
  try {
    await fn();
  } catch (err) {
    console.error("Staff change failed:", err);
    const msg = String((err && err.message) || "");
    toast(/taken|already|characters|only use|admin or cashier|no staff|own login/i.test(msg) ? msg : `Couldn't change staff. ${describeError(err)}`, "error", 8000);
    return false;
  }
  toast(okText, "success");
  await renderStaff();
  return true;
}

$("staffBtn").addEventListener("click", openStaff);
$("closeStaffBtn").addEventListener("click", () => $("staffDialog").close());
$("staffRole").addEventListener("click", e => {
  const b = e.target.closest("[data-role]");
  if (!b) return;
  staffRole = b.dataset.role;
  document.querySelectorAll("#staffRole [data-role]").forEach(x => x.classList.toggle("active", x === b));
});
$("addStaffBtn").addEventListener("click", async () => {
  const username = $("staffUser").value.trim().toLowerCase();
  const password = $("staffPassword").value;
  if (!username || username.endsWith(".")) return toast("Please type a user name, e.g. brewzy.ali", "error");
  if (password.length < 6) return toast("The password needs at least 6 characters.", "error");
  const ok = await staffAction(() => PosApi.createStaff(username, password, staffRole),
    `Added ${username} as ${staffRole} ✓ They can log in now.`);
  if (ok) { $("staffUser").value = `${vendor.username}.`; $("staffPassword").value = ""; }
});
$("staffList").addEventListener("click", e => {
  const role = e.target.closest("[data-staff-role]");
  if (role) return staffAction(() => PosApi.setStaffRole(role.dataset.staffRole, role.dataset.to), `${role.dataset.staffRole} is now ${role.dataset.to} ✓`);
  const pw = e.target.closest("[data-staff-password]");
  if (pw) {
    const password = prompt(`New password for ${pw.dataset.staffPassword} (at least 6 characters):`);
    if (password) staffAction(() => PosApi.resetStaffPassword(pw.dataset.staffPassword, password), `Password changed for ${pw.dataset.staffPassword} ✓`);
    return;
  }
  const rm = e.target.closest("[data-staff-remove]");
  if (rm && confirm(`Remove ${rm.dataset.staffRemove}? They won't be able to log in any more.`)) {
    staffAction(() => PosApi.removeStaff(rm.dataset.staffRemove), `Removed ${rm.dataset.staffRemove}`);
  }
});

// ---------- Super admin: every vendor and their staff ----------

function startSuper() {
  document.body.classList.remove("logged-out");
  document.body.classList.add("super-mode");
  $("superView").hidden = false;
  $("superName").textContent = vendor.user;
  document.title = "Super admin · Brewzy POS";
  renderSuper();
}

async function renderSuper() {
  let rows = [];
  const notice = $("superNotice");
  try {
    rows = await PosApi.superListLogins();
    notice.hidden = true;
  } catch (err) {
    console.error("Failed to load logins:", err);
    notice.hidden = false;
    notice.innerHTML = `<div class="notice error">⚠️ Couldn't load the logins. ${escapeHtml(describeError(err))}</div>`;
  }
  const when = t => (t ? new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "never");
  const actions = (r) => `
    <div class="sv-actions">
      ${r.kind === "super" ? "" : `<button type="button" class="small-btn" data-rename-login="${escapeHtml(r.username)}">✏️ Rename</button>`}
      <button type="button" class="small-btn" data-password-login="${escapeHtml(r.username)}">🔑 Password</button>
      ${r.kind === "staff" ? `<button type="button" class="small-btn" data-role-login="${escapeHtml(r.username)}" data-to="${r.role === "admin" ? "cashier" : "admin"}">Make ${r.role === "admin" ? "cashier" : "admin"}</button>` : ""}
    </div>`;
  const row = (r, cls, title, sub) => `
    <div class="sv-row ${cls}">
      <div><strong>${title}</strong><small>${sub} · last login ${escapeHtml(when(r.last_sign_in_at))}</small></div>
      ${actions(r)}
    </div>`;
  const vendors = rows.filter(r => r.kind === "vendor");
  const supers = rows.filter(r => r.kind === "super");
  $("superList").innerHTML = vendors.map(v => {
    const staff = rows.filter(r => r.kind === "staff" && r.vendor_username === v.username);
    return `<div class="sv-vendor">
      ${row(v, "main", `🏪 ${escapeHtml(v.username)}`, "Vendor · main admin login")}
      ${staff.map(s => row(s, "staff", `${s.role === "admin" ? "⭐" : "🧑‍💼"} ${escapeHtml(s.username)}`, s.role === "admin" ? "Admin" : "Cashier")).join("")}
      ${staff.length ? "" : `<div class="sv-row staff"><small>No staff yet (the vendor adds them in 👥 Staff).</small></div>`}
    </div>`;
  }).join("") + (supers.length ? `<div class="sv-vendor">
      ${supers.map(s => row(s, "main", `🛡️ ${escapeHtml(s.username)}`, "Super admin")).join("")}
    </div>` : "") + (rows.length ? "" : `<div class="empty-state small"><span>No logins found.</span></div>`);
}

async function superAction(fn, okText) {
  try {
    await fn();
  } catch (err) {
    console.error("Super admin change failed:", err);
    const msg = String((err && err.message) || "");
    toast(/taken|characters|only use|no login|only staff|must be|already/i.test(msg) ? msg : `Couldn't make the change. ${describeError(err)}`, "error", 8000);
    return;
  }
  toast(okText, "success");
  await renderSuper();
}

$("superList").addEventListener("click", e => {
  const rn = e.target.closest("[data-rename-login]");
  if (rn) {
    const old = rn.dataset.renameLogin;
    const name = prompt(`New user name for ${old}:`, old);
    if (name && name.trim().toLowerCase() !== old) {
      superAction(() => PosApi.superRenameLogin(old, name.trim().toLowerCase()), `${old} is now ${name.trim().toLowerCase()} ✓ (log in with the new name)`);
    }
    return;
  }
  const pw = e.target.closest("[data-password-login]");
  if (pw) {
    const password = prompt(`New password for ${pw.dataset.passwordLogin} (at least 6 characters):`);
    if (password) superAction(() => PosApi.superSetPassword(pw.dataset.passwordLogin, password), `Password changed for ${pw.dataset.passwordLogin} ✓`);
    return;
  }
  const role = e.target.closest("[data-role-login]");
  if (role) superAction(() => PosApi.superSetRole(role.dataset.roleLogin, role.dataset.to), `${role.dataset.roleLogin} is now ${role.dataset.to} ✓`);
});
$("newVendorBtn").addEventListener("click", () => {
  const username = (prompt("User name of the new vendor (e.g. cafe2):") || "").trim().toLowerCase();
  if (!username) return;
  const password = prompt(`Password for ${username} (at least 6 characters):`);
  if (!password) return;
  superAction(() => PosApi.superCreateVendor(username, password), `Vendor ${username} created ✓ They log in with that name and start with an empty menu.`);
});
$("superLogoutBtn").addEventListener("click", async () => {
  if (!confirm("Log out of the super admin?")) return;
  try { await PosApi.signOut(); } catch (err) { console.warn("Sign out:", err); }
  location.reload();
});

// ---------- Tables ----------
// The till opens on the Tables screen. Tapping a table opens its order; every
// change is saved to the table's shared pending order, so all tills see the
// table as occupied until it's paid.

const TABLES_CACHE_KEY = "brewzyTables";
let tables = [];
let tablesFailed = false;
let editingTables = false;
const tableSaveTimers = new Map();

async function loadTables() {
  try {
    tables = await PosApi.fetchTables();
    tablesFailed = false;
    if (!tables.length && isAdmin()) {
      // First time for this vendor: start with Table 1 to Table 5.
      await PosApi.insertTables([1, 2, 3, 4, 5].map(n => ({ name: `Table ${n}`, sort: n })));
      tables = await PosApi.fetchTables();
    }
    writeStore(TABLES_CACHE_KEY, tables);
  } catch (err) {
    console.error("Failed to load tables:", err);
    tablesFailed = describeError(err);
    tables = readStore(TABLES_CACHE_KEY, tables);
  }
  renderTables();
}

function tableOrderOf(tableId) {
  return pendingOrders.find(p => p.table_id === tableId);
}

function elapsed(since) {
  const mins = Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 60000));
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}`;
}

function renderTables() {
  const notice = $("tablesNotice");
  const problem = tablesFailed || pendingFailed;
  notice.hidden = !problem;
  notice.innerHTML = problem ? `<div class="notice error">⚠️ ${escapeHtml(problem)}</div>` : "";
  $("editTablesBtn").textContent = editingTables ? "✓ Done editing" : "✏️ Edit tables";
  $("tablesPendingBtn").textContent = `🕒 Pending${namedPending().length ? ` · ${namedPending().length}` : ""}`;
  const counter = orders.filter(o => !o.tableId && o.cart.length);
  const counterCount = counter.reduce((sum, o) => sum + o.cart.reduce((s, i) => s + i.qty, 0), 0);
  $("tablesGrid").innerHTML = `
    <button type="button" class="table-tile counter" data-counter>
      <span class="t-name">🥡 Counter / Takeaway</span>
      <span class="t-status">${counter.length ? `${plural(counter.length, "open order")} · ${plural(counterCount, "item")}` : "Quick sale without a table"}</span>
    </button>` +
    tables.map(t => {
      const p = tableOrderOf(t.id);
      const sum = p ? pendingSummary(p.items, products) : null;
      const busy = Boolean(p && sum.count);
      return `
      <button type="button" class="table-tile ${busy ? "busy" : ""}" data-table="${escapeHtml(t.id)}"
        aria-label="${escapeHtml(t.name)}, ${busy ? `occupied, ${money(sum.total)}` : "free"}">
        ${editingTables ? `<span class="table-edit">
          <span role="button" tabindex="0" class="t-rename" data-rename="${escapeHtml(t.id)}">✏️ Rename</span>
          ${busy ? "" : `<span role="button" tabindex="0" class="t-delete" data-delete-table="${escapeHtml(t.id)}">🗑</span>`}
        </span>` : ""}
        <span class="t-name">${escapeHtml(t.name)}</span>
        ${busy ? `<span class="t-total">${money(sum.total)}</span>
          <span class="t-meta">${plural(sum.count, "item")} · ⏱ ${elapsed(p.created_at)}</span>`
          : `<span class="t-status">Free</span>`}
      </button>`;
    }).join("") +
    `<button type="button" class="table-tile add" data-add-table>＋ Add table</button>`;
}

function showTables() {
  document.body.classList.add("tables-mode");
  $("tablesView").hidden = false;
  renderTables();
  refreshPendingOrders();
}

function showOrderView() {
  document.body.classList.remove("tables-mode");
  $("tablesView").hidden = true;
}

// Leave the order screen: a table's order is saved and closed on this till.
async function backToTables() {
  const order = activeOrder();
  if (order && order.tableId) {
    saveOrders();
    const ok = await saveTableOrder(order);
    if (!ok && order.cart.length) {
      toast(`Couldn't save ${order.name}'s order. Check the connection and try again.`, "error", 6000);
      return;
    }
    closeActiveOrder();
  }
  showTables();
}

async function openTable(id) {
  const table = tables.find(t => t.id === id);
  if (!table || saving) return;
  await refreshPendingOrders();
  const p = tableOrderOf(id);
  saveOrders();
  cart = [];
  let dropped = 0;
  for (const line of (p && p.items) || []) {
    const product = products.find(x => x.id === line.id);
    if (product) putInCart(product, line.qty, line.discounted);
    else dropped += line.qty;
  }
  const order = { ...blankOrder(0), cart, name: table.name, tableId: id, pendingId: p ? p.id : newId(), savedRow: Boolean(p) };
  orders = orders.filter(o => !o.tableId); // only one table open at a time on a till
  orders.push(order);
  activeOrderId = order.id;
  showOrderView();
  showActiveOrder();
  if (dropped) toast(`${plural(dropped, "item")} no longer on the menu left out.`, "info");
}

function openCounter() {
  orders = orders.filter(o => !o.tableId);
  if (!orders.length) orders.push(blankOrder(1));
  if (!orders.some(o => o.id === activeOrderId)) activeOrderId = orders[0].id;
  showOrderView();
  showActiveOrder();
}

function scheduleTableSave(order) {
  clearTimeout(tableSaveTimers.get(order.id));
  tableSaveTimers.set(order.id, setTimeout(() => saveTableOrder(order), 700));
}

function cancelTableSave(order) {
  clearTimeout(tableSaveTimers.get(order.id));
  tableSaveTimers.delete(order.id);
}

// Save a table's order to its shared pending order: an empty order frees the table.
async function saveTableOrder(order) {
  cancelTableSave(order);
  const items = toPendingItems(order.cart);
  const now = new Date().toISOString();
  try {
    if (!items.length) {
      if (order.savedRow) await PosApi.deletePendingOrder(order.pendingId);
      order.savedRow = false;
      pendingOrders = pendingOrders.filter(p => p.id !== order.pendingId);
    } else {
      const row = { name: order.name, table_id: order.tableId, items, updated_at: now };
      let found = order.savedRow && await PosApi.updatePendingOrder(order.pendingId, row);
      if (!found) {
        try {
          await PosApi.insertPendingOrder({ id: order.pendingId, ...row });
        } catch (err) {
          if (!(err && err.code === "23505")) throw err;
          // Another till opened this table first: add to its order.
          const rows = await PosApi.fetchPendingOrders();
          const existing = rows.find(p => p.table_id === order.tableId) || rows.find(p => p.id === order.pendingId);
          if (!existing) throw err;
          const merged = existing.id === order.pendingId ? items : mergePendingItems(existing.items || [], items);
          await PosApi.updatePendingOrder(existing.id, { ...row, items: merged });
          order.pendingId = existing.id;
        }
      }
      order.savedRow = true;
      const local = pendingOrders.find(p => p.id === order.pendingId);
      if (local) Object.assign(local, row);
      else pendingOrders.push({ id: order.pendingId, created_at: now, ...row });
    }
    order.saveFailed = false;
    return true;
  } catch (err) {
    console.error("Failed to save table order:", err);
    if (!order.saveFailed) toast(`Couldn't save ${order.name}'s order. ${describeError(err)}`, "error", 6000);
    order.saveFailed = true;
    return false;
  }
}

async function addTable() {
  if (!isAdmin()) return;
  const numbers = tables.map(t => Number((t.name.match(/\d+/) || [0])[0]));
  const n = (numbers.length ? Math.max(...numbers) : 0) + 1;
  const name = prompt("Name of the new table:", `Table ${n}`);
  if (!name || !name.trim()) return;
  try {
    await PosApi.insertTables([{ name: name.trim(), sort: Math.max(0, ...tables.map(t => t.sort || 0)) + 1 }]);
  } catch (err) {
    console.error("Failed to add table:", err);
    return toast(`Couldn't add the table. ${describeError(err)}`, "error", 8000);
  }
  toast(`Added ${name.trim()} ✓`, "success");
  await loadTables();
}

async function renameTable(id) {
  const t = tables.find(x => x.id === id);
  const name = t && prompt("Rename table:", t.name);
  if (!name || !name.trim() || name.trim() === t.name) return;
  try {
    await PosApi.updateTable(id, { name: name.trim() });
  } catch (err) {
    console.error("Failed to rename table:", err);
    return toast(`Couldn't rename the table. ${describeError(err)}`, "error", 8000);
  }
  await loadTables();
}

async function removeTable(id) {
  const t = tables.find(x => x.id === id);
  if (!t || tableOrderOf(id) || !confirm(`Remove ${t.name}?`)) return;
  try {
    await PosApi.deleteTable(id);
  } catch (err) {
    console.error("Failed to remove table:", err);
    return toast(`Couldn't remove the table. ${describeError(err)}`, "error", 8000);
  }
  toast(`Removed ${t.name}`, "info");
  await loadTables();
}

$("tablesGrid").addEventListener("click", e => {
  const rename = e.target.closest("[data-rename]");
  if (rename) return renameTable(rename.dataset.rename);
  const del = e.target.closest("[data-delete-table]");
  if (del) return removeTable(del.dataset.deleteTable);
  if (e.target.closest("[data-counter]")) return openCounter();
  if (e.target.closest("[data-add-table]")) return addTable();
  const tile = e.target.closest("[data-table]");
  if (tile) openTable(tile.dataset.table);
});
$("editTablesBtn").addEventListener("click", () => {
  editingTables = !editingTables;
  renderTables();
});
$("tablesPendingBtn").addEventListener("click", openPendingList);
$("backToTablesBtn").addEventListener("click", backToTables);

// ---------- Login ----------

// Keys used before logins existed. Everything on a till then was Brewzy's,
// so it moves under Brewzy's login (offline sales, open orders, menu cache).
const LEGACY_KEYS = [PRODUCTS_CACHE_KEY, PENDING_SALES_KEY, REPORT_SCOPE_KEY, OPEN_ORDERS_KEY, PENDING_DELETES_KEY];
function adoptLegacyStore() {
  if (vendor.username !== "brewzy") return;
  try {
    for (const key of LEGACY_KEYS) {
      const old = localStorage.getItem(key);
      if (old === null) continue;
      if (localStorage.getItem(storeKey(key)) === null) localStorage.setItem(storeKey(key), old);
      localStorage.removeItem(key);
    }
  } catch (err) {
    console.warn("Couldn't move saved data to the Brewzy login:", err);
  }
}

// Who's logged in: the vendor whose data they work on, and their role.
async function resolveVendor(session) {
  const basic = PosApi.vendorOf(session);
  try {
    const me = await PosApi.whoami();
    const name = me.vendor_username.charAt(0).toUpperCase() + me.vendor_username.slice(1);
    return { id: me.vendor_id, username: me.vendor_username, name, role: me.role, user: me.username, super: Boolean(me.super) };
  } catch (err) {
    console.warn("Couldn't read the login's role (staff migration not run yet?):", err);
    return { ...basic, role: "admin", user: basic.username };
  }
}

const isAdmin = () => Boolean(vendor && vendor.role === "admin");

// Load this vendor's data on this till and start the POS.
async function startSession(session) {
  vendor = await resolveVendor(session);
  if (vendor.super) return startSuper();
  document.body.classList.toggle("role-admin", isAdmin());
  document.body.classList.toggle("role-cashier", !isAdmin());
  setVendor(vendor.username);
  adoptLegacyStore();
  products = readStore(PRODUCTS_CACHE_KEY, []);
  menuLoaded = products.length > 0;
  pendingSales = readStore(PENDING_SALES_KEY, []);
  pendingDeletes = readStore(PENDING_DELETES_KEY, []);
  report.scope = readStore(REPORT_SCOPE_KEY, "main") === "expo" ? "expo" : "main";
  $("vendorName").textContent = vendor.user && vendor.user !== vendor.username
    ? `${vendor.user} (${vendor.name} ${isAdmin() ? "admin" : "cashier"})` : vendor.name;
  document.title = `${vendor.name} · Brewzy POS`;
  document.body.classList.remove("logged-out");
  restoreOrders();
  // A table's order left open on this till: save it, then keep only counter orders here.
  orders.filter(o => o.tableId).forEach(o => saveTableOrder(o));
  orders = orders.filter(o => !o.tableId);
  if (!orders.length) orders.push(blankOrder(1));
  if (!orders.some(o => o.id === activeOrderId)) activeOrderId = orders[0].id;
  cart = activeOrder().cart;
  $("cashReceived").value = activeOrder().cash || "";
  setPaymentMethod(activeOrder().paymentMethod || "Cash");
  tickClock();
  renderStatus();
  renderAll();                          // instant paint from cached menu (if any)
  loadProducts().then(flushPending);    // refresh the menu, upload saved sales
  refreshPendingOrders();
  flushPaidPendingOrders();
  tables = readStore(TABLES_CACHE_KEY, []);
  showTables();
  loadTables();
}

function showLogin(message = "") {
  document.body.classList.add("logged-out");
  $("loginError").hidden = !message;
  $("loginError").textContent = message;
  $("loginUser").focus();
}

$("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  const username = $("loginUser").value.trim();
  const password = $("loginPassword").value;
  if (!username || !password) return showLogin("Please enter your user name and password.");
  const btn = $("loginBtn");
  btn.disabled = true;
  btn.textContent = "Logging in…";
  try {
    const session = await PosApi.signIn(username, password);
    $("loginPassword").value = "";
    await startSession(session);
  } catch (err) {
    console.error("Login failed:", err);
    const msg = String((err && err.message) || "");
    showLogin(/invalid login|invalid credentials|email not confirmed/i.test(msg)
      ? "Wrong user name or password."
      : "Couldn't reach the server. Check the internet connection and try again.");
  }
  btn.disabled = false;
  btn.textContent = "Log in";
});

$("logoutBtn").addEventListener("click", async () => {
  const notes = [];
  if (pendingSales.length) notes.push(`${plural(pendingSales.length, "sale")} not uploaded yet will upload when ${vendor.name} logs in again on this device.`);
  const open = orders.filter(o => o.cart.length).length;
  if (open) notes.push(`${plural(open, "open order")} stay${open === 1 ? "s" : ""} saved on this device for ${vendor.name}.`);
  if (!confirm(`Log out of ${vendor.name}?${notes.length ? `\n\n${notes.join("\n")}` : ""}`)) return;
  saveOrders();
  try {
    await PosApi.signOut();
  } catch (err) {
    console.warn("Sign out:", err);
  }
  location.reload(); // start clean for the next login
});

renderEmojiPicks();
setInterval(tickClock, 15000);
setInterval(tickClockTables, 30000);
setInterval(checkConnection, 30000);
PosApi.getSession()
  .then(session => (session ? startSession(session) : showLogin()))
  .catch(err => { console.error("Start failed:", err); showLogin(); });
