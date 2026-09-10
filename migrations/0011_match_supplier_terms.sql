-- Copy catalog facts into supplier defaults only. Never update a PO snapshot.
-- Existing nonempty terms (including manual edits) win. Source catalog stays intact.
CREATE TABLE _supplier_terms_match_0011 AS
WITH source AS (
  SELECT p.supplier_id, p.id, p.product_name, j.key AS field, j.value
  FROM supplier_products p, json_each(json_object(
  'production', trim(production_cycle),
  'transport', trim(
    CASE WHEN trim(transport_method) != '' THEN '运输：' || transport_method ELSE '' END ||
    CASE WHEN trim(arrival_time) != '' THEN CASE WHEN trim(transport_method) != '' THEN '；' ELSE '' END || '到货：' || arrival_time ELSE '' END),
  'credit', trim(settlement_method),
  'payment', trim(settlement_method),
  'invoice', trim(
    CASE WHEN trim(special_invoice_tax) != '' THEN '专票税点（原文）：' || special_invoice_tax ELSE '' END ||
    CASE WHEN trim(ordinary_invoice_tax) != '' THEN CASE WHEN trim(special_invoice_tax) != '' THEN '；' ELSE '' END || '普票税点（原文）：' || ordinary_invoice_tax ELSE '' END),
  'order_materials', trim(order_required_materials),
  'notes', trim(notes))) j
), grouped AS (
  SELECT supplier_id, field,
    CASE WHEN MAX(value) = '' THEN ''
      WHEN COUNT(DISTINCT value) = 1 THEN MAX(value)
      ELSE group_concat(product_name || '：' || CASE WHEN value = '' THEN '待补充' ELSE value END, char(10)) END AS value
  FROM (SELECT * FROM source ORDER BY supplier_id, field, id)
  GROUP BY supplier_id, field
)
SELECT supplier_id, json_group_object(field, value) AS mapped FROM grouped GROUP BY supplier_id;

INSERT INTO supplier_commercial_terms(supplier_id, terms_json, revision, updated_by, updated_at)
SELECT m.supplier_id, json_object('production','','transport','','credit','','payment','','invoice','','minimum_order','','price_basis','unknown','tax_rate_bps',NULL,'currency','CNY'),
  0, u.id, strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM _supplier_terms_match_0011 m CROSS JOIN users u
WHERE lower(u.email) = 'yifunlife@hotmail.com' AND NOT EXISTS(SELECT 1 FROM supplier_commercial_terms t WHERE t.supplier_id=m.supplier_id);

UPDATE supplier_commercial_terms SET terms_json = json_set(terms_json,
  '$.production', CASE WHEN COALESCE(trim(json_extract(terms_json,'$.production')),'') != '' THEN json_extract(terms_json,'$.production') ELSE (SELECT json_extract(mapped,'$.production') FROM _supplier_terms_match_0011 m WHERE m.supplier_id=supplier_commercial_terms.supplier_id) END,
  '$.transport', CASE WHEN COALESCE(trim(json_extract(terms_json,'$.transport')),'') != '' THEN json_extract(terms_json,'$.transport') ELSE (SELECT json_extract(mapped,'$.transport') FROM _supplier_terms_match_0011 m WHERE m.supplier_id=supplier_commercial_terms.supplier_id) END,
  '$.credit', CASE WHEN COALESCE(trim(json_extract(terms_json,'$.credit')),'') != '' THEN json_extract(terms_json,'$.credit') ELSE (SELECT json_extract(mapped,'$.credit') FROM _supplier_terms_match_0011 m WHERE m.supplier_id=supplier_commercial_terms.supplier_id) END,
  '$.payment', CASE WHEN COALESCE(trim(json_extract(terms_json,'$.payment')),'') != '' THEN json_extract(terms_json,'$.payment') ELSE (SELECT json_extract(mapped,'$.payment') FROM _supplier_terms_match_0011 m WHERE m.supplier_id=supplier_commercial_terms.supplier_id) END,
  '$.invoice', CASE WHEN COALESCE(trim(json_extract(terms_json,'$.invoice')),'') != '' THEN json_extract(terms_json,'$.invoice') ELSE (SELECT json_extract(mapped,'$.invoice') FROM _supplier_terms_match_0011 m WHERE m.supplier_id=supplier_commercial_terms.supplier_id) END,
  '$.order_materials', CASE WHEN COALESCE(trim(json_extract(terms_json,'$.order_materials')),'') != '' THEN json_extract(terms_json,'$.order_materials') ELSE (SELECT json_extract(mapped,'$.order_materials') FROM _supplier_terms_match_0011 m WHERE m.supplier_id=supplier_commercial_terms.supplier_id) END,
  '$.notes', CASE WHEN COALESCE(trim(json_extract(terms_json,'$.notes')),'') != '' THEN json_extract(terms_json,'$.notes') ELSE (SELECT json_extract(mapped,'$.notes') FROM _supplier_terms_match_0011 m WHERE m.supplier_id=supplier_commercial_terms.supplier_id) END
), revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE supplier_id IN (SELECT supplier_id FROM _supplier_terms_match_0011);
DROP TABLE _supplier_terms_match_0011;
