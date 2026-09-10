-- Extend effective staff roles without rebuilding the referenced users table.
CREATE TABLE staff_roles (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('purchaser', 'finance', 'boss'))
);
-- Explicitly approved by the account owner; do not promote other purchasers.
INSERT INTO staff_roles SELECT id, 'boss' FROM users WHERE lower(email) = 'yifunlife@hotmail.com' AND role = 'purchaser';

CREATE TABLE supplier_commercial_terms (
  supplier_id TEXT PRIMARY KEY REFERENCES suppliers(id),
  terms_json TEXT NOT NULL CHECK(json_valid(terms_json)),
  revision INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);
-- Only copy unanimous, existing catalog text into today's defaults. Do not infer tax rates,
-- payment days or minimum quantities from free text, and never copy this into old POs.
INSERT INTO supplier_commercial_terms(supplier_id, terms_json, updated_by, updated_at)
SELECT p.supplier_id, json_object(
  'production', CASE WHEN COUNT(DISTINCT NULLIF(trim(p.production_cycle), '')) = 1 THEN MAX(trim(p.production_cycle)) ELSE '' END,
  'transport', CASE WHEN COUNT(DISTINCT NULLIF(trim(p.transport_method || ' ' || p.arrival_time), '')) = 1 THEN MAX(trim(p.transport_method || ' ' || p.arrival_time)) ELSE '' END,
  'payment', CASE WHEN COUNT(DISTINCT NULLIF(trim(p.settlement_method), '')) = 1 THEN MAX(trim(p.settlement_method)) ELSE '' END,
  'credit', '', 'invoice', '', 'minimum_order', '', 'price_basis', 'unknown', 'tax_rate_bps', NULL, 'currency', 'CNY'
), actor.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM supplier_products p CROSS JOIN (SELECT id FROM users WHERE lower(email) = 'yifunlife@hotmail.com' AND role = 'purchaser') actor
GROUP BY p.supplier_id, actor.id;
ALTER TABLE purchase_orders ADD COLUMN commercial_terms_json TEXT;
ALTER TABLE purchase_orders ADD COLUMN commercial_status TEXT NOT NULL DEFAULT 'unverified' CHECK(commercial_status IN ('unverified', 'confirmed'));
ALTER TABLE purchase_orders ADD COLUMN commercial_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE purchase_orders ADD COLUMN commercial_change_id TEXT;
-- Old orders intentionally have no terms snapshot. Never backfill from today's supplier defaults.
CREATE TABLE commercial_history (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES purchase_orders(id),
  previous_json TEXT,
  actual_json TEXT NOT NULL CHECK(json_valid(actual_json)),
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  actor_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX commercial_history_order ON commercial_history(order_id);
CREATE TABLE order_settlements (
  order_id TEXT PRIMARY KEY REFERENCES purchase_orders(id),
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK(currency = 'CNY'),
  net_cents INTEGER CHECK(net_cents >= 0),
  tax_cents INTEGER CHECK(tax_cents >= 0),
  payable_cents INTEGER CHECK(payable_cents >= 0),
  CHECK((net_cents IS NULL AND tax_cents IS NULL AND payable_cents IS NULL) OR payable_cents = net_cents + tax_cents)
);
INSERT INTO order_settlements(order_id) SELECT id FROM purchase_orders;
CREATE TABLE financial_entries (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES purchase_orders(id),
  kind TEXT NOT NULL CHECK(kind IN ('payment', 'invoice', 'cost')),
  amount_cents INTEGER NOT NULL CHECK(amount_cents != 0),
  record_date TEXT NOT NULL,
  reference TEXT NOT NULL,
  note TEXT NOT NULL,
  reversal_of TEXT UNIQUE REFERENCES financial_entries(id),
  actor_id TEXT NOT NULL REFERENCES users(id),
  actor_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK((reversal_of IS NULL AND amount_cents > 0) OR (reversal_of IS NOT NULL AND amount_cents < 0))
);
CREATE INDEX finance_order ON financial_entries(order_id);
CREATE INDEX finance_reference ON financial_entries(order_id, kind, reference);
CREATE TRIGGER finance_duplicate_reference BEFORE INSERT ON financial_entries
WHEN NEW.reversal_of IS NULL AND EXISTS (
  SELECT 1 FROM financial_entries e WHERE e.order_id = NEW.order_id AND e.kind = NEW.kind
    AND lower(trim(e.reference)) = lower(trim(NEW.reference)) AND e.reversal_of IS NULL
    AND NOT EXISTS(SELECT 1 FROM financial_entries r WHERE r.reversal_of = e.id)
)
BEGIN SELECT RAISE(ABORT, 'Duplicate active financial reference'); END;
CREATE TRIGGER finance_no_update BEFORE UPDATE ON financial_entries
BEGIN SELECT RAISE(ABORT, 'Financial records are append only'); END;
CREATE TRIGGER finance_no_delete BEFORE DELETE ON financial_entries
BEGIN SELECT RAISE(ABORT, 'Financial records are append only'); END;
CREATE TRIGGER commercial_history_no_update BEFORE UPDATE ON commercial_history
BEGIN SELECT RAISE(ABORT, 'Commercial history is append only'); END;
CREATE TRIGGER commercial_history_no_delete BEFORE DELETE ON commercial_history
BEGIN SELECT RAISE(ABORT, 'Commercial history is append only'); END;
CREATE TRIGGER finance_reversal_valid BEFORE INSERT ON financial_entries
WHEN NEW.reversal_of IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM financial_entries e WHERE e.id = NEW.reversal_of AND e.order_id = NEW.order_id
    AND e.kind = NEW.kind AND e.amount_cents = -NEW.amount_cents AND e.reversal_of IS NULL
)
BEGIN SELECT RAISE(ABORT, 'Reversal must exactly offset its original record'); END;
CREATE TRIGGER settled_amount_locked BEFORE UPDATE ON order_settlements
WHEN (NEW.net_cents IS NOT OLD.net_cents OR NEW.tax_cents IS NOT OLD.tax_cents OR NEW.payable_cents IS NOT OLD.payable_cents)
 AND EXISTS(SELECT 1 FROM financial_entries WHERE order_id = OLD.order_id)
BEGIN SELECT RAISE(ABORT, 'Orders with financial records cannot change their price basis'); END;
