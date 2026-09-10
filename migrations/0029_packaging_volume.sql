ALTER TABLE order_items ADD COLUMN packaging_volume TEXT NOT NULL DEFAULT '';
ALTER TABLE order_items ADD COLUMN packaging_volume_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE order_items ADD COLUMN packaging_volume_by TEXT REFERENCES users(id);
ALTER TABLE order_items ADD COLUMN packaging_volume_at TEXT;
CREATE TRIGGER packaging_volume_history AFTER UPDATE OF packaging_volume ON order_items
WHEN NEW.packaging_volume != OLD.packaging_volume BEGIN
 INSERT INTO order_events(id,order_id,event_type,detail,actor_id,actor_name,created_at)
 SELECT lower(hex(randomblob(16))),NEW.order_id,'packaging_volume',NEW.product_name||' · 包装体积：'||
 CASE WHEN OLD.packaging_volume='' THEN '待填写' ELSE OLD.packaging_volume END||' → '||
 CASE WHEN NEW.packaging_volume='' THEN '待填写' ELSE NEW.packaging_volume END,
 NEW.packaging_volume_by,name,NEW.packaging_volume_at FROM users WHERE id=NEW.packaging_volume_by;
END;
