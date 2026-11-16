import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './procurement.test.mjs';

test('contract number edits persist, preserve relations and reject invalid or stale changes', async () => {
  const { db, request } = fixture();
  const route = '/orders/order/identity';
  const base = { poNumber: 'HT-2026-001', supplierId: 'supplier-sp-1001', projectName: '测试项目', orderDate: '2026-09-01', requiredShipDate: '2026-09-20', previousPoNumber: 'CONTRACT-100', previousSupplierId: 'supplier-sp-1001', previousName: '测试项目', revision: 0 };
  for (const actor of ['vendor', 'finance']) assert.equal((await request(actor, route, base, 'PATCH')).status, 403);
  for (const poNumber of ['', '  ', 'x'.repeat(81), 123, null]) assert.equal((await request('buyer', route, { ...base, poNumber }, 'PATCH')).status, 400);
  assert.equal((await request('buyer', route, { ...base, poNumber: '  HT-2026-001  ' }, 'PATCH')).status, 200);
  assert.equal(db.prepare("SELECT po_number FROM purchase_orders WHERE id='order'").get().po_number, 'HT-2026-001');
  assert.equal(db.prepare("SELECT count(*) AS n FROM order_items WHERE order_id='order'").get().n, 20);
  assert.match(db.prepare("SELECT detail FROM order_events WHERE event_type='order_info_updated'").get().detail, /合同编号：CONTRACT-100 → HT-2026-001/);
  assert.equal((await request('buyer', route, { ...base, poNumber: 'STALE' }, 'PATCH')).status, 409);
  const next = { ...base, poNumber: 'HT-2026-001', previousPoNumber: 'HT-2026-001', projectName: '修改项目名' };
  assert.equal((await request('boss', route, next, 'PATCH')).status, 200);
  const orders = (await (await request('buyer', '/dashboard', undefined, 'GET')).json()).orders;
  assert.equal(orders[0].po_number, 'HT-2026-001');
  db.exec("INSERT INTO purchase_orders (id,po_number,supplier_id,project_name,order_date,required_ship_date,status,purchaser_name,internal_requirements,created_by,created_at,updated_at) SELECT 'duplicate','USED-CONTRACT',supplier_id,project_name,order_date,required_ship_date,status,purchaser_name,internal_requirements,created_by,created_at,updated_at FROM purchase_orders WHERE id='order'");
  for (const archived of [false, true]) {
    if (archived) db.exec("UPDATE purchase_orders SET archived_at='2026-09-01' WHERE id='duplicate'");
    assert.equal((await request('buyer', route, { ...next, previousName: '修改项目名', poNumber: 'used-contract' }, 'PATCH')).status, 409);
  }
  assert.equal(db.prepare("SELECT po_number FROM purchase_orders WHERE id='order'").get().po_number, 'HT-2026-001');
});
