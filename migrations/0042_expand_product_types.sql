-- Keep the existing fixed type constraint intact while adding a display category for new business types.
-- This avoids rebuilding product tables that are referenced by shipment and warehouse history.
ALTER TABLE order_items ADD COLUMN product_category TEXT NOT NULL DEFAULT '';
ALTER TABLE supplier_products ADD COLUMN product_category TEXT NOT NULL DEFAULT '';
