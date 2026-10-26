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
      case "all":
        return { from: "2020-01-01", to: today };
      case "lastMonth":
        return {
          from: localDateKey(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
          to: localDateKey(new Date(now.getFullYear(), now.getMonth(), 0)),
        };
      default:
        return { from: today, to: today };
    }
  }

  // A discount is a sale price set below the regular selling price. Blank
  // (null / undefined / "") means no discount.
  function hasDiscount(product) {
    const sale = product.sale_price;
    if (sale === null || sale === undefined || sale === "") return false;
    const n = Number(sale);
    return Number.isFinite(n) && n >= 0 && n < Number(product.price);
  }

  // What the customer pays for one now: the discount price, else the regular price.
  function sellingPrice(product) {
    return hasDiscount(product) ? round2(product.sale_price) : Number(product.price) || 0;
  }

  // Whole-number "% off" for display, e.g. 40 -> 30 is 25.
  function discountPercent(price, salePrice) {
    const p = Number(price) || 0;
    return p > 0 ? Math.round((1 - Number(salePrice) / p) * 100) : 0;
  }

  // Discount price for "N% off" a regular price.
  function priceAfterPercentOff(price, percent) {
    return round2((Number(price) || 0) * (1 - Number(percent) / 100));
  }

  // Expo items are sold at events and don't track stock or discards.
  function tracksStock(product) {
    return String(product.category || "").trim().toLowerCase() !== "expo";
  }

  // Expo events (Maldives time, UTC+5). From "start" to the end of "endDate"
  // every sale counts as Expo, whatever the items' category. Sales earlier
  // on the start day were test runs and are left out of every report total.
  // Add an entry here for each new Expo.
  const EXPOS = [
    { startDate: "2026-10-25", start: "2026-10-25T16:00:00+05:00", endDate: "2026-11-02" },
  ];

  function saleTime(sale) {
    const t = sale.created_at ? Date.parse(sale.created_at) : NaN;
    return Number.isFinite(t) ? t : null;
  }

  function isExpoSale(sale) {
    const key = sale.sale_date || "";
    const t = saleTime(sale);
    return EXPOS.some((e) => key >= e.startDate && key <= e.endDate &&
      (t === null || t >= Date.parse(e.start)));
  }

  function isTestSale(sale) {
    const t = saleTime(sale);
    return t !== null && EXPOS.some((e) => sale.sale_date === e.startDate && t < Date.parse(e.start));
  }

  // While "now" is before an Expo opens on its start day (test runs), the
  // opening time as a Date; otherwise null.
  function testModeUntil(now = new Date()) {
    const e = EXPOS.find((x) => localDateKey(now) === x.startDate && now.getTime() < Date.parse(x.start));
    return e ? new Date(Date.parse(e.start)) : null;
  }

  // Sales narrowed to one report: "expo" keeps the Expo items of each sale
  // (all of them during an Expo), "main" keeps the rest. Totals are
  // recomputed from the kept items; a sale with nothing kept is dropped.
  // "full_total" keeps the whole sale's total. "testRun" marks a sale made
  // before the Expo opened; while the test run is still on (before opening
  // time) those sales count, so the reports can be tried out, and once the
  // Expo opens they get "test" and are left out of every total.
  function scopeSales(sales, scope, now = new Date()) {
    const testing = Boolean(testModeUntil(now));
    const wantExpo = scope === "expo";
    const out = [];
    for (const sale of sales) {
      const expo = isExpoSale(sale);
      const items = (sale.items || []).filter((item) => (expo || !tracksStock(item)) === wantExpo);
      if (!items.length) continue;
      const total = round2(items.reduce((sum, i) => sum + Number(i.price || 0) * Number(i.qty || 0), 0));
      const testRun = isTestSale(sale);
      out.push({ ...sale, items, subtotal: total, total, full_total: Number(sale.total || 0), testRun, test: testRun && !testing });
    }
    return out;
  }

  function expenseError(fields) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.date || "")) return "Please pick the date of the bill.";
    const amount = Number(fields.amount);
    if (fields.amount === "" || !Number.isFinite(amount) || amount <= 0) return "Please enter the bill amount.";
    return null;
  }

  function sumExpenses(expenses) {
    return round2(expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0));
  }

  function calcTotals(cart) {
    const subtotal = round2(cart.reduce((sum, item) => sum + item.price * item.qty, 0));
    return { subtotal, tax: 0, total: subtotal };
  }

  // Snapshot of each cart line stored with the sale. Cost is captured at sale
  // time so later price changes don't rewrite past profit. "price" is what
  // was charged; a discounted line also keeps its regular price.
  function cartToItems(cart) {
    return cart.map((item) => {
      const line = {
        name: item.name,
        category: item.category,
        price: item.price,
        cost: Number(item.cost) || 0,
        qty: item.qty,
      };
      if (Number(item.regular_price) > item.price) line.regular_price = Number(item.regular_price);
      return line;
    });
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

  // Cost of one unit of a sold item: the cost saved with the sale, or, when
  // none was saved (cost prices added later), the item's current cost price
  // from "currentCost(name)". So cost prices entered later also fix past sales.
  function itemCost(item, currentCost) {
    const saved = Number(item.cost || 0);
    if (saved > 0 || !currentCost) return saved;
    return Number(currentCost(item.name) || 0);
  }

  // Roll an array of sale rows up into report figures. Voided sales are
  // excluded from every total. Products are keyed by NAME so identical items
  // merge into one row. "currentCost" (optional) fills in missing cost prices.
  function aggregateSales(sales, currentCost) {
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
    let testCount = 0;
    let itemsMissingCost = 0;
    let discountTotal = 0;
    let discountedQty = 0;
    let discountSales = 0;

    for (const sale of sales) {
      if (sale.voided) {
        voidedCount += 1;
        continue;
      }
      if (sale.test) {
        testCount += 1;
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
        const cost = itemCost(item, currentCost);
        // No buying price recorded (older sale, or item never given one).
        if (!(cost > 0)) itemsMissingCost += qty;
        itemCount += qty;
        costTotal += cost * qty;
        const regular = Number(item.regular_price || 0);
        if (regular > price) {
          discountTotal += (regular - price) * qty;
          discountedQty += qty;
          discountSales += price * qty;
        }

        const current = products.get(item.name) ||
          { name: item.name, category: item.category || "", qty: 0, sales: 0, cost: 0, profit: 0,
            discountQty: 0, discountSales: 0, discountPrices: [], regularQty: 0, regularSales: 0 };
        current.qty += qty;
        if (!(regular > price)) {
          current.regularQty += qty;
          current.regularSales = round2(current.regularSales + price * qty);
        }
        if (regular > price) {
          current.discountQty += qty;
          current.discountSales = round2(current.discountSales + price * qty);
          if (!current.discountPrices.includes(price)) current.discountPrices.push(price);
        }
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
      testCount,
      itemCount,
      itemsMissingCost,
      discountTotal: round2(discountTotal),
      discountedQty,
      discountSales: round2(discountSales),
      regularQty: itemCount - discountedQty,
      regularSales: round2(grandTotal - discountSales),
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
      if (!Number.isFinite(cost) || cost < 0) return "Please enter a valid stock price.";
    }
    if (fields.salePrice !== undefined && fields.salePrice !== "") {
      const sale = Number(fields.salePrice);
      if (!Number.isFinite(sale) || sale < 0) return "Please enter a valid discount price.";
      if (sale >= price) return "The discount price must be lower than the selling price.";
    }
    if (fields.stock !== undefined && fields.stock !== "") {
      const stock = Number(fields.stock);
      if (!Number.isInteger(stock) || stock < 0) return "Stock quantity must be a whole number (0 or more).";
    }
    return null;
  }

  function discardError(fields) {
    const qty = Number(fields.qty);
    if (fields.qty === "" || !Number.isInteger(qty) || qty <= 0) {
      return "Discarded quantity must be a whole number above 0.";
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.date || "")) return "Please pick the date it was discarded.";
    return null;
  }

  // Current stock per menu item, valued at stock (buying) price and selling
  // price. "difference" is selling minus stock price, per unit and in total.
  function stockSummary(products) {
    let totalQty = 0;
    let costValue = 0;
    let sellValue = 0;
    const rows = products.map((p) => {
      const qty = Number(p.stock_qty || 0);
      const cost = Number(p.cost || 0);
      const price = Number(p.price || 0);
      totalQty += qty;
      costValue += cost * qty;
      sellValue += price * qty;
      return {
        name: p.name, category: p.category || "", qty, cost, price,
        difference: round2(price - cost),
        costValue: round2(cost * qty),
        sellValue: round2(price * qty),
      };
    });
    costValue = round2(costValue);
    sellValue = round2(sellValue);
    return { rows, totalQty, costValue, sellValue, difference: round2(sellValue - costValue) };
  }

  // Roll discard rows up by product name. "loss" is what the discarded stock
  // cost (stock price × qty, using the price saved with the discard);
  // "lostSales" is what it would have sold for.
  function aggregateDiscards(discards) {
    const products = new Map();
    let qty = 0;
    let loss = 0;
    let lostSales = 0;
    let qtyMissingCost = 0;
    for (const d of discards) {
      const q = Number(d.qty || 0);
      const cost = Number(d.cost || 0);
      const price = Number(d.price || 0);
      qty += q;
      loss += cost * q;
      lostSales += price * q;
      if (!(cost > 0)) qtyMissingCost += q;
      const name = d.product_name;
      const current = products.get(name) || { name, qty: 0, loss: 0, lostSales: 0 };
      current.qty += q;
      current.loss = round2(current.loss + cost * q);
      current.lostSales = round2(current.lostSales + price * q);
      products.set(name, current);
    }
    return {
      qty,
      loss: round2(loss),
      lostSales: round2(lostSales),
      qtyMissingCost,
      byProduct: products,
    };
  }

  function csvCell(value) {
    const s = value === null || value === undefined ? "" : String(value);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  // One CSV line per item sold, for backups / spreadsheets.
  function salesToCsv(sales, currentCost) {
    const header = ["Date", "Time", "Sale ID", "Payment", "Item", "Category", "Qty",
      "Selling price", "Buying price", "Line total", "Line profit", "Voided",
      "Regular price", "Discount given"];
    const lines = [header.join(",")];
    for (const sale of sales) {
      const time = sale.created_at
        ? new Date(sale.created_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
        : "";
      for (const item of sale.items || []) {
        const qty = Number(item.qty || 0);
        const price = Number(item.price || 0);
        const cost = itemCost(item, currentCost);
        const regular = Number(item.regular_price || 0);
        const discounted = regular > price;
        lines.push([
          sale.sale_date, time, sale.id, sale.payment_method, item.name, item.category || "",
          qty, price.toFixed(2), cost.toFixed(2), (price * qty).toFixed(2),
          ((price - cost) * qty).toFixed(2), sale.voided ? "yes" : sale.test ? "test" : "",
          discounted ? regular.toFixed(2) : "", discounted ? ((regular - price) * qty).toFixed(2) : "",
        ].map(csvCell).join(","));
      }
    }
    return lines.join("\r\n");
  }

  const api = {
    round2, money, localDateKey, parseDateKey, addDays, dateRange, calcTotals, cartToItems,
    margin, quickCashOptions, aggregateSales, bestSellers, productError, salesToCsv,
    discardError, stockSummary, aggregateDiscards,
    hasDiscount, sellingPrice, discountPercent, priceAfterPercentOff, tracksStock,
    scopeSales, expenseError, sumExpenses, isExpoSale, isTestSale, testModeUntil,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PosCore = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
