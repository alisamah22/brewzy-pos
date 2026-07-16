# Touch POS with Daily Sales Report

A browser-based touch POS front end for food sales.

## Features
- Touch-friendly food item buttons
- Search and category filters
- Add, edit, and delete products
- Cart quantity controls
- Automatic subtotal, 8% tax, and total
- Cash, bank transfer, and card payment options
- Cash received and change calculation
- Products saved in browser localStorage
- Completed sales saved in browser localStorage
- Daily cash, card, transfer, and total sales
- Daily transaction count and total number of items sold
- Quantity and sales amount for each product sold
- Responsive desktop, tablet, and mobile layout

## Run
Open `index_updated.html` in Chrome, Edge, Firefox, or Safari.

For best results, use a small local server:
- VS Code: install Live Server, then open `index_updated.html`
- Python: run `python -m http.server 8000` in this folder and visit `http://localhost:8000/index_updated.html`

## Notes
This is a front-end POS. It does not process real card payments or use a remote database. Sales and products are stored in the browser's localStorage.
