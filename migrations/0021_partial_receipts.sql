ALTER TABLE order_items ADD COLUMN received_quantity INTEGER NOT NULL DEFAULT 0;
ALTER TABLE order_items ADD COLUMN stocked_quantity INTEGER NOT NULL DEFAULT 0;
DROP TRIGGER archived_items_read_only;
UPDATE order_items SET received_quantity=COALESCE((SELECT SUM(quantity) FROM warehouse_records WHERE item_id=order_items.id AND action='received'),0), stocked_quantity=COALESCE((SELECT SUM(quantity) FROM warehouse_records WHERE item_id=order_items.id AND action='stocked'),0);
CREATE TRIGGER archived_items_read_only BEFORE UPDATE ON order_items
WHEN EXISTS (SELECT 1 FROM purchase_orders WHERE id=OLD.order_id AND archived_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'Archived order items are read only'); END;
DROP TRIGGER warehouse_record_guard;
DROP TRIGGER warehouse_record_apply;
DROP TRIGGER warehouse_record_no_update;
DROP TRIGGER warehouse_record_no_delete;
CREATE TABLE warehouse_records_next (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES purchase_orders(id),
 item_id TEXT NOT NULL REFERENCES order_items(id), action TEXT NOT NULL CHECK(action IN ('received','stocked')),
 quantity INTEGER NOT NULL CHECK(typeof(quantity)='integer' AND quantity>=1),
 actor_id TEXT NOT NULL REFERENCES users(id), actor_name TEXT NOT NULL, created_at TEXT NOT NULL
);
INSERT INTO warehouse_records_next SELECT * FROM warehouse_records;
DROP TABLE warehouse_records;
ALTER TABLE warehouse_records_next RENAME TO warehouse_records;
CREATE INDEX warehouse_records_item ON warehouse_records(item_id,created_at);
CREATE TRIGGER warehouse_record_guard BEFORE INSERT ON warehouse_records
WHEN NOT EXISTS (
 SELECT 1 FROM order_items i JOIN purchase_orders po ON po.id=i.order_id
 WHERE i.id=NEW.item_id AND i.order_id=NEW.order_id AND po.archived_at IS NULL
 AND po.status IN ('ready_to_ship','shipped','received','completed')
 AND ((NEW.action='received' AND NEW.quantity<=i.shipped_quantity-i.received_quantity)
 OR (NEW.action='stocked' AND NEW.quantity<=i.received_quantity-i.stocked_quantity))
)
BEGIN SELECT RAISE(ABORT,'仓库数量超过可登记数量或订单已锁定'); END;
CREATE TRIGGER warehouse_record_apply AFTER INSERT ON warehouse_records BEGIN
 UPDATE order_items SET received_quantity=received_quantity+NEW.quantity, received_at=NEW.created_at, received_by=NEW.actor_name WHERE id=NEW.item_id AND NEW.action='received';
 UPDATE order_items SET stocked_quantity=stocked_quantity+NEW.quantity, stocked_at=NEW.created_at, stocked_by=NEW.actor_name WHERE id=NEW.item_id AND NEW.action='stocked';
 UPDATE purchase_orders SET status='received',updated_at=NEW.created_at WHERE id=NEW.order_id AND status='shipped'
 AND NOT EXISTS(SELECT 1 FROM order_items WHERE order_id=NEW.order_id AND received_quantity<quantity);
END;
CREATE TRIGGER warehouse_record_no_update BEFORE UPDATE ON warehouse_records BEGIN SELECT RAISE(ABORT,'仓库记录不可覆盖'); END;
CREATE TRIGGER warehouse_record_no_delete BEFORE DELETE ON warehouse_records BEGIN SELECT RAISE(ABORT,'仓库记录不可删除'); END;
