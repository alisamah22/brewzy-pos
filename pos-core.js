// pos-core.js — pure POS logic. No DOM, no network.
// Exposed as window.PosCore in the browser and module.exports in Node.
(function (root) {
  // Round to 2 decimals so 0.1 + 0.2 style float drift never reaches a total.
  function round2(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  }

  function money(value) {
    const n = Number(value) || 0;
    return `MVR ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function localDateKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  // "2026-09-24" -> local Date at midnight (not UTC).
  function parseDateKey(key) {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function addDays(key, days) {
    const date = parseDateKey(key);
    date.setDate(date.getDate() + days);
    return localDateKey(date);
  }

  // Inclusive { from, to } date keys for a report preset.
  function dateRange(preset, now = new Date()) {
    const today = localDateKey(now);
    switch (preset) {
      case "yesterday": {
        const y = addDays(today, -1);
        return { from: y, to: y };
      }
      case "week":
        return { from: addDays(today, -6), to: today };
      case "month":
        return { from: localDateKey(new Date(now.getFullYear(), now.getMonth(), 1)), to: today };
      case "lastMonth":
        return {
          from: localDateKey(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
          to: localDateKey(new Date(now.getFullYear(), now.getMonth(), 0)),
        };
      default:
        return { from: today, to: today };
    }
  }

  function calcTotals(cart) {
    const subtotal = round2(cart.reduce((sum, item) => sum + item.price * item.qty, 0));
    return { subtotal, tax: 0, total: subtotal };
  }

  // Snapshot of each cart line stored with the sale. Cost is captured at sale
  // time so later price changes don't rewrite past profit.
  function cartToItems(cart) {
    return cart.map((item) => ({
      name: item.name,
      category: item.category,
      price: item.price,
      cost: Number(item.cost) || 0,
      qty: item.qty,
    }));
  }

  // Profit per unit and margin % of the selling price.
  function margin(price, cost) {
    const p = Number(price) || 0;
    const profit = round2(p - (Number(cost) || 0));
    return { profit, percent: p > 0 ? (profit / p) * 100 : 0 };
  }

  // Suggested "cash received" amounts: exact, then the next round notes above.
  function quickCashOptions(total) {
    if (!(total > 0)) return [];
    const notes = [10, 20, 50, 100, 200, 500, 1000];
    const rounded = [...new Set(notes.map((n) => Math.ceil(total / n) * n))]
      .filter((v) => v > total)
      .sort((a, b) => a - b)
      .slice(0, 3);
    return [round2(total), ...rounded];
  }

  // Roll an array of sale rows up into report figures. Voided sales are
  // excluded from every total. Products are keyed by NAME so identical items
  // merge into one row.
  function aggregateSales(sales) {
    const paymentTotals = { Cash: 0, Card: 0, Transfer: 0 };
    const paymentCounts = { Cash: 0, Card: 0, Transfer: 0 };
    const products = new Map();
    const byHour = new Array(24).fill(0);
    const byDay = new Map();
    let itemCount = 0;
    let grandTotal = 0;
    let costTotal = 0;
    let transactionCount = 0;
    let voidedCount = 0;
    let itemsMissingCost = 0;

    for (const sale of sales) {
      if (sale.voided) {
        voidedCount += 1;
        continue;
      }
      transactionCount += 1;
      const total = Number(sale.total || 0);
      const method = sale.payment_method;
      paymentTotals[method] = (paymentTotals[method] || 0) + total;
      paymentCounts[method] = (paymentCounts[method] || 0) + 1;
      grandTotal += total;

      if (sale.created_at) byHour[new Date(sale.created_at).getHours()] += total;
      if (sale.sale_date) byDay.set(sale.sale_date, (byDay.get(sale.sale_date) || 0) + total);

      for (const item of sale.items || []) {
        const qty = Number(item.qty || 0);
        const price = Number(item.price || 0);
        const cost = Number(item.cost || 0);
        // No buying price recorded (older sale, or item never given one).
        if (!(cost > 0)) itemsMissingCost += qty;
        itemCount += qty;
        costTotal += cost * qty;

        const current = products.get(item.name) ||
          { name: item.name, category: item.category || "", qty: 0, sales: 0, cost: 0, profit: 0 };
        current.qty += qty;
        current.sales = round2(current.sales + price * qty);
        current.cost = round2(current.cost + cost * qty);
        current.profit = round2(current.sales - current.cost);
        products.set(item.name, current);
      }
    }

    const productRows = [...products.values()].sort(
      (a, b) => b.qty - a.qty || a.name.localeCompare(b.name)
    );

    grandTotal = round2(grandTotal);
    costTotal = round2(costTotal);
    for (const key of Object.keys(paymentTotals)) paymentTotals[key] = round2(paymentTotals[key]);

    return {
      paymentTotals,
      paymentCounts,
      grandTotal,
      costTotal,
      profitTotal: round2(grandTotal - costTotal),
      marginPercent: grandTotal > 0 ? ((grandTotal - costTotal) / grandTotal) * 100 : 0,
      transactionCount,
      voidedCount,
      itemCount,
      itemsMissingCost,
      averageSale: transactionCount ? round2(grandTotal / transactionCount) : 0,
      productRows,
      byHour: byHour.map(round2),
      byDay: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))
        .map(([date, total]) => ({ date, total: round2(total) })),
    };
  }

  // Top N product rows by "qty" | "sales" | "profit".
  function bestSellers(productRows, by = "qty", limit = 5) {
    return [...productRows]
      .sort((a, b) => b[by] - a[by] || a.name.localeCompare(b.name))
      .filter((row) => row[by] > 0)
      .slice(0, limit);
  }

  function productError(fields) {
    const name = (fields.name || "").trim();
    const category = (fields.category || "").trim();
    const price = Number(fields.price);
    if (!name) return "Please enter the item name.";
    if (!category) return "Please enter a category.";
    if (fields.price === "" || !Number.isFinite(price) || price < 0) {
      return "Please enter a valid selling price.";
    }
    if (fields.cost !== undefined && fields.cost !== "") {
      const cost = Number(fields.cost);
      if (!Number.isFinite(cost) || cost < 0) return "Please enter a valid buying price.";
    }
    return null;
  }

  function csvCell(value) {
    const s = value === null || value === undefined ? "" : String(value);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  // One CSV line per item sold, for backups / spreadsheets.
  function salesToCsv(sales) {
    const header = ["Date", "Time", "Sale ID", "Payment", "Item", "Category", "Qty",
      "Selling price", "Buying price", "Line total", "Line profit", "Voided"];
    const lines = [header.join(",")];
    for (const sale of sales) {
      const time = sale.created_at
        ? new Date(sale.created_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
        : "";
      for (const item of sale.items || []) {
        const qty = Number(item.qty || 0);
        const price = Number(item.price || 0);
        const cost = Number(item.cost || 0);
        lines.push([
          sale.sale_date, time, sale.id, sale.payment_method, item.name, item.category || "",
          qty, price.toFixed(2), cost.toFixed(2), (price * qty).toFixed(2),
          ((price - cost) * qty).toFixed(2), sale.voided ? "yes" : "",
        ].map(csvCell).join(","));
      }
    }
    return lines.join("\r\n");
  }

  const api = {
    round2, money, localDateKey, parseDateKey, addDays, dateRange, calcTotals, cartToItems,
    margin, quickCashOptions, aggregateSales, bestSellers, productError, salesToCsv,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PosCore = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
