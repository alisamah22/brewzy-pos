# Touch POS

A simple browser-based touch POS front end for food sales.

## Features
- Touch-friendly food item buttons
- Search and category filters
- Add, edit, and delete products
- Cart quantity controls
- Automatic subtotal, 8% tax, and total
- Cash, bank transfer, and card payment options
- Cash received and change calculation
- Products saved in browser localStorage
- Responsive desktop, tablet, and mobile layout

## Run
Open `index.html` in Chrome, Edge, Firefox, or Safari.

For best results, use a small local server:
- VS Code: install Live Server, then open `index.html`
- Python: run `python -m http.server 8000` in this folder and visit `http://localhost:8000`

## Notes
This is a front-end demo. It does not process real card payments or save completed sales to a database.
Change `TAX_RATE` in `app.js` to modify the tax percentage.
