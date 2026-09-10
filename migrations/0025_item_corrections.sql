CREATE TABLE item_corrections (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES purchase_orders(id), item_id TEXT NOT NULL REFERENCES order_items(id),
 action TEXT NOT NULL CHECK(action IN ('acceptance','received','stocked')),
 quantity INTEGER NOT NULL CHECK(typeof(quantity)='integer' AND quantity>=1), reason TEXT NOT NULL CHECK(length(trim(reason))>0),
 expected_revision INTEGER NOT NULL, expected_received INTEGER NOT NULL, expected_stocked INTEGER NOT NULL,
 actor_id TEXT NOT NULL REFERENCES users(id), actor_name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TRIGGER item_correction_guard BEFORE INSERT ON item_corrections
WHEN NOT EXISTS(SELECT 1 FROM order_items i JOIN purchase_orders p ON p.id=i.order_id
 WHERE i.id=NEW.item_id AND i.order_id=NEW.order_id AND p.archived_at IS NULL
 AND i.production_revision=NEW.expected_revision AND i.received_quantity=NEW.expected_received AND i.stocked_quantity=NEW.expected_stocked
 AND ((NEW.action='acceptance' AND i.acceptance_status IN ('approved','rejected') AND i.shipped_quantity=0 AND i.received_quantity=0 AND i.stocked_quantity=0)
 OR (NEW.action='received' AND NEW.quantity<=i.received_quantity-i.stocked_quantity)
 OR (NEW.action='stocked' AND NEW.quantity<=i.stocked_quantity)))
BEGIN SELECT RAISE(ABORT,'更正状态已变化或存在后续记录，请先撤销后续操作'); END;
CREATE TRIGGER item_correction_apply AFTER INSERT ON item_corrections BEGIN
 UPDATE order_items SET acceptance_status='pending',production_revision=production_revision+1 WHERE id=NEW.item_id AND NEW.action='acceptance';
 UPDATE order_items SET received_quantity=received_quantity-NEW.quantity,
 received_at=CASE WHEN received_quantity=NEW.quantity THEN NULL ELSE received_at END,
 received_by=CASE WHEN received_quantity=NEW.quantity THEN NULL ELSE received_by END WHERE id=NEW.item_id AND NEW.action='received';
 UPDATE order_items SET stocked_quantity=stocked_quantity-NEW.quantity,
 stocked_at=CASE WHEN stocked_quantity=NEW.quantity THEN NULL ELSE stocked_at END,
 stocked_by=CASE WHEN stocked_quantity=NEW.quantity THEN NULL ELSE stocked_by END WHERE id=NEW.item_id AND NEW.action='stocked';
 UPDATE purchase_orders SET status='shipped',updated_at=NEW.created_at WHERE id=NEW.order_id AND status IN ('received','completed') AND NEW.action='received';
 UPDATE purchase_orders SET status='received',updated_at=NEW.created_at WHERE id=NEW.order_id AND status='completed' AND NEW.action='stocked';
 INSERT INTO order_events(id,order_id,event_type,detail,actor_id,actor_name,created_at)
 SELECT NEW.id,NEW.order_id,'item_correction',product_name||' · '||CASE NEW.action WHEN 'acceptance' THEN '撤销验收' WHEN 'received' THEN '撤销收货 '||NEW.quantity WHEN 'stocked' THEN '撤销入库 '||NEW.quantity END||' · 原因：'||NEW.reason,NEW.actor_id,NEW.actor_name,NEW.created_at FROM order_items WHERE id=NEW.item_id;
END;
CREATE TRIGGER item_correction_no_update BEFORE UPDATE ON item_corrections BEGIN SELECT RAISE(ABORT,'更正记录不可覆盖'); END;
CREATE TRIGGER item_correction_no_delete BEFORE DELETE ON item_corrections BEGIN SELECT RAISE(ABORT,'更正记录不可删除'); END;
