const test = require("node:test");
const assert = require("node:assert/strict");
const {
  round2,
  money,
  localDateKey,
  addDays,
  dateRange,
  calcTotals,
  cartToItems,
  margin,
  quickCashOptions,
  aggregateSales,
  bestSellers,
  productError,
  salesToCsv,
  discardError,
  stockSummary,
  aggregateDiscards,
  hasDiscount,
  sellingPrice,
  discountPercent,
  priceAfterPercentOff,
  tracksStock,
  scopeSales,
  expenseError,
  sumExpenses,
  isExpoSale,
  isTestSale,
} = require("../pos-core.js");

test("money formats as MVR with two decimals and thousands separators", () => {
  assert.equal(money(20), "MVR 20.00");
  assert.equal(money(12.5), "MVR 12.50");
  assert.equal(money(0), "MVR 0.00");
  assert.equal(money(1234.5), "MVR 1,234.50");
});

test("round2 removes float drift", () => {
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2(12.345), 12.35);
});

test("localDateKey returns local YYYY-MM-DD (not UTC)", () => {
  const d = new Date(2026, 6, 16, 23, 30); // 16 Jul 2026 23:30 local; month is 0-based
  assert.equal(localDateKey(d), "2026-07-16");
});

test("addDays crosses month and year boundaries", () => {
  assert.equal(addDays("2026-09-30", 1), "2026-10-01");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
});

test("dateRange presets", () => {
  const now = new Date(2026, 8, 24, 10, 0); // 24 Sep 2026
  assert.deepEqual(dateRange("today", now), { from: "2026-09-24", to: "2026-09-24" });
  assert.deepEqual(dateRange("yesterday", now), { from: "2026-09-23", to: "2026-09-23" });
  assert.deepEqual(dateRange("week", now), { from: "2026-09-18", to: "2026-09-24" });
  assert.deepEqual(dateRange("month", now), { from: "2026-09-01", to: "2026-09-24" });
  assert.deepEqual(dateRange("lastMonth", now), { from: "2026-08-01", to: "2026-08-31" });
  const jan = new Date(2026, 0, 5);
  assert.deepEqual(dateRange("lastMonth", jan), { from: "2025-12-01", to: "2025-12-31" });
});

test("calcTotals returns subtotal as total with no tax, rounded", () => {
  const t = calcTotals([{ price: 20, qty: 2 }, { price: 10, qty: 1 }]);
  assert.equal(t.subtotal, 50);
  assert.equal(t.tax, 0);
  assert.equal(t.total, 50);
  assert.equal(calcTotals([{ price: 0.1, qty: 1 }, { price: 0.2, qty: 1 }]).total, 0.3);
});

test("cartToItems keeps name/category/price/cost/qty only", () => {
  const cart = [{ id: "x", name: "Brownie", category: "Desserts", price: 35, cost: 20, qty: 2, emoji: "🍫" }];
  assert.deepEqual(cartToItems(cart), [{ name: "Brownie", category: "Desserts", price: 35, cost: 20, qty: 2 }]);
  assert.equal(cartToItems([{ name: "X", price: 5, qty: 1 }])[0].cost, 0);
});

test("margin gives profit and percent of selling price", () => {
  assert.deepEqual(margin(40, 25), { profit: 15, percent: 37.5 });
  assert.equal(margin(10, 12).profit, -2);
  assert.equal(margin(0, 0).percent, 0);
});

test("quickCashOptions: exact first, then next round notes", () => {
  assert.deepEqual(quickCashOptions(75), [75, 80, 100, 200]);
  assert.deepEqual(quickCashOptions(100), [100, 200, 500, 1000]);
  assert.deepEqual(quickCashOptions(0), []);
});

const sampleSales = [
  {
    id: "a", sale_date: "2026-09-23", created_at: "2026-09-23T04:10:00Z",
    payment_method: "Cash", total: 55,
    items: [
      { name: "Brownie", price: 35, cost: 20, qty: 1 },
      { name: "Sausage", price: 10, cost: 4, qty: 2 },
    ],
  },
  {
    id: "b", sale_date: "2026-09-24", created_at: "2026-09-24T05:00:00Z",
    payment_method: "Card", total: 35,
    items: [{ name: "Brownie", price: 35, cost: 20, qty: 1 }],
  },
  {
    id: "c", sale_date: "2026-09-24", created_at: "2026-09-24T06:00:00Z",
    payment_method: "Cash", total: 100, voided: true,
    items: [{ name: "Brownie", price: 50, cost: 20, qty: 2 }],
  },
];

