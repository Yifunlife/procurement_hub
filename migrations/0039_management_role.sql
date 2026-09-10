CREATE TABLE staff_roles_next (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('purchaser','finance','boss','admin','management','engineering','warehouse','office'))
);
INSERT INTO staff_roles_next SELECT user_id, role FROM staff_roles;

-- These guards reference staff_roles, so remove them before replacing the table.
DROP TRIGGER IF EXISTS production_photo_delete_guard;
DROP TRIGGER IF EXISTS warehouse_record_guard;

DROP TABLE staff_roles;
ALTER TABLE staff_roles_next RENAME TO staff_roles;

-- Restore the guards after the role table is in place.
CREATE TRIGGER production_photo_delete_guard BEFORE UPDATE OF deleted_at ON attachments
WHEN NEW.deleted_at IS NOT OLD.deleted_at AND (
 OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL OR OLD.kind!='production_photo'
 OR NOT (
  EXISTS(SELECT 1 FROM staff_roles WHERE user_id=NEW.deleted_by AND role='admin')
  OR EXISTS(SELECT 1 FROM staff_permissions WHERE user_id=NEW.deleted_by AND supplier_operations=1)
 )
 OR NOT EXISTS(SELECT 1 FROM order_items i JOIN purchase_orders p ON p.id=i.order_id WHERE i.id=OLD.item_id AND i.shipped_quantity=0 AND p.archived_at IS NULL)
)
BEGIN SELECT RAISE(ABORT,'实拍照片已锁定或无权删除'); END;

CREATE TRIGGER warehouse_record_guard BEFORE INSERT ON warehouse_records
WHEN NOT EXISTS (
 SELECT 1 FROM order_items i JOIN purchase_orders po ON po.id=i.order_id
 WHERE i.id=NEW.item_id AND i.order_id=NEW.order_id AND po.archived_at IS NULL
 AND (
  (EXISTS(SELECT 1 FROM staff_roles WHERE user_id=NEW.actor_id AND role='admin')
   AND ((NEW.action='received' AND NEW.quantity<=i.quantity-i.received_quantity)
    OR (NEW.action='stocked' AND NEW.quantity<=i.received_quantity-i.stocked_quantity)))
  OR (po.status IN ('ready_to_ship','shipped','received','completed')
   AND ((NEW.action='received' AND NEW.quantity<=i.shipped_quantity-i.received_quantity)
    OR (NEW.action='stocked' AND NEW.quantity<=i.received_quantity-i.stocked_quantity)))
 )
)
BEGIN SELECT RAISE(ABORT,'仓库数量超过可登记数量或订单已锁定'); END;
