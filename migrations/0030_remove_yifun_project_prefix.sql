UPDATE purchase_orders
SET po_number = trim(substr(po_number, 3))
WHERE po_number LIKE '亦玩%';

UPDATE purchase_orders
SET po_number = trim(substr(po_number, 3))
WHERE po_number LIKE '亦玩%';

UPDATE purchase_orders
SET project_name = trim(substr(project_name, 3))
WHERE project_name LIKE '亦玩%';

UPDATE purchase_orders
SET project_name = trim(substr(project_name, 3))
WHERE project_name LIKE '亦玩%';
