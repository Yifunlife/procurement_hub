ALTER TABLE suppliers ADD COLUMN is_online_purchase INTEGER NOT NULL DEFAULT 0 CHECK(is_online_purchase IN (0, 1));

-- 网上采购是统一采购来源，不对应外部供应商档案或登录账号。
INSERT OR IGNORE INTO suppliers (
  id, code, name, contact_name, contact_info, purchaser_name, region, payment_account, notes,
  is_online_purchase, created_at, updated_at
) VALUES (
  'supplier-online-purchase', 'ONLINE', '网上采购', '', '', '', '', '', '淘宝、京东及其他网商采购来源',
  1, '2026-09-10T00:00:00.000Z', '2026-09-10T00:00:00.000Z'
);

-- 网上采购由采购直接登记发货，不要求供应商生产验收。
DROP TRIGGER shipment_acceptance_guard;
CREATE TRIGGER shipment_acceptance_guard BEFORE INSERT ON shipment_items
WHEN NOT EXISTS (
  SELECT 1
  FROM order_items i
  JOIN purchase_orders po ON po.id = i.order_id
  JOIN suppliers s ON s.id = po.supplier_id
  WHERE i.id = NEW.item_id AND (i.acceptance_status = 'approved' OR s.is_online_purchase = 1)
)
BEGIN SELECT RAISE(ABORT, '产品未通过采购验收，不能发货'); END;
