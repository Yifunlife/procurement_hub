DROP TRIGGER production_photo_item_guard;
CREATE TRIGGER production_photo_item_guard BEFORE INSERT ON attachments
WHEN NEW.kind = 'production_photo' AND NOT EXISTS (
  SELECT 1 FROM order_items i JOIN purchase_orders p ON p.id=i.order_id
  WHERE i.id=NEW.item_id AND i.order_id=NEW.order_id AND i.shipped_quantity=0
    AND p.status IN ('pending_confirmation','in_production','ready_to_ship') AND p.archived_at IS NULL
)
BEGIN SELECT RAISE(ABORT, '生产实拍必须关联未发货产品'); END;
