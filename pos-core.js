// pos-core.js — pure POS logic. No DOM, no network.
// Exposed as window.PosCore in the browser and module.exports in Node.
(function (root) {
  function money(value) {
    return `MVR ${Number(value).toFixed(2)}`;
  }

  function localDateKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function calcTotals(cart) {
    const subtotal = cart.reduce((sum, item) => sum + item.price * item.qty, 0);
    return { subtotal, tax: 0, total: subtotal };
  }

  function cartToItems(cart) {
    return cart.map((item) => ({
      name: item.name,
      price: item.price,
      qty: item.qty,
    }));
  }

  // Roll an array of sale rows up into report figures. Products are keyed by
  // NAME so identical items merge into one row.
  function aggregateSales(sales) {
    const paymentTotals = { Cash: 0, Card: 0, Transfer: 0 };
    const products = new Map();
    let itemCount = 0;
    let grandTotal = 0;

    for (const sale of sales) {
      const method = sale.payment_method;
      paymentTotals[method] = (paymentTotals[method] || 0) + Number(sale.total || 0);
      grandTotal += Number(sale.total || 0);

      for (const item of sale.items || []) {
        const qty = Number(item.qty || 0);
        itemCount += qty;
        const current = products.get(item.name) || { name: item.name, qty: 0, sales: 0 };
        current.qty += qty;
        current.sales += Number(item.price || 0) * qty;
        products.set(item.name, current);
      }
    }

    const productRows = [...products.values()].sort(
      (a, b) => b.qty - a.qty || a.name.localeCompare(b.name)
    );

    return {
      paymentTotals,
      grandTotal,
      transactionCount: sales.length,
      itemCount,
      productRows,
    };
  }

  function productError(fields) {
    const name = (fields.name || "").trim();
    const category = (fields.category || "").trim();
    const price = Number(fields.price);
    if (!name || !category || !Number.isFinite(price) || price < 0) {
      return "Please enter a valid name, category, and price.";
    }
    return null;
  }

  const api = {
    money, localDateKey, calcTotals, cartToItems, aggregateSales, productError,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PosCore = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
