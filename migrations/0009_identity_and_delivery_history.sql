-- Keep existing codes and dates; never infer dates that were not recorded.
ALTER TABLE suppliers ADD COLUMN archived_at TEXT;
ALTER TABLE purchase_orders ADD COLUMN archived_at TEXT;
ALTER TABLE purchase_orders ADD COLUMN estimated_ship_date TEXT;
ALTER TABLE purchase_orders ADD COLUMN delivery_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE purchase_orders ADD COLUMN delivery_actor_id TEXT REFERENCES users(id);
ALTER TABLE purchase_orders ADD COLUMN delivery_actor_name TEXT NOT NULL DEFAULT '';
ALTER TABLE purchase_orders ADD COLUMN delivery_change_reason TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX supplier_code_permanent ON suppliers(lower(trim(code)));
CREATE UNIQUE INDEX po_number_permanent ON purchase_orders(lower(trim(po_number)));

CREATE TABLE order_delivery_history (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES purchase_orders(id),
  kind TEXT NOT NULL CHECK(kind IN ('baseline', 'initial', 'estimate', 'required')),
  previous_date TEXT,
  new_date TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_id TEXT REFERENCES users(id),
  actor_name TEXT NOT NULL,
  changed_at TEXT
);
CREATE INDEX delivery_history_order ON order_delivery_history(order_id, changed_at);
UPDATE purchase_orders SET estimated_ship_date = promised_ship_date;
INSERT INTO order_delivery_history (id, order_id, kind, new_date, reason, actor_name)
SELECT lower(hex(randomblob(16))), id, 'baseline', promised_ship_date,
       '启用交期留痕前已保存的承诺日期；更早的修改记录和时间未记录。', '历史数据'
FROM purchase_orders WHERE promised_ship_date IS NOT NULL;

CREATE TRIGGER supplier_identity_fixed BEFORE UPDATE OF id, code ON suppliers
WHEN NEW.id IS NOT OLD.id OR NEW.code IS NOT OLD.code
BEGIN SELECT RAISE(ABORT, 'Supplier identity is immutable'); END;
CREATE TRIGGER po_identity_fixed BEFORE UPDATE OF id, po_number, supplier_id ON purchase_orders
WHEN NEW.id IS NOT OLD.id OR NEW.po_number IS NOT OLD.po_number OR NEW.supplier_id IS NOT OLD.supplier_id
BEGIN SELECT RAISE(ABORT, 'PO identity is immutable'); END;
CREATE TRIGGER supplier_keep_identity BEFORE DELETE ON suppliers
BEGIN SELECT RAISE(ABORT, 'Archive suppliers instead of deleting'); END;
CREATE TRIGGER po_keep_history BEFORE DELETE ON purchase_orders
BEGIN SELECT RAISE(ABORT, 'Archive orders instead of deleting'); END;
CREATE TRIGGER archived_po_read_only BEFORE UPDATE ON purchase_orders
WHEN OLD.archived_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'Archived orders are read only'); END;
CREATE TRIGGER original_promise_fixed BEFORE UPDATE OF promised_ship_date ON purchase_orders
WHEN OLD.promised_ship_date IS NOT NULL AND NEW.promised_ship_date IS NOT OLD.promised_ship_date
BEGIN SELECT RAISE(ABORT, 'Original promised date is immutable'); END;
CREATE TRIGGER delivery_audit_required BEFORE UPDATE OF promised_ship_date, estimated_ship_date, required_ship_date ON purchase_orders
WHEN (NEW.promised_ship_date IS NOT OLD.promised_ship_date OR NEW.estimated_ship_date IS NOT OLD.estimated_ship_date OR NEW.required_ship_date IS NOT OLD.required_ship_date)
 AND (NEW.delivery_actor_id IS NULL OR trim(NEW.delivery_actor_name) = '' OR trim(NEW.delivery_change_reason) = '' OR NEW.delivery_revision != OLD.delivery_revision + 1)
BEGIN SELECT RAISE(ABORT, 'Delivery changes require revision, actor and reason'); END;
CREATE TRIGGER initial_promise_history AFTER UPDATE OF promised_ship_date ON purchase_orders
WHEN OLD.promised_ship_date IS NULL AND NEW.promised_ship_date IS NOT NULL
BEGIN
  INSERT INTO order_delivery_history VALUES (lower(hex(randomblob(16))), NEW.id, 'initial', NULL, NEW.promised_ship_date, NEW.delivery_change_reason, NEW.delivery_actor_id, NEW.delivery_actor_name, NEW.updated_at);
END;
CREATE TRIGGER estimate_history AFTER UPDATE OF estimated_ship_date ON purchase_orders
WHEN OLD.promised_ship_date IS NOT NULL AND NEW.estimated_ship_date IS NOT OLD.estimated_ship_date
BEGIN
  INSERT INTO order_delivery_history VALUES (lower(hex(randomblob(16))), NEW.id, 'estimate', OLD.estimated_ship_date, NEW.estimated_ship_date, NEW.delivery_change_reason, NEW.delivery_actor_id, NEW.delivery_actor_name, NEW.updated_at);
END;
CREATE TRIGGER required_date_history AFTER UPDATE OF required_ship_date ON purchase_orders
WHEN NEW.required_ship_date IS NOT OLD.required_ship_date
BEGIN
  INSERT INTO order_delivery_history VALUES (lower(hex(randomblob(16))), NEW.id, 'required', OLD.required_ship_date, NEW.required_ship_date, NEW.delivery_change_reason, NEW.delivery_actor_id, NEW.delivery_actor_name, NEW.updated_at);
END;
CREATE TRIGGER delivery_history_no_update BEFORE UPDATE ON order_delivery_history
BEGIN SELECT RAISE(ABORT, 'Delivery history is append only'); END;
CREATE TRIGGER delivery_history_no_delete BEFORE DELETE ON order_delivery_history
BEGIN SELECT RAISE(ABORT, 'Delivery history is append only'); END;
CREATE TRIGGER events_no_update BEFORE UPDATE ON order_events
BEGIN SELECT RAISE(ABORT, 'Order events are append only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON order_events
BEGIN SELECT RAISE(ABORT, 'Order events are append only'); END;

CREATE TRIGGER item_commercial_fields_fixed BEFORE UPDATE OF id, order_id, quantity, unit_price, amount ON order_items
WHEN NEW.id IS NOT OLD.id OR NEW.order_id IS NOT OLD.order_id OR NEW.quantity IS NOT OLD.quantity OR NEW.unit_price IS NOT OLD.unit_price OR NEW.amount IS NOT OLD.amount
BEGIN SELECT RAISE(ABORT, 'Ordered quantities and prices are fixed'); END;
CREATE TRIGGER archived_items_read_only BEFORE UPDATE ON order_items
WHEN EXISTS (SELECT 1 FROM purchase_orders WHERE id = OLD.order_id AND archived_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'Archived order items are read only'); END;
CREATE TRIGGER archived_attachments_read_only BEFORE INSERT ON attachments
WHEN EXISTS (SELECT 1 FROM purchase_orders WHERE id = NEW.order_id AND archived_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'Cannot add files to archived orders'); END;
CREATE TRIGGER archived_shipments_read_only BEFORE INSERT ON shipment_records
WHEN EXISTS (SELECT 1 FROM purchase_orders WHERE id = NEW.order_id AND archived_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'Cannot ship archived orders'); END;
