// supabase-api.js — all Supabase network access.
// Exposes window.PosApi. Requires the supabase-js UMD global (loaded before this).
const SUPABASE_URL = "https://uxpcnpkxathduehpqkyq.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_9Xou20b2C_H--LCbqEw11A_DDLvtqNQ";

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

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

// Cheap query used to check the database is reachable.
async function ping() {
  const { error } = await supabaseClient.from("products").select("id").limit(1);
  if (error) throw error;
}

window.PosApi = {
  fetchProducts, insertProduct, updateProduct, deleteProduct,
  insertSale, fetchSalesInRange, setSaleVoided, ping,
};
