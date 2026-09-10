import * as XLSX from "xlsx";
import type { FinanceOrder, PurchaseOrder } from "./types";

const status = { pending_confirmation: "待供应商确认", in_production: "生产中", ready_to_ship: "待发货", partial_shipped: "部分发货", shipped: "已发货", received: "已到货", completed: "已完结" };
const stage = { queued: "排单中", in_production: "生产中", production_complete: "生产完成", ready_to_ship: "生产完成", shipment_complete: "发货完成" };
const kind = { payment: "付款", invoice: "发票", cost: "额外成本" };
const basis = { unknown: "待核实", inclusive: "单价含税", exclusive: "单价未税" };
const date = (value: string | null) => value ? new Date(`${value}T00:00:00Z`) : "待填写";
const yuan = (value: number | null) => value === null ? "待核实" : value / 100;
type Cell = string | number | Date;

function append(book: XLSX.WorkBook, name: string, headers: string[], rows: Cell[][], decimals: number[] = [], integers: number[] = []) {
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows], { dateNF: "yyyy-mm-dd" });
  sheet["!cols"] = headers.map((heading, index) => ({ wch: /备注|条件|资料|要求|原因/.test(heading) ? 40 : /名称|供应商|项目|图片|账号/.test(heading) ? 30 : integers.includes(index) ? 12 : 20 }));
  sheet["!autofilter"] = { ref: sheet["!ref"]! };
  for (let row = 1; row <= rows.length; row++) for (const column of [...decimals, ...integers]) {
    const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
    if (cell?.t === "n") cell.z = integers.includes(column) ? "#,##0" : "#,##0.00";
  }
  XLSX.utils.book_append_sheet(book, sheet, name);
}

// Exported values are a point-in-time copy, never an editable source of system records.
export function purchaseWorkbook(orders: PurchaseOrder[], origin: string) {
  const book = XLSX.utils.book_new();
  append(book, "采购单汇总", ["PO编号", "供应商编号", "供应商名称", "项目名称", "状态", "下单日期", "要求发货日期", "原承诺发货日期", "最新预计发货日期", "采购负责人", "采购数量", "已发数量", "待发数量", "产品金额合计（按单价口径）", "执行条件", "价格口径", "税率（%）", "制作条件", "运输条件", "账期条件", "付款条件", "开票条件", "起订条件", "内部要求", "留档状态", "下单所需资料", "采购条件补充说明"], orders.map((order) => {
    const quantity = order.items.reduce((sum, item) => sum + item.quantity, 0);
    const shipped = order.shipments.reduce((sum, shipment) => sum + shipment.quantity, 0);
    const terms = order.commercial_terms;
    return [order.po_number, order.supplier_code, order.supplier_name, order.project_name, status[order.status], date(order.order_date), date(order.required_ship_date), date(order.promised_ship_date), date(order.estimated_ship_date), order.purchaser_name, quantity, shipped, Math.max(0, quantity - shipped), Math.round(order.items.reduce((sum, item) => sum + Math.round(item.amount * 100), 0)) / 100, order.commercial_status === "confirmed" ? "已核实" : "待核实", basis[terms?.price_basis || "unknown"], terms?.tax_rate_bps == null ? "待核实" : terms.tax_rate_bps / 100, terms?.production || "待核实", terms?.transport || "待核实", terms?.credit || "待核实", terms?.payment || "待核实", terms?.invoice || "待核实", terms?.minimum_order || "待核实", order.internal_requirements || "", order.archived_at ? "已作废留档" : "有效", terms?.order_materials || "", terms?.notes || ""];
  }), [13, 16], [10, 11, 12]);
  append(book, "产品明细", ["PO编号", "供应商编号", "供应商名称", "项目名称", "型号", "产品名称", "颜色", "产品类型", "数量", "单位", "单价（人民币元）", "金额（人民币元）", "规格 / 备注", "材料/工艺/配置", "安装方式", "完成时间", "生产节点", "产品图片链接（需登录系统）"], orders.flatMap((order) => order.items.map((item) => [order.po_number, order.supplier_code, order.supplier_name, order.project_name, item.model || "", item.product_name, item.color || "", item.product_type, item.quantity, item.unit, item.unit_price, item.amount, item.specification, item.material_process || "", item.installation_method || "", date(item.completion_date), stage[item.workflow_stage], order.attachments.filter((file) => file.kind === (item.shipped_quantity > 0 ? "production_photo" : "product_image") && file.item_id === item.id).map((file) => `${origin}/api/attachments/${encodeURIComponent(file.id)}`).join("\n")])), [10, 11], [8]);
  return book;
}

export function financeWorkbook(orders: FinanceOrder[]) {
  const book = XLSX.utils.book_new();
  append(book, "结算汇总", ["PO编号", "项目名称", "供应商名称", "留档状态", "执行条件", "币种", "价格口径", "税率（%）", "未税金额", "税额", "应付总额（含税）", "累计已付款", "未付款（负数为超付）", "累计开票金额", "额外成本", "含税采购成本"], orders.map((order) => [order.po_number, order.project_name, order.supplier_name, order.archived_at ? "已作废留档" : "有效", order.commercial_status === "confirmed" ? "已核实" : "待核实", "人民币", basis[order.commercial_terms?.price_basis || "unknown"], order.commercial_terms?.tax_rate_bps == null ? "待核实" : order.commercial_terms.tax_rate_bps / 100, yuan(order.net_cents), yuan(order.tax_cents), yuan(order.payable_cents), yuan(order.paid_cents), yuan(order.unpaid_cents), yuan(order.invoiced_cents), yuan(order.extra_cost_cents), yuan(order.cost_cents)]), [7, 8, 9, 10, 11, 12, 13, 14, 15]);
  append(book, "付款发票成本记录", ["PO编号", "项目名称", "供应商名称", "记录编号", "类型", "记录日期", "凭证编号", "金额（人民币元）", "记录状态", "冲销对应原记录编号", "备注 / 冲销原因", "操作人", "登记时间（UTC）"], orders.flatMap((order) => order.entries.map((entry) => [order.po_number, order.project_name, order.supplier_name, entry.id, kind[entry.kind], date(entry.record_date), entry.reference, entry.amount_cents / 100, entry.reversal_of ? "冲销记录" : order.entries.some((other) => other.reversal_of === entry.id) ? "已冲销（原记录保留）" : "有效", entry.reversal_of || "", entry.note, entry.actor_name, entry.created_at])), [7]);
  return book;
}

export function downloadWorkbook(book: XLSX.WorkBook, prefix: string, count: number) {
  XLSX.writeFile(book, `${prefix}_${count}单_${new Date().toISOString().replace(/[:.]/g, "-")}.xlsx`, { compression: true });
}
