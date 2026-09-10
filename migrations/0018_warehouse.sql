CREATE TABLE staff_roles_next (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('purchaser','finance','boss','admin','department','warehouse'))
);
INSERT INTO staff_roles_next SELECT user_id, role FROM staff_roles;
DROP TABLE staff_roles;
ALTER TABLE staff_roles_next RENAME TO staff_roles;
ALTER TABLE order_items ADD COLUMN received_at TEXT;
ALTER TABLE order_items ADD COLUMN received_by TEXT;
ALTER TABLE order_items ADD COLUMN stocked_at TEXT;
ALTER TABLE order_items ADD COLUMN stocked_by TEXT;
CREATE TABLE warehouse_records (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES purchase_orders(id),
  item_id TEXT NOT NULL REFERENCES order_items(id),
  action TEXT NOT NULL CHECK(action IN ('received','stocked')),
  quantity INTEGER NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  actor_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(item_id, action)
);
CREATE TRIGGER warehouse_record_guard BEFORE INSERT ON warehouse_records
WHEN NOT EXISTS (
  SELECT 1 FROM order_items i JOIN purchase_orders po ON po.id=i.order_id
  WHERE i.id=NEW.item_id AND i.order_id=NEW.order_id AND po.archived_at IS NULL
  AND po.status IN ('ready_to_ship','shipped','received','completed')
  AND i.shipped_quantity=i.quantity AND NEW.quantity=i.quantity
  AND ((NEW.action='received' AND i.received_at IS NULL)
    OR (NEW.action='stocked' AND i.received_at IS NOT NULL AND i.stocked_at IS NULL))
)
BEGIN SELECT RAISE(ABORT, '请先核对发货及收货状态'); END;
CREATE TRIGGER warehouse_record_apply AFTER INSERT ON warehouse_records BEGIN
  UPDATE order_items SET received_at=NEW.created_at, received_by=NEW.actor_name
    WHERE id=NEW.item_id AND NEW.action='received';
  UPDATE order_items SET stocked_at=NEW.created_at, stocked_by=NEW.actor_name
    WHERE id=NEW.item_id AND NEW.action='stocked';
  UPDATE purchase_orders SET status='received', updated_at=NEW.created_at
    WHERE id=NEW.order_id AND status='shipped'
    AND NOT EXISTS(SELECT 1 FROM order_items WHERE order_id=NEW.order_id AND received_at IS NULL);
END;
CREATE TRIGGER warehouse_record_no_update BEFORE UPDATE ON warehouse_records
BEGIN SELECT RAISE(ABORT, '仓库记录不可覆盖'); END;
CREATE TRIGGER warehouse_record_no_delete BEFORE DELETE ON warehouse_records
BEGIN SELECT RAISE(ABORT, '仓库记录不可删除'); END;
