ALTER TABLE order_items ADD COLUMN acceptance_status TEXT NOT NULL DEFAULT 'pending' CHECK (acceptance_status IN ('pending','approved','rejected'));
ALTER TABLE order_items ADD COLUMN production_revision INTEGER NOT NULL DEFAULT 0;
CREATE TABLE product_acceptances (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES purchase_orders(id),
  item_id TEXT NOT NULL REFERENCES order_items(id),
  production_revision INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  reason TEXT NOT NULL,
  photo_ids TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  actor_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(item_id, production_revision)
);
CREATE TRIGGER product_acceptance_apply AFTER INSERT ON product_acceptances BEGIN
  UPDATE order_items SET acceptance_status = NEW.decision WHERE id = NEW.item_id;
  UPDATE purchase_orders SET status = 'ready_to_ship', updated_at = NEW.created_at
    WHERE id = NEW.order_id AND status = 'in_production' AND NEW.decision = 'approved';
END;
CREATE TRIGGER product_acceptance_no_update BEFORE UPDATE ON product_acceptances
BEGIN SELECT RAISE(ABORT, '验收记录不可覆盖'); END;
CREATE TRIGGER product_acceptance_no_delete BEFORE DELETE ON product_acceptances
BEGIN SELECT RAISE(ABORT, '验收记录不可删除'); END;
CREATE TRIGGER product_photo_recheck AFTER INSERT ON attachments WHEN NEW.kind = 'production_photo' BEGIN
  UPDATE order_items SET acceptance_status = 'pending', production_revision = production_revision + 1 WHERE id = NEW.item_id;
END;
CREATE TRIGGER product_progress_recheck AFTER UPDATE OF workflow_stage, completion_date ON order_items
WHEN NEW.shipped_quantity = 0 AND (NEW.workflow_stage IS NOT OLD.workflow_stage OR NEW.completion_date IS NOT OLD.completion_date)
BEGIN
  UPDATE order_items SET acceptance_status = 'pending', production_revision = production_revision + 1 WHERE id = NEW.id;
END;
CREATE TRIGGER shipment_acceptance_guard BEFORE INSERT ON shipment_items
WHEN NOT EXISTS (SELECT 1 FROM order_items WHERE id = NEW.item_id AND acceptance_status = 'approved')
BEGIN SELECT RAISE(ABORT, '产品未通过采购验收，不能发货'); END;
