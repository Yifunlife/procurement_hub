import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as XLSX from 'xlsx';

const source = ts.transpileModule(readFileSync(new URL('../src/exportData.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace('from "xlsx"', `from ${JSON.stringify(import.meta.resolve('xlsx'))}`);
const { purchaseWorkbook, financeWorkbook, warehouseStockWorkbook } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const roundTrip = (book) => XLSX.read(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer', cellDates: true, cellNF: true });
const order = (index) => ({
  id: `id-${index}`, po_number: `001-${index}`, supplier_code: 'SP-1001', supplier_name: '=HYPERLINK("https://example.test")', project_name: '测试项目', status: 'in_production', order_date: '2026-09-01', required_ship_date: '2026-09-20', promised_ship_date: null, estimated_ship_date: null, purchaser_name: '测试采购', commercial_terms: null, commercial_status: 'unverified', internal_requirements: '内部包装要求', archived_at: null,
  items: [{ id: 'sku', model: '001', product_name: '测试产品', product_type: '配件类', quantity: 100, unit: '件', unit_price: 1.25, amount: 125, specification: '多行\n备注', completion_date: null, workflow_stage: 'queued' }], shipments: [{ quantity: 60 }], attachments: [{ id: 'image-1', item_id: 'sku', kind: 'product_image' }],
});

test('purchase export includes every passed PO beyond pagination, preserves identifiers and numeric types', () => {
  const book = roundTrip(purchaseWorkbook(Array.from({ length: 25 }, (_, i) => order(i)), 'https://example.test'));
  assert.deepEqual(book.SheetNames, ['采购单汇总', '产品明细']);
  const rows = XLSX.utils.sheet_to_json(book.Sheets['采购单汇总']);
  assert.equal(rows.length, 25); assert.equal(rows[24]['PO编号'], '001-24');
  assert.equal(rows[0]['采购数量'], 100); assert.equal(rows[0]['已发数量'], 60); assert.equal(rows[0]['待发数量'], 40);
  assert.equal(rows[0]['产品金额合计（按单价口径）'], 125); assert.equal(rows[0]['价格口径'], '待核实');
  assert.ok(rows[0]['下单日期'] instanceof Date);
  assert.equal(book.Sheets['采购单汇总'].C2.t, 's'); assert.equal(book.Sheets['采购单汇总'].C2.f, undefined);
  assert.equal(book.Sheets['产品明细'].E2.v, '001'); assert.equal(book.Sheets['产品明细'].G1.v, '颜色'); assert.equal(book.Sheets['产品明细'].I2.z, '#,##0');
  assert.equal(book.Sheets['产品明细'].R2.v, 'https://example.test/api/attachments/image-1');
  assert.equal(book.Sheets['产品明细'].N1.v, '材料/工艺/配置');
  assert.equal(book.Sheets['产品明细'].O1.v, '安装方式');
});

test('purchase export respects supplied filtered subset and single order', () => {
  const rows = XLSX.utils.sheet_to_json(purchaseWorkbook([order(7)], 'https://example.test').Sheets['采购单汇总']);
  assert.equal(rows.length, 1); assert.equal(rows[0]['PO编号'], '001-7');
});

test('finance exports unknowns, zero, overpayment and all original and reversal entries distinctly', () => {
  const entry = { id: 'original', kind: 'payment', amount_cents: 15000, record_date: '2026-09-02', reference: '000123', note: '凭证', reversal_of: null, actor_name: '测试财务', created_at: '2026-09-02T00:00:00.000Z' };
  const base = { id: 'order', po_number: '001', project_name: '测试项目', supplier_name: '测试供应商', archived_at: null, commercial_status: 'unverified', commercial_terms: null, net_cents: null, tax_cents: null, payable_cents: null, paid_cents: 0, unpaid_cents: null, invoiced_cents: 0, extra_cost_cents: 0, cost_cents: null, entries: [] };
  const known = { ...base, po_number: '002', commercial_status: 'confirmed', net_cents: 10000, tax_cents: 0, payable_cents: 10000, paid_cents: 15000, unpaid_cents: -5000, cost_cents: 10000, entries: [entry, { ...entry, id: 'reverse', amount_cents: -15000, reversal_of: 'original', reference: 'reverse', note: '录入错误' }, { ...entry, id: 'replacement', reference: '000124' }] };
  const book = roundTrip(financeWorkbook([base, known]));
  const summary = XLSX.utils.sheet_to_json(book.Sheets['结算汇总']);
  assert.equal(summary[0]['应付总额（含税）'], '待核实'); assert.equal(summary[0]['累计已付款'], 0);
  assert.equal(summary[1]['未付款（负数为超付）'], -50);
  const entries = XLSX.utils.sheet_to_json(book.Sheets['付款发票成本记录']);
  assert.equal(entries.length, 3); assert.equal(entries[0]['凭证编号'], '000123');
  assert.equal(entries[0]['记录状态'], '已冲销（原记录保留）'); assert.equal(entries[1]['金额（人民币元）'], -150);
  assert.equal(entries.reduce((sum, entry) => sum + entry['金额（人民币元）'], 0), summary[1]['累计已付款']);
});

test('empty exports retain meaningful headers and finance export does not contain procurement-only data', () => {
  const book = roundTrip(financeWorkbook([]));
  assert.deepEqual(book.SheetNames, ['结算汇总', '付款发票成本记录']);
  assert.ok(book.Sheets['结算汇总'].A1); assert.ok(book.Sheets['付款发票成本记录'].A1);
  assert.equal(JSON.stringify(book).includes('内部要求'), false);
});

test('warehouse stock export keeps the PO, receipt quantities and stock location together', () => {
  const book = roundTrip(warehouseStockWorkbook({ id: 'receipt-12345678', po_number: 'PO-001', project_name: '测试项目', supplier_name: '测试供应商', product_name: '测试产品', model: 'SKU-01', product_type: '配件类', specification: '规格 A', unit: '件', ordered_quantity: 10, received_quantity: 6, received_date: '2026-09-09', stocked_quantity: 6, warehouse_name: '配件仓', storage_location: 'A-01-03', stocked_at: '2026-09-10T01:00:00.000Z', stocked_by: '仓管', images: [{ id: 'image-1' }] }, 'https://example.test'));
  assert.deepEqual(book.SheetNames, ['入库单', '入库产品明细']);
  const summary = XLSX.utils.sheet_to_json(book.Sheets['入库单']);
  const items = XLSX.utils.sheet_to_json(book.Sheets['入库产品明细']);
  assert.equal(summary[0]['入库单号'], 'RK-RECEIPT1'); assert.equal(summary[0]['仓库'], '配件仓');
  assert.equal(items[0]['本次到货数量'], 6); assert.equal(items[0]['本次入库数量'], 6);
  assert.equal(items[0]['产品图片链接（需登录系统）'], 'https://example.test/api/attachments/image-1');
});
