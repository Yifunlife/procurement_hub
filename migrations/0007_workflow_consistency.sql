UPDATE order_items
SET workflow_stage = CASE
  WHEN order_id IN (SELECT id FROM purchase_orders WHERE status IN ('shipped', 'received', 'completed')) THEN 'shipment_complete'
  WHEN order_id IN (SELECT id FROM purchase_orders WHERE status = 'ready_to_ship') THEN 'ready_to_ship'
  WHEN production_completed = 1 THEN 'production_complete'
  ELSE 'queued'
END
WHERE workflow_stage IS NULL
   OR workflow_stage NOT IN ('queued', 'in_production', 'production_complete', 'ready_to_ship', 'shipment_complete')
   OR (production_completed = 1 AND workflow_stage IN ('queued', 'in_production'));

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
