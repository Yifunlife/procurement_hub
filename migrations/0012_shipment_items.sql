ALTER TABLE order_items ADD COLUMN shipped_quantity INTEGER NOT NULL DEFAULT 0 CHECK (shipped_quantity >= 0 AND shipped_quantity <= quantity);
-- Completed historical deliveries are known at order level; do not invent batch allocations.
UPDATE order_items SET shipped_quantity = quantity WHERE order_id IN (SELECT id FROM purchase_orders WHERE status IN ('shipped', 'received', 'completed') OR shipment_status = 'complete');
CREATE TABLE shipment_items (
  shipment_id TEXT NOT NULL REFERENCES shipment_records(id),
  item_id TEXT NOT NULL REFERENCES order_items(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0 AND quantity = CAST(quantity AS INTEGER)),
  PRIMARY KEY (shipment_id, item_id)
);
CREATE TRIGGER shipment_item_validate BEFORE INSERT ON shipment_items
WHEN NOT EXISTS (SELECT 1 FROM order_items i JOIN shipment_records s ON s.id = NEW.shipment_id WHERE i.id = NEW.item_id AND i.order_id = s.order_id AND i.shipped_quantity + NEW.quantity <= i.quantity)
BEGIN
  SELECT RAISE(ABORT, '产品发货数量或归属无效，请刷新订单');
END;
CREATE TRIGGER shipment_item_apply AFTER INSERT ON shipment_items BEGIN
  UPDATE order_items SET shipped_quantity = shipped_quantity + NEW.quantity,
    workflow_stage = IIF(shipped_quantity + NEW.quantity = quantity, 'shipment_complete', workflow_stage)
    WHERE id = NEW.item_id;
END;
CREATE TRIGGER shipment_item_no_update BEFORE UPDATE ON shipment_items BEGIN SELECT RAISE(ABORT, '发货明细不可覆盖'); END;
CREATE TRIGGER shipment_item_no_delete BEFORE DELETE ON shipment_items BEGIN SELECT RAISE(ABORT, '发货明细不可删除'); END;
CREATE TRIGGER shipped_product_lock BEFORE UPDATE OF completion_date, workflow_stage ON order_items
WHEN (OLD.shipped_quantity > 0 AND NEW.shipped_quantity = OLD.shipped_quantity OR EXISTS (SELECT 1 FROM purchase_orders WHERE id = OLD.order_id AND status IN ('shipped', 'received', 'completed')))
AND (NEW.completion_date IS NOT OLD.completion_date OR NEW.workflow_stage IS NOT OLD.workflow_stage)
BEGIN SELECT RAISE(ABORT, '已发货产品的生产信息已锁定'); END;
