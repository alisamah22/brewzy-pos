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
