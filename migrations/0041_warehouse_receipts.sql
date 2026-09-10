CREATE TABLE warehouse_receipts (
  id TEXT PRIMARY KEY REFERENCES warehouse_records(id),
  order_id TEXT NOT NULL REFERENCES purchase_orders(id),
  item_id TEXT NOT NULL REFERENCES order_items(id),
  received_quantity INTEGER NOT NULL CHECK(typeof(received_quantity)='integer' AND received_quantity>=1),
  received_date TEXT NOT NULL,
  received_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_inspection' CHECK(status IN ('pending_inspection','passed','exception','stocked')),
  exception_type TEXT,
  exception_quantity INTEGER,
  exception_notes TEXT NOT NULL DEFAULT '',
  inspected_at TEXT,
  inspected_by TEXT,
  stocked_quantity INTEGER NOT NULL DEFAULT 0 CHECK(typeof(stocked_quantity)='integer' AND stocked_quantity>=0),
  warehouse_name TEXT NOT NULL DEFAULT '',
  storage_location TEXT NOT NULL DEFAULT '',
  stocked_at TEXT,
  stocked_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(exception_type IS NULL OR exception_type IN ('shortage','overage','wrong_item','damaged','specification','other')),
  CHECK(exception_quantity IS NULL OR (typeof(exception_quantity)='integer' AND exception_quantity>=1 AND exception_quantity<=received_quantity)),
  CHECK(stocked_quantity<=received_quantity)
);
CREATE INDEX warehouse_receipts_status_idx ON warehouse_receipts(status,updated_at);
CREATE INDEX warehouse_receipts_item_idx ON warehouse_receipts(item_id,created_at);

CREATE TABLE warehouse_receipt_attachments (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES warehouse_receipts(id),
  order_id TEXT NOT NULL REFERENCES purchase_orders(id),
  item_id TEXT NOT NULL REFERENCES order_items(id),
  kind TEXT NOT NULL CHECK(kind IN ('arrival_photo','delivery_note','exception_photo')),
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX warehouse_receipt_attachments_receipt_idx ON warehouse_receipt_attachments(receipt_id,created_at);

-- Existing receipt records predate the dedicated warehouse page. Preserve them and put
-- them into the new inspection queue instead of inventing an inspection outcome.
INSERT INTO warehouse_receipts(id,order_id,item_id,received_quantity,received_date,received_by,status,created_at,updated_at)
SELECT id,order_id,item_id,quantity,COALESCE(record_date,substr(created_at,1,10)),actor_name,'pending_inspection',created_at,created_at
FROM warehouse_records WHERE action='received';

-- A historical SKU with exactly one receipt and matching stock record can safely be
-- shown as stocked. Split historical receipts remain pending for a warehouse check.
UPDATE warehouse_receipts
SET stocked_quantity=received_quantity,status='stocked',updated_at=created_at
WHERE (SELECT COUNT(*) FROM warehouse_records r WHERE r.item_id=warehouse_receipts.item_id AND r.action='received')=1
  AND (SELECT COALESCE(SUM(quantity),0) FROM warehouse_records r WHERE r.item_id=warehouse_receipts.item_id AND r.action='stocked')=warehouse_receipts.received_quantity;
