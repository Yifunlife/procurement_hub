ALTER TABLE order_items ADD COLUMN freight_payment_status TEXT NOT NULL DEFAULT 'unknown' CHECK(freight_payment_status IN ('unknown','paid','unpaid'));
ALTER TABLE order_items ADD COLUMN freight_payment_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE order_items ADD COLUMN freight_payment_by TEXT REFERENCES users(id);
ALTER TABLE order_items ADD COLUMN freight_payment_at TEXT;
CREATE TRIGGER freight_payment_history AFTER UPDATE OF freight_payment_status ON order_items
WHEN NEW.freight_payment_status != OLD.freight_payment_status BEGIN
 INSERT INTO order_events(id,order_id,event_type,detail,actor_id,actor_name,created_at)
 SELECT lower(hex(randomblob(16))),NEW.order_id,'freight_payment',NEW.product_name||' · 运费支付状态：'||
 CASE OLD.freight_payment_status WHEN 'paid' THEN '已支付' WHEN 'unpaid' THEN '未支付' ELSE '待填写' END||' → '||
 CASE NEW.freight_payment_status WHEN 'paid' THEN '已支付' WHEN 'unpaid' THEN '未支付' ELSE '待填写' END,
 NEW.freight_payment_by,name,NEW.freight_payment_at FROM users WHERE id=NEW.freight_payment_by;
END;
