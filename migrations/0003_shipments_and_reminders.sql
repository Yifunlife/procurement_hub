PRAGMA foreign_keys = ON;

ALTER TABLE purchase_orders ADD COLUMN shipment_status TEXT NOT NULL DEFAULT 'none'
  CHECK (shipment_status IN ('none', 'partial', 'complete'));

CREATE TABLE shipment_records (
  id TEXT PRIMARY KEY,
  shipment_number TEXT NOT NULL UNIQUE,
  order_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  quantity REAL NOT NULL CHECK (quantity > 0),
  is_complete INTEGER NOT NULL DEFAULT 0 CHECK (is_complete IN (0, 1)),
  carrier TEXT NOT NULL,
  tracking_number TEXT NOT NULL,
  box_count INTEGER NOT NULL CHECK (box_count > 0),
  shipped_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX shipment_records_order_id_idx ON shipment_records(order_id);
CREATE INDEX shipment_records_shipped_at_idx ON shipment_records(shipped_at);

CREATE TABLE shipment_attachments (
  id TEXT PRIMARY KEY,
  shipment_id TEXT NOT NULL REFERENCES shipment_records(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('shipment_photo', 'delivery_note')),
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX shipment_attachments_shipment_id_idx ON shipment_attachments(shipment_id);
CREATE INDEX shipment_attachments_order_id_idx ON shipment_attachments(order_id);

CREATE TABLE order_reminders (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  reminder_key TEXT NOT NULL,
  reminder_type TEXT NOT NULL CHECK (reminder_type IN ('seven_days', 'three_days', 'one_day', 'due_today', 'overdue')),
  message TEXT NOT NULL,
  target_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(order_id, reminder_key)
);
CREATE INDEX order_reminders_order_id_idx ON order_reminders(order_id);
CREATE INDEX order_reminders_created_at_idx ON order_reminders(created_at);