test("aggregateSales merges products by name and skips voided sales", () => {
  const r = aggregateSales(sampleSales);
  assert.equal(r.paymentTotals.Cash, 55);
  assert.equal(r.paymentTotals.Card, 35);
  assert.equal(r.paymentTotals.Transfer, 0);
  assert.equal(r.paymentCounts.Cash, 1);
  assert.equal(r.grandTotal, 90);
  assert.equal(r.costTotal, 48);
  assert.equal(r.profitTotal, 42);
  assert.equal(r.transactionCount, 2);
  assert.equal(r.voidedCount, 1);
  assert.equal(r.itemCount, 4);
  assert.equal(r.averageSale, 45);
  assert.equal(r.itemsMissingCost, 0);
  const brownie = r.productRows.find((p) => p.name === "Brownie");
  assert.equal(brownie.qty, 2);
  assert.equal(brownie.sales, 70);
  assert.equal(brownie.profit, 30);
  assert.equal(r.productRows[0].name, "Brownie"); // qty tie -> name asc
  assert.deepEqual(r.byDay, [{ date: "2026-09-23", total: 55 }, { date: "2026-09-24", total: 35 }]);
  assert.equal(r.byHour.reduce((a, b) => a + b, 0), 90);
});

test("aggregateSales counts old sales without a buying price", () => {
  const r = aggregateSales([{ payment_method: "Cash", total: 20, items: [{ name: "Old", price: 10, qty: 2 }] }]);
  assert.equal(r.itemsMissingCost, 2);
  assert.equal(r.profitTotal, 20);
});

test("bestSellers ranks by the chosen measure", () => {
  const rows = aggregateSales(sampleSales).productRows;
  assert.deepEqual(bestSellers(rows, "qty").map((r) => r.name), ["Brownie", "Sausage"]);
  assert.deepEqual(bestSellers(rows, "sales", 1).map((r) => r.name), ["Brownie"]);
  assert.equal(bestSellers([], "qty").length, 0);
});

test("productError validates name, category, selling and buying price", () => {
  assert.equal(productError({ name: "Latte", price: 30, cost: 12, category: "Drinks" }), null);
  assert.equal(productError({ name: "Latte", price: 30, cost: "", category: "Drinks" }), null);
  assert.equal(typeof productError({ name: "", price: 30, category: "Drinks" }), "string");
  assert.equal(typeof productError({ name: "X", price: -1, category: "Drinks" }), "string");
  assert.equal(typeof productError({ name: "X", price: "", category: "Drinks" }), "string");
  assert.equal(typeof productError({ name: "X", price: NaN, category: "Drinks" }), "string");
  assert.equal(typeof productError({ name: "X", price: 30, category: "" }), "string");
  assert.equal(typeof productError({ name: "X", price: 30, cost: -5, category: "Drinks" }), "string");
});

