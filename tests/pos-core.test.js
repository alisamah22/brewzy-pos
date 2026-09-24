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
  assert.ok(lines[1].endsWith(",2,15.00,5.00,30.00,20.00,"));
});
