CREATE TABLE po_renumber_map (
  order_id TEXT PRIMARY KEY,
  new_po_number TEXT NOT NULL UNIQUE
);

INSERT INTO po_renumber_map (order_id, new_po_number)
SELECT
  id,
  project_name || '-' || printf('%03d', ROW_NUMBER() OVER (
    PARTITION BY project_name
    ORDER BY created_at, id
  ))
FROM purchase_orders
WHERE archived_at IS NULL;

UPDATE purchase_orders
SET po_number = '__renumber__' || id
WHERE archived_at IS NULL;

UPDATE purchase_orders
SET po_number = (
  SELECT new_po_number
  FROM po_renumber_map
  WHERE order_id = purchase_orders.id
)
WHERE archived_at IS NULL;

DROP TABLE po_renumber_map;
