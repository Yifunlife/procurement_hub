ALTER TABLE attachments ADD COLUMN deleted_at TEXT;
ALTER TABLE attachments ADD COLUMN deleted_by TEXT REFERENCES users(id);
CREATE TRIGGER production_photo_delete_guard BEFORE UPDATE OF deleted_at ON attachments
WHEN NEW.deleted_at IS NOT OLD.deleted_at AND (
 OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL OR OLD.kind!='production_photo'
 OR NOT EXISTS(SELECT 1 FROM staff_roles WHERE user_id=NEW.deleted_by AND role='admin')
 OR NOT EXISTS(SELECT 1 FROM order_items i JOIN purchase_orders p ON p.id=i.order_id WHERE i.id=OLD.item_id AND i.shipped_quantity=0 AND p.archived_at IS NULL)
)
BEGIN SELECT RAISE(ABORT,'实拍照片已锁定或无权删除'); END;
CREATE TRIGGER production_photo_delete_recheck AFTER UPDATE OF deleted_at ON attachments
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL BEGIN
 UPDATE order_items SET acceptance_status='pending',production_revision=production_revision+1 WHERE id=NEW.item_id;
 INSERT INTO order_events(id,order_id,event_type,detail,actor_id,actor_name,created_at)
 SELECT lower(hex(randomblob(16))),NEW.order_id,'photo_deleted','管理员删除错误实拍照片：'||NEW.file_name,NEW.deleted_by,name,NEW.deleted_at FROM users WHERE id=NEW.deleted_by;
END;
DROP TRIGGER warehouse_record_guard;
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
