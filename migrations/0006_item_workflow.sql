ALTER TABLE order_items ADD COLUMN model TEXT NOT NULL DEFAULT '';
ALTER TABLE order_items ADD COLUMN completion_date TEXT;
ALTER TABLE order_items ADD COLUMN workflow_stage TEXT NOT NULL DEFAULT 'queued'
  CHECK (workflow_stage IN ('queued', 'in_production', 'production_complete', 'ready_to_ship', 'shipment_complete'));

UPDATE order_items
SET workflow_stage = CASE
  WHEN order_id IN (SELECT id FROM purchase_orders WHERE status IN ('shipped', 'received', 'completed')) THEN 'shipment_complete'
  WHEN order_id IN (SELECT id FROM purchase_orders WHERE status = 'ready_to_ship') THEN 'ready_to_ship'
  WHEN production_completed = 1 THEN 'production_complete'
  ELSE 'queued'
END;
