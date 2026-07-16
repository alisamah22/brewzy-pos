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
