import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash, pbkdf2Sync } from 'node:crypto';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const migrations = readdirSync(new URL('../migrations/', import.meta.url)).filter((name) => name.endsWith('.sql')).sort();

test('supplier matching preserves manual defaults, product differences and old PO snapshots', async () => {
  const { db, request } = fixture();
  db.exec("UPDATE users SET email='yifunlife@hotmail.com' WHERE id='boss'");
  const terms = { production: '人工确认 45 天', transport: '', credit: '', payment: '', invoice: '', minimum_order: '', price_basis: 'unknown', tax_rate_bps: null, currency: 'CNY' };
  await request('buyer', '/suppliers/supplier-sp-1001/commercial-terms', { terms, revision: 0 });
  const ordersBefore = db.prepare('SELECT * FROM purchase_orders').all();
  const catalogBefore = db.prepare('SELECT * FROM supplier_products ORDER BY id').all();
  db.exec(readFileSync(new URL('../migrations/0011_match_supplier_terms.sql', import.meta.url), 'utf8'));
  const mapped = JSON.parse(db.prepare("SELECT terms_json FROM supplier_commercial_terms WHERE supplier_id='supplier-sp-1001'").get().terms_json);
  assert.equal(mapped.production, '人工确认 45 天'); assert.equal(mapped.credit, '月结');
  assert.match(mapped.invoice, /专票税点（原文）：8%/); assert.match(mapped.order_materials, /EPS文件/);
  assert.equal(mapped.tax_rate_bps, null); assert.equal(mapped.price_basis, 'unknown');
  const varied = JSON.parse(db.prepare("SELECT terms_json FROM supplier_commercial_terms WHERE supplier_id='supplier-sp-1013'").get().terms_json);
  assert.match(varied.transport, /皮革UV：运输：到付/); assert.match(varied.transport, /壁纸：运输：快递包邮/);
  assert.deepEqual(db.prepare('SELECT * FROM purchase_orders').all(), ordersBefore);
  assert.deepEqual(db.prepare('SELECT * FROM supplier_products ORDER BY id').all(), catalogBefore);
  assert.equal((await request('buyer', '/suppliers/supplier-sp-1001/commercial-terms', { terms: mapped, revision: 2 })).status, 200);
});

