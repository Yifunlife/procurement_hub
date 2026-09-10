ALTER TABLE order_settlements ADD COLUMN finance_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(finance_confirmed IN (0, 1));
ALTER TABLE order_settlements ADD COLUMN invoice_required INTEGER CHECK(invoice_required IN (0, 1));

UPDATE order_settlements
SET finance_confirmed = 1
WHERE payable_cents IS NOT NULL;

UPDATE order_settlements
SET net_cents = (SELECT COALESCE(SUM(CAST(ROUND(amount * 100) AS INTEGER)), 0) FROM order_items WHERE order_id = order_settlements.order_id),
    tax_cents = 0,
    payable_cents = (SELECT COALESCE(SUM(CAST(ROUND(amount * 100) AS INTEGER)), 0) FROM order_items WHERE order_id = order_settlements.order_id)
WHERE payable_cents IS NULL;
