DROP TRIGGER IF EXISTS po_identity_fixed;
CREATE TRIGGER po_identity_fixed BEFORE UPDATE OF id, supplier_id ON purchase_orders
WHEN NEW.id IS NOT OLD.id OR NEW.supplier_id IS NOT OLD.supplier_id
BEGIN SELECT RAISE(ABORT, 'PO order and supplier identity are immutable'); END;
