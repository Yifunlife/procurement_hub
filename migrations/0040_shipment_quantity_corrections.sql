CREATE TABLE shipment_quantity_corrections (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES purchase_orders(id),
  shipment_id TEXT NOT NULL REFERENCES shipment_records(id),
  item_id TEXT NOT NULL REFERENCES order_items(id),
  previous_quantity INTEGER NOT NULL CHECK(previous_quantity >= 0),
  corrected_quantity INTEGER NOT NULL CHECK(corrected_quantity >= 0),
  delta_quantity INTEGER NOT NULL CHECK(delta_quantity != 0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','applied','rejected')),
  requested_by TEXT NOT NULL REFERENCES users(id),
  requested_by_name TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  decided_by TEXT REFERENCES users(id),
  decided_by_name TEXT,
  decided_at TEXT,
  decision_note TEXT
);
CREATE INDEX shipment_quantity_corrections_shipment_idx ON shipment_quantity_corrections(shipment_id, item_id, requested_at);
CREATE INDEX shipment_quantity_corrections_pending_idx ON shipment_quantity_corrections(status, requested_at);
