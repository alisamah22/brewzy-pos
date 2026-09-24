// app.js — DOM wiring for Brewzy POS.
// Pure logic: pos-core.js (PosCore). Supabase access: supabase-api.js (PosApi).

const {
  money, localDateKey, parseDateKey, addDays, dateRange, calcTotals, cartToItems, margin,
  quickCashOptions, aggregateSales, bestSellers, productError, salesToCsv,
} = PosCore;

const PRODUCTS_CACHE_KEY = "touchPosProducts";
const PENDING_SALES_KEY = "brewzyPendingSales";
const EMOJI_PICKS = ["🍔", "🌭", "🥪", "🍕", "🍟", "🥐", "🍩", "🍪", "🍫", "🍰", "🧁", "🍨",
  "☕", "🧋", "🥤", "🧃", "🍵", "🥗", "🍛", "🐟"];

const $ = (id) => document.getElementById(id);

// localStorage can throw (private mode, blocked storage) or hold bad JSON.
function readStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn("Couldn't write to local storage:", err);
  }
}

let products = readStore(PRODUCTS_CACHE_KEY, []);
let pendingSales = readStore(PENDING_SALES_KEY, []); // sales not yet uploaded
let menuLoaded = products.length > 0;
let cart = [];
let activeCategory = "All";
let paymentMethod = "Cash";
let online = null; // null = not checked yet
let saving = false;