test("salesToCsv writes one line per item and escapes commas/quotes", () => {
  const csv = salesToCsv([{
    id: "z", sale_date: "2026-09-24", created_at: "2026-09-24T05:00:00Z", payment_method: "Cash",
    items: [{ name: 'Tea, "large"', category: "Drinks", price: 15, cost: 5, qty: 2 }],
  }]);
  const lines = csv.split("\r\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[1].includes('"Tea, ""large"""'));
  assert.ok(lines[1].endsWith(",2,15.00,5.00,30.00,20.00,,,"));
});

test("productError validates stock quantity as a whole number", () => {
  const base = { name: "Latte", price: 30, cost: 12, category: "Drinks" };
  assert.equal(productError({ ...base, stock: "" }), null);
  assert.equal(productError({ ...base, stock: "0" }), null);
  assert.equal(productError({ ...base, stock: "24" }), null);
  assert.equal(typeof productError({ ...base, stock: "-1" }), "string");
  assert.equal(typeof productError({ ...base, stock: "2.5" }), "string");
});

test("discardError needs a positive whole quantity and a date", () => {
  assert.equal(discardError({ qty: "3", date: "2026-10-12" }), null);
  assert.equal(typeof discardError({ qty: "", date: "2026-10-12" }), "string");
  assert.equal(typeof discardError({ qty: "0", date: "2026-10-12" }), "string");
  assert.equal(typeof discardError({ qty: "1.5", date: "2026-10-12" }), "string");
  assert.equal(typeof discardError({ qty: "2", date: "" }), "string");
});

test("stockSummary totals quantity, value at stock and selling price, and the difference", () => {
  const s = stockSummary([
    { name: "Brownie", price: 35, cost: 20, stock_qty: 10 },
    { name: "Tea", price: 15, cost: 0, stock_qty: 4 },
    { name: "Old", price: 5, cost: 2 }, // no stock column yet
  ]);
  assert.equal(s.totalQty, 14);
  assert.equal(s.costValue, 200);
  assert.equal(s.sellValue, 410);
  assert.equal(s.difference, 210);
  assert.equal(s.rows[0].difference, 15);
  assert.equal(s.rows[2].qty, 0);
});

test("aggregateDiscards sums quantity, loss at stock price and lost sales by product", () => {
  const d = aggregateDiscards([
    { product_name: "Brownie", qty: 2, cost: 20, price: 35 },
    { product_name: "Brownie", qty: 1, cost: 20, price: 35 },
    { product_name: "Tea", qty: 3, cost: 0, price: 15 },
  ]);
  assert.equal(d.qty, 6);
  assert.equal(d.loss, 60);
  assert.equal(d.lostSales, 150);
  assert.equal(d.qtyMissingCost, 3);
  assert.deepEqual(d.byProduct.get("Brownie"), { name: "Brownie", qty: 3, loss: 60, lostSales: 105 });
  assert.equal(aggregateDiscards([]).loss, 0);
});

test("hasDiscount / sellingPrice use the discount price only when it is below the regular price", () => {
  assert.equal(sellingPrice({ price: 40, sale_price: 30 }), 30);
  assert.equal(sellingPrice({ price: 40, sale_price: null }), 40);
  assert.equal(sellingPrice({ price: 40 }), 40);
  assert.equal(sellingPrice({ price: 40, sale_price: 40 }), 40); // not lower: no discount
  assert.equal(sellingPrice({ price: 40, sale_price: 0 }), 0); // free
  assert.equal(hasDiscount({ price: 40, sale_price: "" }), false);
  assert.equal(hasDiscount({ price: 40, sale_price: "25" }), true);
});

test("discountPercent and priceAfterPercentOff", () => {
  assert.equal(discountPercent(40, 30), 25);
  assert.equal(discountPercent(0, 0), 0);
  assert.equal(priceAfterPercentOff(40, 25), 30);
  assert.equal(priceAfterPercentOff(35, 15), 29.75);
});

test("productError checks the discount price is valid and below the selling price", () => {
  const base = { name: "Latte", price: "30", cost: "12", category: "Drinks" };
  assert.equal(productError({ ...base, salePrice: "" }), null);
  assert.equal(productError({ ...base, salePrice: "25" }), null);
  assert.equal(typeof productError({ ...base, salePrice: "30" }), "string");
  assert.equal(typeof productError({ ...base, salePrice: "35" }), "string");
  assert.equal(typeof productError({ ...base, salePrice: "-1" }), "string");
});

test("discounted cart lines keep their regular price, and reports total the discount given", () => {
  const items = cartToItems([
    { name: "Brownie", category: "Desserts", price: 30, regular_price: 40, cost: 20, qty: 2 },
    { name: "Tea", category: "Drinks", price: 15, regular_price: 15, cost: 5, qty: 1 },
  ]);
  assert.equal(items[0].regular_price, 40);
  assert.equal("regular_price" in items[1], false);

  const r = aggregateSales([
    { payment_method: "Cash", total: 75, items },
    { payment_method: "Cash", total: 30, voided: true, items: [items[0]] },
  ]);
  assert.equal(r.grandTotal, 75);
  assert.equal(r.discountTotal, 20);
  assert.equal(r.discountedQty, 2);
  assert.equal(r.profitTotal, 30);

  const csv = salesToCsv([{ id: "s", sale_date: "2026-10-25", payment_method: "Cash", items: [items[0]] }]);
  assert.ok(csv.split("\r\n")[1].endsWith(",,40.00,20.00"));
});

test("stockSummary values stock at the discount price while one is set", () => {
  const s = stockSummary([{ name: "Brownie", price: 40, sale_price: 30, cost: 20, stock_qty: 2 }]);
  assert.equal(s.sellValue, 60);
  assert.equal(s.rows[0].difference, 10);
});

test("tracksStock is off for the Expo category only", () => {
  assert.equal(tracksStock({ category: "Desserts" }), true);
  assert.equal(tracksStock({ category: "Expo" }), false);
  assert.equal(tracksStock({ category: " expo " }), false);
  assert.equal(tracksStock({}), true);
});

test("scopeSales splits sales into Expo and main items", () => {
  const sales = [
    { id: "a", total: 80, items: [
      { name: "Boava Wrap", category: "Expo", price: 60, qty: 1 },
      { name: "Tea", category: "Drinks", price: 10, qty: 2 },
    ] },
    { id: "b", total: 10, items: [{ name: "Tea", category: "Drinks", price: 10, qty: 1 }] },
  ];
  const expo = scopeSales(sales, "expo");
  assert.equal(expo.length, 1);
  assert.equal(expo[0].total, 60);
  assert.equal(expo[0].full_total, 80);
  assert.deepEqual(expo[0].items.map(i => i.name), ["Boava Wrap"]);
  const main = scopeSales(sales, "main");
  assert.deepEqual(main.map(s => s.total), [20, 10]);
});

test("expenseError and sumExpenses", () => {
  assert.equal(expenseError({ date: "2026-10-25", description: "Flour", amount: "120" }), null);
  assert.equal(typeof expenseError({ date: "", description: "Flour", amount: "120" }), "string");
  assert.equal(typeof expenseError({ date: "2026-10-25", description: " ", amount: "120" }), "string");
  assert.equal(typeof expenseError({ date: "2026-10-25", description: "Flour", amount: "0" }), "string");
  assert.equal(sumExpenses([{ amount: 120.5 }, { amount: "79.5" }]), 200);
});

test("dateRange all covers everything up to today", () => {
  assert.deepEqual(dateRange("all", new Date(2026, 9, 25)), { from: "2020-01-01", to: "2026-10-25" });
});

test("Expo runs from 25 Oct 2026 16:00 to 2 Nov; earlier sales that day are test runs", () => {
  const sale = (date, iso) => ({ sale_date: date, created_at: iso });
  assert.equal(isExpoSale(sale("2026-10-25", "2026-10-25T11:30:00Z")), true); // 16:30 Maldives
  assert.equal(isExpoSale(sale("2026-10-25", "2026-10-25T10:30:00Z")), false); // 15:30 Maldives
  assert.equal(isTestSale(sale("2026-10-25", "2026-10-25T10:30:00Z")), true);
  assert.equal(isTestSale(sale("2026-10-25", "2026-10-25T11:00:00Z")), false); // exactly 16:00
  assert.equal(isExpoSale(sale("2026-11-02", "2026-11-02T15:00:00Z")), true);
  assert.equal(isExpoSale(sale("2026-11-03", "2026-11-03T05:00:00Z")), false);
  assert.equal(isTestSale(sale("2026-10-26", "2026-10-26T03:00:00Z")), false);

  const tea = { name: "Tea", category: "Drinks", price: 10, qty: 1 };
  const sales = [
    { id: "test", sale_date: "2026-10-25", created_at: "2026-10-25T09:00:00Z", payment_method: "Cash", total: 10, items: [tea] },
    { id: "expo", sale_date: "2026-10-28", created_at: "2026-10-28T09:00:00Z", payment_method: "Cash", total: 10, items: [tea] },
    { id: "main", sale_date: "2026-11-05", created_at: "2026-11-05T09:00:00Z", payment_method: "Cash", total: 10, items: [tea] },
  ];
  assert.deepEqual(scopeSales(sales, "expo").map(s => s.id), ["expo"]);
  const main = scopeSales(sales, "main");
  assert.deepEqual(main.map(s => [s.id, s.test]), [["test", true], ["main", false]]);
  const r = aggregateSales(main);
  assert.equal(r.grandTotal, 10);
  assert.equal(r.testCount, 1);
  assert.equal(r.transactionCount, 1);
});
