ALTER TABLE order_items ADD COLUMN production_completed INTEGER NOT NULL DEFAULT 0 CHECK (production_completed IN (0, 1));
ALTER TABLE order_items ADD COLUMN production_completed_at TEXT;
ALTER TABLE order_items ADD COLUMN production_completed_by TEXT;

UPDATE order_items
SET production_completed = 1,
    production_completed_at = (SELECT updated_at FROM purchase_orders WHERE purchase_orders.id = order_items.order_id)
WHERE order_id IN (
  SELECT id FROM purchase_orders WHERE status IN ('ready_to_ship', 'shipped', 'received', 'completed')
);

