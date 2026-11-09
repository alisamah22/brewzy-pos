// supabase-api.js — all Supabase network access.
// Exposes window.PosApi. Requires the supabase-js UMD global (loaded before this).
const SUPABASE_URL = "https://uxpcnpkxathduehpqkyq.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_9Xou20b2C_H--LCbqEw11A_DDLvtqNQ";

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// --- Logins (Supabase Auth). A vendor signs in with a user name, which is
// the part before the @ of their login email. ---
const LOGIN_EMAIL_DOMAIN = "brewzy-pos.example.com";

function loginEmail(username) {
  const u = String(username || "").trim().toLowerCase();
  return u.includes("@") ? u : `${u}@${LOGIN_EMAIL_DOMAIN}`;
}

async function signIn(username, password) {
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email: loginEmail(username), password });
  if (error) throw error;
  return data.session;
}

async function getSession() {
  const { data } = await supabaseClient.auth.getSession();
  return data.session || null;
}

async function signOut() {
  await supabaseClient.auth.signOut({ scope: "local" });
}

// { id, username, name } of the logged-in vendor.
function vendorOf(session) {
  const email = (session.user && session.user.email) || "";
  const username = email.endsWith(`@${LOGIN_EMAIL_DOMAIN}`) ? email.split("@")[0] : email;
  const name = username.charAt(0).toUpperCase() + username.slice(1);
  return { id: session.user.id, username, name };
}

// Supabase returns at most 1000 rows per request, so page through results.
const PAGE_SIZE = 1000;

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
// The sale carries its own id (generated on the till), so a retry after a
// lost response can't create a duplicate: the second insert hits the primary
// key and is treated as "already saved".
async function insertSale(sale) {
  const { error } = await supabaseClient.from("sales").insert(sale);
  if (error && error.code !== "23505") throw error;
}

async function fetchSalesInRange(fromKey, toKey) {
  let rows = [];
  for (let start = 0; ; start += PAGE_SIZE) {
    const { data, error } = await supabaseClient
      .from("sales")
      .select("*")
      .gte("sale_date", fromKey)
      .lte("sale_date", toKey)
      .order("created_at", { ascending: true })
      .range(start, start + PAGE_SIZE - 1);
    if (error) throw error;
    rows = rows.concat(data || []);
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

// Sales are never deleted — a mistaken sale is marked void and excluded from
// report totals, but stays in the database.
async function setSaleVoided(id, voided) {
  const { error } = await supabaseClient
    .from("sales")
    .update({ voided, voided_at: voided ? new Date().toISOString() : null })
    .eq("id", id);
  if (error) throw error;
}

// --- Discarded stock ---
async function fetchDiscardsForProduct(productId) {
  const { data, error } = await supabaseClient
    .from("discards")
    .select("*")
    .eq("product_id", productId)
    .order("discard_date", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

async function fetchDiscardsInRange(fromKey, toKey) {
  let rows = [];
  for (let start = 0; ; start += PAGE_SIZE) {
    const { data, error } = await supabaseClient
      .from("discards")
      .select("*")
      .gte("discard_date", fromKey)
      .lte("discard_date", toKey)
      .order("discard_date", { ascending: true })
      .range(start, start + PAGE_SIZE - 1);
    if (error) throw error;
    rows = rows.concat(data || []);
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

async function insertDiscard(discard) {
  const { error } = await supabaseClient.from("discards").insert(discard);
  if (error) throw error;
}

async function updateDiscard(id, fields) {
  const { error } = await supabaseClient.from("discards").update(fields).eq("id", id);
  if (error) throw error;
}

async function deleteDiscard(id) {
  const { error } = await supabaseClient.from("discards").delete().eq("id", id);
  if (error) throw error;
}

// --- Bills (expenses), e.g. Expo prep shopping ---
async function fetchExpensesInRange(fromKey, toKey, scope) {
  let rows = [];
  for (let start = 0; ; start += PAGE_SIZE) {
    const { data, error } = await supabaseClient
      .from("expenses")
      .select("*")
      .eq("scope", scope)
      .gte("expense_date", fromKey)
      .lte("expense_date", toKey)
      .order("expense_date", { ascending: false })
      .order("created_at", { ascending: false })
      .range(start, start + PAGE_SIZE - 1);
    if (error) throw error;
    rows = rows.concat(data || []);
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

async function insertExpense(expense) {
  const { error } = await supabaseClient.from("expenses").insert(expense);
  if (error) throw error;
}

async function updateExpense(id, fields) {
  const { error } = await supabaseClient.from("expenses").update(fields).eq("id", id);
  if (error) throw error;
}

async function deleteExpense(id) {
  const { error } = await supabaseClient.from("expenses").delete().eq("id", id);
  if (error) throw error;
}

// --- Tables (Table 1, Table 2, ...) ---
async function fetchTables() {
  const { data, error } = await supabaseClient
    .from("dining_tables")
    .select("*")
    .order("sort", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

async function insertTables(rows) {
  const { error } = await supabaseClient.from("dining_tables").insert(rows);
  if (error) throw error;
}

async function updateTable(id, fields) {
  const { error } = await supabaseClient.from("dining_tables").update(fields).eq("id", id);
  if (error) throw error;
}

async function deleteTable(id) {
  const { error } = await supabaseClient.from("dining_tables").delete().eq("id", id);
  if (error) throw error;
}

// --- Named "pay later" orders, shared by every till ---
async function fetchPendingOrders() {
  const { data, error } = await supabaseClient
    .from("pending_orders")
    .select("*")
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

async function insertPendingOrder(order) {
  const { error } = await supabaseClient.from("pending_orders").insert(order);
  if (error) throw error;
}

async function updatePendingOrder(id, fields) {
  const { data, error } = await supabaseClient.from("pending_orders").update(fields).eq("id", id).select("id");
  if (error) throw error;
  return (data || []).length > 0; // false when it was already paid / deleted elsewhere
}

async function deletePendingOrder(id) {
  const { error } = await supabaseClient.from("pending_orders").delete().eq("id", id);
  if (error) throw error;
}

// Cheap query used to check the database is reachable.
async function ping() {
  const { error } = await supabaseClient.from("products").select("id").limit(1);
  if (error) throw error;
}

window.PosApi = {
  signIn, getSession, signOut, vendorOf,
  fetchProducts, insertProduct, updateProduct, deleteProduct,
  insertSale, fetchSalesInRange, setSaleVoided,
  fetchDiscardsForProduct, fetchDiscardsInRange, insertDiscard, updateDiscard, deleteDiscard,
  fetchExpensesInRange, insertExpense, updateExpense, deleteExpense,
  fetchPendingOrders, insertPendingOrder, updatePendingOrder, deletePendingOrder,
  fetchTables, insertTables, updateTable, deleteTable,
  ping,
};
