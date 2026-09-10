import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as XLSX from 'xlsx';
const source = ts.transpileModule(readFileSync(new URL('../src/purchaseOrderImport.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace('from "xlsx"', `from ${JSON.stringify(import.meta.resolve('xlsx'))}`).replace('from "fflate"', `from ${JSON.stringify(import.meta.resolve('fflate'))}`);
const { importPurchaseOrder } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
test('spreadsheet imports material, process, configuration and installation without duplicating combined headings', async () => {
  for (const [headers, row, expected] of [
    [['材料/工艺/配置', '安装方式'], ['玻璃钢/喷漆/LED', '螺栓固定'], '玻璃钢/喷漆/LED'],
    [['材料', '工艺', '配置', '安装方式'], ['玻璃钢', '喷漆', 'LED', '螺栓固定'], '玻璃钢；工艺：喷漆；配置：LED'],
  ]) {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['产品名称', '数量', '单价', ...headers], ['测试产品', 1, 100, ...row]]), '采购单');
    const file = new File([XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })], '测试采购单.xlsx');
    const imported = await importPurchaseOrder(file, []);
    assert.equal(imported.items[0].materialProcess, expected);
    assert.equal(imported.items[0].installationMethod, '螺栓固定');
  }
});

test('spreadsheet header supplier and project override filename guesses and detail notes', async () => {
  const book = XLSX.utils.book_new();
  const rows = [
    [null, null, null, null, null, null, null, null, null, null, null, '项目名', '沙特MG-920'],
    ['供应商编号', null, 'SP-1005', '报价公司', null, '浙江微丽蹦床有限公司'],
    ['采购员', null, '张紫玫', null, null, null, null, null, null, null, null, '下单时间', '2026年9月4日'],
    ['序号', '款号', '大场景图', '产品名称', '图片展示', '规格/尺寸', '单位', '数量', '单价', '合计金额', '材料/工艺/配置', '安装方式', '备注'],
    [1, 'A-1', null, '蹦床面', null, '2号色', '张', 6, 100, 600, '弹力布', '固定', '2号色，6张'],
  ];
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), '采购单');
  const suppliers = [
    { id: 'right', code: 'SP-1005', name: '浙江微丽蹦床有限公司', products: [] },
    { id: 'wrong', code: 'SP-1046', name: '网上采购', products: [{ product_name: '蹦床面', product_type: '成品设备类' }] },
  ];
  const file = new File([XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })], '网上采购-测试.xlsx');
  const imported = await importPurchaseOrder(file, suppliers);
  assert.equal(imported.supplierId, 'right');
  assert.equal(imported.supplierName, 'SP-1005 · 浙江微丽蹦床有限公司');
  assert.equal(imported.projectName, '沙特MG-920');
  assert.equal(imported.orderDate, '2026-09-04');
  assert.match(imported.items[0].specification, /备注：2号色，6张/);
});

test('Excel calendar dates do not shift with JavaScript time zones', async () => {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    [null, null, null, null, null, null, null, null, null, null, null, '项目名', '沙特MG-920'],
    ['供应商编号', null, 'SP-1020', '报价公司', '琅士唯(深圳)灯具有限公司'],
    [null, null, null, null, null, null, null, null, null, null, null, '下单时间', new Date(Date.UTC(2026, 8, 4))],
    ['序号', '款号', '大场景图', '产品名称', '图片展示', '规格/尺寸', '单位', '数量', '单价'],
    [1, null, null, '钢琴灯', null, '800*200', '个', 7, 320],
  ]);
  XLSX.utils.book_append_sheet(book, sheet, '亦玩集团报价表');
  const suppliers = [{ id: 'lighting', code: 'SP-1020', name: '琅士唯(深圳)灯具有限公司', products: [] }];
  const file = new File([XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })], '亦玩 沙特MG-920灯饰采购清单.xlsx');
  const imported = await importPurchaseOrder(file, suppliers);
  assert.equal(imported.supplierId, 'lighting');
  assert.equal(imported.projectName, '沙特MG-920');
  assert.equal(imported.orderDate, '2026-09-04');
  assert.deepEqual(imported.items.map((item) => item.productName), ['钢琴灯']);
});

test('official order template imports every product field and WPS cell image without totals', async () => {
  const sourcePath = new URL('../资料/下单模板基础版V1.0.xlsx', import.meta.url);
  const file = new File([readFileSync(sourcePath)], '下单模板基础版V1.0.xlsx');
  const imported = await importPurchaseOrder(file, []);
  assert.equal(imported.orderDate, '2026-08-31');
  assert.deepEqual(imported.items.map((item) => item.productName), ['定制玻璃钢灯具-示例', '定制玻璃钢灯具-示例']);
  assert.deepEqual(imported.items.map((item) => item.quantity), [1, 1]);
  assert.deepEqual(imported.items.map((item) => item.unit), ['个', '个']);
  assert.deepEqual(imported.items.map((item) => item.model), ['', '']);
  assert.deepEqual(imported.items.map((item) => item.specification), ['规格：0.4*0.37*0.6；备注：放一直整理图', '规格：1.45*0.15*1.45；备注：放一直整理图']);
  assert.deepEqual(imported.items.map((item) => item.materialProcess), ['主材：\n工艺：\n灯光：', '主材：\n工艺：\n灯光：']);
  assert.deepEqual(imported.items.map((item) => item.installationMethod), ['¨吊装\n¨壁挂\n¨落地', '¨吊装\n¨壁挂\n¨落地']);
  assert.equal(imported.imageCount, 2);
  assert.ok(imported.items.every((item) => item.image instanceof File));
});

test('project name follows the imported project cell and removes the leading company prefix', async () => {
  const rows = [
    [null, null, null, null, null, null, null, null, null, null, null, '项目名', '亦玩 亦玩沙特利雅得'],
    ['产品名称', '数量', '单价'],
    ['测试产品', 1, 10],
  ];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), '采购单');
  const file = new File([XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })], '任意文件名.xlsx');
  const imported = await importPurchaseOrder(file, []);
  assert.equal(imported.projectName, '沙特利雅得');
});
