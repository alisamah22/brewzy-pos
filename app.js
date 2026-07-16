const SUPABASE_URL = "https://uxpcnpkxathduehpqkyq.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_9Xou20b2C_H--LCbqEw11A_DDLvtqNQ";

const supabaseClient = supabase.createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY
);

async function testSupabaseConnection() {
  const { data, error } = await supabaseClient
    .from("sales")
    .select("*")
    .limit(1);

  if (error) {
    console.error("❌ Supabase connection failed:", error);
  } else {
    console.log("✅ Supabase connected successfully:", data);
  }
}

testSupabaseConnection();

const TAX_RATE = 0.08;

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
const money = (value) => `MVR ${Number(value).toFixed(2)}`;

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

function totals() {
  const subtotal = cart.reduce((sum, item) => sum + item.price * item.qty, 0);
  const tax = subtotal * TAX_RATE;
  return { subtotal, tax, total: subtotal + tax };
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

  const t = totals();
  $("subtotal").textContent = money(t.subtotal);
  $("tax").textContent = money(t.tax);
  $("total").textContent = money(t.total);
  $("payBtn").textContent = `Pay ${money(t.total)}`;
  $("payBtn").disabled = cart.length === 0;
  updateChange();
}

function updateChange() {
  const total = totals().total;
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

function processPayment() {
  if (!cart.length) return;
  const t = totals();

  if (paymentMethod === "Cash") {
    const received = Number($("cashReceived").value || 0);
    if (received < t.total) {
      alert(`Cash received must be at least ${money(t.total)}.`);
      $("cashReceived").focus();
      return;
    }
  }

  const count = cart.reduce((sum, item) => sum + item.qty, 0);
  let message = `${count} item${count === 1 ? "" : "s"} paid by ${paymentMethod}.<br><strong>Total: ${money(t.total)}</strong>`;

  if (paymentMethod === "Cash") {
    const change = Number($("cashReceived").value) - t.total;
    message += `<br>Change: ${money(change)}`;
  }

  $("receiptText").innerHTML = message;
  $("receiptDialog").showModal();
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

