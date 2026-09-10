// Local-only browser QA. In-memory synthetic fixtures; never connects to D1/R2 or real accounts.
// Each loopback port represents a test role, using the same real Worker and built frontend.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fixture } from './procurement.test.mjs';

const { db, request, objects } = fixture();
if (process.env.ACCEPTANCE_QA === '1') {
  db.exec("UPDATE purchase_orders SET status='in_production' WHERE id='order'; UPDATE order_items SET workflow_stage='production_complete' WHERE order_id='order'");
  const image = readFileSync('public/yifun-logo.png');
  db.exec("INSERT INTO attachments (id,order_id,item_id,kind,file_name,content_type,r2_key,uploaded_by,created_at) VALUES ('qa-real','order','item-0','production_photo','测试实拍.png','image/png','qa-real','vendor','2026-09-03')");
  objects.set('qa-real', { body: image, writeHttpMetadata(headers) { headers.set('Content-Type', 'image/png'); }, httpEtag: 'test' });
}
if (process.env.SHIPMENT_QA === '1') {
  db.exec("UPDATE purchase_orders SET status='ready_to_ship', shipment_status='partial' WHERE id='order'");
  db.exec("UPDATE order_items SET acceptance_status='approved' WHERE id IN ('item-0','item-1')");
  db.exec("INSERT INTO shipment_records VALUES ('qa-shipment','SH-001','order',8,0,'测试物流','TEST',1,'2026-09-03','vendor','2026-09-03T00:00:00Z')");
  db.exec("INSERT INTO shipment_items VALUES ('qa-shipment','item-0',3), ('qa-shipment','item-1',5)");
}
db.exec("UPDATE users SET name='本地测试老板' WHERE id='boss'; UPDATE users SET name='本地测试财务' WHERE id='finance'");
const terms = { production: '30 天', transport: '陆运，含运费', credit: '验收后 30 天', payment: '30% 预付款，70% 验收后结清', invoice: '增值税普通发票', minimum_order: '1 件', price_basis: 'exclusive', tax_rate_bps: 1300, currency: 'CNY' };
await request('buyer', '/suppliers/supplier-sp-1001/commercial-terms', { terms, revision: 0 });
await request('buyer', '/orders/order/commercial-terms', { terms, confirmed: true, revision: 0, reason: '本地合成测试合同，仅用于页面验证' });
for (const [kind, amount, reference] of [['payment', '300', 'TEST-PAY-001'], ['payment', '200', 'TEST-PAY-002'], ['invoice', '500', 'TEST-INV-001']]) await request('finance', '/orders/order/financial-entries', { requestId: crypto.randomUUID(), kind, amount, reference, recordDate: '2026-09-03', note: '本地合成测试凭证' }, 'POST');
const root = resolve('dist/client');
if (process.env.OFFICE_QA === '1') db.exec("INSERT INTO staff_roles VALUES ('buyer','office')");
if (process.env.ADMIN_QA === '1') db.exec("INSERT INTO staff_roles VALUES ('buyer','admin')");
if (process.env.DEPARTMENT_QA === '1') {
  db.exec("INSERT INTO staff_roles VALUES ('buyer', 'department'); UPDATE purchase_orders SET status='shipped' WHERE id='order'");
}
if (process.env.WAREHOUSE_QA === '1') {
  db.exec("INSERT INTO staff_roles VALUES ('buyer', 'warehouse'); UPDATE order_items SET workflow_stage='shipment_complete',acceptance_status='approved' WHERE order_id='order'; UPDATE order_items SET shipped_quantity=quantity WHERE order_id='order'; UPDATE purchase_orders SET status='shipped' WHERE id='order'");
}
db.exec(readFileSync('migrations/0011_match_supplier_terms.sql', 'utf8'));
for (const [port, role] of [[5187, 'boss'], [5188, 'finance'], [5189, 'buyer'], [5190, 'vendor']]) {
  createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname.startsWith('/api')) {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const response = await request(role, url.pathname.slice(4), raw ? JSON.parse(raw) : undefined, req.method);
        res.writeHead(response.status, { 'Content-Type': response.headers.get('Content-Type') || 'application/json' }); res.end(Buffer.from(await response.arrayBuffer())); return;
      }
      const path = url.pathname.startsWith('/assets/') || url.pathname.endsWith('.png') ? resolve(root, '.' + url.pathname) : resolve(root, 'index.html');
      if (!path.startsWith(root + '/')) { res.writeHead(404); res.end(); return; }
      const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png' }[extname(path)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime }); res.end(readFileSync(path));
    } catch { res.writeHead(500); res.end('Local preview error'); }
  }).listen(port, '127.0.0.1', () => console.log(`Synthetic ${role} preview: http://127.0.0.1:${port}`));
}