export function fixture({ legacy = false } = {}) {
  const db = new DatabaseSync(':memory:');
  for (const name of migrations.filter((name) => !legacy || (!name.startsWith('0009') && !name.startsWith('0013') && !name.startsWith('0019') && !name.startsWith('0020') && !name.startsWith('0021') && !name.startsWith('0022') && !name.startsWith('0026') && !name.startsWith('0028') && !name.startsWith('0029') && !name.startsWith('0030') && !name.startsWith('0031') && !name.startsWith('0039')))) db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  const timestamp = '2026-09-01T00:00:00.000Z';
  for (const [user, role, supplier] of [['buyer', 'purchaser', null], ['finance', 'purchaser', null], ['boss', 'purchaser', null], ['vendor', 'supplier', 'supplier-sp-1001'], ['other', 'supplier', 'supplier-sp-1002']]) {
    db.prepare('INSERT INTO users (id,email,name,role,supplier_id,password_hash,password_salt,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(user, `${user}@example.test`, user, role, supplier, 'unused', 'unused', timestamp, timestamp);
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(createHash('sha256').update(user).digest('hex'), user, '2099-01-01T00:00:00.000Z', timestamp);
  }
  db.exec("INSERT INTO staff_roles VALUES ('finance', 'finance'), ('boss', 'boss')");
  db.prepare(`INSERT INTO purchase_orders (id,po_number,supplier_id,project_name,order_date,required_ship_date,status,purchaser_name,internal_requirements,created_by,created_at,updated_at)
    VALUES ('order','CONTRACT-100','supplier-sp-1001','测试项目','2026-09-01','2026-09-20','pending_confirmation','buyer','内部机密','buyer',?,?)`).run(timestamp, timestamp);
  for (let index = 0; index < 20; index++) db.prepare(`INSERT INTO order_items (id,order_id,product_name,product_type,quantity,unit_price,amount,created_at) VALUES (?,'order',?,'配件类',5,10,50,?)`).run(`item-${index}`, `产品 ${index}`, timestamp);
  db.prepare(`INSERT INTO attachments (id,order_id,kind,file_name,content_type,r2_key,uploaded_by,created_at) VALUES ('file','order','purchase_order','test.pdf','application/pdf','test-file','buyer',?)`).run(timestamp);
  db.exec("INSERT INTO order_settlements(order_id) VALUES ('order')");
  const objects = new Map([['test-file', { body: 'fixture', writeHttpMetadata() {}, httpEtag: 'test' }]]);
  const prepare = (sql) => {
    let params = {};
    const execute = () => {
      const statement = db.prepare(sql);
      if (/^\s*SELECT\b/i.test(sql)) return { results: statement.all(params), meta: { changes: 0 } };
      const result = statement.run(params);
      return { results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    };
    const wrapper = {
      bind(...values) { params = Object.fromEntries(values.map((value, index) => [`?${index + 1}`, value])); return wrapper; },
      async first() { return db.prepare(sql).get(params) || null; },
      async all() { return execute(); }, async run() { return execute(); }, execute,
    };
    return wrapper;
  };
  const env = {
    DB: { prepare, async batch(statements) { db.exec('BEGIN'); try { const results = statements.map((statement) => statement.execute()); db.exec('COMMIT'); return results; } catch (error) { db.exec('ROLLBACK'); throw error; } } },
    FILES: { async get(key) { return objects.get(key); }, async put(key, body) { objects.set(key, { body, writeHttpMetadata() {}, httpEtag: 'test' }); }, async delete(key) { objects.delete(key); } },
  };
  const request = (user, path, body, method = 'PATCH') => worker.fetch(new Request(`https://test.invalid/api${path}`, {
    method, headers: { Cookie: `procure_session=${user}`, ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) }, body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  }), env);
  const confirm = () => request('vendor', '/orders/order/confirm', { promisedShipDate: '2026-09-20' }, 'POST');
  return { db, request, confirm, objects };
}

function seedProductionPhotos(db) {
  db.exec("INSERT INTO attachments (id,order_id,item_id,kind,file_name,content_type,r2_key,uploaded_by,created_at) SELECT 'real-' || id,order_id,id,'production_photo','real.png','image/png','real-' || id,'vendor','2026-09-03' FROM order_items WHERE order_id='order'");
  db.exec("UPDATE order_items SET workflow_stage='production_complete' WHERE order_id='order'; UPDATE order_items SET acceptance_status='approved' WHERE order_id='order'");
}

test('multiple shipment photos are saved together and invalid batches leave no records', async () => {
  const { db, request, objects } = fixture();
  db.exec("UPDATE purchase_orders SET status='ready_to_ship' WHERE id='order'");
  seedProductionPhotos(db);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9kAAAAASUVORK5CYII=', 'base64');
  function form() {
    const data = new FormData();
    data.set('items', JSON.stringify(Array.from({ length: 12 }, (_, i) => ({ itemId: `item-${i}`, quantity: 5 }))));
    for (const [key, value] of Object.entries({ shippedAt: '2026-09-03', quantity: '60', isComplete: 'false', carrier: 'test', trackingNumber: 'TEST-1', boxCount: '2' })) data.set(key, value);
    data.append('photo', new File([png], 'one.png', { type: 'image/png' }));
    data.append('photo', new File([png], 'two.png', { type: 'image/png' }));
    data.append('deliveryNote', new File(['%PDF-test'], 'note.pdf', { type: 'application/pdf' }));
    return data;
  }
  const invalid = form(); invalid.append('photo', new File(['not a png'], 'bad.png', { type: 'image/png' }));
  assert.equal((await request('vendor', '/orders/order/shipments', invalid, 'POST')).status, 400);
  const twoForms = form(); twoForms.append('deliveryNote', new File(['%PDF-test'], 'second.pdf', { type: 'application/pdf' }));
  assert.equal((await request('vendor', '/orders/order/shipments', twoForms, 'POST')).status, 400);
  assert.equal((await request('other', '/orders/order/shipments', form(), 'POST')).status, 404);
  assert.equal(db.prepare('SELECT count(*) AS n FROM shipment_records').get().n, 0);
  assert.equal(objects.size, 1);
  db.exec("UPDATE order_items SET acceptance_status='pending' WHERE id='item-0'");
  assert.equal((await request('vendor', '/orders/order/shipments', form(), 'POST')).status, 409);
  db.exec("UPDATE order_items SET acceptance_status='approved' WHERE id='item-0'");
  assert.equal((await request('vendor', '/orders/order/shipments', form(), 'POST')).status, 201);
  assert.equal(db.prepare('SELECT count(*) AS n FROM shipment_attachments').get().n, 3);
  assert.equal(objects.size, 4);
  assert.equal(db.prepare('SELECT quantity FROM shipment_records').get().quantity, 60);
});

test('purchaser can delete an incorrect clean product but not the final or processed product', async () => {
  const { db, request, objects } = fixture();
  db.exec("INSERT INTO attachments (id,order_id,item_id,kind,file_name,content_type,r2_key,uploaded_by,created_at) VALUES ('wrong-image','order','item-0','product_image','wrong.png','image/png','wrong-image','buyer','2026-09-03')");
  objects.set('wrong-image', { body: 'wrong', writeHttpMetadata() {}, httpEtag: 'wrong' });
  assert.equal((await request('buyer', '/orders/order/items/item-0', undefined, 'DELETE')).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM order_items WHERE id='item-0'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE id='wrong-image'").get().n, 0);
  assert.equal(objects.has('wrong-image'), false);
  db.exec("INSERT INTO product_acceptances (id,order_id,item_id,production_revision,decision,reason,photo_ids,actor_id,actor_name,created_at) VALUES ('accepted','order','item-1',0,'approved','','[]','buyer','buyer','2026-09-03')");
  assert.equal((await request('buyer', '/orders/order/items/item-1', undefined, 'DELETE')).status, 409);
  db.exec("DELETE FROM order_items WHERE order_id='order' AND id NOT IN ('item-1','item-2')");
  assert.equal((await request('buyer', '/orders/order/items/item-2', undefined, 'DELETE')).status, 200);
  assert.equal((await request('buyer', '/orders/order/items/item-1', undefined, 'DELETE')).status, 409);
});

test('partial SKU delivery locks production but allows remaining quantity; full delivery locks all', async () => {
  const { db, request } = fixture();
  db.exec("UPDATE purchase_orders SET status='ready_to_ship' WHERE id='order'");
  seedProductionPhotos(db);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9kAAAAASUVORK5CYII=', 'base64');
  function shipment(lines, complete = false) {
    const data = new FormData();
    for (const [key, value] of Object.entries({ shippedAt: '2026-09-03', quantity: String(lines.reduce((sum, line) => sum + line.quantity, 0)), isComplete: String(complete), carrier: 'test', trackingNumber: 'TEST', boxCount: '1', items: JSON.stringify(lines) })) data.set(key, value);
    data.set('photo', new File([png], 'one.png', { type: 'image/png' })); data.set('deliveryNote', new File(['pdf'], 'note.pdf', { type: 'application/pdf' }));
    return request('vendor', '/orders/order/shipments', data, 'POST');
  }
  assert.equal((await shipment([{ itemId: 'item-0', quantity: 3 }])).status, 201);
  assert.equal(db.prepare("SELECT shipped_quantity FROM order_items WHERE id='item-0'").get().shipped_quantity, 3);
  for (const body of [{ workflowStage: 'queued' }, { completionDate: '2026-09-04' }]) assert.equal((await request('vendor', '/orders/order/items/item-0/production', body)).status, 409);
  assert.equal((await request('vendor', '/orders/order/items/item-1/production', { completionDate: '2026-09-04' })).status, 200);
  const revised = db.prepare("SELECT production_revision FROM order_items WHERE id='item-1'").get().production_revision;
  assert.equal((await request('buyer', '/orders/order/items/item-1/acceptance', { decision: 'approved', revision: revised }, 'POST')).status, 200);
  assert.equal((await shipment([{ itemId: 'item-0', quantity: 3 }])).status, 400);
  assert.equal((await shipment([{ itemId: 'item-0', quantity: 2 }])).status, 201);
  assert.equal((await shipment([{ itemId: 'item-0', quantity: 1 }])).status, 400);
  assert.equal((await shipment(Array.from({ length: 19 }, (_, i) => ({ itemId: `item-${i + 1}`, quantity: 5 })), true)).status, 201);
  assert.equal(db.prepare("SELECT status FROM purchase_orders WHERE id='order'").get().status, 'shipped');
  assert.equal((await request('vendor', '/orders/order/items/item-1/production', { completionDate: '2026-09-05' })).status, 409);
  assert.throws(() => db.exec("UPDATE order_items SET workflow_stage='queued' WHERE id='item-0'"), /已锁定/);
  assert.equal(db.prepare('SELECT SUM(quantity) AS n FROM shipment_items').get().n, 100);
});

test('production completion requires own SKU photos and shipped photos cannot change', async () => {
  const { db, request } = fixture();
  db.exec("UPDATE purchase_orders SET status='in_production' WHERE id='order'");
  assert.equal((await request('vendor', '/orders/order/items/item-0/production', { workflowStage: 'production_complete' })).status, 409);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9kAAAAASUVORK5CYII=', 'base64');
  const data = () => { const form = new FormData(); form.set('file', new File([png], 'actual.png', { type: 'image/png' })); form.set('kind', 'production_photo'); return form; };
  assert.equal((await request('vendor', '/orders/order/attachments', data(), 'POST')).status, 400);
  const photo = data(); photo.set('itemId', 'item-0');
  assert.equal((await request('other', '/orders/order/attachments', photo, 'POST')).status, 404);
  assert.equal((await request('vendor', '/orders/order/attachments', photo, 'POST')).status, 201);
  assert.equal((await request('vendor', '/orders/order/items/item-0/production', { workflowStage: 'production_complete' })).status, 200);
  assert.equal((await request('vendor', '/orders/order/items/item-1/production', { workflowStage: 'ready_to_ship' })).status, 409);
  db.exec("UPDATE order_items SET shipped_quantity=1 WHERE id='item-0'");
  assert.equal((await request('vendor', '/orders/order/attachments', photo, 'POST')).status, 409);
  assert.equal(db.prepare("SELECT count(*) n FROM attachments WHERE item_id='item-0' AND kind='production_photo'").get().n, 1);
});

test('production completion may explicitly record that no physical photo was provided', async () => {
  const { db, request } = fixture();
  db.exec("UPDATE purchase_orders SET status='in_production' WHERE id='order'");
  assert.equal((await request('vendor', '/orders/order/items/item-0/production', { workflowStage: 'production_complete', photoNotProvided: true })).status, 200);
  const item = db.prepare("SELECT production_photo_waived, production_revision FROM order_items WHERE id='item-0'").get();
  assert.equal(item.production_photo_waived, 1);
  assert.equal((await request('buyer', '/orders/order/items/item-0/acceptance', { decision: 'approved', revision: item.production_revision }, 'POST')).status, 200);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9kAAAAASUVORK5CYII=', 'base64');
  const photo = new FormData(); photo.set('file', new File([png], 'later.png', { type: 'image/png' })); photo.set('kind', 'production_photo'); photo.set('itemId', 'item-0');
  assert.equal((await request('vendor', '/orders/order/attachments', photo, 'POST')).status, 201);
  assert.equal(db.prepare("SELECT production_photo_waived FROM order_items WHERE id='item-0'").get().production_photo_waived, 0);
});

test('only procurement can accept current production evidence, revisions invalidate approval and history stays intact', async () => {
  const { db, request } = fixture();
  db.exec("UPDATE purchase_orders SET status='in_production' WHERE id='order'");
  seedProductionPhotos(db);
  db.exec("UPDATE order_items SET acceptance_status='pending' WHERE id='item-0'");
  const revision = () => db.prepare("SELECT production_revision AS n FROM order_items WHERE id='item-0'").get().n;
  const path = '/orders/order/items/item-0/acceptance';
  const body = { decision: 'approved', revision: revision() };
  assert.equal((await request('vendor', path, body, 'POST')).status, 403);
  assert.equal((await request('finance', path, body, 'POST')).status, 403);
  assert.equal((await request('buyer', path, { ...body, decision: 'rejected' }, 'POST')).status, 400);
  assert.equal((await request('buyer', path, body, 'POST')).status, 200);
  assert.equal((await request('boss', path, body, 'POST')).status, 409);
  assert.equal(db.prepare("SELECT status FROM purchase_orders WHERE id='order'").get().status, 'ready_to_ship');
  assert.equal((await request('vendor', '/orders/order/items/item-0/production', { completionDate: '2026-09-04' })).status, 200);
  assert.equal(db.prepare("SELECT acceptance_status FROM order_items WHERE id='item-0'").get().acceptance_status, 'pending');
  assert.equal((await request('buyer', path, body, 'POST')).status, 409);
  assert.equal((await request('buyer', path, { decision: 'rejected', revision: revision(), reason: '表面需整改' }, 'POST')).status, 200);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9kAAAAASUVORK5CYII=', 'base64');
  const form = new FormData(); form.set('kind', 'production_photo'); form.set('itemId', 'item-0'); form.set('file', new File([png], 'reworked.png', { type: 'image/png' }));
  assert.equal((await request('vendor', '/orders/order/attachments', form, 'POST')).status, 201);
  assert.equal((await request('boss', path, { decision: 'approved', revision: revision() }, 'POST')).status, 200);
  const records = db.prepare("SELECT * FROM product_acceptances WHERE item_id='item-0' ORDER BY rowid").all();
  assert.equal(records.length, 3); assert.equal(JSON.parse(records[0].photo_ids).length, 1); assert.equal(JSON.parse(records[2].photo_ids).length, 2);
  assert.throws(() => db.exec("DELETE FROM product_acceptances"), /不可删除/);
});

test('migration preserves existing promised date without inventing historical timestamps', () => {
  const { db } = fixture({ legacy: true });
  db.exec("UPDATE purchase_orders SET promised_ship_date='2026-09-20', status='in_production'");
  db.exec(readFileSync(new URL('../migrations/0009_identity_and_delivery_history.sql', import.meta.url), 'utf8'));
  assert.equal(db.prepare('SELECT estimated_ship_date FROM purchase_orders').get().estimated_ship_date, '2026-09-20');
  const history = db.prepare('SELECT * FROM order_delivery_history').get();
  assert.equal(history.kind, 'baseline'); assert.equal(history.changed_at, null);
  assert.equal(db.prepare('SELECT count(*) n FROM order_items').get().n, 20);
});

test('first promise, successive estimates, reasons, actor and timestamps are retained', async () => {
  const { db, request, confirm } = fixture();
  assert.equal((await confirm()).status, 200);
  assert.equal((await request('vendor', '/orders/order/delivery-estimate', { estimatedShipDate: '2026-09-25', reason: '原料延期', revision: 1 })).status, 200);
  assert.equal((await request('vendor', '/orders/order/delivery-estimate', { estimatedShipDate: '2026-09-28', reason: '增加质检', revision: 2 })).status, 200);
  const order = db.prepare('SELECT * FROM purchase_orders').get();
  assert.equal(order.promised_ship_date, '2026-09-20'); assert.equal(order.estimated_ship_date, '2026-09-28');
  const entries = db.prepare('SELECT * FROM order_delivery_history ORDER BY rowid').all();
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((entry) => entry.new_date), ['2026-09-20', '2026-09-25', '2026-09-28']);
  assert.equal(entries[1].previous_date, '2026-09-20'); assert.equal(entries[1].reason, '原料延期');
  assert.ok(entries.every((entry) => entry.changed_at && entry.actor_id === 'vendor'));
  assert.equal(db.prepare('SELECT sum(quantity) n FROM order_items').get().n, 100);
});

test('stale competing date edits cannot overwrite the winner or create extra history', async () => {
  const { db, request, confirm } = fixture(); await confirm();
  const results = await Promise.all(['2026-09-25', '2026-09-26'].map((date) => request('vendor', '/orders/order/delivery-estimate', { estimatedShipDate: date, reason: '测试调整', revision: 1 })));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal(db.prepare('SELECT count(*) n FROM order_delivery_history').get().n, 2);
});

test('invalid dates, empty reasons, stale revisions and original-date tampering are rejected', async () => {
  const { db, request, confirm } = fixture(); await confirm();
  for (const override of [{ estimatedShipDate: '2026-02-30' }, { estimatedShipDate: '2026-08-31' }, { reason: '   ' }, { revision: 0 }, { promisedShipDate: '2026-09-25' }]) {
    assert.ok((await request('vendor', '/orders/order/delivery-estimate', { estimatedShipDate: '2026-09-25', reason: '调整', revision: 1, ...override })).status >= 400);
  }
  assert.equal(db.prepare('SELECT count(*) n FROM order_delivery_history').get().n, 1);
});

test('date change and audit insertion roll back together on audit failure', async () => {
  const { db, request, confirm } = fixture(); await confirm();
  db.exec("CREATE TRIGGER simulate_audit_failure BEFORE INSERT ON order_delivery_history BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  const originalError = console.error; console.error = () => {};
  try { assert.equal((await request('vendor', '/orders/order/delivery-estimate', { estimatedShipDate: '2026-09-25', reason: '调整', revision: 1 })).status, 500); }
  finally { console.error = originalError; }
  assert.equal(db.prepare('SELECT estimated_ship_date FROM purchase_orders').get().estimated_ship_date, '2026-09-20');
});

test('supplier cannot change quantity, prices, required dates, original promise or delete data', async () => {
  const { db, request, confirm } = fixture(); await confirm();
  for (const payload of [{ quantity: 99 }, { unitPrice: 99 }, { unit_price: 99 }, { requiredShipDate: '2026-09-28' }, { amount: 99 }, { workflowStage: 'production_complete', quantity: 99 }]) {
    assert.equal((await request('vendor', '/orders/order/items/item-0/production', payload)).status, 403);
  }
  assert.equal((await request('vendor', '/orders/order/internal', { requiredShipDate: '2026-09-28' })).status, 403);
  assert.equal((await request('vendor', '/orders/order', undefined, 'DELETE')).status, 403);
  assert.equal((await request('vendor', '/suppliers/supplier-sp-1001', {}, 'PATCH')).status, 403);
  assert.equal((await request('vendor', '/orders/order/history', undefined, 'DELETE')).status, 404);
  assert.equal(db.prepare('SELECT quantity FROM order_items LIMIT 1').get().quantity, 5);
});

test('suppliers only see their own orders, attachments, history, and never internal requirements', async () => {
  const { request, confirm } = fixture(); await confirm();
  const own = await (await request('vendor', '/dashboard', undefined, 'GET')).json();
  assert.equal(own.orders.length, 1); assert.equal(own.orders[0].items.length, 20);
  assert.equal(own.orders[0].internal_requirements, ''); assert.equal(own.orders[0].delivery_history.length, 1);
  assert.equal((await request('vendor', '/attachments/file', undefined, 'GET')).status, 200);
  const other = await (await request('other', '/dashboard', undefined, 'GET')).json();
  assert.equal(other.orders.length, 0);
  for (const [path, body, method] of [
    ['/orders/order/delivery-estimate', { estimatedShipDate: '2026-09-25', reason: '调整', revision: 1 }, 'PATCH'],
    ['/orders/order/items/item-0/production', { workflowStage: 'production_complete' }, 'PATCH'],
    ['/orders/order/attachments', undefined, 'POST'], ['/orders/order/shipments', undefined, 'POST'],
    ['/attachments/file', undefined, 'GET'],
  ]) assert.equal((await request('other', path, body, method)).status, 404);
});

test('purchaser deadline edits are audited separately and preserve original supplier promise', async () => {
  const { db, request, confirm } = fixture(); await confirm();
  assert.equal((await request('buyer', '/orders/order/internal', { requiredShipDate: '2026-09-22', internalRequirements: '新内部机密', revision: 1 })).status, 200);
  assert.equal(db.prepare('SELECT promised_ship_date FROM purchase_orders').get().promised_ship_date, '2026-09-20');
  const entry = db.prepare("SELECT * FROM order_delivery_history WHERE kind='required'").get();
  assert.equal(entry.previous_date, '2026-09-20'); assert.equal(entry.new_date, '2026-09-22');
  const dashboard = await (await request('vendor', '/dashboard', undefined, 'GET')).text();
  assert.ok(!dashboard.includes('新内部机密'));
  assert.equal((await request('buyer', '/orders/order/internal', { requiredShipDate: '2026-09-26', revision: 1 })).status, 409);
  assert.equal(db.prepare("SELECT count(*) n FROM order_delivery_history WHERE kind='required'").get().n, 1);
});

test('names may change but supplier identity, original promise and audit rows cannot', async () => {
  const { db, confirm } = fixture(); await confirm();
  db.exec("UPDATE suppliers SET name='新名称' WHERE id='supplier-sp-1001'; UPDATE purchase_orders SET project_name='新项目'");
  assert.equal(db.prepare('SELECT po_number FROM purchase_orders').get().po_number, 'CONTRACT-100');
  for (const sql of [
    "UPDATE suppliers SET code='SP-9999' WHERE id='supplier-sp-1001'",
    "UPDATE purchase_orders SET promised_ship_date='2026-09-28'", "DELETE FROM order_delivery_history",
    "UPDATE order_items SET quantity=99", "UPDATE order_items SET unit_price=99",
    "UPDATE order_delivery_history SET reason='覆盖'", "DELETE FROM order_events", "UPDATE order_events SET detail='覆盖'",
    "DELETE FROM purchase_orders", "DELETE FROM suppliers WHERE id='supplier-sp-1002'",
  ]) assert.throws(() => db.exec(sql));
});

test('archive retains lines, files, history and code, but stops supplier access and edits', async () => {
  const { db, request, confirm, objects } = fixture(); await confirm();
  assert.equal((await request('buyer', '/orders/order', undefined, 'DELETE')).status, 200);
  assert.equal(db.prepare('SELECT count(*) n FROM order_items').get().n, 20); assert.ok(objects.has('test-file'));
  assert.equal(db.prepare('SELECT count(*) n FROM order_delivery_history').get().n, 1);
  const supplier = await (await request('vendor', '/dashboard', undefined, 'GET')).json(); assert.equal(supplier.orders.length, 0);
  const buyer = await (await request('buyer', '/dashboard', undefined, 'GET')).json(); assert.ok(buyer.orders[0].archived_at);
  assert.equal((await request('buyer', '/attachments/file', undefined, 'GET')).status, 200);
  assert.equal((await request('vendor', '/attachments/file', undefined, 'GET')).status, 404);
  assert.equal((await request('vendor', '/orders/order/items/item-0/production', { workflowStage: 'queued' })).status, 404);
  assert.equal((await request('buyer', '/orders/order/internal', { requiredShipDate: '2026-09-30', revision: 1 })).status, 404);
  assert.equal((await request('buyer', '/orders', { poNumber: 'contract-100', supplierId: 'supplier-sp-1001', projectName: '新项目', orderDate: '2026-09-01', requiredShipDate: '2026-09-20', purchaserName: '伪造负责人', items: [{ productName: '测试', productType: '配件类', quantity: 1, unitPrice: 10 }] }, 'POST')).status, 201);
  const created = db.prepare("SELECT po_number,purchaser_name FROM purchase_orders WHERE project_name='新项目'").get();
  assert.equal(created.po_number, '新项目-001');
  assert.equal(created.purchaser_name, 'buyer');
});

test('removing unused supplier disables login, keeps code and next supplier continues sequence', async () => {
  const { db, request } = fixture();
  assert.equal((await request('buyer', '/suppliers/supplier-sp-1001', undefined, 'DELETE')).status, 409);
  assert.equal((await request('buyer', '/suppliers/supplier-sp-1002', undefined, 'DELETE')).status, 200);
  assert.ok(db.prepare("SELECT archived_at FROM suppliers WHERE id='supplier-sp-1002'").get().archived_at);
  assert.equal((await request('other', '/dashboard', undefined, 'GET')).status, 401);
  const last = db.prepare("SELECT current_value FROM supplier_number_sequence WHERE name='supplier'").get().current_value;
  const result = await request('buyer', '/suppliers', { name: '独立测试供应商', contactName: '测试', contactInfo: '测试', purchaserName: 'buyer', email: 'new@example.test', password: 'Test-only-long-password', products: [] }, 'POST');
  assert.equal(result.status, 201);
  assert.equal((await result.json()).supplierCode, `SP-${String(last + 1).padStart(4, '0')}`);
});

const terms = { production: '30 天', transport: '陆运，含运费', credit: '验收后 30 天', payment: '30% 预付，70% 验收后支付', invoice: '增值税普通发票', minimum_order: '1 件', price_basis: 'exclusive', tax_rate_bps: 1300, currency: 'CNY' };
const poBody = (poNumber, extra = {}) => ({ poNumber, supplierId: 'supplier-sp-1001', projectName: '测试快照', orderDate: '2026-09-01', requiredShipDate: '2026-09-20', purchaserName: 'buyer', items: [{ productName: '测试', productType: '配件类', quantity: 1, unitPrice: 100 }], ...extra });
const verifyTerms = (request, overrides = {}) => request('buyer', '/orders/order/commercial-terms', { terms, confirmed: true, revision: 0, reason: '依据原合同核实', ...overrides });
const entryBody = (kind, amount, reference, extra = {}) => ({ requestId: crypto.randomUUID(), kind, amount, reference, recordDate: '2026-09-03', note: '测试凭证', ...extra });

test('supplier defaults copy into new PO, supplier edits never touch its snapshot or old orders', async () => {
  const { db, request } = fixture();
  assert.equal((await request('buyer', '/suppliers/supplier-sp-1001/commercial-terms', { terms, revision: 0 })).status, 200);
  const created = await request('buyer', '/orders', poBody('NEW-1', { commercialConfirmed: true, supplierTermsRevision: 1 }), 'POST');
  assert.equal(created.status, 201); const { orderId } = await created.json();
  assert.equal(JSON.parse(db.prepare('SELECT commercial_terms_json FROM purchase_orders WHERE id=?').get(orderId).commercial_terms_json).production, '30 天');
  assert.equal((await request('buyer', '/suppliers/supplier-sp-1001/commercial-terms', { terms: { ...terms, production: '45 天' }, revision: 1 })).status, 200);
  assert.equal(JSON.parse(db.prepare('SELECT commercial_terms_json FROM purchase_orders WHERE id=?').get(orderId).commercial_terms_json).production, '30 天');
  assert.equal(db.prepare("SELECT commercial_terms_json FROM purchase_orders WHERE id='order'").get().commercial_terms_json, null);
  assert.equal(db.prepare("SELECT payable_cents FROM order_settlements WHERE order_id='order'").get().payable_cents, null);
  assert.equal((await request('buyer', '/orders', poBody('STALE-PO', { supplierTermsRevision: 1 }), 'POST')).status, 409);
  const unverified = await request('buyer', '/orders', poBody('NEW-2', { supplierTermsRevision: 2 }), 'POST');
  assert.equal(unverified.status, 201);
  assert.equal(db.prepare('SELECT payable_cents FROM order_settlements WHERE order_id=?').get((await unverified.json()).orderId).payable_cents, 10000);
});

test('old PO can be verified without copying current defaults; changes retain both snapshots', async () => {
  const { db, request } = fixture();
  assert.equal((await verifyTerms(request)).status, 200);
  assert.equal((await verifyTerms(request, { terms: { ...terms, production: '40 天' }, revision: 1, reason: '双方协商' })).status, 200);
  const history = db.prepare("SELECT * FROM commercial_history WHERE order_id='order' ORDER BY rowid").all();
  assert.equal(history.length, 2); assert.equal(history[0].previous_json, null);
  assert.equal(JSON.parse(history[1].previous_json).production, '30 天'); assert.equal(JSON.parse(history[1].actual_json).production, '40 天');
  assert.equal((await verifyTerms(request, { revision: 1 })).status, 409);
  assert.throws(() => db.exec("DELETE FROM commercial_history"));
});

test('inclusive/exclusive tax calculation uses integer cents and unknown is not zero', async () => {
  const { db, request } = fixture();
  assert.equal((await verifyTerms(request)).status, 200);
  let result = db.prepare("SELECT * FROM order_settlements WHERE order_id='order'").get();
  assert.equal(result.net_cents, 100000); assert.equal(result.tax_cents, 13000); assert.equal(result.payable_cents, 113000);
  assert.equal((await verifyTerms(request, { terms: { ...terms, price_basis: 'inclusive' }, revision: 1 })).status, 200);
  result = db.prepare("SELECT * FROM order_settlements WHERE order_id='order'").get();
  assert.equal(result.payable_cents, 100000); assert.equal(result.net_cents, 88496); assert.equal(result.tax_cents, 11504);
  assert.equal((await verifyTerms(request, { terms: { ...terms, tax_rate_bps: null }, revision: 2 })).status, 400);
  assert.equal((await verifyTerms(request, { terms: { ...terms, tax_rate_bps: 1001 }, revision: 2 })).status, 400);
  assert.equal(db.prepare("SELECT commercial_revision FROM purchase_orders WHERE id='order'").get().commercial_revision, 2);
  const small = await request('buyer', '/orders', poBody('ROUND', { commercialTerms: terms, commercialConfirmed: true, items: [{ productName: '分', productType: '配件类', quantity: 1, unitPrice: 0.05 }] }), 'POST');
  assert.equal(small.status, 201);
  assert.equal(db.prepare('SELECT payable_cents FROM order_settlements WHERE order_id=?').get((await small.json()).orderId).payable_cents, 6);
});

test('multiple payments/invoices/costs roll up; duplicate retry is idempotent and edits forbidden', async () => {
  const { db, request } = fixture(); await verifyTerms(request);
  const payment = entryBody('payment', '300.00', 'PAY-1');
  assert.equal((await request('finance', '/orders/order/financial-entries', payment, 'POST')).status, 201);
  assert.equal((await request('finance', '/orders/order/financial-entries', payment, 'POST')).status, 200);
  for (const [kind, amount, ref] of [['payment', '200', 'PAY-2'], ['invoice', '400', 'INV-1'], ['invoice', '730', 'INV-2'], ['cost', '20', 'COST-1']]) assert.equal((await request('finance', '/orders/order/financial-entries', entryBody(kind, amount, ref), 'POST')).status, 201);
  const order = (await (await request('finance', '/finance', undefined, 'GET')).json()).orders[0];
  assert.equal(order.paid_cents, 50000); assert.equal(order.unpaid_cents, 63000); assert.equal(order.invoiced_cents, 113000); assert.equal(order.cost_cents, 115000); assert.equal(order.entries.length, 5);
  assert.equal((await request('finance', '/orders/order/financial-entries', entryBody('payment', '300', 'PAY-1'), 'POST')).status, 409);
  assert.equal((await request('finance', '/orders/order/financial-entries', { ...payment, amount: '301' }, 'POST')).status, 409);
  assert.throws(() => db.exec('UPDATE financial_entries SET amount_cents=1')); assert.throws(() => db.exec('DELETE FROM financial_entries'));
});

test('finance can match purchase amount, invoice choice and tax before records lock settlement', async () => {
  const { db, request } = fixture();
  const saved = await request('finance', '/orders/order/finance-settlement', { payableAmount: '1000.00', taxRate: '13', invoiceRequired: true });
  assert.equal(saved.status, 200);
  const settlement = db.prepare("SELECT * FROM order_settlements WHERE order_id='order'").get();
  assert.equal(settlement.payable_cents, 100000); assert.equal(settlement.net_cents, 88496); assert.equal(settlement.tax_cents, 11504);
  assert.equal(settlement.invoice_required, 1); assert.equal(settlement.finance_confirmed, 1);
  assert.equal((await request('finance', '/orders/order/financial-entries', entryBody('payment', '100', 'PAY-FINANCE'), 'POST')).status, 201);
  assert.equal((await request('finance', '/orders/order/finance-settlement', { payableAmount: '900.00', taxRate: '10', invoiceRequired: false })).status, 409);
});

test('finance settlement permission grants a non-finance account full finance access', async () => {
  const { db, request } = fixture();
  assert.equal((await request('buyer', '/finance', undefined, 'GET')).status, 403);
  db.exec("INSERT INTO staff_permissions(user_id,supplier_operations,finance_settlement) VALUES ('buyer',0,1)");
  assert.equal((await request('buyer', '/finance', undefined, 'GET')).status, 200);
  assert.equal((await request('buyer', '/orders/order/finance-settlement', { payableAmount: '1000.00', taxRate: '0', invoiceRequired: false })).status, 200);
  assert.equal((await request('buyer', '/orders/order/financial-entries', entryBody('payment', '10', 'PAY-PERMITTED'), 'POST')).status, 201);
});

test('reversal appends exact offset, cannot reverse twice, and corrected reference may be reused', async () => {
  const { db, request } = fixture(); await verifyTerms(request);
  const payment = entryBody('payment', '300', 'PAY-1'); await request('finance', '/orders/order/financial-entries', payment, 'POST');
  const reversal = entryBody('cost', '9999', 'REV-1', { reversalOf: payment.requestId, note: '原记录录错金额' });
  assert.equal((await request('finance', '/orders/order/financial-entries', reversal, 'POST')).status, 201);
  assert.equal(db.prepare('SELECT amount_cents FROM financial_entries WHERE id=?').get(payment.requestId).amount_cents, 30000);
  assert.equal(db.prepare('SELECT amount_cents FROM financial_entries WHERE id=?').get(reversal.requestId).amount_cents, -30000);
  assert.equal((await request('finance', '/orders/order/financial-entries', { ...reversal, requestId: crypto.randomUUID() }, 'POST')).status, 409);
  assert.equal((await request('finance', '/orders/order/financial-entries', entryBody('payment', '200', 'PAY-1'), 'POST')).status, 201);
  assert.equal(db.prepare("SELECT sum(amount_cents) n FROM financial_entries WHERE kind='payment'").get().n, 20000);
});

test('financial records lock monetary basis atomically, while delivery/payment prose may change', async () => {
  const { db, request } = fixture(); await verifyTerms(request);
  await request('finance', '/orders/order/financial-entries', entryBody('payment', '30', 'PAY-1'), 'POST');
  assert.equal((await verifyTerms(request, { terms: { ...terms, tax_rate_bps: 600 }, revision: 1 })).status, 409);
  assert.equal(db.prepare("SELECT commercial_revision FROM purchase_orders WHERE id='order'").get().commercial_revision, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM commercial_history').get().n, 1);
  assert.equal((await verifyTerms(request, { terms: { ...terms, transport: '双方同意加急陆运' }, revision: 1 })).status, 200);
});

test('backend role matrix isolates finance, procurement, supplier and boss', async () => {
  const { request } = fixture();
  for (const user of ['buyer', 'vendor', 'other']) {
    assert.equal((await request(user, '/finance', undefined, 'GET')).status, 403);
    assert.equal((await request(user, '/orders/order/financial-entries', entryBody('payment', '1', 'NO'), 'POST')).status, 403);
    assert.equal((await request(user, '/staff', undefined, 'GET')).status, 403);
  }
  for (const path of ['/dashboard', '/attachments/file', '/staff']) assert.equal((await request('finance', path, undefined, 'GET')).status, 403);
  assert.equal((await request('finance', '/orders', poBody('NO'), 'POST')).status, 403);
  assert.equal((await request('finance', '/orders/order/commercial-terms', {})).status, 403);
  assert.equal((await request('vendor', '/suppliers/supplier-sp-1001/commercial-terms', {})).status, 403);
  assert.equal((await request('vendor', '/orders/order/commercial-terms', {})).status, 403);
  assert.equal((await request('boss', '/dashboard', undefined, 'GET')).status, 200);
  assert.equal((await request('boss', '/finance', undefined, 'GET')).status, 200);
  assert.equal((await request('boss', '/staff', undefined, 'GET')).status, 200);
  assert.equal((await request('finance', '/orders/order/financial-entries', entryBody('payment', '1', 'UNVERIFIED'), 'POST')).status, 409);
});

test('department sees all orders read-only without monetary payloads; admin has staff and finance access', async () => {
  const { db, request } = fixture();
  db.exec("INSERT INTO staff_roles VALUES ('buyer', 'engineering')");
  db.exec("UPDATE purchase_orders SET status='shipped'");
  const dashboard = await (await request('buyer', '/dashboard', undefined, 'GET')).json();
  assert.equal(dashboard.orders.length, 1);
  const order = dashboard.orders[0];
  assert.equal(order.items.length, 20);
  for (const key of ['commercial_terms', 'commercial_history', 'events', 'attachments', 'internal_requirements']) assert.equal(key in order, false);
  for (const item of order.items) for (const key of ['unit_price', 'amount', 'specification']) assert.equal(key in item, false);
  for (const path of ['/finance', '/staff', '/attachments/file']) assert.equal((await request('buyer', path, undefined, 'GET')).status, 403);
  assert.equal((await request('buyer', '/orders/order/complete', {}, 'POST')).status, 403);
  assert.equal((await request('buyer', '/orders/order/internal', {}, 'PATCH')).status, 403);
  assert.equal((await request('buyer', '/orders/order/items/item-0/production', {}, 'PATCH')).status, 403);
  assert.equal((await request('buyer', '/orders/order/received', {}, 'POST')).status, 403);
  assert.equal((await request('buyer', '/orders/order/items/item-0/warehouse', {action:'received'}, 'POST')).status, 403);
  db.exec("UPDATE staff_roles SET role='admin' WHERE user_id='buyer'");
  for (const path of ['/dashboard', '/finance', '/staff']) assert.equal((await request('buyer', path, undefined, 'GET')).status, 200);
  assert.equal((await request('buyer', '/orders/order/complete', {}, 'POST')).status, 409);
  assert.equal((await request('buyer', '/staff', { name: '部门管理', email: 'department@example.test', password: 'Test-only-password', role: 'engineering' }, 'POST')).status, 201);
});

test('product material and installation requirements persist independently and suppliers cannot alter them', async () => {
  const { db, request } = fixture();
  const item = { productName: '配置测试', productType: '配件类', quantity: 1, unitPrice: 20, specification: '备注', materialProcess: '玻璃钢；手工喷漆', installationMethod: '地脚螺栓固定' };
  const response = await request('buyer', '/orders', poBody('MATERIAL-001', { items: [item] }), 'POST');
  assert.equal(response.status, 201);
  const { orderId, itemIds } = await response.json();
  const saved = db.prepare('SELECT * FROM order_items WHERE id=?').get(itemIds[0]);
  assert.equal(saved.material_process, item.materialProcess);
  assert.equal(saved.installation_method, item.installationMethod);
  assert.equal(saved.specification, '备注');
  assert.equal(db.prepare("SELECT material_process FROM order_items WHERE id='item-0'").get().material_process, '');
  const dashboard = await (await request('vendor', '/dashboard', undefined, 'GET')).json();
  assert.equal(dashboard.orders.find((order) => order.id === orderId).items[0].installation_method, item.installationMethod);
  db.prepare("UPDATE purchase_orders SET status='in_production' WHERE id=?").run(orderId);
  assert.equal((await request('vendor', `/orders/${orderId}/items/${itemIds[0]}/production`, { materialProcess: '篡改' }, 'PATCH')).status, 403);
  assert.equal((await request('buyer', '/orders', poBody('INVALID-MATERIAL', { items: [{ ...item, installationMethod: 123 }] }), 'POST')).status, 400);
});

test('all roles can change only their own password and revoke all old sessions', async () => {
  for (const role of ['purchaser', 'supplier', 'finance', 'boss', 'admin', 'engineering']) {
    const { db, request } = fixture();
    const user = role === 'supplier' ? 'vendor' : 'buyer';
    if (user === 'buyer') db.prepare('INSERT INTO staff_roles VALUES (?, ?)').run(user, role);
    const salt = Buffer.alloc(16, 7);
    const oldPassword = 'Old-test-password';
    const hash = pbkdf2Sync(oldPassword, salt, 100000, 32, 'sha256').toString('hex');
    db.prepare('UPDATE users SET password_hash=?, password_salt=? WHERE id=?').run(hash, salt.toString('hex'), user);
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(createHash('sha256').update('second-device').digest('hex'), user, '2099-01-01', '2026-09-03');
    const body = { currentPassword: oldPassword, newPassword: 'New-test-password', confirmPassword: 'New-test-password' };
    assert.equal((await request(user, '/account/password', { ...body, userId: 'boss' }, 'POST')).status, 403);
    assert.equal((await request(user, '/account/password', { ...body, currentPassword: 'incorrect-password' }, 'POST')).status, 400);
    assert.equal((await request(user, '/account/password', { ...body, confirmPassword: 'different-password' }, 'POST')).status, 400);
    assert.equal((await request(user, '/account/password', { ...body, newPassword: 'short', confirmPassword: 'short' }, 'POST')).status, 400);
    assert.equal(db.prepare('SELECT password_hash FROM users WHERE id=?').get(user).password_hash, hash);
    assert.equal((await request(user, '/account/password', body, 'POST')).status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?').get(user).n, 0);
    assert.equal((await request(user, '/account/password', body, 'POST')).status, 401);
    assert.equal((await request(user, '/auth/login', { email: user + '@example.test', password: oldPassword }, 'POST')).status, 401);
    assert.equal((await request(user, '/auth/login', { email: user + '@example.test', password: body.newPassword }, 'POST')).status, 200);
    assert.equal(db.prepare("SELECT password_hash FROM users WHERE id='other'").get().password_hash, 'unused');
  }
});

test('boss and admin can edit every internal account role, permissions and credentials with history', async () => {
  const { db, request } = fixture();
  const body = { name: '新采购名', email: 'renamed@example.test', password: 'Reset-test-password', role: 'finance', supplierOperations: true, financeSettlement: true };
  for (const role of ['buyer', 'finance', 'vendor']) assert.equal((await request(role, '/staff/buyer', body)).status, 403);
  assert.equal((await request('boss', '/staff/vendor', body)).status, 404);
  assert.equal((await request('boss', '/staff/buyer', { ...body, role: 'supplier' })).status, 400);
  assert.equal((await request('boss', '/staff/buyer', { ...body, email: 'boss@example.test' })).status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_changes').get().n, 0);
  assert.equal((await request('boss', '/staff/buyer', body)).status, 200);
  assert.equal(db.prepare("SELECT name FROM users WHERE id='buyer'").get().name, body.name);
  assert.equal(db.prepare("SELECT role FROM staff_roles WHERE user_id='buyer'").get().role, 'finance');
  assert.deepEqual({ ...db.prepare("SELECT supplier_operations,finance_settlement FROM staff_permissions WHERE user_id='buyer'").get() }, { supplier_operations: 1, finance_settlement: 1 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id='buyer'").get().n, 0);
  assert.equal((await request('boss', '/auth/login', { email: body.email, password: body.password }, 'POST')).status, 200);
  const history = db.prepare('SELECT * FROM account_changes').get();
  assert.equal(history.password_reset, 1); assert.equal(history.actor_id, 'boss');
  assert.equal(history.old_name, 'buyer'); assert.equal(history.new_name, body.name);
  assert.equal(history.old_role, 'purchaser'); assert.equal(history.new_role, 'finance');
  assert.equal(history.old_supplier_operations, 0); assert.equal(history.new_supplier_operations, 1);
  assert.equal(history.old_finance_settlement, 0); assert.equal(history.new_finance_settlement, 1);
  assert.ok(!JSON.stringify(history).includes(body.password));
  assert.equal(db.prepare("SELECT purchaser_name FROM purchase_orders WHERE id='order'").get().purchaser_name, 'buyer');
  assert.throws(() => db.exec("DELETE FROM account_changes"));
  db.exec("UPDATE staff_roles SET role='admin' WHERE user_id='boss'");
  const hash = db.prepare("SELECT password_hash FROM users WHERE id='buyer'").get().password_hash;
  assert.equal((await request('boss', '/staff/buyer', { name: '仅修改名字', email: body.email, password: '' })).status, 200);
  assert.equal(db.prepare("SELECT password_hash FROM users WHERE id='buyer'").get().password_hash, hash);
});

test('procurement can update unshipped product stages but cannot bypass shipment locks', async () => {
  const { db, request } = fixture();
  db.exec("UPDATE purchase_orders SET status='in_production'");
  for (const user of ['buyer', 'boss']) {
    assert.equal((await request(user, '/orders/order/items/item-0/production', { workflowStage: 'in_production' })).status, 200);
    assert.equal((await request(user, '/orders/order/items/item-0/production', { workflowStage: 'shipment_complete' })).status, 409);
  }
  db.exec("UPDATE staff_roles SET role='admin' WHERE user_id='boss'");
  assert.equal((await request('boss', '/orders/order/items/item-0/production', { workflowStage: 'queued' })).status, 200);
  assert.equal((await request('finance', '/orders/order/items/item-0/production', { workflowStage: 'queued' })).status, 403);
  db.exec("UPDATE order_items SET shipped_quantity=1 WHERE id='item-0'");
  assert.equal((await request('buyer', '/orders/order/items/item-0/production', { workflowStage: 'in_production' })).status, 409);
});

test('procurement with supplier operations permission can update stages before supplier confirmation', async () => {
  const { db, request } = fixture();
  db.exec("INSERT INTO staff_permissions(user_id,supplier_operations) VALUES ('buyer',1)");
  assert.equal((await request('buyer', '/orders/order/items/item-0/production', { workflowStage: 'in_production' })).status, 200);
});

test('procurement and admin can correct PO basic information with delivery audit', async () => {
  const { db, request } = fixture();
  const route = '/orders/order/identity';
  const base = { poNumber: 'CONTRACT-100', supplierId: 'supplier-sp-1001', projectName: '测试项目', orderDate: '2026-09-01', requiredShipDate: '2026-09-20', purchaserName: 'buyer', previousPoNumber: 'CONTRACT-100', previousSupplierId: 'supplier-sp-1001', previousName: '测试项目', revision: 0 };
  assert.equal((await request('vendor', route, { ...base, projectName: '供应商不能改' }, 'PATCH')).status, 403);
  assert.equal((await request('buyer', route, { ...base, projectName: '' }, 'PATCH')).status, 400);
  assert.equal((await request('buyer', route, { ...base, previousName: '错误旧名' }, 'PATCH')).status, 409);
  assert.equal((await request('buyer', route, { ...base, poNumber: 'NEW-PO' }, 'PATCH')).status, 403);
  assert.equal((await request('buyer', route, { ...base, purchaserName: '其他人' }, 'PATCH')).status, 403);
  assert.equal((await request('buyer', route, { ...base, supplierId: 'supplier-sp-1002', projectName: '正确项目', requiredShipDate: '2026-09-25' }, 'PATCH')).status, 200);
  const updated = db.prepare("SELECT po_number,supplier_id,project_name,commercial_status FROM purchase_orders WHERE id='order'").get();
  assert.equal(updated.po_number, 'CONTRACT-100');
  assert.equal(updated.supplier_id, 'supplier-sp-1002');
  assert.equal(updated.project_name, '正确项目');
  assert.equal(updated.commercial_status, 'unverified');
  assert.equal((await (await request('vendor', '/dashboard', undefined, 'GET')).json()).orders.length, 0);
  assert.equal((await (await request('other', '/dashboard', undefined, 'GET')).json()).orders.length, 1);
  assert.equal(db.prepare("SELECT event_type FROM order_events WHERE order_id='order' ORDER BY rowid DESC").get().event_type, 'order_info_updated');
  assert.equal(db.prepare("SELECT kind FROM order_delivery_history WHERE order_id='order' ORDER BY rowid DESC").get().kind, 'required');
  db.exec("UPDATE staff_roles SET role='admin' WHERE user_id='boss'");
  assert.equal((await request('boss', route, { ...base, supplierId: 'supplier-sp-1002', projectName: '管理员更正', previousPoNumber: 'CONTRACT-100', previousSupplierId: 'supplier-sp-1002', previousName: '正确项目', requiredShipDate: '2026-09-25', revision: 1 }, 'PATCH')).status, 200);
  assert.equal((await request('other', '/orders/order/confirm', { promisedShipDate: '2026-09-25' }, 'POST')).status, 200);
  assert.equal((await request('buyer', route, { ...base, supplierId: 'supplier-sp-1001', projectName: '管理员更正', previousPoNumber: 'CONTRACT-100', previousSupplierId: 'supplier-sp-1002', previousName: '管理员更正', requiredShipDate: '2026-09-25', revision: 1 }, 'PATCH')).status, 409);
});

test('warehouse supports partial receipt, supplementary registration, idempotency and stock limits', async () => {
  const {db,request}=fixture();
  db.exec("INSERT INTO staff_roles VALUES ('buyer','warehouse'); UPDATE purchase_orders SET status='shipped'; UPDATE order_items SET shipped_quantity=quantity");
  const route='/orders/order/items/item-0/warehouse';
  const payload=(action,quantity)=>({action,quantity,requestId:crypto.randomUUID()});
  for (const actor of ['vendor','finance']) assert.equal((await request(actor,route,payload('received',1),'POST')).status,403);
  for (const quantity of [0,-1,1.5,'2',null]) assert.equal((await request('buyer',route,payload('received',quantity),'POST')).status,400);
  assert.equal((await request('buyer',route,payload('stocked',1),'POST')).status,409);
  assert.equal((await request('buyer',route,payload('received',6),'POST')).status,409);
  const first=payload('received',2);
  assert.equal((await request('buyer',route,first,'POST')).status,200);
  assert.equal((await request('buyer',route,first,'POST')).status,200);
  assert.equal(db.prepare("SELECT received_quantity FROM order_items WHERE id='item-0'").get().received_quantity,2);
  assert.equal((await request('buyer',route,payload('stocked',3),'POST')).status,409);
  assert.equal((await request('buyer',route,payload('stocked',2),'POST')).status,200);
  assert.equal((await request('buyer',route,payload('received',3),'POST')).status,200);
  assert.equal((await request('buyer',route,payload('stocked',3),'POST')).status,200);
  assert.equal((await request('buyer',route,payload('received',1),'POST')).status,409);
  assert.equal(db.prepare("SELECT quantity FROM order_items WHERE id='item-0'").get().quantity,5);
  assert.equal(db.prepare("SELECT status FROM purchase_orders WHERE id='order'").get().status,'shipped');
  for(let i=1;i<20;i++) assert.equal((await request('buyer','/orders/order/items/item-'+i+'/warehouse',payload('received',5),'POST')).status,200);
  assert.equal(db.prepare("SELECT status FROM purchase_orders WHERE id='order'").get().status,'received');
  const data=await (await request('buyer','/dashboard',undefined,'GET')).json();
  assert.equal(data.orders[0].items[0].unit_price,undefined);
  assert.equal(data.orders[0].items[0].warehouse_history.length,4);
  assert.equal(data.orders[0].items[0].stocked_quantity,5);
  assert.equal((await request('buyer','/finance',undefined,'GET')).status,403);
  assert.throws(()=>db.exec("DELETE FROM warehouse_records"));
  assert.throws(()=>db.exec("UPDATE warehouse_records SET quantity=1"));
});

test('boss can create finance account, session uses effective role, other roles cannot grant access', async () => {
  const { db, request } = fixture();
  const body = { name: '独立测试财务', email: 'accountant@example.test', password: 'Local-test-password', role: 'finance' };
  assert.equal((await request('buyer', '/staff', body, 'POST')).status, 403);
  assert.equal((await request('boss', '/staff', body, 'POST')).status, 201);
  assert.equal(db.prepare("SELECT sr.role FROM staff_roles sr JOIN users u ON u.id=sr.user_id WHERE email='accountant@example.test'").get().role, 'finance');
  const login = await request('boss', '/auth/login', { email: body.email, password: body.password }, 'POST');
  assert.equal(login.status, 200); assert.equal((await login.json()).user.role, 'finance');
});

test('management can operate procurement, suppliers and finance without CEO or account authority', async () => {
  const { db, request } = fixture();
  db.exec("INSERT INTO staff_roles VALUES ('buyer', 'management')");
  for (const path of ['/dashboard', '/finance']) assert.equal((await request('buyer', path, undefined, 'GET')).status, 200);
  assert.equal((await request('buyer', '/staff', undefined, 'GET')).status, 403);
  assert.equal((await request('buyer', '/attachments/file', undefined, 'GET')).status, 200);
  assert.equal((await request('buyer', '/orders', poBody('MANAGEMENT'), 'POST')).status, 201);
  assert.equal((await request('buyer', '/orders/order/finance-settlement', { payableAmount: '1000.00', taxRate: '0', invoiceRequired: false })).status, 200);
  assert.equal((await request('buyer', '/orders/order/financial-entries', entryBody('payment', '10', 'MANAGEMENT-PAYMENT'), 'POST')).status, 201);
});
