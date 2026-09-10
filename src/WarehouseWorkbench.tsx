import { FormEvent, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, ClipboardCheck, FileText, PackageCheck, Truck, Upload } from "lucide-react";
import { api } from "./api";
import { FilePicker } from "./FilePicker";
import type { User } from "./types";

type WarehouseTab = "arrival" | "inspection" | "exception" | "stock" | "stocked";
type Attachment = { id: string; kind: "arrival_photo" | "delivery_note" | "exception_photo"; file_name: string; content_type: string };
type ProductImage = { id: string; item_id: string; file_name: string; kind: "product_image" | "production_photo" };
type Arrival = { order_id: string; po_number: string; project_name: string; supplier_name: string; is_online_purchase: number; item_id: string; product_name: string; model: string; product_type: string; specification: string; quantity: number; unit: string; shipped_quantity: number; received_quantity: number; carrier: string; tracking_number: string; shipped_at: string | null; images: ProductImage[] };
type Receipt = { id: string; order_id: string; item_id: string; po_number: string; project_name: string; supplier_name: string; is_online_purchase: number; product_name: string; model: string; product_type: string; specification: string; unit: string; ordered_quantity: number; shipped_quantity: number; received_quantity: number; received_date: string; received_by: string; status: "pending_inspection" | "passed" | "exception" | "stocked"; exception_type: string | null; exception_quantity: number | null; exception_notes: string; inspected_at: string | null; inspected_by: string | null; stocked_quantity: number; warehouse_name: string; storage_location: string; stocked_at: string | null; stocked_by: string | null; attachments: Attachment[]; images: ProductImage[] };
type Queue = { arrivals: Arrival[]; receipts: Receipt[] };

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date());
const canOperate = (user: User, online: boolean) => ["warehouse", "boss", "admin"].includes(user.role) || (online && ["purchaser", "boss", "admin", "management"].includes(user.role));
const date = (value?: string | null) => value ? new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(new Date(`${value.slice(0, 10)}T00:00:00`)) : "待填写";
const exceptionLabel: Record<string, string> = { shortage: "少货", overage: "多货", wrong_item: "错货", damaged: "破损", specification: "规格不符", other: "其他" };

