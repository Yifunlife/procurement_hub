import { useEffect, useRef, useState, type FormEvent } from "react";
import { ChevronDown, Eye, EyeOff, X } from "lucide-react";
import { api } from "./api";
import { ExportButton } from "./ExportButton";
import type { CommercialTerms, FinanceOrder, FinancialEntry, PurchaseOrder, Supplier, User } from "./types";

// Operate-mode extension: retain the existing blue/yellow workbench and dense tables.
// Separate default terms, PO snapshots and append-only financial records; unknown is not zero.
export const canPurchase = (role: User["role"]) => role === "purchaser" || role === "boss" || role === "admin" || role === "management";
export const roleLabel = { purchaser: "采购部", supplier: "供应商账号", finance: "财务部", boss: "CEO", admin: "管理员", management: "管理层", engineering: "工程部", office: "总经办", warehouse: "仓库部" };
export const emptyTerms = (): CommercialTerms => ({ production: "", transport: "", credit: "", payment: "", invoice: "", minimum_order: "", price_basis: "unknown", tax_rate_bps: null, currency: "CNY" });
const textFields = { production: "制作条件", transport: "运输 / 到货条件", credit: "账期条件", payment: "付款条件", invoice: "开票条件", minimum_order: "起订条件", order_materials: "下单所需资料", notes: "采购条件补充说明" } as const;
const basisLabel = { unknown: "待核实", inclusive: "单价含税", exclusive: "单价未税" };
const entryLabel = { payment: "付款", invoice: "发票", cost: "额外成本" };
const money = (cents: number | null) => cents === null ? "待核实" : `¥ ${(cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const time = (value: string) => new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" }).format(new Date(value));

function PasswordField({ label, value, onChange, disabled, required = false }: { label: string; value: string; onChange: (value: string) => void; disabled: boolean; required?: boolean }) {
  const [visible,setVisible]=useState(false);
  return <label>{label}<span className="password-control"><input type={visible ? "text" : "password"} minLength={10} maxLength={256} required={required} autoComplete="new-password" value={value} onChange={event=>onChange(event.target.value)} disabled={disabled} /><button type="button" className="password-visibility" aria-label={visible ? `隐藏${label}` : `显示${label}`} aria-pressed={visible} disabled={disabled} onClick={()=>setVisible(current=>!current)}>{visible ? <EyeOff size={17} /> : <Eye size={17} />}<span>{visible ? "隐藏" : "显示"}</span></button></span></label>;
}

export function TermsFields({ value, onChange, disabled = false }: { value: CommercialTerms; onChange: (value: CommercialTerms) => void; disabled?: boolean }) {
  return <div className="terms-fields">
    {Object.entries(textFields).map(([key, label]) => <label key={key}>{label}<textarea value={value[key as keyof typeof textFields] || ""} maxLength={2000} placeholder="待核实；不适用请填“无”" disabled={disabled} onChange={(event) => onChange({ ...value, [key]: event.target.value })} /></label>)}
    <label>本单价格口径<select value={value.price_basis} disabled={disabled} onChange={(event) => onChange({ ...value, price_basis: event.target.value as CommercialTerms["price_basis"] })}>{Object.entries(basisLabel).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>
    <label>税率（%）<input type="number" min="0" max="100" step="1" inputMode="numeric" placeholder="请输入整数，0% 请填写 0" value={value.tax_rate_bps === null ? "" : value.tax_rate_bps / 100} disabled={disabled} onKeyDown={(event) => { if ([".", ",", "e", "E", "+", "-"].includes(event.key)) event.preventDefault(); }} onChange={(event) => { const rate = event.target.value; if (rate === "" || /^\d+$/.test(rate)) onChange({ ...value, tax_rate_bps: rate === "" ? null : Number(rate) * 100 }); }} /></label>
    <p className="form-help">币种：人民币。含税口径从金额中拆分税额；未税口径另加税额，不会重复加税。</p>
  </div>;
}

function TermsSummary({ terms }: { terms: CommercialTerms | null }) {
  return <dl className="terms-summary">{Object.entries(textFields).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{terms?.[key as keyof typeof textFields] || "待核实"}</dd></div>)}<div><dt>价格口径 / 税率</dt><dd>{basisLabel[terms?.price_basis || "unknown"]} · {terms?.tax_rate_bps == null ? "税率待核实" : `${terms.tax_rate_bps / 100}%`} · 人民币</dd></div></dl>;
}

export function SupplierTermsEditor({ supplier, onSaved }: { supplier: Supplier; onSaved: () => void }) {
  const [terms, setTerms] = useState(supplier.commercial_terms || emptyTerms());
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [saved, setSaved] = useState(false);
  useEffect(() => { setTerms(supplier.commercial_terms || emptyTerms()); }, [supplier.commercial_revision]);
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setSaved(false);
    try {
      await api(`/api/suppliers/${supplier.id}/commercial-terms`, { method: "PATCH", body: JSON.stringify({ terms, revision: supplier.commercial_revision }) });
      setSaved(true); onSaved();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "保存失败"); }
    finally { setBusy(false); }
  }
  return <section className="commercial-block supplier-default-terms"><h3>供应商默认商务条件 · {supplier.commercial_terms ? `第 ${supplier.commercial_revision} 版` : "待建立"}</h3>
    <p className="form-help">已按现有产品采购条件匹配；不同产品的差异按名称保留，空缺仍待核实。保存只影响新建 PO 的默认值，不改变历史订单。开票税点保留来源原文，不自动视为本单适用税率。</p>
    <form onSubmit={save}><TermsFields value={terms} onChange={setTerms} disabled={busy} /><button className="secondary" disabled={busy}>{busy ? "正在保存" : "保存默认条件"}</button>{error && <p className="form-error" role="alert">{error}</p>}{saved && <p role="status">默认条件已保存，历史订单未改变。</p>}</form>
  </section>;
}

export function OrderCommercial({ order, user, onChanged }: { order: PurchaseOrder; user: User; onChanged: (message: string) => void }) {
  const [open, setOpen] = useState(true);
  const [terms, setTerms] = useState(order.commercial_terms || emptyTerms());
  const [confirmed, setConfirmed] = useState(order.commercial_status === "confirmed");
  const [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { setTerms(order.commercial_terms || emptyTerms()); setConfirmed(order.commercial_status === "confirmed"); }, [order.commercial_revision]);
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await api(`/api/orders/${order.id}/commercial-terms`, { method: "PATCH", body: JSON.stringify({ terms, confirmed, reason, revision: order.commercial_revision }) });
      setReason(""); onChanged("本单执行条件已保存，变更记录已保留");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "保存失败"); }
    finally { setBusy(false); }
  }
  return <section className="detail-section commercial-block"><div className="section-heading"><h3><button type="button" className="product-details-toggle" aria-expanded={open} aria-controls={`order-terms-${order.id}`} onClick={() => setOpen(!open)}><ChevronDown size={18} aria-hidden="true" />本单实际执行条件<span>{open ? "收起" : "展开"}</span></button></h3><span>{order.commercial_status === "confirmed" ? "已核实" : "待核实"} · 第 {order.commercial_revision} 版</span></div>
    <div id={`order-terms-${order.id}`} hidden={!open}>
    {!order.commercial_terms && <p className="verification-note">本单没有历史商务条件快照。请依据原合同核实，系统不会用供应商当前条件补填。</p>}
    <TermsSummary terms={order.commercial_terms} />
    {canPurchase(user.role) && !order.archived_at && <details><summary>核实 / 调整本单条件</summary><form onSubmit={save}>
      <TermsFields value={terms} onChange={(value) => { setTerms(value); setConfirmed(false); }} disabled={busy} />
      <label className="terms-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={busy} />已逐项核实本单条件及价格口径</label>
      <label>核实依据 / 变更原因<textarea required maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="例如：依据已签合同第 3 条核实，不使用供应商现行条件代替历史约定" disabled={busy} /></label>
      <p className="form-help">仅影响本单。已有财务记录后，不能再改变应付金额或税额。</p><button className="secondary" disabled={busy}>{busy ? "正在保存" : "保存本单条件"}</button>
      {error && <div className="form-error" role="alert">{error}<button type="button" className="text-button" onClick={() => onChanged("已刷新，请核对条件后重试")}>刷新核对</button></div>}
    </form></details>}
    <details><summary>执行条件变更记录（{order.commercial_history.length}）</summary>
      {order.commercial_history.length ? order.commercial_history.map((entry) => <details className="commercial-history-entry" key={entry.id}><summary>{time(entry.created_at)} · {entry.actor_name} · {entry.status === "confirmed" ? "已核实" : "待核实"}</summary><p>{entry.reason}</p><div className="terms-comparison"><div><h4>变更前</h4>{entry.previous_json ? <TermsSummary terms={JSON.parse(entry.previous_json)} /> : <p>无历史快照 / 待核实</p>}</div><div><h4>本次保存</h4><TermsSummary terms={JSON.parse(entry.actual_json)} /></div></div></details>) : <p className="form-help">暂无执行条件记录。</p>}
    </details>
    </div>
  </section>;
}

export function FinancePanel({ readOnly = false }: { readOnly?: boolean }) {
  const [orders, setOrders] = useState<FinanceOrder[] | null>(null), [selectedProject, setSelectedProject] = useState(""), [editing, setEditing] = useState("");
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState(""), [query, setQuery] = useState("");
  const load = async () => { try { const result = await api<{ orders: FinanceOrder[] }>("/api/finance"); setOrders(result.orders); setError(""); } catch (caught) { setError(caught instanceof Error ? caught.message : "读取失败"); } };
  useEffect(() => { void load(); }, []);
  const filtered = orders?.filter((entry) => `${entry.po_number} ${entry.project_name} ${entry.supplier_name}`.toLowerCase().includes(query.toLowerCase())) || [];
  const projectOrders = selectedProject ? filtered.filter((entry) => entry.project_name === selectedProject) : filtered;
  const exportOrders = projectOrders.filter((entry) => checkedIds.has(entry.id));
  const projects = Array.from(new Map(filtered.map((entry) => [entry.project_name, filtered.filter((candidate) => candidate.project_name === entry.project_name)])).entries());
  const editingOrder = orders?.find((entry) => entry.id === editing);
  useEffect(() => { setCheckedIds(new Set()); }, [query]);
  return <section className="finance-surface"><div className="section-heading"><h2>财务结算</h2><button className="secondary" onClick={() => void load()}>刷新数据</button></div>
    <p className="form-help">按项目归类采购订单。点击项目查看订单，再通过编辑弹窗确认应付金额、开票需求和税金。</p>
    {error && <p className="form-error" role="alert">{error}</p>}{!orders ? <p role="status">正在读取结算…</p> : <>
      <label className="finance-search">搜索<input name="finance-search" autoComplete="off" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入项目、PO 或供应商" /></label>
      {!selectedProject ? <div className="finance-project-list">{projects.map(([project, entries]) => <button type="button" key={project} onClick={() => setSelectedProject(project)}><span><strong>{project}</strong><small>{entries.length} 张采购单</small></span><span>{money(entries.reduce((total, entry) => total + (entry.payable_cents || 0), 0))}<ChevronDown size={18} /></span></button>)}</div> : <>
        <div className="finance-project-heading"><button type="button" className="back-button" onClick={() => setSelectedProject("")}>返回项目列表</button><h3>{selectedProject}<small>{projectOrders.length} 张采购单</small></h3></div>
        {!readOnly && <div className="export-toolbar"><label className="order-select-all"><input type="checkbox" aria-label="全选当前项目订单" disabled={!projectOrders.length} checked={projectOrders.length > 0 && exportOrders.length === projectOrders.length} onChange={(event) => setCheckedIds(new Set(event.target.checked ? projectOrders.map((entry) => entry.id) : []))} />全选（{projectOrders.length} 单）</label><ExportButton kind="finance" orders={exportOrders} selectedOnly /></div>}
        <div className="finance-table-scroll"><table className="finance-table"><thead><tr><th>选择</th><th>PO 编号</th><th>供应商</th><th>采购金额 / 应付款</th><th>已付款</th><th>未付款</th><th>开票状态</th><th>操作</th></tr></thead><tbody>
          {projectOrders.map((entry) => <tr key={entry.id} className={entry.archived_at ? "archived-order-row" : undefined}><td><label className="finance-checkbox"><input type="checkbox" aria-label={`选择结算 ${entry.po_number}`} checked={checkedIds.has(entry.id)} onChange={() => setCheckedIds((current) => { const next = new Set(current); if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id); return next; })} /></label></td><td><strong>{entry.po_number}</strong>{entry.archived_at && <small>已作废留档</small>}</td><td>{entry.supplier_name}</td><td>{money(entry.payable_cents)}{!entry.finance_confirmed && <small>采购单金额自动带入 · 待财务确认</small>}</td><td>{money(entry.paid_cents)}</td><td>{money(entry.unpaid_cents)}</td><td>{entry.invoice_required === null ? "待填写" : entry.invoice_required ? `需要开票 · 已开 ${money(entry.invoiced_cents)}` : "无需开票"}</td><td><button className="text-button" onClick={() => setEditing(entry.id)}>{readOnly ? "查看" : "编辑"}</button></td></tr>)}
        </tbody></table></div>
      </>}{!filtered.length && <p className="form-help">没有符合条件的采购订单。</p>}
    </>}
    {editingOrder && <FinanceEditDialog order={editingOrder} readOnly={readOnly} onClose={() => setEditing("")} onSaved={load} />}
  </section>;
}

function FinanceDetail({ order, onSaved, readOnly = false }: { order: FinanceOrder; onSaved: () => Promise<void>; readOnly?: boolean }) {
  return <section><div className="section-heading"><h2>{order.po_number} · 财务结算</h2><span>{order.supplier_name}</span></div>
    <dl className="finance-totals">{([['未税金额', order.net_cents], ['税额', order.tax_cents], ['应付总额（含税）', order.payable_cents], ['累计已付款', order.paid_cents], ['未付款', order.unpaid_cents], ['累计开票金额', order.invoiced_cents], ['额外成本', order.extra_cost_cents], ['含税采购成本', order.cost_cents]] as const).map(([label, amount]) => <div key={label}><dt>{label}</dt><dd>{money(amount)}</dd></div>)}</dl>
    <p className="form-help">{basisLabel[order.commercial_terms?.price_basis || "unknown"]} · 税率 {order.commercial_terms?.tax_rate_bps == null ? "待核实" : `${order.commercial_terms.tax_rate_bps / 100}%`}。含税采购成本＝本单应付＋额外成本；额外成本不自动并入供应商应付款。</p>
    {readOnly || order.archived_at || order.payable_cents === null ? <p className="verification-note">{order.archived_at ? "已作废，只读留档。" : "请先由采购依据原合同核实执行条件、价格口径和税率，再登记财务记录。"}</p> : <FinancialEntryForm order={order} onSaved={onSaved} />}
    <h3>付款、发票与成本记录</h3><p className="form-help">原记录不可覆盖。录入有误时追加冲销记录，再重新登记。</p>
    {order.entries.length ? <div className="finance-table-scroll"><table className="finance-table"><thead><tr><th>类型 / 日期</th><th>凭证编号</th><th>金额</th><th>备注 / 操作人</th><th>记录状态</th></tr></thead><tbody>{order.entries.map((entry) => {
      const reversed = order.entries.some((other) => other.reversal_of === entry.id);
      return <tr key={entry.id}><td>{entryLabel[entry.kind]}{entry.reversal_of ? "冲销" : ""}<small>{entry.record_date}</small></td><td>{entry.reference}</td><td>{money(entry.amount_cents)}</td><td>{entry.note || "—"}<small>{entry.actor_name} · {time(entry.created_at)}</small></td><td>{entry.reversal_of ? "冲销记录" : reversed ? "已冲销（原记录保留）" : (readOnly || order.archived_at) ? "只读留档" : <ReverseEntry order={order} entry={entry} onSaved={onSaved} />}</td></tr>;
    })}</tbody></table></div> : <p className="form-help">尚无财务记录。</p>}
  </section>;
}

function FinanceEditDialog({ order, readOnly, onClose, onSaved }: { order: FinanceOrder; readOnly: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialogRef.current?.showModal(); }, []);
  return <dialog ref={dialogRef} className="finance-edit-dialog" aria-labelledby={`finance-edit-${order.id}`} onClose={onClose}><div className="finance-edit-panel"><div className="section-heading"><div><h2 id={`finance-edit-${order.id}`}>{order.po_number}</h2><p>{order.project_name} · {order.supplier_name}</p></div><button type="button" className="dialog-close" aria-label="关闭" onClick={() => dialogRef.current?.close()}><X /></button></div>{!readOnly && !order.archived_at && <SettlementEditor order={order} onSaved={onSaved} />}<FinanceDetail readOnly={readOnly} order={order} onSaved={onSaved} /></div></dialog>;
}

function SettlementEditor({ order, onSaved }: { order: FinanceOrder; onSaved: () => Promise<void> }) {
  const [payable, setPayable] = useState(order.payable_cents === null ? "" : (order.payable_cents / 100).toFixed(2));
  const [taxRate, setTaxRate] = useState(order.tax_cents && order.net_cents ? String(Math.round(order.tax_cents * 100 / order.net_cents)) : "0");
  const [invoiceRequired, setInvoiceRequired] = useState(order.invoice_required === null ? "" : order.invoice_required ? "yes" : "no");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [success, setSuccess] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setSuccess("");
    try { await api(`/api/orders/${order.id}/finance-settlement`, { method: "PATCH", body: JSON.stringify({ payableAmount: payable, taxRate, invoiceRequired: invoiceRequired === "yes" }) }); setSuccess("财务应付款信息已保存"); await onSaved(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "保存失败"); }
    finally { setBusy(false); }
  }
  return <form className="finance-settlement-editor" onSubmit={save}><h3>应付款信息</h3><div className="terms-fields"><label>需要支付的金额（元）<input type="number" min="0" step="0.01" required value={payable} onChange={(event) => setPayable(event.target.value)} disabled={busy} /></label><label>是否需要开票<select required value={invoiceRequired} onChange={(event) => setInvoiceRequired(event.target.value)} disabled={busy}><option value="" disabled>请选择</option><option value="yes">需要开票</option><option value="no">无需开票</option></select></label><label>税率（%）<input type="number" min="0" max="100" step="1" inputMode="numeric" required value={taxRate} onChange={(event) => setTaxRate(event.target.value.replace(/\D/g, ""))} disabled={busy} /></label></div><p className="form-help">税率只填写整数，例如 3、6、9、13；系统会自动计算税额。采购单金额已自动带入应付款，已有付款或发票记录后不可再修改。</p><button className="primary" disabled={busy}>{busy ? "正在保存" : "保存应付款信息"}</button>{error && <p className="form-error" role="alert">{error}</p>}{success && <p role="status">{success}</p>}</form>;
}

function FinancialEntryForm({ order, onSaved }: { order: FinanceOrder; onSaved: () => Promise<void> }) {
  const [kind, setKind] = useState<FinancialEntry["kind"]>("payment"), [amount, setAmount] = useState("");
  const [recordDate, setDate] = useState(new Date().toISOString().slice(0, 10)), [reference, setReference] = useState(""), [note, setNote] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID()), [busy, setBusy] = useState(false), [error, setError] = useState(""), [success, setSuccess] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setSuccess("");
    try {
      await api(`/api/orders/${order.id}/financial-entries`, { method: "POST", body: JSON.stringify({ requestId, kind, amount, recordDate, reference, note }) });
      setRequestId(crypto.randomUUID()); setAmount(""); setReference(""); setNote(""); setSuccess("记录已保存，汇总已更新。"); await onSaved();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "保存失败"); }
    finally { setBusy(false); }
  }
  return <details className="commercial-block"><summary>新增付款 / 发票 / 额外成本记录</summary><form onSubmit={submit}>
    <div className="terms-fields"><label>记录类型<select value={kind} onChange={(event) => setKind(event.target.value as FinancialEntry["kind"])} disabled={busy}>{Object.entries(entryLabel).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>
      <label>金额（人民币元）<input type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} required disabled={busy} /></label>
      <label>记录日期<input type="date" value={recordDate} onInput={(event) => setDate(event.currentTarget.value)} required disabled={busy} /></label>
      <label>{kind === "invoice" ? "发票号码" : kind === "payment" ? "付款流水号" : "成本凭证号"}<input value={reference} maxLength={200} onChange={(event) => setReference(event.target.value)} required disabled={busy} /></label>
      <label>备注<textarea value={note} maxLength={2000} onChange={(event) => setNote(event.target.value)} disabled={busy} /></label></div>
    <p className="form-help">只登记已发生的记录；金额按凭证填写。付款流水、发票号码及成本凭证号用于防止重复录入。</p><button className="primary" disabled={busy}>{busy ? "正在保存" : "保存财务记录"}</button>
    {error && <p className="form-error" role="alert">{error}</p>}{success && <p role="status">{success}</p>}
  </form></details>;
}

function ReverseEntry({ order, entry, onSaved }: { order: FinanceOrder; entry: FinancialEntry; onSaved: () => Promise<void> }) {
  const [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [requestId] = useState(() => crypto.randomUUID());
  async function reverse(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { await api(`/api/orders/${order.id}/financial-entries`, { method: "POST", body: JSON.stringify({ requestId, reversalOf: entry.id, recordDate: new Date().toISOString().slice(0, 10), reference: `冲销-${entry.id}`, note: reason }) }); await onSaved(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "冲销失败"); }
    finally { setBusy(false); }
  }
  return <details><summary>冲销录入错误</summary><form onSubmit={reverse}><p>追加 {money(-entry.amount_cents)} 的冲销记录，保留原记录。不会实际退款。</p><label>冲销原因<input value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={2000} disabled={busy} /></label><button className="secondary" disabled={busy || !reason.trim()}>确认追加冲销</button>{error && <p className="form-error" role="alert">{error}</p>}</form></details>;
}

export function StaffPanel({ onLogout }: { onLogout: () => void }) {
  const createForm = useRef<HTMLFormElement>(null);
  const [users, setUsers] = useState<User[]>([]), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "purchaser", supplierOperations: false, financeSettlement: false });
  const load = async () => { try { setUsers((await api<{ users: User[] }>("/api/staff")).users); } catch (caught) { setError(caught instanceof Error ? caught.message : "读取失败"); } };
  useEffect(() => { void load(); }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { await api("/api/staff", { method: "POST", body: JSON.stringify(form) }); setForm({ name: "", email: "", password: "", role: "purchaser", supplierOperations: false, financeSettlement: false }); await load(); requestAnimationFrame(() => { createForm.current?.scrollIntoView({block:"nearest"}); createForm.current?.querySelector("input")?.focus({preventScroll:true}); }); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "创建失败"); }
    finally { setBusy(false); }
  }
  const departments = [
    { name: "管理层", roles: ["boss", "admin", "management"] },
    { name: "采购部", roles: ["purchaser"] },
    { name: "财务部", roles: ["finance"] },
    { name: "仓库部", roles: ["warehouse"] },
    { name: "工程部", roles: ["engineering"] },
    { name: "总经办", roles: ["office"] },
  ] as const;
  return <section className="finance-surface"><h2>内部账号与权限</h2><p className="form-help">CEO、管理员可维护内部账号。采购管理执行交付；财务管理结算；仓库部确认收货与入库；工程部只读查看，不含金额。权限由后台校验。</p>
    <details className="commercial-block" open><summary>创建内部账号</summary><form ref={createForm} onSubmit={submit}><div className="terms-fields">
      <label>姓名<input name="staff-name" autoComplete="off" required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} disabled={busy} /></label>
      <label>邮箱<input name="staff-email" type="email" autoComplete="username" spellCheck={false} required value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} disabled={busy} /></label>
      <PasswordField label="初始密码" value={form.password} onChange={password=>setForm({...form,password})} disabled={busy} required />
      <label>角色<select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })} disabled={busy}><option value="purchaser">采购</option><option value="finance">财务</option><option value="boss">CEO（全部权限）</option><option value="admin">管理员（全部权限及数据维护）</option><option value="management">管理层（采购、供应商、财务，不含 CEO 看板和账号管理）</option><option value="warehouse">仓库部（收货与入库，不含金额）</option><option value="office">总经办（全部只读，禁止下载导出）</option><option value="engineering">工程部（只读，不含金额）</option></select></label><label className="staff-permission-check"><input type="checkbox" checked={form.supplierOperations} onChange={event => setForm({ ...form, supplierOperations: event.target.checked })} disabled={busy} /><span>供应商流程操作<small>可代操作确认、排单、生产、待发货和发货登记</small></span></label><label className="staff-permission-check"><input type="checkbox" checked={form.financeSettlement} onChange={event => setForm({ ...form, financeSettlement: event.target.checked })} disabled={busy} /><span>财务结算<small>可查看并编辑应付款、付款、发票和税金</small></span></label></div><button className="primary" disabled={busy}>{busy ? "正在创建" : "创建内部账号"}</button></form></details>
    {error && <p className="form-error" role="alert">{error}</p>}
    <h3 className="staff-list-title">已创建账号</h3>
    <div className="finance-table-scroll"><table className="finance-table staff-department-table"><thead><tr><th>姓名</th><th>邮箱</th><th>角色</th><th>附加权限</th><th>操作</th></tr></thead>{departments.map(department => { const members = users.filter(user => (department.roles as readonly string[]).includes(user.role)); if (!members.length) return null; return <tbody key={department.name}><tr className="staff-department-heading"><th colSpan={5}>{department.name}<span>{members.length} 人</span></th></tr>{members.map(user => { const permissions = [user.role === "admin" || user.supplier_operations === 1 ? "供应商流程" : "", user.role === "admin" || user.role === "finance" || user.finance_settlement === 1 ? "财务结算" : ""].filter(Boolean); return <tr key={user.id}><td>{user.name}</td><td>{user.email}</td><td>{roleLabel[user.role]}</td><td>{permissions.join("、") || "—"}</td><td><button type="button" className="text-button" onClick={() => setEditing(user)}>编辑账号</button></td></tr>; })}</tbody>; })}</table></div>
    {editing && <StaffAccountEditor key={editing.id} user={editing} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} onLogout={onLogout} />}
  </section>;
}

function StaffAccountEditor({ user, onCancel, onSaved, onLogout }: { user: User; onCancel: () => void; onSaved: () => void; onLogout: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(user.name), [email, setEmail] = useState(user.email);
  const [role, setRole] = useState(user.role);
  const [password, setPassword] = useState(""), [confirmation, setConfirmation] = useState("");
  const [supplierOperations, setSupplierOperations] = useState(user.role === "admin" || user.supplier_operations === 1);
  const [financeSettlement, setFinanceSettlement] = useState(user.role === "admin" || user.role === "finance" || user.finance_settlement === 1);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { dialogRef.current?.showModal(); requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>("input")?.focus()); }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (password !== confirmation) { setError("两次输入的新密码不一致，请重新确认。"); requestAnimationFrame(() => dialogRef.current?.querySelectorAll<HTMLInputElement>('input[type="password"]')[1]?.focus()); return; }
    setBusy(true); setError("");
    try {
      const result = await api<{ loginRequired: boolean }>(`/api/staff/${user.id}`, { method: "PATCH", body: JSON.stringify({ name, email, password, role, supplierOperations, financeSettlement }) });
      setPassword(""); setConfirmation("");
      if (result.loginRequired) onLogout(); else onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败，请重试"); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialogRef} className="staff-account-dialog" aria-labelledby={`staff-editor-title-${user.id}`} onCancel={event => { if (busy) event.preventDefault(); else onCancel(); }} onClose={onCancel}><form className="entity-form" onSubmit={save}>
    <h3 id={`staff-editor-title-${user.id}`}>编辑账号 · {user.name}</h3>
    <p>可重新设置主角色和附加权限。权限变更后该账号需重新登录；历史订单和操作记录不会改写。密码留空则保持原密码。</p>
    <div className="form-grid">
      <label>姓名 / 账号名称<input name="staff-name" autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} required maxLength={100} disabled={busy} /></label>
      <label>登录邮箱<input name="staff-email" type="email" autoComplete="username" spellCheck={false} value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={254} disabled={busy} /></label>
      <PasswordField label="重设密码（可选）" value={password} onChange={setPassword} disabled={busy} />
      <PasswordField label="确认新密码" value={confirmation} onChange={setConfirmation} required={Boolean(password)} disabled={busy} />
      <label>主角色<select value={role} onChange={(event) => { const next = event.target.value as User["role"]; setRole(next); if (next === "admin") { setSupplierOperations(true); setFinanceSettlement(true); } else if (next === "finance") setFinanceSettlement(true); }} disabled={busy}><option value="purchaser">采购</option><option value="finance">财务</option><option value="boss">CEO（全部权限）</option><option value="admin">管理员（全部权限及数据维护）</option><option value="management">管理层（采购、供应商、财务，不含 CEO 看板和账号管理）</option><option value="warehouse">仓库部（收货与入库，不含金额）</option><option value="office">总经办（全部只读，禁止下载导出）</option><option value="engineering">工程部（只读，不含金额）</option></select></label>
      <label className="staff-permission-check"><input type="checkbox" checked={supplierOperations} onChange={event => setSupplierOperations(event.target.checked)} disabled={busy || role === "admin"} /><span>供应商流程操作<small>可随时开启或取消；管理员默认拥有</small></span></label>
      <label className="staff-permission-check"><input type="checkbox" checked={financeSettlement} onChange={event => setFinanceSettlement(event.target.checked)} disabled={busy || role === "admin" || role === "finance"} /><span>财务结算<small>可查看并编辑应付款、付款、发票和税金</small></span></label>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="form-actions"><button type="button" className="text-button" disabled={busy} onClick={onCancel}>取消</button><button className="primary" disabled={busy}>{busy ? "正在保存" : "保存账号"}</button></div>
  </form></dialog>;
}