const report = {
  preset: "today",
  sales: [],
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
  if (/column/i.test(msg) && /cost|voided/i.test(msg)) {
    return "The database needs a one-time update: run the migration SQL from the README.";
  }
  if (/permission denied|row-level security/i.test(msg)) {
    return "The database refused this change. Run the latest migration SQL from the README.";
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
  return { ...p, price: Number(p.price), cost: Number(p.cost || 0) };
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
  // Keep cart lines in step with any menu edits; drop deleted items.
  cart = cart
    .map(item => {
      const p = products.find(x => x.id === item.id);
      return p ? { ...p, qty: item.qty } : null;
    })
    .filter(Boolean);
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
  const inCart = new Map(cart.map(i => [i.id, i.qty]));
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
    return `
    <button class="product-card ${qty ? "in-cart" : ""}" data-id="${escapeHtml(product.id)}"
      aria-label="Add ${escapeHtml(product.name)}, ${money(product.price)}${qty ? `, ${qty} in order` : ""}">
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
  const existing = cart.find(item => item.id === id);
  if (existing) existing.qty += 1;
  else {
    const product = products.find(p => p.id === id);
    if (!product) return;
    cart.push({ ...product, qty: 1 });
  }
  renderCart();
  renderProducts();
  const card = document.querySelector(`.product-card[data-id="${CSS.escape(id)}"]`);
  if (card) card.classList.add("bump");
}

function updateQty(id, change) {
  const item = cart.find(i => i.id === id);
  if (!item) return;
  item.qty += change;
  if (item.qty <= 0) cart = cart.filter(i => i.id !== id);
  renderCart();
  renderProducts();
}

function clearCart() {
  cart = [];
  $("cashReceived").value = "";
  renderCart();
  renderProducts();
}

function renderCart() {
  const count = cart.reduce((sum, item) => sum + item.qty, 0);
  const t = calcTotals(cart);
  $("itemCount").textContent = plural(count, "item");
  $("clearCartBtn").hidden = !cart.length;

  $("cartItems").innerHTML = cart.length ? cart.map(item => `
    <div class="cart-row">
      <div class="cart-emoji" aria-hidden="true">${escapeHtml(item.emoji || "🍽️")}</div>
      <div class="cart-info">
        <h4>${escapeHtml(item.name)}</h4>
        <small>${money(item.price)} each</small>
      </div>
      <div class="qty-controls">
        <button class="qty-btn ${item.qty === 1 ? "remove" : ""}" data-id="${escapeHtml(item.id)}" data-change="-1"
          aria-label="${item.qty === 1 ? "Remove" : "One less"} ${escapeHtml(item.name)}">${item.qty === 1 ? "🗑" : "−"}</button>
        <span class="qty">${item.qty}</span>
        <button class="qty-btn" data-id="${escapeHtml(item.id)}" data-change="1" aria-label="One more ${escapeHtml(item.name)}">＋</button>
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
  $("mobileCartCount").textContent = plural(count, "item");
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
  else payBtn.textContent = `Charge ${money(total)} · ${paymentMethod}`;
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

  showReceipt(sale, received, uploaded);
  clearCart();
}

function showReceipt(sale, received, uploaded) {
  const time = new Date(sale.created_at).toLocaleString("en-GB", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
  const lines = sale.items.map(item => `
    <div class="r-line"><span>${item.qty} × ${escapeHtml(item.name)}</span><span>${money(item.price * item.qty)}</span></div>
  `).join("");
  const cash = sale.payment_method === "Cash" ? `
    <div class="r-line"><span>Cash received</span><span>${money(received)}</span></div>
    <div class="r-line r-change"><span>Change</span><strong>${money(received - sale.total)}</strong></div>` : "";

  $("receiptBody").innerHTML = `
    <div class="r-head"><strong>Brewzy</strong><span>${escapeHtml(time)}</span></div>
    ${lines}
    <div class="r-line r-total"><span>Total</span><strong>${money(sale.total)}</strong></div>
    <div class="r-line"><span>Paid by</span><span>${escapeHtml(sale.payment_method)}</span></div>
    ${cash}
    ${uploaded ? "" : `<div class="notice warn">⏳ No internet. The sale is saved on this device and will upload automatically when the connection is back.</div>`}
  `;
  $("receiptDialog").showModal();
  $("newOrderBtn").focus();
}

// ---------- Manage items ----------

function openManageItems() {
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
      : `<span class="chip-tag muted">No buying price</span>`;
    return `
    <div class="manage-row ${product.id === editingId ? "editing" : ""}">
      <div class="manage-emoji" aria-hidden="true">${escapeHtml(product.emoji || "🍽️")}</div>
      <div class="manage-info">
        <strong>${escapeHtml(product.name)}</strong>
        <small>${escapeHtml(product.category)} · Buy ${money(product.cost)} · Sell ${money(product.price)}</small>
        ${profitChip}
      </div>
      <div class="manage-actions">
        <button type="button" class="small-btn" data-edit="${escapeHtml(product.id)}">Edit</button>
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
    el.textContent = "Add the buying price to track profit in reports.";
    return;
  }
  const m = margin(priceRaw, costRaw);
  if (m.profit < 0) {
    el.classList.add("loss");
    el.textContent = `⚠️ Selling below buying price: a loss of ${money(-m.profit)} on each one.`;
  } else {
    el.classList.add("gain");
    el.textContent = `Profit per item: ${money(m.profit)} (${m.percent.toFixed(1)}% margin)`;
  }
}

function loadItemForEdit(id) {
  const product = products.find(p => p.id === id);
  if (!product) return;
  $("editingId").value = product.id;
  $("itemName").value = product.name;
  $("itemPrice").value = product.price;
  $("itemCost").value = product.cost || "";
  $("itemCategory").value = product.category;
  $("itemEmoji").value = product.emoji || "";
  $("formTitle").textContent = `Editing: ${product.name}`;
  $("saveItemBtn").textContent = "Save Changes";
  $("resetFormBtn").hidden = false;
  $("itemForm").classList.add("editing");
  updateMarginPreview();
  renderManageList();
  $("itemForm").scrollIntoView({ block: "nearest", behavior: "smooth" });
  $("itemName").focus();
}

function resetItemForm(focus = true) {
  ["editingId", "itemName", "itemPrice", "itemCost", "itemCategory", "itemEmoji"].forEach(id => { $(id).value = ""; });
  $("formTitle").textContent = "Add a new item";
  $("saveItemBtn").textContent = "Add Item";
  $("resetFormBtn").hidden = true;
  $("itemForm").classList.remove("editing");
  updateMarginPreview();
  renderManageList();
  if (focus) $("itemName").focus();
}

async function saveItem() {
  const fields = {
    name: $("itemName").value.trim(),
    category: $("itemCategory").value.trim(),
    price: $("itemPrice").value,
    cost: $("itemCost").value,
  };
  const editingId = $("editingId").value;

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
  toast(`${editingId ? "Updated" : "Added"} “${row.name}” ✓`, "success");
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

// ---------- Reports ----------

function formatDay(key, opts = { weekday: "short", day: "numeric", month: "short" }) {
  return parseDateKey(key).toLocaleDateString("en-GB", opts);
}

function openSalesReport() {
  report.showAllTransactions = false;
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
  try {
    sales = await PosApi.fetchSalesInRange(from, to);
    setOnline(true);
  } catch (err) {
    console.error("Failed to load report:", err);
    failed = true;
    if (isNetworkError(err)) setOnline(false);
  }
  if (token !== report.token) return; // a newer request replaced this one

  // Include sales still waiting to upload from this till.
  const ids = new Set(sales.map(s => s.id));
  const waiting = pendingSales
    .filter(s => s.sale_date >= from && s.sale_date <= to && !ids.has(s.id))
    .map(s => ({ ...s, pending: true }));
  report.sales = sales.concat(waiting).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  report.failed = failed;
  $("reportDialogBody").classList.remove("loading");
  renderReport();
}

function renderReport() {
  const { from, to } = reportRange();
  const r = aggregateSales(report.sales);

  $("reportTotal").textContent = money(r.grandTotal);
  // With no buying prices at all, "profit" would just repeat total sales.
  const noCosts = r.itemCount > 0 && r.itemsMissingCost === r.itemCount;
  $("reportProfit").textContent = noCosts ? "Not tracked" : money(r.profitTotal);
  $("reportMargin").textContent = noCosts ? "No buying prices yet"
    : r.grandTotal ? `${r.marginPercent.toFixed(1)}% margin` : "";
  $("reportCost").textContent = money(r.costTotal);
  $("reportTransactions").textContent = r.transactionCount;
  $("reportVoided").textContent = r.voidedCount ? `${r.voidedCount} voided` : "";
  $("reportItems").textContent = r.itemCount;
  $("reportAverage").textContent = money(r.averageSale);
  document.querySelector(".report-card.profit").classList.toggle("negative", r.profitTotal < 0);

  const notices = [];
  if (report.failed) notices.push(["error", "⚠️ Couldn't load sales from the database. Check the connection. Only sales saved on this device are shown."]);
  const waiting = report.sales.filter(s => s.pending).length;
  if (waiting) notices.push(["warn", `⏳ Includes ${plural(waiting, "sale")} saved on this device that haven't uploaded yet.`]);
  if (r.itemsMissingCost) notices.push(["info", `ℹ️ ${plural(r.itemsMissingCost, "item")} sold had no buying price, so the profit shown is higher than the real profit. Add buying prices in Manage Items.`]);
  const notice = $("reportNotice");
  notice.hidden = !notices.length;
  notice.innerHTML = notices.map(([cls, text]) => `<div class="notice ${cls}">${escapeHtml(text)}</div>`).join("");

  renderBestSellers(r);
  renderPaymentBreakdown(r);
  renderTimeChart(r, from, to);
  renderProductTable(r);
  renderTransactions();
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
  const unsold = products.filter(p => !soldNames.has(p.name)).map(p => p.name);

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
    points = [];
    for (let d = from; d <= to && points.length < 400; d = addDays(d, 1)) {
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

function renderProductTable(r) {
  const { sortKey, sortDir } = report;
  const rows = [...r.productRows].sort((a, b) => {
    const cmp = sortKey === "name" ? a.name.localeCompare(b.name) : a[sortKey] - b[sortKey];
    return cmp * sortDir || a.name.localeCompare(b.name);
  });
  document.querySelectorAll("#productTable th").forEach(th => {
    const active = th.dataset.sort === sortKey;
    th.classList.toggle("sorted", active);
    th.setAttribute("aria-sort", active ? (sortDir > 0 ? "ascending" : "descending") : "none");
    th.dataset.arrow = active ? (sortDir > 0 ? "▲" : "▼") : "";
  });
  $("productSalesBody").innerHTML = rows.length ? rows.map(item => `
    <tr>
      <td>${escapeHtml(productFor(item.name)?.emoji || "🍽️")} ${escapeHtml(item.name)}</td>
      <td>${item.qty}</td>
      <td>${money(item.sales)}</td>
      <td>${money(item.cost)}</td>
      <td class="${item.profit < 0 ? "loss-text" : ""}">${item.profit < 0 ? "−" : ""}${money(Math.abs(item.profit))}</td>
    </tr>
  `).join("") : `<tr><td colspan="5" class="report-empty">No sales recorded for this period.</td></tr>`;
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
    else if (sale.voided) action = `<button type="button" class="small-btn" data-unvoid="${escapeHtml(sale.id)}">Restore</button>`;
    else action = `<button type="button" class="small-btn delete" data-void="${escapeHtml(sale.id)}">Void</button>`;
    return `
    <div class="txn ${sale.voided ? "voided" : ""}">
      <div class="txn-time">${escapeHtml(date + time)}</div>
      <div class="txn-items">${escapeHtml(summary)}${sale.voided ? ` <span class="chip-tag muted">VOID</span>` : ""}</div>
      <div class="txn-method">${escapeHtml(sale.payment_method)}</div>
      <strong class="txn-total">${money(sale.total)}</strong>
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
    ? `Void this ${money(sale.total)} sale?\n\nIt will be left out of report totals but kept on record. You can restore it later.`
    : `Restore this ${money(sale.total)} sale into the report totals?`;
  if (!confirm(question)) return;
  try {
    await PosApi.setSaleVoided(id, voided);
  } catch (err) {
    console.error("Failed to void sale:", err);
    toast(`Couldn't update the sale. ${describeError(err)}`, "error", 8000);
    return;
  }
  sale.voided = voided;
  toast(voided ? "Sale voided" : "Sale restored", "success");
  renderReport();
}

function exportCsv() {
  const { from, to } = reportRange();
  if (!report.sales.length) {
    toast("No sales to export for this period.", "info");
    return;
  }
  const blob = new Blob(["﻿" + salesToCsv(report.sales)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = from === to ? `brewzy-sales-${from}.csv` : `brewzy-sales-${from}-to-${to}.csv`;
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

function tickClock() {
  $("clock").textContent = new Date().toLocaleString("en-GB", {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
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
  if (btn) updateQty(btn.dataset.id, Number(btn.dataset.change));
});

$("clearCartBtn").addEventListener("click", () => {
  if (cart.length && confirm("Clear the current order?")) clearCart();
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
$("cashReceived").addEventListener("input", updateChange);
$("cashReceived").addEventListener("keydown", e => {
  if (e.key === "Enter") processPayment();
});
$("payBtn").addEventListener("click", processPayment);
$("mobileCartBar").addEventListener("click", () => $("cartPanel").scrollIntoView({ behavior: "smooth" }));

$("newOrderBtn").addEventListener("click", () => $("receiptDialog").close());
$("printReceiptBtn").addEventListener("click", () => window.print());

// Manage items
$("manageItemsBtn").addEventListener("click", openManageItems);
$("closeItemDialogBtn").addEventListener("click", () => $("itemDialog").close());
$("saveItemBtn").addEventListener("click", saveItem);
$("resetFormBtn").addEventListener("click", () => resetItemForm());
$("manageSearch").addEventListener("input", renderManageList);
["itemPrice", "itemCost"].forEach(id => $(id).addEventListener("input", updateMarginPreview));
$("itemForm").addEventListener("keydown", e => {
  if (e.key === "Enter" && e.target.tagName === "INPUT") {
    e.preventDefault();
    saveItem();
  }
});
$("emojiPicks").addEventListener("click", e => {
  const pick = e.target.closest(".emoji-pick");
  if (pick) $("itemEmoji").value = pick.dataset.emoji;
});
$("manageItemList").addEventListener("click", e => {
  const edit = e.target.closest("[data-edit]");
  if (edit) return loadItemForEdit(edit.dataset.edit);
  const del = e.target.closest("[data-delete]");
  if (del) deleteItem(del.dataset.delete);
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
  renderBestSellers(aggregateSales(report.sales));
});
$("productTable").querySelector("thead").addEventListener("click", e => {
  const th = e.target.closest("th[data-sort]");
  if (!th) return;
  const key = th.dataset.sort;
  report.sortDir = report.sortKey === key ? -report.sortDir : (key === "name" ? 1 : -1);
  report.sortKey = key;
  renderProductTable(aggregateSales(report.sales));
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
setupTooltip($("salesReportDialog"));

// Keyboard: "/" jumps to search.
document.addEventListener("keydown", e => {
  if (e.key === "/" && !openDialogEl() && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
    e.preventDefault();
    $("searchInput").focus();
  }
});

window.addEventListener("online", () => { flushPending(); loadProducts(); });
window.addEventListener("offline", () => setOnline(false));

renderEmojiPicks();
tickClock();
setInterval(tickClock, 15000);
setInterval(checkConnection, 30000);
setPaymentMethod("Cash");
renderStatus();
renderAll();                          // instant paint from cached menu (if any)
loadProducts().then(flushPending);    // refresh the shared menu, upload saved sales