export function WarehouseWorkbench({ user, refreshVersion, onChanged }: { user: User; refreshVersion: number; onChanged: (message: string) => Promise<void> }) {
  const [queue, setQueue] = useState<Queue | null>(null);
  const [tab, setTab] = useState<WarehouseTab>("arrival");
  const [error, setError] = useState("");
  const load = async () => {
    try { setQueue(await api<Queue>("/api/warehouse/queue")); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取仓库验收队列"); }
  };
  useEffect(() => { void load(); }, [refreshVersion]);
  const groups = useMemo(() => ({
    arrival: queue?.arrivals || [],
    inspection: queue?.receipts.filter(receipt => receipt.status === "pending_inspection") || [],
    exception: queue?.receipts.filter(receipt => receipt.status === "exception") || [],
    stock: queue?.receipts.filter(receipt => receipt.status === "passed" && receipt.stocked_quantity < receipt.received_quantity) || [],
    stocked: queue?.receipts.filter(receipt => receipt.status === "stocked") || [],
  }), [queue]);
  const saved = async (message: string) => { await Promise.all([load(), onChanged(message)]); };
  const tabs: Array<{ id: WarehouseTab; label: string }> = [
    { id: "arrival", label: "待到货" }, { id: "inspection", label: "待验收" }, { id: "exception", label: "验收异常" }, { id: "stock", label: "待入库" }, { id: "stocked", label: "已入库" },
  ];
  return <section className="warehouse-workbench" aria-label="仓库验收">
    <div className="warehouse-intro"><div><h2>仓库验收</h2><p>直接读取已发货的采购产品；到货、验收和入库均按产品与批次留痕。</p></div><button type="button" className="secondary" onClick={() => void load()}>刷新队列</button></div>
    <nav className="warehouse-tabs" aria-label="仓库验收状态">{tabs.map(item => <button key={item.id} type="button" className={tab === item.id ? "active" : ""} aria-current={tab === item.id ? "page" : undefined} onClick={() => setTab(item.id)}>{item.label}<span>{groups[item.id].length}</span></button>)}</nav>
    {error && <p className="form-error" role="alert">{error}</p>}
    {!queue ? <p className="warehouse-loading" role="status">正在读取仓库待办…</p> : <WarehouseList tab={tab} rows={groups[tab]} user={user} onChanged={saved} />}
  </section>;
}

function WarehouseList({ tab, rows, user, onChanged }: { tab: WarehouseTab; rows: Array<Arrival | Receipt>; user: User; onChanged: (message: string) => Promise<void> }) {
  const heading: Record<WarehouseTab, [string, string]> = {
    arrival: ["待到货", "已发货但仍有未到数量的产品"], inspection: ["待验收", "已确认到货，等待仓库核对产品、数量、规格、外观与包装"], exception: ["验收异常", "异常已同步到采购订单记录，等待采购负责人处理"], stock: ["待入库", "验收通过后才能登记仓库与库位"], stocked: ["已入库", "已完成入库的收货验收记录"],
  };
  return <section className="warehouse-list"><header><div><h3>{heading[tab][0]}</h3><p>{heading[tab][1]}</p></div><strong>{rows.length} 条</strong></header>{rows.length ? <div className="warehouse-rows">{rows.map(row => tab === "arrival" ? <ArrivalRow key={row.item_id} row={row as Arrival} user={user} onChanged={onChanged} /> : <ReceiptRow key={(row as Receipt).id} row={row as Receipt} tab={tab} user={user} onChanged={onChanged} />)}</div> : <div className="warehouse-empty"><PackageCheck size={26} /><strong>当前没有{heading[tab][0]}记录</strong><p>新的发货、到货或入库操作会自动同步到这里。</p></div>}</section>;
}

function Identity({ row }: { row: Arrival | Receipt }) {
  const image = row.images[0];
  return <div className="warehouse-identity">{image ? <a className="warehouse-product-image" href={`/api/attachments/${image.id}`} target="_blank" rel="noreferrer"><img src={`/api/attachments/${image.id}`} alt={`${row.product_name} 产品图片`} /></a> : <span className="warehouse-product-image empty">无图</span>}<div><strong>{row.po_number}</strong><span>{row.product_name}{row.model ? ` · ${row.model}` : ""}</span><small>{row.supplier_name} · {row.project_name || "无项目"}{row.images.length > 1 ? ` · ${row.images.length} 张产品图` : ""}</small></div></div>;
}

function ArrivalRow({ row, user, onChanged }: { row: Arrival; user: User; onChanged: (message: string) => Promise<void> }) {
  const remaining = row.shipped_quantity - row.received_quantity;
  const [quantity, setQuantity] = useState(String(remaining)), [receivedDate, setReceivedDate] = useState(today()), [arrivalPhotos, setArrivalPhotos] = useState<File[]>([]), [deliveryNotes, setDeliveryNotes] = useState<File[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault(); const value = Number(quantity);
    if (!Number.isInteger(value) || value < 1 || value > remaining) { setError(`到货数量需为 1–${remaining} 的整数`); return; }
    setBusy(true); setError("");
    try {
      const form = new FormData(); form.set("orderId", row.order_id); form.set("itemId", row.item_id); form.set("requestId", crypto.randomUUID()); form.set("quantity", String(value)); form.set("receivedDate", receivedDate);
      arrivalPhotos.forEach(file => form.append("arrivalPhoto", file)); deliveryNotes.forEach(file => form.append("deliveryNote", file));
      await api("/api/warehouse/receipts", { method: "POST", body: form }); await onChanged(`${row.product_name} 已确认到货，进入待验收`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "到货登记失败"); }
    finally { setBusy(false); }
  };
  return <article className="warehouse-row"><div className="warehouse-row-main"><Identity row={row} /><div><span>采购 / 已发</span><strong>{row.quantity} / {row.shipped_quantity} {row.unit}</strong></div><div><span>累计到货 / 未到</span><strong>{row.received_quantity} / {remaining} {row.unit}</strong></div><div><span>物流</span><strong>{row.carrier || "待填写"}</strong><small>{row.tracking_number || "无单号"}</small></div><div><span>发货日期</span><strong>{date(row.shipped_at)}</strong></div></div>{canOperate(user, row.is_online_purchase === 1) && <details className="warehouse-action"><summary><Truck size={16} />确认到货</summary><form onSubmit={submit}><div className="warehouse-form-grid"><label>本次实际到货数量<input type="number" min="1" max={remaining} step="1" value={quantity} disabled={busy} onChange={event => setQuantity(event.target.value)} /></label><label>实际到货日期<input type="date" min={row.shipped_at?.slice(0, 10)} max={today()} value={receivedDate} disabled={busy} onChange={event => setReceivedDate(event.target.value)} /></label></div><FilePicker label="到货照片（可选）" files={arrivalPhotos} onFiles={setArrivalPhotos} disabled={busy} accept="image/jpeg,image/png,image/webp" /><FilePicker label="送货单（可选）" files={deliveryNotes} onFiles={setDeliveryNotes} disabled={busy} accept=".pdf,.doc,.docx,.xls,.xlsx,image/jpeg,image/png,image/webp" />{error && <p className="form-error" role="alert">{error}</p>}<button className="primary" disabled={busy}>{busy ? "正在保存" : "确认到货"}</button></form></details>}</article>;
}

function ReceiptRow({ row, tab, user, onChanged }: { row: Receipt; tab: WarehouseTab; user: User; onChanged: (message: string) => Promise<void> }) {
  return <article className="warehouse-row"><div className="warehouse-row-main"><Identity row={row} /><div><span>本次到货</span><strong>{row.received_quantity} {row.unit}</strong><small>{date(row.received_date)}</small></div><div><span>验收状态</span><strong>{row.status === "pending_inspection" ? "待验收" : row.status === "passed" ? "验收通过" : row.status === "exception" ? "验收异常" : "已入库"}</strong><small>{row.inspected_by || row.received_by}</small></div>{tab === "exception" ? <div><span>异常</span><strong>{exceptionLabel[row.exception_type || "other"]} {row.exception_quantity} {row.unit}</strong><small>{row.exception_notes}</small></div> : tab === "stock" || tab === "stocked" ? <div><span>入库</span><strong>{row.stocked_quantity} / {row.received_quantity} {row.unit}</strong><small>{row.warehouse_name ? `${row.warehouse_name} / ${row.storage_location}` : "待填写"}</small></div> : <ReceiptAttachments attachments={row.attachments} />}</div>{tab === "inspection" && canOperate(user, row.is_online_purchase === 1) && <InspectionAction row={row} onChanged={onChanged} />}{tab === "stock" && canOperate(user, row.is_online_purchase === 1) && <StockAction row={row} onChanged={onChanged} />}{row.attachments.length > 0 && tab !== "inspection" && <div className="warehouse-files"><FileText size={15} />{row.attachments.map(file => <a key={file.id} href={`/api/warehouse/attachments/${file.id}`} target="_blank" rel="noreferrer">{file.kind === "arrival_photo" ? "到货照片" : file.kind === "exception_photo" ? "异常照片" : "送货单"}</a>)}</div>}</article>;
}

function ReceiptAttachments({ attachments }: { attachments: Attachment[] }) { return <div><span>附件</span><strong>{attachments.length ? `${attachments.length} 份` : "未上传"}</strong><small>{attachments.map(file => file.kind === "arrival_photo" ? "到货照片" : file.kind === "delivery_note" ? "送货单" : "异常照片").join("、")}</small></div>; }

function InspectionAction({ row, onChanged }: { row: Receipt; onChanged: (message: string) => Promise<void> }) {
  const [decision, setDecision] = useState<"passed" | "exception">("passed"), [type, setType] = useState("shortage"), [quantity, setQuantity] = useState(""), [notes, setNotes] = useState(""), [photos, setPhotos] = useState<File[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(""); try { const form = new FormData(); form.set("decision",decision); if (decision === "exception") { form.set("exceptionType",type); form.set("exceptionQuantity",quantity); form.set("exceptionNotes",notes); photos.forEach(file => form.append("exceptionPhoto",file)); } await api(`/api/warehouse/receipts/${row.id}/inspection`,{method:"POST",body:form}); await onChanged(decision === "passed" ? `${row.product_name} 仓库验收通过，等待入库` : `${row.product_name} 验收异常，已同步采购处理`); } catch(cause) { setError(cause instanceof Error ? cause.message : "验收保存失败"); } finally { setBusy(false); } };
  return <details className="warehouse-action" open><summary><ClipboardCheck size={16} />进行验收</summary><form onSubmit={submit}><fieldset className="warehouse-decision"><label><input type="radio" checked={decision === "passed"} onChange={() => setDecision("passed")} />通过</label><label><input type="radio" checked={decision === "exception"} onChange={() => setDecision("exception")} />异常</label></fieldset>{decision === "exception" && <><div className="warehouse-form-grid"><label>异常类型<select value={type} onChange={event => setType(event.target.value)}><option value="shortage">少货</option><option value="overage">多货</option><option value="wrong_item">错货</option><option value="damaged">破损</option><option value="specification">规格不符</option><option value="other">其他</option></select></label><label>异常数量<input type="number" min="1" max={row.received_quantity} step="1" value={quantity} onChange={event => setQuantity(event.target.value)} /></label></div><label>异常说明<textarea value={notes} maxLength={2000} onChange={event => setNotes(event.target.value)} placeholder="说明实际问题与处理建议" /></label><FilePicker label="异常照片（可选）" files={photos} onFiles={setPhotos} disabled={busy} accept="image/jpeg,image/png,image/webp" /></>}{error && <p className="form-error" role="alert">{error}</p>}<button className={decision === "exception" ? "secondary" : "primary"} disabled={busy}>{busy ? "正在保存" : decision === "passed" ? "确认验收通过" : "提交异常"}</button></form></details>;
}

function StockAction({ row, onChanged }: { row: Receipt; onChanged: (message: string) => Promise<void> }) {
  const remaining = row.received_quantity-row.stocked_quantity;
  const [quantity, setQuantity] = useState(String(remaining)), [warehouse, setWarehouse] = useState(row.warehouse_name), [location, setLocation] = useState(row.storage_location), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true);setError("");try { await api(`/api/warehouse/receipts/${row.id}/stock`,{method:"POST",body:JSON.stringify({quantity:Number(quantity),warehouseName:warehouse,storageLocation:location,requestId:crypto.randomUUID()})});await onChanged(`${row.product_name} 已登记入库`); } catch(cause) { setError(cause instanceof Error ? cause.message : "入库失败"); } finally { setBusy(false); } };
  return <details className="warehouse-action" open><summary><PackageCheck size={16} />确认入库</summary><form onSubmit={submit}><div className="warehouse-form-grid"><label>本次入库数量<input type="number" min="1" max={remaining} step="1" value={quantity} disabled={busy} onChange={event => setQuantity(event.target.value)} /></label><label>仓库<input value={warehouse} disabled={busy} onChange={event => setWarehouse(event.target.value)} placeholder="如：原材料仓" /></label><label>库位<input value={location} disabled={busy} onChange={event => setLocation(event.target.value)} placeholder="如：A-01-03" /></label></div>{error && <p className="form-error" role="alert">{error}</p>}<button className="primary" disabled={busy}>{busy ? "正在保存" : "确认入库"}</button></form></details>;
}
