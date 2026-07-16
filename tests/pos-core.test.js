const test = require("node:test");
const assert = require("node:assert/strict");
const {
  money,
  localDateKey,
  calcTotals,
  cartToItems,
  aggregateSales,
  productError,
} = require("../pos-core.js");

test("money formats as MVR with two decimals", () => {
  assert.equal(money(20), "MVR 20.00");
  assert.equal(money(12.5), "MVR 12.50");
  assert.equal(money(0), "MVR 0.00");
});

test("localDateKey returns local YYYY-MM-DD (not UTC)", () => {
  const d = new Date(2026, 6, 16, 23, 30); // 16 Jul 2026 23:30 local; month is 0-based
  assert.equal(localDateKey(d), "2026-07-16");
});

test("calcTotals returns subtotal as total with no tax", () => {
  const cart = [
    { price: 20, qty: 2 },
    { price: 10, qty: 1 },
  ];
  const t = calcTotals(cart);
  assert.equal(t.subtotal, 50);
  assert.equal(t.tax, 0);
  assert.equal(t.total, 50);
});

test("cartToItems strips everything except name/price/qty", () => {
  const cart = [{ id: "x", name: "Brownie", price: 35, qty: 2, emoji: "🍫" }];
  assert.deepEqual(cartToItems(cart), [{ name: "Brownie", price: 35, qty: 2 }]);
});

test("aggregateSales merges products by name across sales", () => {
  const sales = [
    {
      payment_method: "Cash",
      total: 55,
      items: [
        { name: "Brownie", price: 35, qty: 1 },
        { name: "Sausage", price: 10, qty: 2 },
      ],
    },
    {
      payment_method: "Card",
      total: 35,
      items: [{ name: "Brownie", price: 35, qty: 1 }],
    },
  ];
  const r = aggregateSales(sales);
  assert.equal(r.paymentTotals.Cash, 55);
  assert.equal(r.paymentTotals.Card, 35);
  assert.equal(r.paymentTotals.Transfer, 0);
  assert.equal(r.grandTotal, 90);
  assert.equal(r.transactionCount, 2);
  assert.equal(r.itemCount, 4);
  const brownie = r.productRows.find((p) => p.name === "Brownie");
  assert.equal(brownie.qty, 2);
  assert.equal(brownie.sales, 70);
  assert.equal(r.productRows[0].name, "Brownie"); // qty tie -> name asc
});

test("productError returns null for valid input, message for invalid", () => {
  assert.equal(productError({ name: "Latte", price: 30, category: "Drinks" }), null);
  assert.equal(typeof productError({ name: "", price: 30, category: "Drinks" }), "string");
  assert.equal(typeof productError({ name: "X", price: -1, category: "Drinks" }), "string");
  assert.equal(typeof productError({ name: "X", price: NaN, category: "Drinks" }), "string");
  assert.equal(typeof productError({ name: "X", price: 30, category: "" }), "string");
});
