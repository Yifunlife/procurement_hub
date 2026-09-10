DROP TRIGGER IF EXISTS po_identity_fixed;
CREATE TRIGGER po_identity_fixed BEFORE UPDATE OF id ON purchase_orders
WHEN NEW.id IS NOT OLD.id
BEGIN SELECT RAISE(ABORT, 'PO order identity is immutable'); END;
