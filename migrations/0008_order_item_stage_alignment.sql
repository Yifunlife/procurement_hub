UPDATE order_items
SET workflow_stage = 'shipment_complete'
WHERE order_id IN (
  SELECT id FROM purchase_orders WHERE status IN ('shipped', 'received', 'completed')
);

UPDATE order_items
SET workflow_stage = 'ready_to_ship'
WHERE order_id IN (
  SELECT id FROM purchase_orders WHERE status = 'ready_to_ship'
)
AND workflow_stage <> 'shipment_complete';

UPDATE order_items
SET production_completed = CASE
  WHEN workflow_stage IN ('production_complete', 'ready_to_ship', 'shipment_complete') THEN 1
  ELSE 0
END;

UPDATE purchase_orders
SET production_progress = COALESCE((
  SELECT ROUND(100.0 * SUM(CASE WHEN workflow_stage IN ('production_complete', 'ready_to_ship', 'shipment_complete') THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0))
  FROM order_items
  WHERE order_items.order_id = purchase_orders.id
), 0);
