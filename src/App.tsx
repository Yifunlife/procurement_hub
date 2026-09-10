import { Account } from "./Account";
import { useSectionHeaders } from "./useSectionHeaders";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  AlertTriangle,
  Box,
  Building2,
  CalendarClock,
  Check,
  ChevronDown,
  ClipboardCheck,
  FileText,
  Image as ImageIcon,
  LayoutDashboard,
  LayoutList,
  LogOut,
  Menu,
  PackageCheck,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Truck,
  Trash2,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import { api, ApiError, uploadFile } from "./api";
import { FilePicker } from "./FilePicker";
import { ExportButton } from "./ExportButton";
import { canPurchase, roleLabel, emptyTerms, TermsFields, SupplierTermsEditor, OrderCommercial, FinancePanel, StaffPanel } from "./Commercial";
import type { DashboardData, FinanceOrder, ProductType, ProductWorkflowStage, PurchaseOrder, Status, Supplier, SupplierProduct, User } from "./types";

const STATUS: Record<Status, { label: string; short: string; step: number }> = {
  pending_confirmation: { label: "待供应商确认", short: "待确认", step: 0 },
  in_production: { label: "生产中", short: "生产中", step: 1 },
  ready_to_ship: { label: "生产完成", short: "生产完成", step: 2 },
  partial_shipped: { label: "部分发货", short: "部分发货", step: 3 },
  shipped: { label: "已发货", short: "已发货", step: 4 },
  received: { label: "已到货", short: "已到货", step: 5 },
  completed: { label: "已完结", short: "已完结", step: 6 },
};

const STAGES: Status[] = ["pending_confirmation", "in_production", "ready_to_ship", "partial_shipped", "shipped", "received", "completed"];
const PRODUCT_WORKFLOW_STAGES: Array<{ id: ProductWorkflowStage; label: string }> = [
  { id: "queued", label: "排单中" },
  { id: "in_production", label: "生产中" },
  { id: "production_complete", label: "生产完成" },
  { id: "shipment_complete", label: "发货完成" },
];
const PRODUCT_TYPES: ProductType[] = ["配件类", "电气类", "安全防护类", "成品设备类", "定制加工类"];
const PRODUCT_OPTIONS: Record<ProductType, string[]> = {
  配件类: ["五金件", "连接件", "轴承", "合页", "滑轨", "拉手", "锁具", "绳网扣", "弹簧", "脚盘", "管通件", "装饰件", "其他产品（在备注中说明）"],
  电气类: ["电源", "电线缆", "开关", "插座", "灯具/灯带", "变压器", "适配器", "电机", "风机", "传感器", "控制器", "屏幕", "音响", "按钮", "PCB板", "配电箱", "线管线槽", "电子元件", "其他产品（在备注中说明）"],
  安全防护类: ["防护网", "安全带", "化纤钢绳", "包胶钢丝绳", "安全锁扣", "扎带", "包管", "扶手护栏", "其他产品（在备注中说明）"],
  成品设备类: ["互动体感", "数字游戏", "互动墙", "投影设备", "滑梯", "秋千", "摇马", "蹦床面", "小玩具", "充气制品", "海洋球", "木粒/白沙/陶瓷沙", "其他产品（在备注中说明）"],
  定制加工类: ["钣金", "亚克力制品", "CNC", "激光切割", "玻璃钢制品", "文本印刷", "广告制作", "皮革UV", "壁纸", "地胶", "车贴", "玻璃制品", "车木加工", "定制结构件", "其他产品（在备注中说明）"],
};

const money = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const quantityText = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
const dateText = (value?: string | null) => value ? new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", year: "numeric" }).format(new Date(`${value}T00:00:00`)) : "待填写";
const total = (order: PurchaseOrder) => order.items.reduce((sum, item) => sum + Number(item.amount), 0);
const canViewAmounts = (role: User["role"]) => !["engineering", "warehouse"].includes(role);
const normalizedProductName = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[\s【】\[\]（）()·,，。._\-—/\\]/g, "");
const shippingTotals = (order: PurchaseOrder) => {
  const ordered = order.items.reduce((sum, item) => sum + Number(item.quantity), 0);
  const shipped = order.shipments.reduce((sum, shipment) => sum + Number(shipment.quantity), 0);
  return { ordered, shipped, remaining: Math.max(0, ordered - shipped) };
};
const productionTotals = (order: PurchaseOrder) => {
  const completedStages: ProductWorkflowStage[] = ["production_complete", "ready_to_ship", "shipment_complete"];
  const completed = order.items.filter((item) => completedStages.includes(item.workflow_stage)).length;
  return { completed, total: order.items.length, progress: order.items.length ? Math.round((completed / order.items.length) * 100) : 0 };
};
const shanghaiToday = () => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};
const daysToShip = (order: PurchaseOrder) => {
  const target = order.promised_ship_date || order.required_ship_date;
  return Math.round((Date.parse(`${target}T00:00:00Z`) - Date.parse(`${shanghaiToday()}T00:00:00Z`)) / 86_400_000);
};
const isDelayed = (order: PurchaseOrder) => {
  if (order.archived_at || ["shipped", "received", "completed"].includes(order.status)) return false;
  return shippingTotals(order).remaining > 0 && daysToShip(order) < 0;
};
const effectiveOrderStatus = (order: PurchaseOrder): Status => {
  if (order.status !== "pending_confirmation" || !order.items.length) return order.status;
  const completedStages: ProductWorkflowStage[] = ["production_complete", "ready_to_ship", "shipment_complete"];
  if (order.items.every((item) => completedStages.includes(item.workflow_stage))) return "ready_to_ship";
  if (order.items.some((item) => item.workflow_stage !== "queued")) return "in_production";
  return order.status;
};

const projectCountry = (project: string) => {
  const normalized = project.normalize("NFKC").replace(/[\s\u200B-\u200D\u2060\uFEFF]/g, "").toLowerCase();
  if (["备货", "上海公司展厅", "公司展厅", "集团展厅"].some((keyword) => normalized.includes(keyword))) return "公司内部";
  const international: Array<[string, string]> = [["沙特", "沙特阿拉伯"], ["美国", "美国"], ["加拿大", "加拿大"], ["canada", "加拿大"], ["泰国", "泰国"], ["阿联酋", "阿联酋"], ["迪拜", "阿联酋"], ["卡塔尔", "卡塔尔"], ["科威特", "科威特"], ["巴林", "巴林"], ["阿曼", "阿曼"], ["澳洲", "澳大利亚"], ["澳大利亚", "澳大利亚"], ["英国", "英国"], ["德国", "德国"], ["法国", "法国"]];
  const matched = international.find(([keyword]) => normalized.includes(keyword));
  if (matched) return matched[1];
  const chinaLocations = ["中国", "北京", "上海", "天津", "重庆", "河北", "山西", "辽宁", "吉林", "黑龙江", "江苏", "浙江", "安徽", "福建", "江西", "山东", "河南", "湖北", "湖南", "广东", "海南", "四川", "贵州", "云南", "陕西", "甘肃", "青海", "内蒙古", "广西", "西藏", "宁夏", "新疆", "香港", "澳门", "台湾", "宁波", "鄞州", "ningbo", "zhejiang", "杭州", "温州", "绍兴", "金华", "苏州", "南京", "无锡", "广州", "深圳", "佛山", "东莞", "武汉", "长沙", "成都", "西安", "青岛", "济南", "郑州", "合肥", "福州", "厦门", "沈阳", "大连", "昆明", "贵阳"];
  return chinaLocations.some((location) => normalized.includes(location)) ? "中国" : "未分类";
};

function useUnsavedChanges(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const guardNavigation = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest(".sidebar a, .sidebar button, .back-button") : null;
      if (target && !window.confirm("已填写的内容尚未保存，确定离开吗？")) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", guardNavigation, true);
    return () => { window.removeEventListener("beforeunload", beforeUnload); document.removeEventListener("click", guardNavigation, true); };
  }, [dirty]);
}

function focusFirstFormError() {
  requestAnimationFrame(() => {
    const error = document.querySelector<HTMLElement>(".form-error");
    if (!error) return;
    error.tabIndex = -1;
    error.focus();
  });
}

function BrandLogo({ compact = false }: { compact?: boolean }) {
  return <img className={compact ? "brand-logo compact" : "brand-logo"} src="/yifun-logo.png" alt="亦玩集团 YIFUN LIFE" width="1431" height="340" fetchPriority="high" />;
}

function App() {
  useSectionHeaders();
  const [user, setUser] = useState<User | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    Promise.all([
      api<{ authenticated: boolean; user: User | null }>("/api/auth/session"),
      api<{ needsSetup: boolean }>("/api/setup/status"),
    ])
      .then(([session, setup]) => { setUser(session.user); setNeedsSetup(setup.needsSetup); })
      .finally(() => setChecking(false));
  }, []);

  if (checking) return <LoadingScreen />;
  if (needsSetup) return <InitialSetup onCreated={(createdUser) => { setUser(createdUser); setNeedsSetup(false); }} />;
  if (!user) return <Login onLogin={setUser} />;
  return <Workbench user={user} onLogout={() => setUser(null)} />;
}

function LoadingScreen() {
  return <main id="main-content" className="loading-screen"><BrandLogo compact /><p>正在打开采购流程台…</p></main>;
}

function InitialSetup({ onCreated }: { onCreated: (user: User) => void }) {
  const [form, setForm] = useState({ name: "", email: "", password: "", setupCode: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const change = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = await api<{ user: User }>("/api/setup/admin", { method: "POST", body: JSON.stringify(form) });
      onCreated(result.user);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "管理员账号创建失败，请检查填写内容后重试。"); focusFirstFormError(); }
    finally { setBusy(false); }
  }

  return <main id="main-content" className="login-page setup-page"><section className="login-story"><div className="login-brand"><BrandLogo /></div><div className="setup-seal"><ShieldCheck size={28} aria-hidden="true" /><span>首次开通</span></div><h1>由你亲自建立<br />第一个采购账号。</h1><p>这个账号拥有采购端管理权限。创建后，系统会关闭首次开通入口。</p></section><section className="login-panel"><form onSubmit={submit}><div><h2>创建采购管理员</h2><p>请使用你自己的姓名、邮箱和密码</p></div><label>你的姓名<input name="name" autoComplete="name" value={form.name} onChange={(e) => change("name", e.target.value)} placeholder="例如：采购负责人姓名…" required /></label><label>登录邮箱<input name="email" type="email" autoComplete="username" spellCheck={false} value={form.email} onChange={(e) => change("email", e.target.value)} placeholder="name@company.com" required /></label><label>设置密码<input name="password" type="password" autoComplete="new-password" value={form.password} onChange={(e) => change("password", e.target.value)} minLength={10} placeholder="至少 10 位…" required /></label><label>初始化安全码<input name="setup-code" type="password" autoComplete="off" value={form.setupCode} onChange={(e) => change("setupCode", e.target.value)} placeholder="部署时提供的一次性安全码…" required /><small>安全码只用于首次开通，防止他人抢先注册管理员。</small></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="primary wide" disabled={busy}><ShieldCheck size={18} aria-hidden="true" />{busy ? "正在创建…" : "创建并进入系统"}</button></form></section></main>;
}

function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const emailRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (window.matchMedia("(min-width: 769px)").matches) emailRef.current?.focus(); }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ user: User }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      onLogin(result.user);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "登录失败，请检查邮箱和密码。");
      focusFirstFormError();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="main-content" className="login-page">
      <section className="login-story">
        <div className="login-brand"><BrandLogo /></div>
        <div className="route-line" aria-hidden="true">
          {STAGES.map((status, index) => <span key={status} className={index < 3 ? "active" : ""}>{index + 1}</span>)}
        </div>
        <h1>采购，不再停在<br />“问到哪一步了”。</h1>
        <p>从供应商确认到到货完结，每一次更新都留在同一张采购单里。</p>
        <div className="login-proof"><ShieldCheck size={20} /><span>供应商仅能查看自己的采购单</span></div>
      </section>
      <section className="login-panel">
        <form onSubmit={submit}>
          <div>
            <h2>登录采购管理中心</h2>
            <p>采购人员与供应商使用各自账号登录</p>
          </div>
          <label>登录邮箱<input ref={emailRef} name="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" spellCheck={false} placeholder="name@company.com" required /></label>
          <label>密码<input name="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" placeholder="请输入密码…" required /></label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary wide" disabled={busy}>{busy ? <RefreshCw className="spin" size={18} /> : <ArrowRight size={18} />}{busy ? "正在登录" : "登录"}</button>
          <p className="security-note">管理员账号由你首次开通时创建；供应商账号由采购负责人创建。</p>
        </form>
      </section>
    </main>
  );
}

type View = "ceo" | "orders" | "suppliers" | "supplier-detail" | "new-order" | "new-supplier" | "edit-supplier" | "finance" | "staff" | "account";
type Filter = "all" | Status | "delayed" | "archived";

function Workbench({ user, onLogout }: { user: User; onLogout: () => void }) {
  const hasFinanceAccess = user.role === "finance" || ["boss", "admin", "office", "management"].includes(user.role) || user.finance_settlement === 1;
  const initialParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const [data, setData] = useState<DashboardData | null>(null);
  const defaultView: View = user.role === "finance" ? "finance" : user.role === "boss" ? "ceo" : "orders";
  const [view, setView] = useState<View>((initialParams.get("view") as View) || defaultView);
  const [filter, setFilter] = useState<Filter>((initialParams.get("filter") as Filter) || "all");
  const [query, setQuery] = useState(initialParams.get("q") || "");
  const [selectedId, setSelectedId] = useState(initialParams.get("order") || "");
  const [editingSupplierId, setEditingSupplierId] = useState("");
  const [supplierQuery, setSupplierQuery] = useState("");
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [currentProject, setCurrentProject] = useState(initialParams.get("project") || "尚未选择项目");
  const refreshPromise = useRef<Promise<void> | null>(null);

  useEffect(() => {
    const params = new URLSearchParams();
    if (view !== defaultView) params.set("view", view);
    if (filter !== "all") params.set("filter", filter);
    if (query) params.set("q", query);
    if (selectedId) params.set("order", selectedId);
    if (currentProject !== "尚未选择项目") params.set("project", currentProject);
    window.history.replaceState(null, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`);
  }, [view, filter, query, selectedId, currentProject, defaultView]);
  useEffect(() => {
    const restoreUrlState = () => {
      const params = new URLSearchParams(window.location.search);
      setView((params.get("view") as View) || defaultView);
      setFilter((params.get("filter") as Filter) || "all");
      setQuery(params.get("q") || "");
      setSelectedId(params.get("order") || "");
      setCurrentProject(params.get("project") || "尚未选择项目");
    };
    window.addEventListener("popstate", restoreUrlState);
    return () => window.removeEventListener("popstate", restoreUrlState);
  }, [defaultView]);

  const refresh = (keepSelection = true) => {
    if (refreshPromise.current) return refreshPromise.current;
    const pending = (async () => {
      if (user.role === "finance") { setData({ user, orders: [], suppliers: [] }); return; }
      try {
        const next = await api<DashboardData>("/api/dashboard");
        setData(next);
        const refreshedSelection = next.orders.find((order) => order.id === selectedId);
        if (refreshedSelection) setCurrentProject(refreshedSelection.project_name);
        if (!keepSelection || !next.orders.some((order) => order.id === selectedId)) setSelectedId("");
        setError("");
      } catch (caught) {
        if (caught instanceof ApiError && caught.status === 401) onLogout();
        else setError(caught instanceof Error ? caught.message : "无法读取数据");
      }
    })();
    refreshPromise.current = pending;
    void pending.finally(() => { if (refreshPromise.current === pending) refreshPromise.current = null; });
    return pending;
  };

  useEffect(() => { void refresh(false); }, []);
  useEffect(() => {
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("yifun-procurement-data");
    const sync = () => { void refresh().then(() => setRefreshVersion(current => current + 1)); };
    const announce = () => { channel?.postMessage("changed"); sync(); };
    window.addEventListener("procurement:data-changed", announce);
    channel?.addEventListener("message", sync);
    return () => { window.removeEventListener("procurement:data-changed", announce); channel?.removeEventListener("message", sync); channel?.close(); };
  }, [user.role, selectedId]);
  useEffect(() => {
    if (user.role === "finance" || ["new-order", "new-supplier", "edit-supplier", "supplier-detail", "account"].includes(view)) return;
    let active = true, loading = false;
    const sync = async () => {
      if (loading || document.hidden || document.querySelector("dialog[open]") || document.activeElement?.matches("input, textarea, select")) return;
      loading = true;
      try {
        await refresh();
        if (active) setRefreshVersion(current => current + 1);
      } catch { /* Keep the last loaded order until the next refresh. */ }
      finally { loading = false; }
    };
    const timer = window.setInterval(() => void sync(), 8000);
    window.addEventListener("focus", sync);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("focus", sync); };
  }, [view, user.role]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.orders.filter((order) => {
      if (filter === "archived" ? !order.archived_at : order.archived_at) return false;
      const matchesFilter = filter === "all" || filter === "archived" || (filter === "delayed" ? isDelayed(order) : effectiveOrderStatus(order) === filter);
      const text = `${order.po_number} ${order.project_name} ${order.supplier_name}`.toLowerCase();
      const matchesProject = currentProject === "尚未选择项目" || order.project_name === currentProject;
      return matchesFilter && matchesProject && text.includes(query.toLowerCase().trim());
    });
  }, [data, filter, query, currentProject]);
  const selected = filtered.find((order) => order.id === selectedId);

  async function logout() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    onLogout();
  }

  const done = async (message: string) => {
    setToast(message);
    setView("orders");
    await refresh();
  };

  if (!data) return <LoadingScreen />;

  const sidebarProjects = [...new Set(data.orders.filter((order) => !order.archived_at).map((order) => order.project_name).filter(Boolean))];
  const projectsByCountry = sidebarProjects.reduce<Record<string, string[]>>((groups, project) => { const country = projectCountry(project); (groups[country] ||= []).push(project); return groups; }, {});

  return (
    <div className="app-shell">
      <aside className={mobileNav ? "sidebar open" : "sidebar"}>
        <div className="sidebar-top">
          <div className="app-brand"><BrandLogo /><div><strong>采购管理中心</strong><span>YIFUN PROCUREMENT</span></div></div>
          <button className="icon-button mobile-only" onClick={() => setMobileNav(false)} aria-label="关闭导航"><X size={20} /></button>
        </div>
        <nav aria-label="主导航">
          {["boss", "admin"].includes(user.role) && <a href="?view=ceo" className={view === "ceo" ? "active" : ""} aria-current={view === "ceo" ? "page" : undefined} onClick={(event) => { event.preventDefault(); setView("ceo"); setMobileNav(false); }}><LayoutDashboard size={19} aria-hidden="true" />CEO 看板</a>}
          {user.role !== "finance" && <a href="?view=orders" className={view === "orders" || view === "new-order" ? "active" : ""} aria-current={view === "orders" ? "page" : undefined} onClick={(event) => { event.preventDefault(); setView("orders"); setFilter("all"); setQuery(""); setCurrentProject("尚未选择项目"); setSelectedId(""); setMobileNav(false); }}><LayoutList size={19} aria-hidden="true" />采购订单</a>}
          {hasFinanceAccess && <a href="?view=finance" className={view === "finance" ? "active" : ""} aria-current={view === "finance" ? "page" : undefined} onClick={(event) => { event.preventDefault(); setView("finance"); setMobileNav(false); }}><FileText size={19} aria-hidden="true" />财务结算</a>}
          {["boss", "admin", "office"].includes(user.role) && <a href="?view=staff" className={view === "staff" ? "active" : ""} aria-current={view === "staff" ? "page" : undefined} onClick={(event) => { event.preventDefault(); setView("staff"); setMobileNav(false); }}><ShieldCheck size={19} aria-hidden="true" />内部账号</a>}
          {(canPurchase(user.role) || ["office", "management"].includes(user.role)) && <a href="?view=suppliers" className={["suppliers", "supplier-detail", "new-supplier", "edit-supplier"].includes(view) ? "active" : ""} aria-current={view === "suppliers" ? "page" : undefined} onClick={(event) => { event.preventDefault(); setView("suppliers"); setMobileNav(false); }}><Building2 size={19} aria-hidden="true" />供应商资料</a>}
        </nav>
        {user.role !== "finance" && view !== "ceo" && <div className="sidebar-projects" aria-label="项目导航">
          <p>项目</p>
          {sidebarProjects.length ? Object.entries(projectsByCountry).sort(([left, leftProjects], [right, rightProjects]) => { const priority = (country: string) => country === "公司内部" ? 0 : country === "中国" ? 1 : country === "未分类" ? 3 : 2; const priorityDifference = priority(left) - priority(right); if (priorityDifference) return priorityDifference; const quantityDifference = rightProjects.length - leftProjects.length; return quantityDifference || left.localeCompare(right, "zh-CN"); }).map(([country, projects]) => <details className="sidebar-country" key={country}><summary><ChevronDown size={14} />{country}<small>{projects.length}</small></summary>{projects.map((project) => <button type="button" key={project} className={currentProject === project ? "active" : ""} title={project} onClick={() => { setCurrentProject(project); setView("orders"); setFilter("all"); setQuery(""); setSelectedId(""); setMobileNav(false); }}>{project}</button>)}</details>) : <small>暂无项目</small>}
        </div>}
        <div className="account-block"><button type="button" className="avatar" aria-label="个人账号 / 修改密码" title="个人账号 / 修改密码" aria-current={view === "account" ? "page" : undefined} onClick={() => { setView("account"); setMobileNav(false); }}><UserRound size={18} /></button><div><strong>{user.name}</strong><small>{roleLabel[user.role]}</small></div><button className="icon-button" onClick={logout} aria-label="退出登录"><LogOut size={18} /></button></div>
      </aside>
      {mobileNav && <button className="nav-scrim" onClick={() => setMobileNav(false)} aria-label="关闭导航" />}
      <main id="main-content" className="workspace" tabIndex={-1}>
        <header className="topbar">
          <button className="icon-button mobile-only" onClick={() => setMobileNav(true)} aria-label="打开导航"><Menu size={21} /></button>
          <div><h1>{view === "ceo" ? "CEO 采购看板" : view === "account" ? "个人账号" : view === "finance" ? "财务结算" : view === "staff" ? "内部账号" : view === "suppliers" ? "供应商资料" : view === "supplier-detail" ? "供应商详情" : view === "new-supplier" ? "新建供应商" : view === "edit-supplier" ? "编辑供应商" : view === "new-order" ? "新建采购单" : canPurchase(user.role) ? "采购订单"  : ["engineering", "warehouse", "office", "management"].includes(user.role) ? "全部采购单" : "我的采购单"}</h1><p>{view === "ceo" ? "看金额、付款、发票和成本分布，不展开订单细节。" : user.role === "finance" ? "逐笔记录付款、发票与成本，金额自动汇总。" : user.role === "management" ? "管理采购、供应商与财务结算；不含 CEO 看板和内部账号管理。" : canPurchase(user.role) ? "今天需要推进的采购事项，都在这里。" : user.role === "office" ? "全部资料只读，不可修改、下载表单或导出。" : user.role === "warehouse" ? "核对产品收货与入库，不显示财务金额。" : user.role === "engineering" ? "只读查看全部采购单，不含财务金额；收货与入库由仓库部确认。" : "查看并更新属于贵司的采购订单。"}</p></div>
          {canPurchase(user.role) && view === "orders" && <button className="primary" onClick={() => setView("new-order")}><Plus size={18} />新建采购单</button>}
          {canPurchase(user.role) && view === "suppliers" && <button className="primary" onClick={() => setView("new-supplier")}><Plus size={18} />新建供应商</button>}
        </header>
        {error && <div className="global-error" role="alert">{error}<button onClick={() => refresh()}>重试</button></div>}
        {view === "ceo" && ["boss", "admin"].includes(user.role) && <CeoDashboard key={refreshVersion} purchaseOrders={data.orders} />}
        {view === "finance" && hasFinanceAccess && <FinancePanel key={refreshVersion} readOnly={user.role === "office"} />}
        {view === "staff" && ["boss", "admin", "office"].includes(user.role) && <div className={"staff-scroll" + (user.role === "office" ? " office-readonly" : "")}><StaffPanel onLogout={onLogout} /></div>}
        {view === "account" && <Account user={user} onLogout={onLogout} />}
        {view === "new-order" && <NewOrder suppliers={data.suppliers} user={user} onCancel={() => setView("orders")} onDone={(id, message) => { setSelectedId(id); void done(message || "采购单已创建，等待供应商确认"); }} />}
        {view === "new-supplier" && <NewSupplier user={user} onCancel={() => setView("suppliers")} onDone={async () => { setToast("供应商资料与登录账号已创建"); setView("suppliers"); await refresh(); }} />}
        {view === "edit-supplier" && <NewSupplier user={user} supplier={data.suppliers.find((supplier) => supplier.id === editingSupplierId)} onCancel={() => setView("supplier-detail")} onDone={async () => { setToast("供应商资料与登录账号已更新"); setView("supplier-detail"); await refresh(); }} />}
        {view === "suppliers" && <SupplierDirectory suppliers={data.suppliers} query={supplierQuery} onQuery={setSupplierQuery} onOpen={(supplierId) => { setEditingSupplierId(supplierId); setView("supplier-detail"); }} />}
        {view === "supplier-detail" && <SupplierDetail readOnly={user.role === "office"} key={editingSupplierId} supplier={data.suppliers.find((supplier) => supplier.id === editingSupplierId)} hasOrders={data.orders.some((order) => order.supplier_id === editingSupplierId)} onBack={() => setView("suppliers")} onEdit={() => setView("edit-supplier")} onRemoved={async (name) => { setToast(`${name} 已移除`); setView("suppliers"); await refresh(); }} onTermsSaved={() => { setToast("默认商务条件已保存，历史订单未改变"); void refresh(); }} />}
        {view === "orders" && <OrdersView orders={filtered} allOrders={data.orders} suppliers={data.suppliers} selected={selected} currentProject={currentProject} filter={filter} query={query} user={user} onFilter={setFilter} onQuery={setQuery} onProject={setCurrentProject} onSelect={(id) => { if (id) setCurrentProject(data.orders.find((order) => order.id === id)?.project_name || "尚未选择项目"); setSelectedId(id); }} onChanged={(message) => done(message)} />}
      </main>
      {toast && <div className="toast" role="status" aria-live="polite"><Check size={18} />{toast}</div>}
    </div>
  );
}

function CeoDashboard({ purchaseOrders }: { purchaseOrders: PurchaseOrder[] }) {
  const [financeOrders, setFinanceOrders] = useState<FinanceOrder[] | null>(null);
  const [error, setError] = useState("");
  const [supplierPeriod, setSupplierPeriod] = useState<"month" | "quarter" | "year" | "all">("month");
  const [showAllSupplierPurchases, setShowAllSupplierPurchases] = useState(false);
  const [projectPeriod, setProjectPeriod] = useState<"month" | "quarter" | "year" | "all">("month");
  const [showAllProjectPurchases, setShowAllProjectPurchases] = useState(false);
  const [supplierPerformanceQuery, setSupplierPerformanceQuery] = useState("");
  const [supplierPerformanceSort, setSupplierPerformanceSort] = useState<"risk" | "purchase" | "delivery">("risk");
  const [showAllSupplierPerformance, setShowAllSupplierPerformance] = useState(false);
  const [financePeriod, setFinancePeriod] = useState<"month" | "quarter" | "half" | "year" | "custom">("month");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const load = async () => {
    try { setFinanceOrders((await api<{ orders: FinanceOrder[] }>("/api/finance")).orders); setError(""); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "看板数据读取失败"); }
  };
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden && !document.querySelector("dialog[open]") && !document.activeElement?.matches("input, textarea, select")) void load();
    }, 8000);
    return () => window.clearInterval(timer);
  }, []);
  const today = new Date();
  const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const month = localDate(today).slice(0, 7);
  const todayText = localDate(today);
  const quarterStartMonth = Math.floor(today.getMonth() / 3) * 3 + 1;
  const quarterStart = `${today.getFullYear()}-${String(quarterStartMonth).padStart(2, "0")}`;
  const quarterEnd = `${today.getFullYear()}-${String(quarterStartMonth + 2).padStart(2, "0")}`;
  const periodStarts = { month: `${month}-01`, quarter: `${quarterStart}-01`, half: localDate(new Date(today.getFullYear(), today.getMonth() - 5, 1)), year: `${today.getFullYear()}-01-01` };
  const periodStart = financePeriod === "custom" ? customStart : periodStarts[financePeriod];
  const periodEnd = financePeriod === "custom" ? customEnd : todayText;
  const periodLabel = financePeriod === "month" ? "本月" : financePeriod === "quarter" ? "本季度" : financePeriod === "half" ? "近半年" : financePeriod === "year" ? "本年度" : "所选期间";
  const deadline = new Date(today); deadline.setDate(deadline.getDate() + 30);
  const activeOrders = purchaseOrders.filter(order => !order.archived_at);
  const purchaseById = new Map(activeOrders.map(order => [order.id, order]));
  const finances = (financeOrders || []).filter(order => purchaseById.has(order.id));
  const sum = (values: Array<number | null | undefined>) => values.reduce<number>((totalValue, value) => totalValue + Number(value || 0), 0);
  const formatCents = (value: number) => `¥ ${money.format(value / 100)}`;
  const formatCompactCents = (value: number) => Math.abs(value) >= 1000000 ? `¥ ${(value / 1000000).toLocaleString("zh-CN", { maximumFractionDigits: 1 })}万` : formatCents(value);
  const monthlyPurchases = sum(activeOrders.filter(order => order.order_date.startsWith(month)).map(order => Math.round(total(order) * 100)));
  const periodOrders = activeOrders.filter(order => periodStart && periodEnd && order.order_date >= periodStart && order.order_date <= periodEnd);
  const periodOrderIds = new Set(periodOrders.map(order => order.id));
  const periodFinances = finances.filter(order => periodOrderIds.has(order.id));
  const periodPurchases = sum(periodOrders.map(order => Math.round(total(order) * 100)));
  const periodPayable = sum(periodFinances.map(order => order.payable_cents));
  const periodPaid = sum(finances.flatMap(order => order.entries).filter(entry => entry.kind === "payment" && periodStart && periodEnd && entry.record_date >= periodStart && entry.record_date <= periodEnd).map(entry => entry.amount_cents));
  const periodUnpaid = sum(periodFinances.map(order => order.unpaid_cents));
  const thirtyDayPayable = sum(finances.filter(order => { const purchase = purchaseById.get(order.id); return purchase && purchase.required_ship_date >= localDate(today) && purchase.required_ship_date <= localDate(deadline); }).map(order => order.unpaid_cents));
  const delayedOrders = activeOrders.filter(isDelayed);
  const paid = sum(finances.map(order => order.paid_cents));
  const invoiced = sum(finances.map(order => order.invoiced_cents));
  const uninvoiced = sum(finances.map(order => order.payable_cents === null ? 0 : Math.max(0, order.payable_cents - order.invoiced_cents)));
  const freightCosts = sum(finances.map(order => order.extra_cost_cents));
  const groupPurchases = (orders: PurchaseOrder[], key: "supplier_name" | "project_name") => [...orders.reduce((groups, order) => groups.set(order[key] || "未分类", (groups.get(order[key] || "未分类") || 0) + Math.round(total(order) * 100)), new Map<string, number>()).entries()].sort((left, right) => right[1] - left[1]);
  const supplierDelivery = [...activeOrders.filter(order => order.shipped_at).reduce((groups, order) => { const target = order.promised_ship_date || order.required_ship_date; const shipped = order.shipped_at!.slice(0, 10); const delay = Math.max(0, Math.round((new Date(`${shipped}T00:00:00`).getTime() - new Date(`${target}T00:00:00`).getTime()) / 86400000)); const current = groups.get(order.supplier_name) || { total: 0, onTime: 0, delayDays: 0 }; current.total++; if (shipped <= target) current.onTime++; current.delayDays += delay; groups.set(order.supplier_name, current); return groups; }, new Map<string, { total: number; onTime: number; delayDays: number }>()).entries()].map(([name, value]) => ({ name, ...value, rate: Math.round(value.onTime / value.total * 100), averageDelay: Math.round(value.delayDays / value.total) })).sort((left, right) => left.rate - right.rate || right.total - left.total);
  const quarterlyPurchases = sum(activeOrders.filter(order => order.order_date.slice(0, 7) >= quarterStart && order.order_date.slice(0, 7) <= quarterEnd).map(order => Math.round(total(order) * 100)));
  const supplierPeriodOrders = activeOrders.filter(order => supplierPeriod === "all" || (supplierPeriod === "year" ? order.order_date.startsWith(String(today.getFullYear())) : supplierPeriod === "quarter" ? order.order_date.slice(0, 7) >= quarterStart && order.order_date.slice(0, 7) <= quarterEnd : order.order_date.startsWith(month)));
  const supplierPurchases = groupPurchases(supplierPeriodOrders, "supplier_name");
  const allSupplierPurchases = groupPurchases(activeOrders, "supplier_name");
  const supplierPurchaseOther = sum(supplierPurchases.slice(10).map(([, value]) => value));
  const supplierPurchaseRows = showAllSupplierPurchases ? supplierPurchases : [...supplierPurchases.slice(0, 10), ...(supplierPurchaseOther ? [["其他供应商", supplierPurchaseOther] as [string, number]] : [])];
  const projectPeriodOrders = activeOrders.filter(order => projectPeriod === "all" || (projectPeriod === "year" ? order.order_date.startsWith(String(today.getFullYear())) : projectPeriod === "quarter" ? order.order_date.slice(0, 7) >= quarterStart && order.order_date.slice(0, 7) <= quarterEnd : order.order_date.startsWith(month)));
  const projectPurchases = groupPurchases(projectPeriodOrders, "project_name");
  const projectPurchaseOther = sum(projectPurchases.slice(10).map(([, value]) => value));
  const projectPurchaseRows = showAllProjectPurchases ? projectPurchases : [...projectPurchases.slice(0, 10), ...(projectPurchaseOther ? [["其他项目", projectPurchaseOther] as [string, number]] : [])];
  const unfinishedOrders = activeOrders.filter(order => order.status !== "completed");
  const sevenDayShipOrders = activeOrders.filter(order => !["shipped", "received", "completed"].includes(order.status) && shippingTotals(order).remaining > 0 && daysToShip(order) >= 0 && daysToShip(order) <= 7);
  const arrivalExceptions = activeOrders.filter(order => ["received", "completed"].includes(order.status) && order.items.some(item => Number(item.received_quantity || 0) !== Number(item.shipped_quantity || 0)));
  const Ranking = ({ title, rows, compact = false }: { title: string; rows: Array<[string, number]>; compact?: boolean }) => { const maximum = Math.max(...rows.map(row => row[1]), 1); return <section className="ceo-ranking"><div className="section-heading"><h2>{title}</h2><span>{rows.length} 项</span></div>{rows.length ? <ol>{rows.map(([name, value]) => <li key={name}><div><strong>{name || "未分类"}</strong><span title={compact ? formatCents(value) : undefined}>{compact ? formatCompactCents(value) : formatCents(value)}</span></div><i aria-hidden="true"><span style={{ width: `${Math.max(3, value / maximum * 100)}%` }} /></i></li>)}</ol> : <p className="form-help">暂无采购金额数据</p>}</section>; };
  const supplierPerformance = allSupplierPurchases.map(([name, purchaseAmount]) => {
    const orders = activeOrders.filter(order => order.supplier_name === name);
    const delivery = supplierDelivery.find(row => row.name === name);
    const completedItems = orders.flatMap(order => order.items.map(item => ({ orderDate: order.order_date, completedAt: item.production_completed_at }))).filter(item => item.completedAt);
    const averageCycle = completedItems.length ? Math.round(sum(completedItems.map(item => Math.max(0, (new Date(item.completedAt!).getTime() - new Date(`${item.orderDate}T00:00:00`).getTime()) / 86400000))) / completedItems.length) : null;
    const exceptions = new Set([...delayedOrders, ...arrivalExceptions].filter(order => order.supplier_name === name).map(order => order.id)).size;
    return { name, purchaseAmount, rate: delivery?.rate ?? null, averageCycle, exceptions };
  });
  const visibleSupplierPerformance = [...supplierPerformance].filter(row => row.name.toLowerCase().includes(supplierPerformanceQuery.trim().toLowerCase())).sort((left, right) => supplierPerformanceSort === "purchase" ? right.purchaseAmount - left.purchaseAmount : supplierPerformanceSort === "delivery" ? (left.rate ?? 101) - (right.rate ?? 101) : right.exceptions - left.exceptions || (left.rate ?? 101) - (right.rate ?? 101) || right.purchaseAmount - left.purchaseAmount);
  const displayedSupplierPerformance = showAllSupplierPerformance ? visibleSupplierPerformance : visibleSupplierPerformance.slice(0, 10);
  return <section className="ceo-dashboard">
    <div className="ceo-dashboard-heading"><div><h2>采购经营看板</h2><p>{today.getFullYear()} 年 {today.getMonth() + 1} 月 · 采购进度、风险、付款与供应商表现</p></div><button className="secondary" onClick={() => void load()}>刷新数据</button></div>
    {error && <p className="form-error" role="alert">{error}</p>}{!financeOrders ? <p role="status">正在读取看板…</p> : <>
      <section className="ceo-overview" aria-label="顶部总览">
        <section className="ceo-overview-group order-overview" aria-labelledby="order-overview-title">
          <header><h3 id="order-overview-title">订单进度</h3><span>数量</span></header>
          <div className="ceo-metrics order-metrics">
            <article className="metric-progress"><span>未完成采购单</span><strong>{unfinishedOrders.length} 张</strong><small>尚未进入已完结状态</small></article>
            <article className="metric-danger"><span>已延期订单</span><strong>{delayedOrders.length} 张</strong><small>已超过要求或承诺发货日</small></article>
            <article className="metric-warning"><span>7 天内要发货</span><strong>{sevenDayShipOrders.length} 张</strong><small>仍有待发数量</small></article>
          </div>
        </section>
        <section className="ceo-overview-group money-overview" aria-labelledby="money-overview-title">
          <header><div><h3 id="money-overview-title">资金概览</h3><span>{periodStart && periodEnd ? `${periodStart} 至 ${periodEnd}` : "请选择完整日期"}</span></div><div className="finance-period-controls"><label><span>统计周期</span><select value={financePeriod} onChange={(event) => setFinancePeriod(event.target.value as typeof financePeriod)}><option value="month">本月</option><option value="quarter">本季度</option><option value="half">近半年</option><option value="year">本年度</option><option value="custom">自定义日期</option></select></label><div className="finance-date-range"><label><span>开始日期</span><input type="date" value={periodStart} max={periodEnd || todayText} onChange={(event) => { setCustomStart(event.target.value); setCustomEnd(current => current || todayText); setFinancePeriod("custom"); }} /></label><i aria-hidden="true">至</i><label><span>结束日期</span><input type="date" value={periodEnd} min={periodStart} max={todayText} onChange={(event) => { setCustomEnd(event.target.value); setCustomStart(current => current || periodStarts.month); setFinancePeriod("custom"); }} /></label></div></div></header>
          <div className="ceo-metrics money-metrics">
            <article className="metric-purchase"><span>{periodLabel}采购总金额</span><strong>{formatCents(periodPurchases)}</strong><small>按所选期间创建的采购单汇总</small></article>
            <article className="metric-payable"><span>{periodLabel}应付</span><strong>{formatCents(periodPayable)}</strong><small>所选期间采购单应付金额</small></article>
            <article className="metric-monthly-paid"><span>{periodLabel}已支付</span><strong>{formatCents(periodPaid)}</strong><small>按实际付款日期汇总</small></article>
            <article className="metric-invoice"><span>{periodLabel}未支付</span><strong>{formatCents(periodUnpaid)}</strong><small>所选期间采购单未支付余额</small></article>
          </div>
        </section>
      </section>
      <section className="ceo-dashboard-block ceo-finance-block"><div className="section-heading"><div><h2>采购与财务</h2><p>项目、供应商采购金额与资金状态分开查看</p></div></div><div className="ceo-finance-split"><section><h3>采购金额</h3><div className="ceo-finance-summary purchase-summary"><div><span>本月</span><strong>{formatCents(monthlyPurchases)}</strong></div><div><span>本季度</span><strong>{formatCents(quarterlyPurchases)}</strong></div></div><div className="ceo-rankings"><section className="ceo-purchase-ranking"><div className="ceo-ranking-controls"><label>项目采购金额<select value={projectPeriod} onChange={(event) => { setProjectPeriod(event.target.value as typeof projectPeriod); setShowAllProjectPurchases(false); }}><option value="month">本月</option><option value="quarter">本季度</option><option value="year">本年度</option><option value="all">全部</option></select></label></div><Ranking title="按项目" rows={projectPurchaseRows} compact />{projectPurchases.length > 10 && <button className="ceo-show-all" type="button" onClick={() => setShowAllProjectPurchases(current => !current)}>{showAllProjectPurchases ? "收起" : `查看全部 ${projectPurchases.length} 个项目`}</button>}</section><section className="ceo-purchase-ranking"><div className="ceo-ranking-controls"><label>供应商采购金额<select value={supplierPeriod} onChange={(event) => { setSupplierPeriod(event.target.value as typeof supplierPeriod); setShowAllSupplierPurchases(false); }}><option value="month">本月</option><option value="quarter">本季度</option><option value="year">本年度</option><option value="all">全部</option></select></label></div><Ranking title="按供应商" rows={supplierPurchaseRows} compact />{supplierPurchases.length > 10 && <button className="ceo-show-all" type="button" onClick={() => setShowAllSupplierPurchases(current => !current)}>{showAllSupplierPurchases ? "收起" : `查看全部 ${supplierPurchases.length} 家供应商`}</button>}</section></div></section><section><h3>财务状态</h3><div className="ceo-finance-summary finance-status-summary"><div><span>已付款</span><strong>{formatCents(paid)}</strong></div><div><span>待付款</span><strong>{formatCents(sum(finances.map(order => order.unpaid_cents)))}</strong></div><div><span>30 天内应付款</span><strong>{formatCents(thirtyDayPayable)}</strong></div><div><span>未开票</span><strong>{formatCompactCents(uninvoiced)}</strong></div><div><span>已开票</span><strong>{formatCompactCents(invoiced)}</strong></div></div><p className="ceo-data-note">{finances.filter(order => order.payable_cents === null).length} 张订单应付金额尚未核实；运费按财务登记的额外费用 {formatCents(freightCosts)} 汇总。</p></section></div></section>
      <section className="ceo-dashboard-block ceo-supplier-block"><div className="section-heading"><div><h2>供应商表现</h2><p>默认优先显示风险较高的供应商</p></div></div><div className="ceo-performance-controls"><label><span>搜索供应商</span><input type="search" value={supplierPerformanceQuery} onChange={(event) => { setSupplierPerformanceQuery(event.target.value); setShowAllSupplierPerformance(false); }} placeholder="输入供应商名称" /></label><label><span>排列方式</span><select value={supplierPerformanceSort} onChange={(event) => { setSupplierPerformanceSort(event.target.value as typeof supplierPerformanceSort); setShowAllSupplierPerformance(false); }}><option value="risk">风险优先</option><option value="purchase">采购金额最高</option><option value="delivery">准时率最低</option></select></label></div>{displayedSupplierPerformance.length ? <><div className="ceo-performance-table"><div><strong>供应商</strong><strong>采购金额</strong><strong>准时交付率</strong><strong>平均制作周期</strong><strong>异常订单数</strong></div>{displayedSupplierPerformance.map(row => <div key={row.name}><span>{row.name}</span><span title={formatCents(row.purchaseAmount)}>{formatCompactCents(row.purchaseAmount)}</span><span className={row.rate !== null && row.rate < 80 ? "low" : ""}>{row.rate === null ? "待累积" : `${row.rate}%`}</span><span>{row.averageCycle === null ? "待累积" : `${row.averageCycle} 天`}</span><span className={row.exceptions ? "low" : ""}>{row.exceptions} 张</span></div>)}</div>{visibleSupplierPerformance.length > 10 && <button className="ceo-show-all" type="button" onClick={() => setShowAllSupplierPerformance(current => !current)}>{showAllSupplierPerformance ? "收起" : `查看全部 ${visibleSupplierPerformance.length} 家供应商`}</button>}</> : <p className="form-help">没有符合条件的供应商。</p>}</section>
    </>}
  </section>;
}

function OrdersView({ orders, allOrders, suppliers, selected, currentProject, filter, query, user, onFilter, onQuery, onProject, onSelect, onChanged }: {
  orders: PurchaseOrder[]; allOrders: PurchaseOrder[]; suppliers: Supplier[]; selected?: PurchaseOrder; currentProject: string; filter: Filter; query: string; user: User;
  onFilter: (filter: Filter) => void; onQuery: (value: string) => void; onProject: (project: string) => void; onSelect: (id: string) => void; onChanged: (message: string) => void | Promise<void>;
}) {
  const pageSize = 10;
  const [page, setPage] = useState(1);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [riskView, setRiskView] = useState<"severe" | "attention" | null>(null);
  const showingProject = currentProject !== "尚未选择项目";
  const exportOrders = orders.filter((order) => checkedIds.has(order.id));
  const toggleChecked = (id: string) => setCheckedIds((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const tabs: Array<{ id: Filter; label: string }> = [
    { id: "all", label: "全部" }, { id: "pending_confirmation", label: "待确认" }, { id: "in_production", label: "生产中" },
    { id: "ready_to_ship", label: "生产完成" }, { id: "partial_shipped", label: "部分发货" }, { id: "shipped", label: "已发货" }, { id: "received", label: "已到货" }, { id: "delayed", label: "延期" }, { id: "completed", label: "已完成" },
  ];
  if (canPurchase(user.role) || user.role === "office") tabs.push({ id: "archived", label: "作废留档" });
  const activeOrders = allOrders.filter((order) => !order.archived_at);
  const count = (id: Filter) => id === "archived" ? allOrders.length - activeOrders.length : id === "all" ? activeOrders.length : id === "delayed" ? activeOrders.filter(isDelayed).length : activeOrders.filter((order) => effectiveOrderStatus(order) === id).length;
  const projectGroups = useMemo(() => {
    const groups = new Map<string, PurchaseOrder[]>();
    for (const order of orders) groups.set(order.project_name, [...(groups.get(order.project_name) || []), order]);
    return [...groups.entries()].map(([project, projectOrders]) => ({ project, orders: projectOrders }));
  }, [orders]);
  const pageCount = Math.max(1, Math.ceil(projectGroups.length / pageSize));
  const visibleGroups = projectGroups.slice((page - 1) * pageSize, page * pageSize);
  useEffect(() => { setPage(1); setCheckedIds(new Set()); }, [filter, query]);
  useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount]);

  if (selected) {
    return <div className="order-focus">
      <button className="back-button order-back" onClick={() => onSelect("")}><ArrowLeft size={17} />返回订单列表</button>
      <section className="order-detail"><OrderDetail key={selected.id} order={selected} suppliers={suppliers} user={user} onChanged={onChanged} /></section>
    </div>;
  }

  return (
    <div className="orders-surface">
      {canPurchase(user.role) && <DeliveryRiskBoard orders={allOrders} activeView={riskView} onView={setRiskView} onOpen={(id) => { onFilter("all"); onSelect(id); }} />}
      {showingProject && <div className="project-orders-heading"><button className="back-button" type="button" onClick={() => { onProject("尚未选择项目"); onQuery(""); }}><ArrowLeft size={17} />返回项目列表</button><div><h2>{currentProject}</h2><span>{orders.length} 张采购单</span></div></div>}
      <div className="filter-strip">
        <div className="filter-tabs" role="tablist" aria-label="采购单状态">{tabs.map((tab) => <button type="button" role="tab" aria-selected={filter === tab.id} key={tab.id} className={filter === tab.id ? "active" : ""} onClick={() => { onFilter(tab.id); if (showingProject) onProject("尚未选择项目"); }}>{tab.label}<span>{count(tab.id)}</span></button>)}</div>
        <label className="search-field"><Search size={17} /><input aria-label="搜索采购订单" value={query} onChange={(event) => onQuery(event.target.value)} placeholder="搜索 PO、项目或供应商" /></label>
      </div>
      {showingProject && canPurchase(user.role) && <div className="export-toolbar"><label className="order-select-all"><input type="checkbox" aria-label="全选当前项目的采购单" disabled={!orders.length} checked={orders.length > 0 && exportOrders.length === orders.length} onChange={(event) => setCheckedIds(new Set(event.target.checked ? orders.map((order) => order.id) : []))} />全选当前项目（{orders.length} 单）</label><ExportButton kind="purchase" orders={exportOrders} selectedOnly /></div>}
      <section className={`${showingProject ? `order-table${canPurchase(user.role) ? " has-selection" : ""}` : "project-menu"}`} aria-label={showingProject ? "项目采购订单列表" : "项目列表"}>
        {showingProject && <div className="order-table-head" aria-hidden="true"><span>PO / 项目</span><span>产品名称</span><span>颜色</span><span>供应商</span><span>状态</span><span>下单日期</span><span>发货节点</span><span>金额</span><span>操作</span></div>}
        <div className="order-table-body">
          {showingProject ? (orders.length ? orders.map((order) => <OrderListEntry key={order.id} order={order} user={user} selectable={canPurchase(user.role)} checked={checkedIds.has(order.id)} onChecked={() => toggleChecked(order.id)} onOpen={() => onSelect(order.id)} onChanged={onChanged} />) : <EmptyOrders query={query} />) : (visibleGroups.length ? visibleGroups.map((group) => <button type="button" className="project-menu-row" key={group.project} onClick={() => { onProject(group.project); onQuery(""); setCheckedIds(new Set()); }}><span><strong>{group.project}</strong><small>{[...new Set(group.orders.flatMap((order) => order.items.map((item) => item.product_name)))].slice(0, 3).join("、") || "暂无产品"}</small></span><em>{group.orders.length} 张采购单</em><ArrowRight size={18} /></button>) : <EmptyOrders query={query} />)}
        </div>
        {!showingProject && projectGroups.length > pageSize && <div className="pagination"><span>共 {projectGroups.length} 个项目 · 第 {page} / {pageCount} 页</span><div><button className="secondary" disabled={page === 1} onClick={() => setPage((current) => current - 1)}>上一页</button><button className="secondary" disabled={page === pageCount} onClick={() => setPage((current) => current + 1)}>下一页</button></div></div>}
      </section>
    </div>
  );
}

type DeliveryRisk = { order: PurchaseOrder; level: "severe" | "attention"; reason: string };

function deliveryRisks(orders: PurchaseOrder[]): DeliveryRisk[] {
  return orders.flatMap<DeliveryRisk>((order) => {
    if (order.archived_at || ["shipped", "received", "completed"].includes(order.status) || shippingTotals(order).remaining === 0) return [];
    const days = daysToShip(order);
    const progress = productionTotals(order).progress;
    const originalTarget = order.promised_ship_date || order.required_ship_date;
    if (days < 0) return [{ order, level: "severe" as const, reason: `已超过发货节点 ${Math.abs(days)} 天` }];
    if (days <= 3 && progress < 100) return [{ order, level: "severe" as const, reason: `${days === 0 ? "今天" : `${days} 天内`}需发货，生产完成度 ${progress}%` }];
    if (order.estimated_ship_date && order.estimated_ship_date > originalTarget) return [{ order, level: "attention" as const, reason: `预计交期已晚于原交期 ${Math.round((Date.parse(`${order.estimated_ship_date}T00:00:00Z`) - Date.parse(`${originalTarget}T00:00:00Z`)) / 86_400_000)} 天` }];
    if (days <= 7) return [{ order, level: "attention" as const, reason: `${days} 天内需发货，生产完成度 ${progress}%` }];
    const inactiveDays = Math.floor((Date.now() - Date.parse(order.updated_at)) / 86_400_000);
    if (effectiveOrderStatus(order) === "pending_confirmation" && inactiveDays >= 3) return [{ order, level: "attention" as const, reason: `待供应商确认，订单已 ${inactiveDays} 天未更新` }];
    return [];
  });
}

function DeliveryRiskBoard({ orders, activeView, onView, onOpen }: { orders: PurchaseOrder[]; activeView: "severe" | "attention" | null; onView: (view: "severe" | "attention" | null) => void; onOpen: (id: string) => void }) {
  const risks = deliveryRisks(orders);
  const severe = risks.filter((risk) => risk.level === "severe");
  const attention = risks.filter((risk) => risk.level === "attention");
  const health = Math.max(0, 100 - severe.length * 8 - attention.length * 3);
  const visible = activeView ? risks.filter((risk) => risk.level === activeView) : [];
  const riskySuppliers = new Set(risks.map((risk) => risk.order.supplier_name)).size;
  const riskyProjects = new Set(risks.map((risk) => risk.order.project_name)).size;
  return <section className={`delivery-risk-board health-${health >= 90 ? "good" : health >= 75 ? "watch" : "danger"}`} aria-labelledby="delivery-risk-title">
    <div className="delivery-risk-summary"><div><span id="delivery-risk-title">采购健康度</span><strong>{health}<small>/100</small></strong></div><button type="button" className="risk-severe" aria-expanded={activeView === "severe"} onClick={() => onView(activeView === "severe" ? null : "severe")}><i aria-hidden="true" />{severe.length} 项严重问题</button><button type="button" className="risk-attention" aria-expanded={activeView === "attention"} onClick={() => onView(activeView === "attention" ? null : "attention")}><i aria-hidden="true" />{attention.length} 项需要关注</button><p>{riskyProjects} 个项目 · {riskySuppliers} 家供应商存在交期风险</p></div>
    {activeView && <div className="delivery-risk-list" aria-live="polite">{visible.length ? visible.map(({ order, reason }) => <button type="button" key={order.id} onClick={() => onOpen(order.id)}><AlertTriangle size={16} aria-hidden="true" /><span><strong>{order.po_number}</strong><small>{order.project_name} · {order.supplier_name}</small></span><em>{reason}</em><ArrowRight size={16} aria-hidden="true" /></button>) : <p>当前没有{activeView === "severe" ? "严重问题" : "需要关注的订单"}。</p>}</div>}
  </section>;
}

function OrderListEntry({ order, user, selectable, checked, onChecked, onOpen, onChanged }: { order: PurchaseOrder; user: User; selectable: boolean; checked: boolean; onChecked: () => void; onOpen: () => void; onChanged: (message: string) => void | Promise<void> }) {
  const [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function archive() {
    setBusy(true); setError("");
    try { await api(`/api/orders/${order.id}`, { method: "DELETE" }); await onChanged(`${order.po_number} 已删除并转入作废留档`); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "删除采购单失败"); }
    finally { setBusy(false); }
  }
  return <div className={`order-list-entry${selectable ? " selectable" : ""}`}>
    {selectable && <label className="order-checkbox"><input type="checkbox" aria-label={`选择采购单 ${order.po_number}`} checked={checked} onChange={onChecked} /></label>}
    <OrderTableRow order={order} user={user} onClick={onOpen} />
    {selectable && !order.archived_at && <div className="order-delete-cell">{confirming ? <div className="order-delete-confirm"><span>确认删除？</span><button type="button" disabled={busy} onClick={() => void archive()}>{busy ? "处理中" : "确认"}</button><button type="button" disabled={busy} onClick={() => setConfirming(false)}>取消</button></div> : <button type="button" className="order-delete-button" onClick={() => setConfirming(true)}><Trash2 size={15} />删除</button>}{error && <small role="alert">{error}</small>}</div>}
  </div>;
}

function OrderTableRow({ order, user, onClick }: { order: PurchaseOrder; user: User; onClick: () => void }) {
  return (
    <button className={`order-table-row${isDelayed(order) ? " delayed" : ""}`} onClick={onClick} aria-label={`查看采购单 ${order.po_number}，项目 ${order.project_name}，供应商 ${order.supplier_name}，状态 ${STATUS[effectiveOrderStatus(order)].label}，下单日期 ${dateText(order.order_date)}${canViewAmounts(user.role) ? `，金额 ¥ ${money.format(total(order))}` : ""}`}>
      <span className="table-order"><strong>{order.po_number}</strong><em>{order.project_name}</em></span>
      <span className="table-product-types">{[...new Set(order.items.map((item) => item.product_name))].join("、") || "—"}</span>
      <span className="table-product-colors">{[...new Set(order.items.map((item) => item.color).filter(Boolean))].join("、") || "—"}</span>
      <span className="table-supplier">{order.supplier_name}<small>{order.supplier_code}</small></span>
      <span className="table-status"><StatusTag order={order} /></span>
      <span className="table-date">{dateText(order.order_date)}</span>
      <span className="table-ship"><strong>{dateText(order.promised_ship_date || order.required_ship_date)}</strong><small>{order.promised_ship_date ? "供应商承诺" : "要求发货"}</small></span>
      <span className="table-amount">{canViewAmounts(user.role) ? `¥ ${money.format(total(order))}` : "—"}</span>
    </button>
  );
}

function StatusTag({ order }: { order: PurchaseOrder }) {
  if (order.archived_at) return <span className="status-tag">已作废留档</span>;
  if (isDelayed(order)) return <span className="status-tag delayed"><CalendarClock size={14} />已延期 {Math.abs(daysToShip(order))} 天</span>;
  if (!["shipped", "received", "completed"].includes(order.status) && shippingTotals(order).remaining > 0 && daysToShip(order) === 0) return <span className="status-tag due-today"><CalendarClock size={14} />今日应发</span>;
  if (!["shipped", "received", "completed"].includes(order.status) && shippingTotals(order).remaining > 0 && daysToShip(order) > 0 && daysToShip(order) <= 3) return <span className="status-tag due-soon"><CalendarClock size={14} />还有 {daysToShip(order)} 天需发货</span>;
  const effectiveStatus = effectiveOrderStatus(order);
  const label = order.status === "pending_confirmation" && effectiveStatus === "pending_confirmation" && order.items.length && order.items.every((item) => item.workflow_stage === "queued") ? "排单中" : STATUS[effectiveStatus].label;
  return <span className={`status-tag status-${effectiveStatus}`}>{label}</span>;
}

function StageRail({ order }: { order: PurchaseOrder }) {
  const current = STATUS[effectiveOrderStatus(order)].step;
  return <div className="stage-rail" aria-label="采购流程状态">{STAGES.map((status, index) => <div key={status} aria-current={index === current ? "step" : undefined} className={index < current ? "done" : index === current ? "current" : ""}><span>{index < current ? <Check size={13} /> : index + 1}</span><em>{STATUS[status].short}</em></div>)}</div>;
}

function ProcurementAcceptance({ order, onChanged }: { order: PurchaseOrder; onChanged: (message: string) => void | Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const awaiting = order.items.filter(item => item.shipped_quantity === 0 && item.acceptance_status === "pending" && ["production_complete", "ready_to_ship"].includes(item.workflow_stage) && (item.production_photo_waived === 1 || order.attachments.some(file => file.item_id === item.id && file.kind === "production_photo"))).length;
  async function advance(action: "complete") {
    setBusy(true); setError("");
    try { await api(`/api/orders/${order.id}/${action}`, { method: "POST" }); onChanged("采购单已完结"); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "操作失败"); }
    finally { setBusy(false); }
  }
  return <section className="procurement-priority" aria-label="采购操作与产品验收">
    <div className="action-panel"><div className="action-copy"><ClipboardCheck size={22} /><div><h3>采购操作</h3><p>{order.status === "shipped" ? "供应商已发货，请核对下方运输信息；收货、入库由仓库部逐项确认。" : order.status === "received" ? "已确认到货，请核实本单是否可以完结。" : order.status === "completed" ? "本单已完结，记录只读留档。" : `${awaiting} 项产品待验收；只有采购接受的产品才能登记发货。`}</p></div></div>
    {order.status === "received" && <button className="primary" disabled={busy} onClick={() => void advance("complete")}>确认完结</button>}{error && <p className="form-error" role="alert">{error}</p>}</div>
  </section>;
}

async function cancelItemAction(order: PurchaseOrder, item: PurchaseOrder["items"][number], action: "acceptance" | "received" | "stocked", attempt: { current: { signature: string; id: string } }) {
  const body={action,quantity:action==="acceptance" ? 1 : action==="received" ? item.received_quantity : item.stocked_quantity,reason:"再次点击原按钮取消",revision:item.production_revision,received:item.received_quantity || 0,stocked:item.stocked_quantity || 0};
  const signature=JSON.stringify(body);
  if(attempt.current.signature!==signature) attempt.current={signature,id:crypto.randomUUID()};
  await api(`/api/orders/${order.id}/items/${item.id}/corrections`,{method:"POST",body:JSON.stringify({...body,requestId:attempt.current.id})});
}

function CorrectionHistory({ item, action }: { item: PurchaseOrder["items"][number]; action: string }) {
  const records=item.correction_history?.filter(entry=>entry.action===action) || [];
  return records.length>0 ? <details><summary>取消记录（{records.length}）</summary>{records.map((entry,index)=><p key={index}>已取消{action==="acceptance" ? "验收" : `${entry.quantity} ${item.unit}`} · {entry.actor_name}<br />{new Date(entry.created_at).toLocaleString("zh-CN")}</p>)}</details> : null;
}

function ProductAcceptanceCard({ order, item, user, onChanged }: { order: PurchaseOrder; item: PurchaseOrder["items"][number]; user: User; onChanged: (message: string) => void | Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const attempt=useRef({signature:"",id:""});
  const submitting=useRef(false);
  const [optimisticDecision, setOptimisticDecision] = useState<"approved" | "rejected" | null>(null);
  useEffect(() => { if (item.acceptance_status !== "pending") setOptimisticDecision(null); }, [item.acceptance_status]);
  const acceptanceStatus=optimisticDecision || item.acceptance_status;
  const confirmed=acceptanceStatus!=="pending";
  const cancellable=item.acceptance_status!=="pending" && canPurchase(user.role) && !order.archived_at && item.shipped_quantity===0 && !item.received_quantity && !item.stocked_quantity;
  async function cancel() {
    if(submitting.current || busy || !cancellable) return;
    submitting.current=true;
    setBusy(true);setError("");
    try { await cancelItemAction(order,item,"acceptance",attempt);await onChanged("已取消验收"); }
    catch(cause) { setError(cause instanceof Error ? cause.message : "取消失败，请重试"); }
    finally { submitting.current=false;setBusy(false); }
  }
  const photos = order.attachments.filter(file => file.item_id === item.id && file.kind === "production_photo");
  const mayOperateBeforeConfirmation = user.role === "admin" || user.supplier_operations === 1;
  const reviewable = !order.archived_at && item.shipped_quantity === 0 && item.acceptance_status === "pending" && ((photos.length > 0 || item.production_photo_waived === 1) && ["production_complete", "ready_to_ship"].includes(item.workflow_stage) && (mayOperateBeforeConfirmation ? ["pending_confirmation", "in_production", "ready_to_ship", "partial_shipped"].includes(order.status) : ["in_production", "ready_to_ship", "partial_shipped"].includes(order.status)));
  const status = item.shipped_quantity > 0 ? "已发货 · 只读" : acceptanceStatus === "approved" ? "已接受 · 允许发货" : acceptanceStatus === "rejected" ? "已退回 · 等待整改" : reviewable ? "待采购验收" : "等待供应商完成生产并提供实图状态";
  async function decide(decision: "approved" | "rejected") {
    if(submitting.current || busy || !reviewable) return;
    submitting.current=true;
    setBusy(true); setError("");
    try { await api(`/api/orders/${order.id}/items/${item.id}/acceptance`, { method: "POST", body: JSON.stringify({ decision, reason: "", revision: item.production_revision }) }); setOptimisticDecision(decision); await onChanged(`${item.product_name}：${decision === "approved" ? "验收通过，允许发货" : "已退回整改"}`); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "验收保存失败，请刷新核对"); }
    finally { submitting.current=false;setBusy(false); }
  }
  return <div className="inline-acceptance" title={status}><strong>采购验收</strong>
    <button type="button" className="primary workflow-confirm" data-confirmed={acceptanceStatus === "approved"} aria-pressed={confirmed} title={confirmed ? "再次点击取消验收；需先取消后续收货和入库，已发货不可取消" : "确认验收"} disabled={busy || (confirmed ? !cancellable : !reviewable)} onClick={() => confirmed ? void cancel() : void decide("approved")}>{busy ? "保存中" : confirmed ? (acceptanceStatus==="approved" ? "已验收" : "已退回") : "确认验收"}</button>
    <CorrectionHistory item={item} action="acceptance" />
    {error && <p className="form-error" role="alert">{error}</p>}
    {item.acceptance_history?.length > 0 && <details><summary>验收记录（{item.acceptance_history.length}）</summary>{[...item.acceptance_history].reverse().map(entry => <div className="acceptance-record" key={entry.id}><strong>{entry.decision === "approved" ? "接受" : "退回整改"} · {entry.actorName}</strong><p>{entry.reason || "无备注"}</p><small>{new Date(entry.createdAt).toLocaleString("zh-CN")} · 生产资料第 {entry.revision} 版</small><div>{entry.photoIds.map((id, index) => <a key={id} href={`/api/attachments/${id}`} target="_blank" rel="noreferrer">当时实拍 {index + 1} </a>)}</div></div>)}</details>}
  </div>;
}

function FreightPayment({ order, item, user, onChanged }: { order: PurchaseOrder; item: PurchaseOrder["items"][number]; user: User; onChanged: (message: string) => void | Promise<void> }) {
  const [busy,setBusy] = useState(false), [error,setError] = useState("");
  const status = item.freight_payment_status || "unknown";
  async function save(value: string) {
    if (busy || value === status) return;
    setBusy(true); setError("");
    try { await api(`/api/orders/${order.id}/items/${item.id}/freight-payment`,{method:"PATCH",body:JSON.stringify({status:value,revision:item.freight_payment_revision || 0})}); onChanged("运费支付状态已保存"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败，请重试"); }
    finally { setBusy(false); }
  }
  return <div role="cell" className="freight-payment"><strong>运费是否已支付</strong>{canPurchase(user.role) && !order.archived_at ? <select aria-label={item.product_name+" 运费是否已支付"} value={status} disabled={busy} onChange={event=>void save(event.target.value)}><option value="unknown" disabled>待填写</option><option value="unpaid">未支付</option><option value="paid">已支付</option></select> : <p>{status === "paid" ? "已支付" : status === "unpaid" ? "未支付" : "待填写"}</p>}{error && <p role="alert" className="form-error">{error}</p>}</div>;
}

function PackagingVolume({ order, item, user, onChanged }: { order: PurchaseOrder; item: PurchaseOrder["items"][number]; user: User; onChanged: (message: string) => void | Promise<void> }) {
  const [value,setValue]=useState(item.packaging_volume || ""), [busy,setBusy]=useState(false), [error,setError]=useState("");
  useEffect(()=>setValue(item.packaging_volume || ""),[item.packaging_volume]);
  async function save() {
    const next=value.trim();
    if(busy || next===(item.packaging_volume || "")) return;
    setBusy(true);setError("");
    try { await api(`/api/orders/${order.id}/items/${item.id}/packaging-volume`,{method:"PATCH",body:JSON.stringify({volume:next,revision:item.packaging_volume_revision || 0})}); await onChanged("包装体积已保存"); }
    catch(cause) { setError(cause instanceof Error ? cause.message : "保存失败");setValue(item.packaging_volume || ""); }
    finally { setBusy(false); }
  }
  return <div role="cell" className="packaging-volume"><strong>包装体积</strong>{canPurchase(user.role) && !order.archived_at ? <input aria-label={item.product_name+" 包装体积"} value={value} maxLength={100} placeholder="如 0.5 m³" disabled={busy} onChange={event=>setValue(event.target.value)} onBlur={()=>void save()} onKeyDown={event=>{if(event.key==="Enter"){event.preventDefault();event.currentTarget.blur();}}} /> : <p>{item.packaging_volume || "待填写"}</p>}{error && <p role="alert" className="form-error">{error}</p>}</div>;
}

function WarehouseFields({ order, item, user, onChanged }: { order: PurchaseOrder; item: PurchaseOrder["items"][number]; user: User; onChanged: (message: string) => void | Promise<void> }) {
  const received = item.received_quantity || 0, stocked = item.stocked_quantity || 0;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date());
  const remaining = Math.max(0, (user.role === "admin" ? item.quantity : item.shipped_quantity) - received), toStock = Math.max(0, received - stocked);
  const [quantity, setQuantity] = useState(""), [receiptDate, setReceiptDate] = useState(today), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const attempt = useRef({ signature: "", id: "" });
  const onlinePurchase = order.is_online_purchase === 1;
  const permitted = ["warehouse","boss","admin"].includes(user.role) || (onlinePurchase && canPurchase(user.role));
  const active = !order.archived_at && (user.role === "admin" || ["partial_shipped","ready_to_ship","shipped","received","completed"].includes(order.status));
  const valid = /^[0-9]+$/.test(quantity) && Number.isSafeInteger(Number(quantity)) && Number(quantity)>=1 && Number(quantity)<=remaining;
  const cancellingReceipt=received>0 && !quantity;
  async function cancel(action: "received" | "stocked") {
    if(busy || !permitted || !active) return;
    if(action==="received" && stocked>0) { setError("请先点击“已入库”取消入库，再取消收货");return; }
    setBusy(true);setError("");
    try { await cancelItemAction(order,item,action,attempt);setQuantity("");await onChanged(action==="received" ? "已取消收货，请重新填写实际收货数量" : "已取消入库"); }
    catch(cause) { setError(cause instanceof Error ? cause.message : "取消失败，请重试"); }
    finally { setBusy(false); }
  }
  async function save(action: "received" | "stocked") {
    if (busy || !active || !permitted || (action==="received" ? !valid : toStock<1)) return;
    const amount = action==="received" ? Number(quantity) : toStock;
    const signature = [action,amount,received,stocked,action === "received" ? receiptDate : ""].join(":");
    if (attempt.current.signature!==signature) attempt.current={signature,id:crypto.randomUUID()};
    setBusy(true); setError("");
    try {
      await api(`/api/orders/${order.id}/items/${item.id}/warehouse`,{method:"POST",body:JSON.stringify({action,quantity:amount,requestId:attempt.current.id,...(action === "received" ? {recordDate:receiptDate} : {})})});
      setQuantity(""); await onChanged(item.product_name + (action==="received" ? " 收货已登记" : " 入库已登记"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败，请重试"); }
    finally { setBusy(false); }
  }
  return <>
    <div role="cell" className="warehouse-quantity"><strong>{received>0 && received<item.quantity ? "补登数量" : "实际收货数量"}</strong>
      {permitted && !order.archived_at && received<item.quantity ? <input aria-label={item.product_name+(received>0 ? " 补登数量" : " 实际收货数量")} type="number" min="1" step="1" max={remaining || undefined} inputMode="numeric" value={quantity} onChange={event=>setQuantity(event.target.value)} disabled={busy} placeholder="整数 ≥ 1" /> : <p>{received} {item.unit}</p>}
      <small>累计已收 {received} / {item.quantity}</small><small>{permitted ? "可登记收货" : "已发未收"} {remaining}</small>
      {quantity && !valid && <small className="form-error">请输入 1–{remaining} 的整数</small>}
    </div>
    <div role="cell" className="warehouse-receipt-date"><strong>收货时间</strong>
      {permitted && !order.archived_at && received<item.quantity ? <input type="date" aria-label={item.product_name + " 收货时间"} min={order.order_date} max={today} value={receiptDate} onChange={event=>setReceiptDate(event.currentTarget.value)} disabled={busy} /> : <p>{item.warehouse_history?.filter(record=>record.action==="received").at(-1)?.record_date || dateText(item.received_at)}</p>}
    </div>
    <div role="cell" className="warehouse-receive"><strong>仓库核对收货</strong>
      <button className="secondary workflow-confirm" data-confirmed={received>0} type="button" aria-pressed={cancellingReceipt} title={cancellingReceipt ? "再次点击取消收货；补登请先填写数量" : "登记实际收货数量"} disabled={!permitted || !active || busy || (!cancellingReceipt && !valid)} onClick={()=>cancellingReceipt ? void cancel("received") : void save("received")}>{busy ? "保存中" : cancellingReceipt ? (received>=item.quantity ? "已收齐" : "已收到") : received>0 ? "确认补登" : "确认收货"}</button>
      <CorrectionHistory item={item} action="received" />
      {error && <p role="alert" className="form-error">{error}</p>}
      {!!item.warehouse_history?.length && <details><summary>登记记录（{item.warehouse_history.length}）</summary>{item.warehouse_history.map((record,index)=><p key={index}>{record.action==="received" ? "收货" : "入库"} {record.quantity} {item.unit}<br />{record.actor_name} · {new Date(record.created_at).toLocaleString("zh-CN")}</p>)}</details>}
    </div>
    <div role="cell" className="warehouse-stock"><strong>是否入库</strong>
      <button className="secondary workflow-confirm" data-confirmed={stocked>0} type="button" aria-pressed={stocked>0 && toStock===0} title={stocked>0 && toStock===0 ? "再次点击取消入库" : "确认入库"} disabled={!permitted || !active || busy || (toStock<1 && stocked<1)} onClick={()=>stocked>0 && toStock===0 ? void cancel("stocked") : void save("stocked")}>{busy ? "保存中" : stocked>0 && toStock===0 ? "已入库" : "确认入库"}</button>
      <small>已入库 {stocked} · 待入库 {toStock}</small>
      <CorrectionHistory item={item} action="stocked" />
    </div>
  </>;
}

function WarehouseCell({ order, item, user, action, onChanged }: { order: PurchaseOrder; item: PurchaseOrder["items"][number]; user: User; action: "received" | "stocked"; onChanged: (message: string) => void | Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const timestamp = action === "received" ? item.received_at : item.stocked_at;
  const actor = action === "received" ? item.received_by : item.stocked_by;
  const label = action === "received" ? "已收到" : "已入库";
  const permitted = ["warehouse", "boss", "admin"].includes(user.role);
  const available = !order.archived_at && ["partial_shipped", "ready_to_ship", "shipped", "received", "completed"].includes(order.status) && item.shipped_quantity === item.quantity && (action === "received" || Boolean(item.received_at));
  async function confirm() {
    if (busy) return;
    setBusy(true); setError("");
    try { await api(`/api/orders/${order.id}/items/${item.id}/warehouse`, { method: "POST", body: JSON.stringify({ action }) }); onChanged(item.product_name + " " + label); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败，请重试"); }
    finally { setBusy(false); }
  }
  return <><strong>{action === "received" ? "仓库核对收货" : "是否入库"}</strong>{timestamp ? <><p>{label}</p><small>{actor} · {new Date(timestamp).toLocaleString("zh-CN")}</small></> : permitted ? <button className="secondary" type="button" disabled={busy || !available} onClick={() => void confirm()}>{busy ? "保存中" : label}</button> : <p>{action === "received" ? "待仓库收货" : "待仓库入库"}</p>}{!timestamp && permitted && !available && <small>{action === "received" ? "该产品发完后核对收货" : "请先确认收到"}</small>}{error && <p className="form-error" role="alert">{error}</p>}</>;
}

function OrderDetail({ order, suppliers, user, onChanged }: { order: PurchaseOrder; suppliers: Supplier[]; user: User; onChanged: (message: string) => void | Promise<void> }) {
  const [tab, setTab] = useState<"detail" | "records">("detail");
  const displayOrder = { ...order, attachments: order.attachments || [], events: order.events || [], reminders: order.reminders || [], delivery_history: order.delivery_history || [], commercial_history: order.commercial_history || [] };
  return (
    <div className="detail-inner">
      <div className="detail-title">
        <div><div className="po-line"><span>{order.po_number}</span><StatusTag order={order} /></div><OrderIdentityEditor order={order} suppliers={suppliers} user={user} onChanged={onChanged} /><p>{order.supplier_name} · 采购负责人 {order.purchaser_name}</p></div>
        {canViewAmounts(user.role) && <div className="detail-total"><span>采购金额</span><strong>¥ {money.format(total(order))}</strong></div>}
      </div>
      {!order.archived_at && <div className="order-guidance-row">
        {displayOrder.reminders[0] ? <div className={`reminder-banner ${displayOrder.reminders[0].reminder_type}`}><CalendarClock size={19} /><div><strong>自动催单</strong><p>{displayOrder.reminders[0].message}</p></div></div> : <div />}
        {canPurchase(user.role) && !order.is_online_purchase && <ProcurementAcceptance order={order} onChanged={onChanged} />}
      </div>}
      {!order.is_online_purchase && <StageRail order={order} />}
      <div className="detail-tabs" role="tablist"><button role="tab" aria-selected={tab === "detail"} className={tab === "detail" ? "active" : ""} onClick={() => setTab("detail")}>订单详情</button><button role="tab" aria-selected={tab === "records"} className={tab === "records" ? "active" : ""} onClick={() => setTab("records")}>操作记录 <span>{displayOrder.events.length}</span></button></div>
      {tab === "detail" ? <>
        <ProductTable order={displayOrder} user={user} onChanged={onChanged} />
        {canPurchase(user.role) && order.shipments.length > 0 && <ShipmentRecords order={order} />}
        {!order.is_online_purchase && (user.role === "admin" || user.supplier_operations === 1) && !order.archived_at && ["pending_confirmation", "in_production", "ready_to_ship", "partial_shipped"].includes(order.status) && <details className="supplier-operation-disclosure"><summary>采购代供应商操作（内部试用）</summary><ActionPanel order={order} user={user} onChanged={onChanged} supplierOperations /></details>}
        {(user.role === "supplier" || user.role === "office") && <ShipmentRecords order={order} />}
        <OrderFacts order={order} />
        <DeliverySchedule order={displayOrder} user={user} onChanged={onChanged} />
        {canViewAmounts(user.role) ? <OrderCommercial order={order} user={user} onChanged={onChanged} /> : <section className="detail-section commercial-block"><div className="section-heading"><h3>商务与金额</h3></div><p className="form-help">当前部门无权查看商务及金额信息。</p></section>}
        <Attachments order={displayOrder} readOnly={["office", "engineering", "warehouse"].includes(user.role)} />
        <SceneImages order={displayOrder} user={user} onChanged={onChanged} />
        {order.archived_at ? <><ShipmentRecords order={order} /><p className="form-help">本单已作废，只读留档。编号、产品明细、交期历史、发货记录与附件均保留。</p></> : user.role === "supplier" ? <ActionPanel order={order} user={user} onChanged={onChanged} /> : canPurchase(user.role) && !order.is_online_purchase && !["shipped", "received", "completed"].includes(order.status) && <ActionPanel order={order} user={user} onChanged={onChanged} />}
      </> : <EventTimeline order={displayOrder} />}
    </div>
  );
}

function OrderIdentityEditor({ order, suppliers, user, onChanged }: { order: PurchaseOrder; suppliers: Supplier[]; user: User; onChanged: (message: string) => void | Promise<void> }) {
  const values = () => ({ poNumber: order.po_number, supplierId: order.supplier_id, projectName: order.project_name, orderDate: order.order_date, requiredShipDate: order.required_ship_date, purchaserName: order.purchaser_name });
  const [editing, setEditing] = useState(false), [form, setForm] = useState(values), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const editable = canPurchase(user.role) && !order.archived_at;
  useEffect(() => { setForm(values()); }, [order.po_number, order.supplier_id, order.project_name, order.order_date, order.required_ship_date, order.purchaser_name]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.supplierId || !form.projectName.trim() || !form.orderDate || !form.requiredShipDate) { setError("请完整填写采购单基本信息"); return; }
    setBusy(true); setError("");
    try {
      await api(`/api/orders/${order.id}/identity`, { method: "PATCH", body: JSON.stringify({ ...form, previousPoNumber: order.po_number, previousSupplierId: order.supplier_id, previousName: order.project_name, revision: order.delivery_revision }) });
      setEditing(false);
      await onChanged("采购单基本信息已更新");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "采购单基本信息修改失败"); }
    finally { setBusy(false); }
  }
  const change = (key: keyof ReturnType<typeof values>, value: string) => setForm((current) => ({ ...current, [key]: value }));
  if (!editing) return <div className="project-name-heading"><h2>{order.project_name}</h2>{editable && <button type="button" aria-label="修改采购单基本信息" onClick={() => setEditing(true)}><Pencil size={15} />修改</button>}</div>;
  return <form className="project-name-editor order-identity-editor" onSubmit={submit}><label>PO 编号<input className="identity-readonly" value={form.poNumber} readOnly aria-readonly="true" /><small>由项目名称和顺序号自动生成</small></label><label>供应商<select value={form.supplierId} disabled={busy || order.status !== "pending_confirmation"} onChange={(event) => change("supplierId", event.target.value)}>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name} · {supplier.code}</option>)}</select>{order.status !== "pending_confirmation" && <small>仅待供应商确认阶段可更正</small>}</label><label>项目名称<input value={form.projectName} maxLength={120} autoFocus disabled={busy} onChange={(event) => change("projectName", event.target.value)} /></label><label>下单日期<input type="date" value={form.orderDate} disabled={busy} onChange={(event) => change("orderDate", event.target.value)} /></label><label>要求发货日期<input type="date" min={form.orderDate} value={form.requiredShipDate} disabled={busy} onChange={(event) => change("requiredShipDate", event.target.value)} /></label><label>采购负责人<input className="identity-readonly" value={order.purchaser_name} readOnly aria-readonly="true" /><small>由创建采购单的登录账号自动记录</small></label><div className="order-identity-actions"><button className="primary" type="submit" disabled={busy}>{busy ? "保存中" : "保存"}</button><button className="secondary" type="button" disabled={busy} onClick={() => { setForm(values()); setError(""); setEditing(false); }}>取消</button></div>{error && <small role="alert">{error}</small>}</form>;
}

function OrderFacts({ order }: { order: PurchaseOrder }) {
  return <section className="fact-band"><div><span>下单日期</span><strong>{dateText(order.order_date)}</strong></div><div><span>要求发货</span><strong>{dateText(order.required_ship_date)}</strong></div><div><span>原承诺发货</span><strong>{dateText(order.promised_ship_date)}</strong></div><div><span>联系人</span><strong>{order.contact_name}</strong><small>{order.contact_info}</small></div>{order.tracking_number && <div><span>物流信息</span><strong>{order.carrier}</strong><small>{order.tracking_number}</small></div>}</section>;
}

function DeliverySchedule({ order, user, onChanged }: { order: PurchaseOrder; user: User; onChanged: (message: string) => void | Promise<void> }) {
  const [date, setDate] = useState(order.estimated_ship_date || "");
  const [reason, setReason] = useState("");
  const [revision, setRevision] = useState(order.delivery_revision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canEdit = (user.role === "supplier" || canPurchase(user.role)) && !order.archived_at && ["in_production", "ready_to_ship", "partial_shipped"].includes(order.status);
  useEffect(() => {
    setDate(order.estimated_ship_date || "");
    setRevision(order.delivery_revision);
  }, [order.estimated_ship_date, order.delivery_revision]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      await api(`/api/orders/${order.id}/delivery-estimate`, { method: "PATCH", body: JSON.stringify({ estimatedShipDate: date, reason, revision }) });
      setReason("");
      onChanged("预计交期已更新，原承诺日期与本次变更记录已保留");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "交期更新失败，请重试");
    } finally { setBusy(false); }
  }

  return <section className="detail-section delivery-schedule" aria-label="交期与变更历史">
    <div className="section-heading"><h3>交期与变更历史</h3><span>原承诺保留 · 变更留痕</span></div>
    <div className="delivery-dates"><div><span>原承诺发货日期</span><strong>{dateText(order.promised_ship_date)}</strong></div><div><span>最新预计发货日期</span><strong>{dateText(order.estimated_ship_date)}</strong></div></div>
    <p className="form-help">延期与催单按原承诺日期计算；尚未确认时按我司要求交期计算。调整预计日期不会重置延期天数。</p>
    {canEdit && <details className="delivery-edit"><summary>调整预计发货日期</summary><form onSubmit={submit}>
      <label>最新预计发货日期<input type="date" min={order.order_date} value={date} onInput={(event) => setDate(event.currentTarget.value)} disabled={busy} required /></label>
      <label>调整 / 延期原因<textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="请说明原因，例如原料延迟到货，预计延后 5 天" maxLength={2000} disabled={busy} required /></label>
      <button className="secondary" disabled={busy || !reason.trim() || !date || date === order.estimated_ship_date}>{busy ? "正在保存" : "保存交期变更"}</button>
      {error && <div className="form-error" role="alert"><p>{error}</p><button type="button" className="text-button" disabled={busy} onClick={() => onChanged("已刷新订单，请核对最新交期后重新提交")}>刷新并核对最新交期</button></div>}
    </form></details>}
    <details className="delivery-history"><summary>查看交期记录（{order.delivery_history.length}）</summary>
      {order.delivery_history.length ? <ol>{order.delivery_history.map((entry) => <li key={entry.id}>
        <strong>{entry.kind === "required" ? "我司要求交期" : entry.kind === "estimate" ? "预计交期调整" : entry.kind === "baseline" ? "历史承诺日期" : "首次承诺交期"}：{entry.previous_date ? `${dateText(entry.previous_date)} → ` : ""}{dateText(entry.new_date)}</strong>
        <p>{entry.reason}</p><small>{entry.actor_name} · {entry.changed_at ? `${new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" }).format(new Date(entry.changed_at))}（北京时间）` : "原修改时间未记录"}</small>
      </li>)}</ol> : <p className="form-help">暂无交期记录。供应商确认后将自动记录首次承诺日期。</p>}
    </details>
  </section>;
}

function SelectAllProducts({items,selectedIds,disabled,onChange}: {items:PurchaseOrder["items"];selectedIds:string[];disabled:boolean;onChange:(ids:string[])=>void}) {
  const input=useRef<HTMLInputElement>(null);
  const count=items.filter(item=>selectedIds.includes(item.id)).length;
  useEffect(()=>{if(input.current) input.current.indeterminate=count>0 && count<items.length;},[count,items.length]);
  return <label className="sku-select-all"><input ref={input} className="sku-select" type="checkbox" aria-label="全选本单产品" checked={items.length>0 && count===items.length} disabled={disabled || !items.length} onChange={event=>onChange(event.target.checked ? items.map(item=>item.id) : [])} />全选</label>;
}

function canStockItem(order: PurchaseOrder, item: PurchaseOrder["items"][number], user: User) {
  return ["warehouse","boss","admin"].includes(user.role) && !order.archived_at && (user.role==="admin" || ["partial_shipped","ready_to_ship","shipped","received","completed"].includes(order.status)) && (item.received_quantity || 0)>(item.stocked_quantity || 0);
}

function BatchStockButton({order,user,selectedIds,busy,onBusy,onSaved,onChanged}: {order:PurchaseOrder;user:User;selectedIds:string[];busy:boolean;onBusy:(value:boolean)=>void;onSaved:(id:string)=>void;onChanged:(message:string)=>void | Promise<void>}) {
  const [message,setMessage]=useState("");const lock=useRef(false);
  const attempts=useRef(new Map<string,string>());
  const items=order.items.filter(item=>selectedIds.includes(item.id) && canStockItem(order,item,user));
  async function submit() {
    if(lock.current || busy || !items.length) return;
    lock.current=true;onBusy(true);setMessage("正在入库…");let completed=0;const failures:string[]=[];
    try {
      for(const item of items) {
        const signature=[item.id,item.received_quantity,item.stocked_quantity].join(":");
        if(!attempts.current.has(signature)) attempts.current.set(signature,crypto.randomUUID());
        try {
          await api(`/api/orders/${order.id}/items/${item.id}/warehouse`,{method:"POST",body:JSON.stringify({action:"stocked",quantity:(item.received_quantity || 0)-(item.stocked_quantity || 0),requestId:attempts.current.get(signature)})});
          attempts.current.delete(signature);completed++;onSaved(item.id);
        } catch(cause) { failures.push(`${item.product_name}：${cause instanceof Error ? cause.message : "保存失败"}`); }
        setMessage(`已处理 ${completed+failures.length} / ${items.length}`);
      }
      await onChanged(`批量入库：成功 ${completed} 项${failures.length ? `，失败 ${failures.length} 项` : ""}`);
      setMessage(failures.length ? `成功 ${completed} 项；${failures.join("；")}` : `已入库 ${completed} 项`);
    } finally { lock.current=false;onBusy(false); }
  }
  return <><button type="button" className="primary" disabled={busy || !items.length} onClick={()=>void submit()}>批量入库（{items.length}）</button><span role="status">{message}</span></>;
}

function ProductTable({ order, user, onChanged }: { order: PurchaseOrder; user: User; onChanged: (message: string) => void | Promise<void> }) {
  const onlinePurchase = order.is_online_purchase === 1;
  const progress = productionTotals(order);
  const meterTone = ["received", "completed"].includes(order.status) ? "received" : ["partial_shipped", "shipped"].includes(order.status) ? "shipped" : !["shipped", "received", "completed"].includes(order.status) && daysToShip(order) >= 0 && daysToShip(order) <= 3 ? "urgent" : order.status === "ready_to_ship" || progress.progress === 100 ? "ready" : order.status === "in_production" ? "production" : "pending";
  const [selectedItems,setSelectedItems]=useState<string[]>([]);
  const [batchBusy,setBatchBusy]=useState(false), [batchResult,setBatchResult]=useState("");
  const batchLock=useRef(false);
  const selectable=onlinePurchase ? [] : order.items.filter(item=>canPurchase(user.role) && !order.archived_at && item.shipped_quantity===0 && item.acceptance_status==="pending" && (user.role==="admin" || (["in_production","ready_to_ship","partial_shipped"].includes(order.status) && ["production_complete","ready_to_ship"].includes(item.workflow_stage) && (item.production_photo_waived===1 || order.attachments.some(file=>file.item_id===item.id && file.kind==="production_photo")))));
  const selected=selectable.filter(item=>selectedItems.includes(item.id));
  async function acceptSelected() {
    if(batchLock.current || !selected.length) return;
    batchLock.current=true;setBatchBusy(true);setBatchResult("正在验收…");
    let completed=0;const failures:string[]=[];
    try {
      for(const item of selected) {
        try {
          await api(`/api/orders/${order.id}/items/${item.id}/acceptance`,{method:"POST",body:JSON.stringify({decision:"approved",reason:"",revision:item.production_revision})});
          completed++;setSelectedItems(current=>current.filter(id=>id!==item.id));
        } catch(cause) { failures.push(`${item.product_name}：${cause instanceof Error ? cause.message : "保存失败"}`); }
        setBatchResult(`已处理 ${completed+failures.length} / ${selected.length}`);
      }
      await onChanged(`批量验收完成：成功 ${completed} 项${failures.length ? `，失败 ${failures.length} 项` : ""}`);
      setBatchResult(failures.length ? `成功 ${completed} 项；${failures.join("；")}` : `已验收 ${completed} 项`);
    } finally { batchLock.current=false;setBatchBusy(false); }
  }
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [expandedImage, setExpandedImage] = useState<{ src: string; name: string } | null>(null);
  const canSelectProducts = canPurchase(user.role) || user.role === "warehouse";
  const imageTrigger = useRef<HTMLElement | null>(null);
  const openImage = (image: { src: string; name: string }) => {
    imageTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setExpandedImage(image);
  };
  const finishCloseImage = () => { setExpandedImage(null); requestAnimationFrame(() => imageTrigger.current?.focus()); };

  return <section className="detail-section product-workflow-section">
    <div className="section-heading"><div><h3><button type="button" className="product-details-toggle" aria-expanded={detailsOpen} aria-controls={`product-details-${order.id}`} onClick={() => setDetailsOpen(!detailsOpen)}><ChevronDown size={18} aria-hidden="true" />采购产品明细<span>{detailsOpen ? "收起" : "展开"}</span></button></h3><p hidden={!detailsOpen}>{onlinePurchase ? "网上采购由采购直接登记物流发货，采购或仓库收货并入库。" : "每个 SKU 只保留一个当前节点，采购端与供应商端同步显示。"}</p></div>{!onlinePurchase && <div className="batch-acceptance-actions"><span>{progress.completed} / {progress.total} 项生产完成</span>{canSelectProducts && <SelectAllProducts items={order.items} selectedIds={selectedItems} disabled={batchBusy} onChange={setSelectedItems} />}{canPurchase(user.role) && !order.archived_at && <button type="button" className="primary" disabled={batchBusy || !selected.length} onClick={()=>void acceptSelected()}>{batchBusy ? "正在验收…" : `批量验收（${selected.length}）`}</button>}{["admin","boss","warehouse"].includes(user.role) && !order.archived_at && <BatchStockButton order={order} user={user} selectedIds={selectedItems} busy={batchBusy} onBusy={setBatchBusy} onSaved={id=>setSelectedItems(current=>current.filter(value=>value!==id))} onChanged={onChanged} />}<span role="status">{batchResult}</span></div>}</div>
    {!onlinePurchase && <div className={`production-meter tone-${meterTone}`} role="progressbar" aria-label="产品生产进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.progress}><span style={{ width: progress.progress + "%" }} /><strong>{progress.progress}%</strong></div>}
    <div className="product-workflow-scroll" id={`product-details-${order.id}`} hidden={!detailsOpen} tabIndex={0} aria-label="产品明细表，小屏幕可横向滚动">
      <div className="product-workflow-table" role="table" aria-label="采购产品明细与生产进度">
        <div className="product-workflow-head" role="row">
          <span role="columnheader">选择</span><span role="columnheader">型号</span><span role="columnheader">产品名称</span><span role="columnheader">产品图</span><span role="columnheader">数量</span><span role="columnheader">单价</span><span role="columnheader">金额</span><span role="columnheader">完成时间</span>
          {onlinePurchase ? <span role="columnheader">物流发货</span> : PRODUCT_WORKFLOW_STAGES.map((stage) => <span role="columnheader" key={stage.id}>{stage.label}</span>)}
        </div>
        {order.items.map((item) => <ProductWorkflowRow key={item.id} order={order} item={item} user={user} onChanged={onChanged} onExpandImage={openImage} selection={!onlinePurchase && canSelectProducts ? {checked:selectedItems.includes(item.id),disabled:batchBusy,onChange:(checked:boolean)=>setSelectedItems(current=>checked ? [...new Set([...current,item.id])] : current.filter(id=>id!==item.id))} : undefined} batchBusy={batchBusy} />)}
      </div>
    </div>
    {expandedImage && <ImageLightbox image={expandedImage} onClosed={finishCloseImage} />}
  </section>;
}

function ImageLightbox({ image, onClosed }: { image: { src: string; name: string }; onClosed: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    closeRef.current?.focus();
  }, []);
  return <dialog ref={dialogRef} className="image-lightbox" aria-label={"查看产品图：" + image.name} onClose={onClosed} onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
    <div className="image-lightbox-panel"><button ref={closeRef} type="button" onClick={() => dialogRef.current?.close()} aria-label="关闭产品图"><X size={22} aria-hidden="true" /></button><img src={image.src} alt={image.name} width="1040" height="780" /><strong>{image.name}</strong></div>
  </dialog>;
}

function ProductDetailDialog({ order, item, images, user, onClose, onExpandImage, onChanged }: { order: PurchaseOrder; item: PurchaseOrder["items"][number]; images: PurchaseOrder["attachments"]; user: User; onClose: () => void; onExpandImage: (image: { src: string; name: string }) => void; onChanged: (message: string) => void | Promise<void> }) {
  const ref = useRef<HTMLDialogElement>(null);
  const values = () => ({ model: item.model || "", productName: item.product_name, color: item.color || "", productType: item.product_type, quantity: item.quantity, unit: item.unit || "", unitPrice: item.unit_price, specification: item.specification || "", materialProcess: item.material_process || "", installationMethod: item.installation_method || "", packagingVolume: item.packaging_volume || "" });
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(values);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const editable = canPurchase(user.role) && !order.archived_at;
  function change(key: keyof ReturnType<typeof values>, value: string | number) { setForm(current => ({ ...current, [key]: value })); }
  async function save(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { await api(`/api/orders/${order.id}/items/${item.id}/details`, { method: "PATCH", body: JSON.stringify(form) }); await onChanged("产品资料已更新"); ref.current?.close(); } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败，请重试"); } finally { setBusy(false); } }
  const stage = item.workflow_stage === "ready_to_ship" ? "生产完成" : PRODUCT_WORKFLOW_STAGES.find((value) => value.id === item.workflow_stage)?.label || "待更新";
  const acceptance = item.acceptance_status === "approved" ? "已验收" : item.acceptance_status === "rejected" ? "退回整改" : "待验收";
  const freight = item.freight_payment_status === "paid" ? "已支付" : item.freight_payment_status === "unpaid" ? "未支付" : "待填写";
  useEffect(() => { const trigger = document.activeElement as HTMLElement | null; ref.current?.showModal(); return () => trigger?.focus(); }, []);
  return <dialog ref={ref} className="product-detail-dialog" aria-label={`查看产品 ${item.product_name}`} onClose={onClose} onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
    <div className="product-detail-panel">
      <header><div><small>{order.po_number}</small><h3>{item.product_name}</h3><p>{item.model || "未填写型号"} · {item.product_type}</p></div><div className="product-detail-header-actions">{editable && !editing && <button type="button" onClick={() => setEditing(true)} aria-label="修改产品资料"><Pencil size={18} /></button>}<button type="button" onClick={() => ref.current?.close()} aria-label="关闭产品详情"><X size={20} /></button></div></header>
      <div className="product-detail-images">{images.length ? images.map((image) => <button key={image.id} type="button" aria-label={`放大查看 ${item.product_name} ${image.file_name}`} onClick={() => onExpandImage({ src: `/api/attachments/${image.id}`, name: item.product_name })}><img src={`/api/attachments/${image.id}`} alt={`${item.product_name} ${image.file_name}`} width="112" height="112" loading="lazy" /></button>) : <div><ImageIcon size={24} aria-hidden="true" /><span>暂无产品图片</span></div>}</div>
      {editing && <form className="product-detail-edit" onSubmit={save}><div className="product-detail-edit-grid"><label>型号<input value={form.model} onChange={e => change("model", e.target.value)} /></label><label>产品名称<input required value={form.productName} onChange={e => change("productName", e.target.value)} /></label><label>颜色<input value={form.color} onChange={e => change("color", e.target.value)} /></label><label>产品类型<select value={form.productType} onChange={e => change("productType", e.target.value)}>{PRODUCT_TYPES.map(type => <option key={type} value={type}>{type}</option>)}</select></label><label>数量<input type="number" min="1" step="1" value={form.quantity} onChange={e => change("quantity", Number(e.target.value))} /></label><label>单位<input value={form.unit} onChange={e => change("unit", e.target.value)} /></label><label>单价<input type="number" min="0" step="0.01" value={form.unitPrice} onChange={e => change("unitPrice", Number(e.target.value))} /></label><label>包装体积<input value={form.packagingVolume} onChange={e => change("packagingVolume", e.target.value)} /></label><label className="wide">规格 / 备注<textarea value={form.specification} onChange={e => change("specification", e.target.value)} /></label><label className="wide">材料 / 工艺 / 配置<textarea value={form.materialProcess} onChange={e => change("materialProcess", e.target.value)} /></label><label className="wide">安装方式<textarea value={form.installationMethod} onChange={e => change("installationMethod", e.target.value)} /></label></div><div className="product-detail-edit-actions"><button className="primary" type="submit" disabled={busy}>{busy ? "保存中" : "保存修改"}</button><button className="secondary" type="button" disabled={busy} onClick={() => { setForm(values()); setError(""); setEditing(false); }}>取消</button></div>{error && <p className="form-error" role="alert">{error}</p>}</form>}
      {!editing && <>
      <dl className="product-detail-facts">
        <div><dt>数量</dt><dd>{quantityText.format(item.quantity)} {item.unit}</dd></div><div><dt>单价</dt><dd>{canViewAmounts(user.role) ? `¥ ${money.format(item.unit_price)}` : "—"}</dd></div><div><dt>金额</dt><dd>{canViewAmounts(user.role) ? `¥ ${money.format(item.amount)}` : "—"}</dd></div><div><dt>完成时间</dt><dd>{dateText(item.completion_date)}</dd></div>
        <div><dt>生产节点</dt><dd>{stage}</dd></div><div><dt>采购验收</dt><dd>{acceptance}</dd></div><div><dt>已收货</dt><dd>{quantityText.format(item.received_quantity)} / {quantityText.format(item.quantity)}</dd></div><div><dt>已入库</dt><dd>{quantityText.format(item.stocked_quantity)} / {quantityText.format(item.quantity)}</dd></div>
        <div><dt>运费</dt><dd>{freight}</dd></div><div><dt>包装体积</dt><dd>{item.packaging_volume || "待填写"}</dd></div><div><dt>已发货</dt><dd>{quantityText.format(item.shipped_quantity)} / {quantityText.format(item.quantity)}</dd></div><div><dt>颜色</dt><dd>{item.color || "—"}</dd></div>
      </dl>
      <section className="product-detail-copy"><div><strong>规格 / 备注</strong><p>{item.specification || "暂无"}</p></div><div><strong>材料 / 工艺 / 配置</strong><p>{item.material_process || "暂无"}</p></div><div><strong>安装方式</strong><p>{item.installation_method || "暂无"}</p></div></section></>}
      <section className="product-detail-history"><h4>该产品记录</h4>{[...(item.acceptance_history || []).map((record) => ({ id: record.id, label: record.decision === "approved" ? "采购验收通过" : "采购退回整改", detail: record.reason || "无补充说明", actor: record.actorName, at: record.createdAt })), ...(item.warehouse_history || []).map((record, index) => ({ id: `warehouse-${index}`, label: record.action === "received" ? `仓库收货 ${record.quantity}` : `确认入库 ${record.quantity}`, detail: `${record.action === "received" ? "收货" : "入库"}时间 ${record.record_date || dateText(record.created_at)}`, actor: record.actor_name, at: record.record_date || record.created_at }))].sort((left, right) => right.at.localeCompare(left.at)).map((record) => <div key={record.id}><span><strong>{record.label}</strong><small>{record.detail}</small></span><span><small>{record.actor}</small><time>{dateText(record.at)}</time></span></div>)}{!item.acceptance_history?.length && !item.warehouse_history?.length && <p>暂无验收或仓库记录</p>}</section>
    </div>
  </dialog>;
}

function ProductWorkflowRow({ order, item, user, onChanged, onExpandImage, selection, batchBusy }: {
  order: PurchaseOrder;
  item: PurchaseOrder["items"][number];
  user: User;
  onChanged: (message: string) => void | Promise<void>;
  onExpandImage: (image: { src: string; name: string }) => void;
  selection?: { checked: boolean; disabled: boolean; onChange: (checked: boolean) => void };
  batchBusy?: boolean;
}) {
  const onlinePurchase = order.is_online_purchase === 1;
  const realPhotos = order.attachments.filter(attachment => attachment.item_id === item.id && attachment.kind === "production_photo");
  const images = item.shipped_quantity > 0 ? realPhotos : order.attachments.filter(attachment => attachment.item_id === item.id && attachment.kind === "product_image");
  const [photoStage, setPhotoStage] = useState<ProductWorkflowStage | "photos" | null>(null);
  const canEdit = (user.role === "supplier" || canPurchase(user.role)) && !order.archived_at && (user.role === "admin" || user.supplier_operations === 1 || ["in_production", "ready_to_ship", "partial_shipped"].includes(order.status)) && item.shipped_quantity === 0;
  const canUpload = (user.role === "supplier" || canPurchase(user.role)) && !order.archived_at && ["pending_confirmation", "in_production", "ready_to_ship", "partial_shipped"].includes(order.status) && item.shipped_quantity === 0;
  const [completionDate, setCompletionDate] = useState(item.completion_date || "");
  const [workflowStage, setWorkflowStage] = useState(item.workflow_stage);
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState("");
  const [deletingPhoto, setDeletingPhoto] = useState<string | null>(null);
  const [confirmingItemDelete, setConfirmingItemDelete] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [shipmentOpen, setShipmentOpen] = useState(false);
  async function removePhoto() {
    if (!deletingPhoto || busy) return;
    setBusy(true); setRowError("");
    try { await api("/api/attachments/" + deletingPhoto, {method:"DELETE"}); setDeletingPhoto(null); onChanged("错误实拍已删除，历史记录保留，请重新上传并验收"); }
    catch (cause) { setRowError(cause instanceof Error ? cause.message : "删除失败，请重试"); }
    finally { setBusy(false); }
  }
  async function removeItem() {
    if (busy) return;
    setBusy(true); setRowError("");
    try { await api(`/api/orders/${order.id}/items/${item.id}`, { method: "DELETE" }); await onChanged(`${item.product_name} 已从采购单删除`); }
    catch (cause) { setRowError(cause instanceof Error ? cause.message : "删除产品失败"); setConfirmingItemDelete(false); }
    finally { setBusy(false); }
  }
  const displaySpecification = (item.specification || "").split(/[；;\n]/).filter(part => !/^\s*税率\s*[:：]\s*[\d.]+\s*[%％]\s*$/.test(part)).join("；").trim();

  useEffect(() => { setCompletionDate(item.completion_date || ""); }, [item.completion_date]);
  useEffect(() => { setWorkflowStage(item.workflow_stage); }, [item.workflow_stage]);

  async function save(patch: { completionDate?: string | null; workflowStage?: ProductWorkflowStage }, success: string) {
    setBusy(true); setRowError("");
    try {
      await api("/api/orders/" + order.id + "/items/" + item.id + "/production", { method: "PATCH", body: JSON.stringify(patch) });
      await onChanged(success);
    } catch (caught) {
      setRowError(caught instanceof Error ? caught.message : "产品信息更新失败");
      setCompletionDate(item.completion_date || "");
      setWorkflowStage(item.workflow_stage);
    } finally { setBusy(false); }
  }

  return <div className="product-item-group" role="rowgroup" inert={batchBusy} aria-label={item.product_name + " 产品及验收"}><div className={"product-workflow-row" + (busy ? " is-saving" : "")} role="row">
    <span role="cell" className="workflow-selection">{selection && <input className="sku-select" type="checkbox" aria-label={`选择产品 ${item.product_name}`} checked={selection.checked} disabled={selection.disabled} onChange={event=>selection.onChange(event.target.checked)} />}</span>
    <span role="cell" className="workflow-model" title={item.model || "未填写型号"}><button type="button" className="product-row-detail-button" onClick={() => setDetailOpen(true)} aria-label={`查看产品详情：${item.product_name}`}>{item.model || "查看"}</button></span>
    <span role="cell" className="workflow-product"><strong>{item.product_name}</strong><em>{item.product_type}</em>{displaySpecification && <small>{displaySpecification}</small>}{item.material_process && <small>材料/工艺/配置：{item.material_process}</small>}{item.installation_method && <small>安装方式：{item.installation_method}</small>}{item.shipped_quantity > 0 && <small>已发 {item.shipped_quantity} / {item.quantity} · 生产信息已锁定</small>}{user.role === "supplier" && item.shipped_quantity === 0 && <small>{item.acceptance_status === "approved" ? "采购已接受，可发货" : item.acceptance_status === "rejected" ? `采购退回：${item.acceptance_history?.at(-1)?.reason || "请整改并上传新实拍"}` : "等待采购验收"}</small>}{canPurchase(user.role) && !order.archived_at && <span className="product-item-delete">{confirmingItemDelete ? <><span>确认删除此产品？</span><button type="button" disabled={busy} onClick={() => void removeItem()}>确认</button><button type="button" disabled={busy} onClick={() => setConfirmingItemDelete(false)}>取消</button></> : <button type="button" disabled={busy || order.items.length <= 1} title={order.items.length <= 1 ? "采购单至少保留一个产品" : "删除错误产品"} onClick={() => setConfirmingItemDelete(true)}><Trash2 size={13} />删除产品</button>}</span>}{rowError && <small className="workflow-error" role="alert">{rowError}</small>}</span>
    <span role="cell" className="workflow-images">{images.length ? images.map(image => <button key={image.id} type="button" className="product-thumb product-thumb-button" onClick={() => onExpandImage({ src: "/api/attachments/" + image.id, name: item.product_name })} aria-label={"放大查看 " + item.product_name + " 产品图 " + image.file_name}><img src={"/api/attachments/" + image.id} alt="" width="68" height="68" loading="lazy" /></button>) : <span className="product-thumb empty" title={item.shipped_quantity > 0 ? "暂无产品实拍" : "暂无产品图"}><ImageIcon size={17} aria-hidden="true" /></span>}{item.shipped_quantity > 0 && <small>{realPhotos.length ? "产品实拍" : "历史订单暂无实拍"}</small>}</span>
    <span role="cell" aria-label={item.product_name + " 固定数量"}><strong>{quantityText.format(item.quantity)}</strong>{item.unit && <small>{item.unit}</small>}</span>
    <span role="cell" className="workflow-money">{canViewAmounts(user.role) ? `¥ ${money.format(item.unit_price)}` : "—"}</span>
    <span role="cell" className="workflow-money">{canViewAmounts(user.role) ? `¥ ${money.format(item.amount)}` : "—"}</span>
    <span role="cell">{canEdit ? <input className="workflow-date" type="date" min={order.order_date} value={completionDate} disabled={busy} aria-label={item.product_name + " 完成时间"} onChange={(event) => { const value = event.currentTarget.value; setCompletionDate(value); void save({ completionDate: value || null }, item.product_name + " 完成时间已更新"); }} /> : <time>{dateText(item.completion_date)}</time>}</span>
    {onlinePurchase ? <span role="cell" className="online-purchase-shipment">{item.shipped_quantity >= item.quantity ? <><strong>已登记发货</strong><small>已发 {item.shipped_quantity} / {item.quantity}</small></> : canPurchase(user.role) && !order.archived_at ? <button type="button" className="secondary" disabled={busy} onClick={() => setShipmentOpen(true)}>登记发货</button> : <><strong>待采购登记</strong><small>已发 {item.shipped_quantity} / {item.quantity}</small></>}</span> : PRODUCT_WORKFLOW_STAGES.map((stage) => { const checked = workflowStage === stage.id || (stage.id === "production_complete" && workflowStage === "ready_to_ship"); return <label role="cell" className={"workflow-stage-check" + (checked ? " checked" : "")} key={stage.id} title={stage.label}>
      <input type="radio" name={"workflow-" + item.id} value={stage.id} checked={checked} disabled={!canEdit || busy || (stage.id === "shipment_complete" && workflowStage !== "ready_to_ship" && workflowStage !== "production_complete")} aria-label={item.product_name + "，" + stage.label} onChange={() => { if (stage.id === "shipment_complete") { if (item.acceptance_status !== "approved") setRowError("请先完成采购验收，再登记发货"); else setShipmentOpen(true); } else if (stage.id === "production_complete") setPhotoStage(stage.id); else { setWorkflowStage(stage.id); void save({ workflowStage: stage.id }, item.product_name + " 已更新为" + stage.label); } }} />
      <span aria-hidden="true">{checked && <Check size={14} />}</span>
      <em className="sr-only">{stage.label}</em>
    </label>; })}
  </div><div className="product-followup-row" role="row" aria-label={item.product_name + " 实拍验收与仓库记录"}>
    <div role="cell" className="workflow-selection-spacer" aria-hidden="true" />
    {!onlinePurchase && <div role="cell"><strong>产品实物图</strong>{canUpload ? <button className="secondary" type="button" onClick={() => setPhotoStage("photos")}>上传实拍照片</button> : <small>{realPhotos.length ? realPhotos.length + " 张实拍" : item.production_photo_waived === 1 ? "未提供实物图" : "暂无实拍照片"}</small>}{item.production_photo_waived === 1 && <small className="photo-waived-status">已记录：未提供实物图</small>}<div className="acceptance-photos">{realPhotos.map(photo => <div className="production-photo" key={photo.id}><button type="button" onClick={() => onExpandImage({ src: "/api/attachments/" + photo.id, name: item.product_name })} aria-label={"放大实拍 " + item.product_name}><img src={"/api/attachments/" + photo.id} alt={item.product_name + " 实拍"} /></button>{(user.role === "admin" || (canPurchase(user.role) && user.supplier_operations === 1)) && canUpload && <button type="button" className="photo-delete" aria-label={"删除实拍 " + photo.file_name} disabled={busy} onClick={() => setDeletingPhoto(photo.id)}>删除</button>}{deletingPhoto === photo.id && <div className="photo-delete-confirm"><p>删除这张实拍？历史保留，需重新验收。</p><button type="button" className="photo-delete" disabled={busy} onClick={() => void removePhoto()}>确认删除</button><button type="button" className="photo-delete" disabled={busy} onClick={() => setDeletingPhoto(null)}>取消</button></div>}</div>)}</div></div>}
    {!onlinePurchase && <div role="cell">{canPurchase(user.role) && !order.archived_at ? <ProductAcceptanceCard order={order} item={item} user={user} onChanged={onChanged} /> : <><strong>采购验收</strong><p>{item.acceptance_status === "approved" ? "已验收" : item.acceptance_status === "rejected" ? "退回整改" : "待验收"}</p></>}</div>}
    <WarehouseFields order={order} item={item} user={user} onChanged={onChanged} />
    <FreightPayment order={order} item={item} user={user} onChanged={onChanged} />
    <PackagingVolume order={order} item={item} user={user} onChanged={onChanged} />
  </div>{photoStage && <ProductionPhotoDialog order={order} item={item} stage={photoStage} existing={realPhotos.length} onClose={() => setPhotoStage(null)} onChanged={onChanged} />}{shipmentOpen && <ProductShipmentDialog order={order} item={item} onlinePurchase={onlinePurchase} onClose={() => setShipmentOpen(false)} onChanged={onChanged} />}{detailOpen && <ProductDetailDialog order={order} item={item} images={images} user={user} onClose={() => setDetailOpen(false)} onExpandImage={onExpandImage} onChanged={onChanged} />}</div>;
}

function ProductShipmentDialog({ order, item, onlinePurchase = false, onClose, onChanged }: { order: PurchaseOrder; item: PurchaseOrder["items"][number]; onlinePurchase?: boolean; onClose: () => void; onChanged: (message: string) => void | Promise<void> }) {
  const ref = useRef<HTMLDialogElement>(null);
  const remaining = item.quantity - item.shipped_quantity;
  const orderRemaining = shippingTotals(order).remaining;
  const [shippedAt, setShippedAt] = useState(shanghaiToday());
  const [quantity, setQuantity] = useState(remaining);
  const [carrier, setCarrier] = useState(order.carrier || "");
  const [tracking, setTracking] = useState(order.tracking_number || "");
  const [boxCount, setBoxCount] = useState("1");
  const [deliveryNote, setDeliveryNote] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { const trigger = document.activeElement as HTMLElement | null; ref.current?.showModal(); return () => { ref.current?.close(); trigger?.focus(); }; }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const form = new FormData();
      form.set("shippedAt", shippedAt); form.set("quantity", String(quantity));
      form.set("items", JSON.stringify([{ itemId: item.id, quantity }]));
      form.set("isComplete", String(quantity === orderRemaining));
      form.set("carrier", carrier.trim()); form.set("trackingNumber", tracking.trim()); form.set("boxCount", boxCount);
      deliveryNote.forEach(file => form.append("deliveryNote", file));
      await api(`/api/orders/${order.id}/shipments`, { method: "POST", body: form });
      await onChanged(`${item.product_name} 发货已登记，物流单号 ${tracking.trim()}`); onClose();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "发货登记失败"); }
    finally { setBusy(false); }
  }
  return <dialog ref={ref} className="product-shipment-dialog" aria-labelledby={`shipment-title-${item.id}`} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}><form onSubmit={submit}>
    <header><div><small>{order.po_number}</small><h3 id={`shipment-title-${item.id}`}>登记发货 · {item.product_name}</h3><p>{onlinePurchase ? "网上采购由采购直接登记发货；送货单可选。" : "提交成功后，“发货完成”节点会自动勾选；送货单可选。"}</p></div><button type="button" aria-label="关闭发货登记" disabled={busy} onClick={onClose}><X size={20} /></button></header>
    <div className="product-shipment-grid"><label>实际发货日期<input required type="date" min={order.order_date} value={shippedAt} onChange={e => setShippedAt(e.target.value)} /></label><label>本次发货数量<input required type="number" min="1" max={remaining} step="1" value={quantity} onChange={e => setQuantity(Number(e.target.value))} /></label><label>物流公司<input required value={carrier} onChange={e => setCarrier(e.target.value)} placeholder="如：顺丰速运" /></label><label>快递 / 物流单号<input required autoFocus value={tracking} onChange={e => setTracking(e.target.value)} placeholder="请输入单号" /></label><label>箱数<input required type="number" min="1" step="1" value={boxCount} onChange={e => setBoxCount(e.target.value)} /></label></div>
    <FilePicker label="上传送货单（可选）" files={deliveryNote} onFiles={setDeliveryNote} disabled={busy} accept=".pdf,.doc,.docx,.xls,.xlsx,image/jpeg,image/png,image/webp" />
    {error && <p className="form-error" role="alert">{error}</p>}<div className="action-buttons"><button type="button" className="secondary" disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy || !tracking.trim() || !carrier.trim()}>{busy ? "正在提交" : "确认发货"}</button></div>
  </form></dialog>;
}

function ProductionPhotoDialog({ order, item, stage, existing, onClose, onChanged }: { order: PurchaseOrder; item: PurchaseOrder["items"][number]; stage: ProductWorkflowStage | "photos"; existing: number; onClose: () => void; onChanged: (message: string) => void | Promise<void> }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [uploaded, setUploaded] = useState(0);
  const [photoChoice, setPhotoChoice] = useState<"upload" | "not_provided">(item.production_photo_waived === 1 ? "not_provided" : "upload");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { const trigger = document.activeElement as HTMLElement | null; ref.current?.showModal(); return () => { ref.current?.close(); trigger?.focus(); }; }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      if (photoChoice === "upload" || stage === "photos") for (const file of files) { await uploadFile(order.id, "production_photo", file, item.id); setUploaded(value => value + 1); setFiles(current => current.filter(value => value !== file)); }
      if (stage !== "photos") await api(`/api/orders/${order.id}/items/${item.id}/production`, { method: "PATCH", body: JSON.stringify({ workflowStage: stage, photoNotProvided: photoChoice === "not_provided" }) });
      onChanged(photoChoice === "not_provided" && stage !== "photos" ? `${item.product_name} 已确认生产完成，记录为未提供实物图` : `${item.product_name} 实拍照片已同步${stage !== "photos" ? "，生产节点已更新" : ""}`); onClose();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "上传失败，请重试"); }
    finally { setBusy(false); }
  }
  return <dialog ref={ref} className="production-photo-dialog" aria-label="上传产品生产实拍" onCancel={event => { event.preventDefault(); if (!busy) { if (uploaded) onChanged("已上传的实拍照片已保留，生产节点未更改"); onClose(); } }}>
    <form onSubmit={submit}><h3>{stage === "photos" ? "产品实拍照片" : "生产完成 · 实物图记录"}</h3><p>{item.model} {item.product_name}</p>{stage !== "photos" && <fieldset className="production-photo-choice"><legend>实物图情况</legend><label><input type="radio" name="photo-choice" checked={photoChoice === "upload"} onChange={() => setPhotoChoice("upload")} />上传实物图</label><label><input type="radio" name="photo-choice" checked={photoChoice === "not_provided"} onChange={() => { setPhotoChoice("not_provided"); setFiles([]); }} />未提供实物图</label></fieldset>}{photoChoice === "upload" || stage === "photos" ? <><p className="form-help">照片仅关联此产品，可上传多个角度。已有 {existing + uploaded} 张实拍；发货后采购产品图自动显示实拍，原图留档。</p><FilePicker label="上传该产品实拍照片" files={files} onFiles={setFiles} disabled={busy} accept="image/jpeg,image/png,image/webp" /></> : <p className="photo-waived-note">系统将明确记录“未提供实物图”，采购仍需确认验收后才能发货。</p>}{error && <p className="form-error" role="alert">{error}</p>}<div className="action-buttons"><button type="button" className="secondary" disabled={busy} onClick={() => { if (uploaded) onChanged("已上传的实拍照片已保留，生产节点未更改"); onClose(); }}>取消</button><button className="primary" disabled={busy || (photoChoice === "upload" && !(existing + uploaded + files.length)) || (item.acceptance_status === "rejected" && photoChoice === "upload" && !(uploaded + files.length))}>{busy ? "正在保存" : stage === "photos" ? "保存实拍照片" : photoChoice === "not_provided" ? "确认未提供实物图" : "保存照片并确认完成"}</button></div></form>
  </dialog>;
}

function ShipmentRecords({ order }: { order: PurchaseOrder }) {
  const totals = shippingTotals(order);
  return <section className="detail-section shipment-records"><div className="section-heading"><h3>发货记录</h3><span>{order.shipments.length} 次发货</span></div><div className="shipment-summary"><div><span>采购数量</span><strong>{quantityText.format(totals.ordered)}</strong></div><div><span>已发数量</span><strong>{quantityText.format(totals.shipped)}</strong></div><div><span>待发数量</span><strong>{quantityText.format(totals.remaining)}</strong></div></div>{order.shipments.length ? <div className="shipment-list"><div className="shipment-head"><span>发货单 / 日期</span><span>数量</span><span>箱数</span><span>物流信息</span><span>附件</span></div>{order.shipments.map((shipment) => <div className="shipment-line" key={shipment.id}><span><strong>{shipment.shipment_number}</strong><small>{dateText(shipment.shipped_at)}</small>{shipment.items?.length ? <details><summary>发货产品（{shipment.items.length} 项）</summary>{shipment.items.map(item => <small key={item.itemId}>{item.productName} × {item.quantity}</small>)}</details> : <small>历史记录未关联产品明细</small>}</span><span>{quantityText.format(shipment.quantity)} 件</span><span>{shipment.box_count} 箱</span><span><strong>{shipment.carrier}</strong><small>{shipment.tracking_number}</small></span><span className="shipment-files">{shipment.attachments.map((attachment) => <a key={attachment.id} href={`/api/shipment-attachments/${attachment.id}`} target="_blank" rel="noreferrer">{attachment.kind === "shipment_photo" ? "发货照片" : "送货单"}</a>)}</span></div>)}</div> : <div className="shipment-empty">尚无发货记录</div>}</section>;
}

function SceneImages({order,user,onChanged}:{order:PurchaseOrder;user:User;onChanged:(message:string)=>void}) {
  const [files,setFiles]=useState<File[]>([]), [busy,setBusy]=useState(false), [error,setError]=useState("");
  const [expanded,setExpanded]=useState<{src:string;name:string}|null>(null);
  const images=order.attachments.filter(file=>file.purpose === "scene");
  async function uploadScenes() {
    setBusy(true); setError(""); let count=0;
    try {
      for (const file of files) { await uploadFile(order.id,"scene_image",file); count++; setFiles(current=>current.filter(value=>value!==file)); }
    } catch(cause) { setError(cause instanceof Error ? cause.message : "上传失败，未成功的图片可重试"); }
    finally { setBusy(false); if(count) onChanged(`已上传 ${count} 张场景大图，供应商可同步查看`); }
  }
  return <section className="detail-section scene-images"><div className="section-heading"><h3>场景大图</h3><span>{images.length} 张图片</span></div>{canPurchase(user.role) && !order.archived_at && <div className="scene-upload"><FilePicker label="上传场景大图" files={files} onFiles={setFiles} disabled={busy} accept="image/jpeg,image/png,image/webp" /><button type="button" className="secondary" disabled={busy || !files.length} onClick={()=>void uploadScenes()}>{busy ? "正在上传" : "上传场景大图"}</button></div>}<p className="form-help">采购上传，对应供应商同步查看；点击图片可放大。</p>{error && <p className="form-error" role="alert">{error}</p>}<div className="scene-gallery">{images.map(file=><button type="button" key={file.id} onClick={()=>setExpanded({src:"/api/attachments/"+file.id,name:file.file_name})} aria-label={"放大场景图 "+file.file_name}><img src={"/api/attachments/"+file.id} alt={file.file_name}/><span>{file.file_name}</span></button>)}</div>{!images.length && <p className="form-help">暂无场景大图</p>}{expanded && <ImageLightbox image={expanded} onClosed={()=>setExpanded(null)}/>}</section>;
}

function Attachments({ order, readOnly = false }: { order: PurchaseOrder; readOnly?: boolean }) {
  const [open, setOpen] = useState(true);
  const images = order.attachments.filter((attachment) => attachment.content_type.startsWith("image/") && attachment.kind !== "product_image" && attachment.kind !== "purchase_order");
  const referenceImages = order.attachments.filter(attachment => attachment.purpose !== "scene" && attachment.content_type.startsWith("image/") && ["product_image", "purchase_order"].includes(attachment.kind));
  const docs = order.attachments.filter((attachment) => !attachment.content_type.startsWith("image/"));
  if (!order.attachments.length) return null;
  return <section className="detail-section"><div className="section-heading"><h3><button type="button" className="product-details-toggle" aria-expanded={open} aria-controls={`attachments-${order.id}`} onClick={() => setOpen(!open)}><ChevronDown size={18} aria-hidden="true" />附件与产品实图<span>{open ? "收起" : "展开"}</span></button></h3><span>{order.attachments.length} 个文件</span></div><div id={`attachments-${order.id}`} hidden={!open}>{images.length > 0 && <div className="image-strip">{images.map((attachment) => <a href={`/api/attachments/${attachment.id}`} target="_blank" rel="noreferrer" key={attachment.id}><img src={`/api/attachments/${attachment.id}`} alt={attachment.file_name} /><span>{order.items.find(item => item.id === attachment.item_id)?.product_name || "历史未关联产品"} · {attachment.file_name}</span></a>)}</div>}{!images.length && <p className="form-help">暂无按产品上传的实拍照片，供应商上传后会自动同步到这里。</p>}{referenceImages.length > 0 && <details><summary>原订单参考图（{referenceImages.length}）</summary><div className="image-strip">{referenceImages.map(attachment => <a href={`/api/attachments/${attachment.id}`} target="_blank" rel="noreferrer" key={attachment.id}><img src={`/api/attachments/${attachment.id}`} alt={attachment.file_name} /><span>{attachment.file_name}</span></a>)}</div></details>}{!readOnly && docs.map((attachment) => <a className="file-link" href={`/api/attachments/${attachment.id}`} target="_blank" rel="noreferrer" key={attachment.id}><FileText size={18} /><span>{attachment.file_name}</span><ArrowRight size={16} /></a>)}</div></section>;
}

function EventTimeline({ order }: { order: PurchaseOrder }) {
  return <div className="event-list">{order.events.map((event) => <div key={event.id}><span className="event-dot" /><div><strong>{event.detail}</strong><p>{event.actor_name} · {new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(event.created_at))}</p></div></div>)}</div>;
}

function ActionPanel({ order, user, onChanged, supplierOperations = false }: { order: PurchaseOrder; user: User; onChanged: (message: string) => void | Promise<void>; supplierOperations?: boolean }) {
  const shipmentTotals = shippingTotals(order);
  const itemProduction = productionTotals(order);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [promisedDate, setPromisedDate] = useState(order.promised_ship_date || "");
  const [note, setNote] = useState(order.production_note || "");
  const [carrier, setCarrier] = useState(order.carrier || "");
  const [tracking, setTracking] = useState(order.tracking_number || "");
  const [shippedAt, setShippedAt] = useState(order.shipped_at || new Date().toISOString().slice(0, 10));
  const [deliveryNote, setDeliveryNote] = useState<File[]>([]);
  const [shipmentItems, setShipmentItems] = useState<Record<string, number>>({});
  const shipmentQuantity = Object.values(shipmentItems).reduce((sum, quantity) => sum + quantity, 0);
  const allShipped = shipmentQuantity > 0 && shipmentQuantity === shipmentTotals.remaining;
  const legacyShipment = order.items.reduce((sum, item) => sum + item.shipped_quantity, 0) !== shipmentTotals.shipped;
  const [boxCount, setBoxCount] = useState("");
  const [deleteConfirming, setDeleteConfirming] = useState(false);


  async function act(path: string, payload?: object, success = "操作已完成") {
    setBusy(true); setError("");
    try {
      await api(`/api/orders/${order.id}/${path}`, { method: path === "internal" ? "PATCH" : "POST", body: payload ? JSON.stringify(payload) : undefined });
      onChanged(success);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "操作失败"); }
    finally { setBusy(false); }
  }

  async function submitShipment() {
    if (!Number.isInteger(Number(shipmentQuantity)) || Number(shipmentQuantity) < 1) { setError("本次发货数量必须是大于等于 1 的整数"); return; }
    setBusy(true); setError("");
    try {
      const form = new FormData();
      form.set("shippedAt", shippedAt);
      form.set("quantity", String(shipmentQuantity));
      form.set("items", JSON.stringify(Object.entries(shipmentItems).map(([itemId, quantity]) => ({ itemId, quantity }))));
      form.set("isComplete", String(allShipped));
      form.set("carrier", carrier);
      form.set("trackingNumber", tracking);
      form.set("boxCount", boxCount);

      deliveryNote.forEach(file => form.append("deliveryNote", file));
      await api(`/api/orders/${order.id}/shipments`, { method: "POST", body: form });
      setDeliveryNote([]); setShipmentItems({}); setBoxCount("");
      onChanged(allShipped ? "全部发货已登记，订单进入已发货" : "部分发货已登记，可继续登记下一次发货");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "发货登记失败"); }
    finally { setBusy(false); }
  }

  async function deleteOrder() {
    setBusy(true); setError("");
    try {
      await api(`/api/orders/${order.id}`, { method: "DELETE" });
      onChanged(`采购单 ${order.po_number} 已作废留档`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "采购单作废失败"); }
    finally { setBusy(false); }
  }

  if (user.role === "supplier" || ((user.role === "admin" || user.supplier_operations === 1) && supplierOperations)) {
    if (order.status === "pending_confirmation") return <section className="action-panel"><div className="action-copy"><ClipboardCheck size={22} /><div><h3>请确认采购单</h3><p>核对产品、数量与要求后，填写贵司承诺的发货日期。</p></div></div><div className="action-form"><label>承诺发货日期<input type="date" value={promisedDate} min={order.order_date} onInput={(event) => setPromisedDate(event.currentTarget.value)} /></label><button className="primary" disabled={busy || !promisedDate} onClick={() => act("confirm", { promisedShipDate: promisedDate }, "采购单已确认，进入生产中")}><Check size={17} />确认采购单</button></div>{error && <p className="form-error" role="alert">{error}</p>}</section>;
    if (order.status === "in_production") return <section className="action-panel"><div className="action-copy"><Box size={22} /><div><h3>生产资料与整单推进</h3><p>采购数量固定不可修改；完成时间和每个产品的当前节点请直接在上方采购产品明细中更新。</p></div></div><div className="production-progress-overview"><div><span style={{ width: `${itemProduction.progress}%` }} /></div><strong>{itemProduction.progress}%</strong><small>{itemProduction.completed} / {itemProduction.total} 项达到生产完成</small></div><div className="progress-editor"><label>进度说明<textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如：主体已完成，正在安装电气配件" /></label><p className="form-help">请在上方每个产品点击“生产完成”，上传实物图或记录“未提供实物图”。</p><div className="action-buttons"><button className="secondary" disabled={busy} onClick={() => act("progress", { note }, "生产说明已更新")}><RefreshCw size={17} />保存说明</button><p className="form-help">生产完成即进入等待发货；采购验收通过后可以登记发货。</p></div>{itemProduction.completed !== itemProduction.total && <p className="completion-hint">全部产品达到“生产完成”后，整单才可推进。</p>}</div>{error && <p className="form-error" role="alert">{error}</p>}</section>;
    if (order.status === "ready_to_ship" || order.status === "partial_shipped") return <section className="action-panel"><div className="action-copy"><Truck size={22} /><div><h3>{order.status === "partial_shipped" ? "登记下一次发货" : "发货登记"}</h3><p>采购 {quantityText.format(shipmentTotals.ordered)} 件，已发 {quantityText.format(shipmentTotals.shipped)} 件，待发 {quantityText.format(shipmentTotals.remaining)} 件。</p></div></div><div className="shipment-grid shipment-registration"><label>实际发货日期<input type="date" value={shippedAt} min={order.order_date} onInput={(event) => setShippedAt(event.currentTarget.value)} /></label><div className="shipment-product-picker"><h4>选择本次发货产品</h4>{legacyShipment && <p className="form-error">历史发货缺少产品明细，请先联系采购核实。</p>}{order.items.map(item => {
      const remaining = item.quantity - item.shipped_quantity;
      const photoCount = order.attachments.filter(file => file.item_id === item.id && file.kind === "production_photo").length;
      const selected = Object.hasOwn(shipmentItems, item.id);
      return <div className="shipment-product-choice" key={item.id}><label><input type="checkbox" checked={selected} disabled={busy || remaining <= 0 || legacyShipment || item.acceptance_status !== "approved"} onChange={event => setShipmentItems(current => { const next = { ...current }; if (event.target.checked) next[item.id] = remaining; else delete next[item.id]; return next; })} /><span>{item.model && `${item.model} · `}{item.product_name}<small>采购 {item.quantity} · 已发 {item.shipped_quantity} · 待发 {remaining}{remaining <= 0 ? " · 已全部发完" : ""} · {item.acceptance_status === "approved" ? "采购已接受" : item.acceptance_status === "rejected" ? "退回整改" : "未验收，不可发货"} · {item.production_photo_waived === 1 ? "未提供实物图" : `实拍 ${photoCount} 张${!photoCount ? "（请先上传）" : ""}`}</small></span></label><input type="number" aria-label={item.product_name + " 本次发货数量"} min="1" max={remaining} step="1" value={selected ? shipmentItems[item.id] : ""} disabled={busy || !selected || remaining <= 0 || legacyShipment || item.acceptance_status !== "approved"} onChange={event => setShipmentItems(current => ({ ...current, [item.id]: Number(event.target.value) }))} /></div>;
    })}</div><label>本次发货总数<input value={shipmentQuantity} readOnly /></label><label className="complete-check"><input type="checkbox" checked={order.items.some(item => item.quantity > item.shipped_quantity && item.acceptance_status === "approved") && order.items.filter(item => item.quantity > item.shipped_quantity && item.acceptance_status === "approved").every(item => shipmentItems[item.id] === item.quantity - item.shipped_quantity)} disabled={busy || legacyShipment} onChange={event => setShipmentItems(event.target.checked ? Object.fromEntries(order.items.filter(item => item.quantity > item.shipped_quantity && item.acceptance_status === "approved").map(item => [item.id, item.quantity - item.shipped_quantity])) : {})} /><span>选择全部已验收的待发产品</span></label><label>物流公司<input value={carrier} onChange={(event) => setCarrier(event.target.value)} placeholder="物流公司名称" /></label><label>物流单号<input value={tracking} onChange={(event) => setTracking(event.target.value)} placeholder="请输入物流单号" /></label><label>箱数<input type="number" min="1" step="1" value={boxCount} onChange={(event) => setBoxCount(event.target.value)} placeholder="本次发货箱数" /></label><p className="form-help">发货产品将自动关联各自的生产实拍照片，无需重复上传原订单图。</p><FilePicker label="上传送货单附件（可选）" files={deliveryNote} onFiles={setDeliveryNote} disabled={busy} accept=".pdf,.doc,.docx,.xls,.xlsx,image/jpeg,image/png,image/webp" /><button className="primary shipment-submit" disabled={busy || legacyShipment || !carrier || !tracking || !shippedAt || !shipmentQuantity || !boxCount} onClick={submitShipment}><Send size={17} />{busy ? "正在提交" : "提交发货登记"}</button></div>{error && <p className="form-error" role="alert">{error}</p>}</section>;
    return <section className="action-panel quiet"><div className="action-copy"><Check size={22} /><div><h3>{order.status === "shipped" ? "已提交发货信息" : order.status === "received" ? "仓库已确认到货" : "采购单已完结"}</h3><p>{order.status === "shipped" ? "请等待仓库部确认收货。" : "当前节点无需供应商继续操作。"}</p></div></div></section>;
  }

  return <><div className="order-danger-zone">{deleteConfirming ? <div className="remove-confirm"><p><strong>确认作废采购单 {order.po_number}？</strong><span>作废后停止流转和催单，供应商不再看到本单。编号、产品、历史和附件保留，可在“作废留档”中查看；不能恢复流转或重复使用编号。</span></p><div><button type="button" className="text-button" disabled={busy} onClick={() => { setDeleteConfirming(false); setError(""); }}>取消</button><button type="button" className="danger-button" disabled={busy} onClick={() => void deleteOrder()}><Trash2 size={16} />{busy ? "正在作废" : "确认作废留档"}</button></div></div> : <button type="button" className="remove-order-button" disabled={busy} onClick={() => { setDeleteConfirming(true); setError(""); }}><Trash2 size={16} />作废采购单</button>}</div>{error && <p className="form-error" role="alert">{error}</p>}</>;
}

function SupplierDirectory({ suppliers, query, onQuery, onOpen }: { suppliers: Supplier[]; query: string; onQuery: (value: string) => void; onOpen: (id: string) => void }) {
  const [search, setSearch] = useState(query);
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const needle = search.toLowerCase().trim();
  const standardSuppliers = suppliers.filter((supplier) => supplier.is_online_purchase !== 1);
  const list = standardSuppliers.filter((supplier) => `${supplier.code} ${supplier.name} ${supplier.region} ${supplier.contact_name} ${supplier.contact_info} ${supplier.products.map(product => `${product.product_type} ${product.product_name}`).join(" ")} ${supplier.login_email || ""} ${supplier.purchaser_name}`.toLowerCase().includes(needle)).sort((left, right) => sort === "newest" ? right.created_at.localeCompare(left.created_at) : left.created_at.localeCompare(right.created_at));
  return <div className="directory"><div className="directory-intro"><div><h2>供应商总表</h2><p>共 {standardSuppliers.length} 家供应商。输入关键词筛选，点击供应商进入详情页。</p></div></div>
    <div className="supplier-filter-bar"><label className="supplier-search"><span>筛选</span><div><Search size={16} /><input aria-label="筛选供应商" value={search} onChange={event => { setSearch(event.target.value); onQuery(event.target.value); }} placeholder="搜索供应商、联系人、产品或负责人" /></div></label><label><span>排列方式</span><select value={sort} onChange={event => setSort(event.target.value as "newest" | "oldest")}><option value="newest">最新添加</option><option value="oldest">最早添加</option></select></label><small>当前显示 {list.length} 家</small></div>
    <div className="supplier-table" role="region" aria-label="供应商总表"><div className="supplier-head"><span>供应商 / 编号</span><span>联系人 / 联系方式</span><span>供应产品</span><span>登录邮箱 / 采购负责人</span></div>
      {list.map((supplier) => <button type="button" className="supplier-line" key={supplier.id} onClick={() => onOpen(supplier.id)} aria-label={`查看供应商 ${supplier.code}，${supplier.name}`}><span><strong>{supplier.name}</strong><small>{supplier.code}</small></span><span><strong>{supplier.contact_name || "待补充"}</strong><small>{supplier.contact_info || supplier.region || "待补充"}</small></span><span><strong>{supplier.products.length} 项</strong><small>{[...new Set(supplier.products.map((product) => product.product_type))].join("、") || "尚未建立产品目录"}</small></span><span><strong>{supplier.login_email || "未开通"}</strong><small>{supplier.purchaser_name || "待分配"}</small></span><ArrowRight size={17} /></button>)}
      {!list.length && <div className="table-empty">{standardSuppliers.length ? "没有找到供应商，请调整搜索条件" : "暂无供应商，点击右上方新建供应商"}</div>}
    </div></div>;
}

function SupplierDetail({ readOnly = false, supplier, hasOrders, onBack, onEdit, onRemoved, onTermsSaved }: { readOnly?: boolean; supplier?: Supplier; hasOrders: boolean; onBack: () => void; onEdit: () => void; onRemoved: (name: string) => Promise<void>; onTermsSaved: () => void }) {
  const [confirmingId, setConfirmingId] = useState("");
  const [busyId, setBusyId] = useState("");
  const [removeError, setRemoveError] = useState("");
  async function remove(supplier: Supplier) {
    setBusyId(supplier.id); setRemoveError("");
    try {
      await api(`/api/suppliers/${supplier.id}`, { method: "DELETE" });
      setConfirmingId("");
      await onRemoved(supplier.name);
    } catch (caught) { setRemoveError(caught instanceof Error ? caught.message : "移除供应商失败"); }
    finally { setBusyId(""); }
  }
  if (!supplier) return <div className="directory"><button className="back-button" onClick={onBack}><ArrowLeft size={17} />返回供应商总表</button><p className="table-empty">该供应商已不可用，请返回总表。</p></div>;
  return <div className="directory supplier-detail-page"><button className="back-button" onClick={onBack}><ArrowLeft size={17} />返回供应商总表</button><div className="directory-intro"><div><h2>{supplier.name}</h2><p>{supplier.code} · 供应商编号固定，资料修改不影响历史订单执行条件。</p></div>{!readOnly && <button type="button" className="primary" onClick={onEdit}><Pencil size={16} />编辑资料与登录账号</button>}</div><section className="supplier-detail-content" aria-label="供应商详情"><div className="supplier-facts"><span><small>联系人</small><strong>{supplier.contact_name || "待补充"}</strong></span><span><small>联系方式</small><strong>{supplier.contact_info || "待补充"}</strong></span><span><small>登录邮箱</small><strong>{supplier.login_email || "未开通"}</strong></span><span><small>地区</small><strong>{supplier.region || "待补充"}</strong></span><span><small>采购负责人</small><strong>{supplier.purchaser_name || "待分配"}</strong></span><span><small>备注</small><strong>{supplier.notes || "—"}</strong></span>{supplier.payment_account && <span className="supplier-payment"><small>收款 / 开票资料</small><pre>{supplier.payment_account}</pre></span>}</div><div className="supplier-product-list"><h3>类型 / 产品</h3>{supplier.products.map((product) => <div className="supplier-product-name" key={product.id}><span>{product.product_type}</span><strong>{product.product_name}</strong></div>)}{!supplier.products.length && <div className="catalog-empty">尚未建立供应产品目录</div>}</div><fieldset disabled={readOnly} className={readOnly ? "office-readonly" : undefined}><SupplierTermsEditor supplier={supplier} onSaved={onTermsSaved} /></fieldset><div className="supplier-danger-zone" hidden={readOnly}>{hasOrders ? <p className="protected-supplier"><Trash2 size={16} /><span><strong>已有采购单，不能移除</strong><small>为保证历史订单、发货和附件记录完整，系统会保留该供应商档案。</small></span></p> : confirmingId === supplier.id ? <div className="remove-confirm"><p><strong>确认移除“{supplier.name}”？</strong><span>供应商将从日常列表移除，登录账号停用；档案、目录和编号仍保留，编号不会重复使用。</span></p><div><button type="button" className="text-button" disabled={busyId === supplier.id} onClick={() => { setConfirmingId(""); setRemoveError(""); }}>取消</button><button type="button" className="danger-button" disabled={busyId === supplier.id} onClick={() => void remove(supplier)}><Trash2 size={16} />{busyId === supplier.id ? "正在移除" : "确认移除"}</button></div></div> : <button type="button" className="remove-supplier-button" onClick={() => { setConfirmingId(supplier.id); setRemoveError(""); }}><Trash2 size={16} />移除供应商</button>}{confirmingId === supplier.id && removeError && <p className="form-error" role="alert">{removeError}</p>}</div></section></div>;
}

type CatalogDraft = {
  productType: ProductType | ""; productName: string; usualSpecification: string; unit: string; defaultUnitPrice: number | null;
  productionCycle: string; transportMethod: string; arrivalTime: string; settlementMethod: string; specialInvoiceTax: string;
  ordinaryInvoiceTax: string; orderRequiredMaterials: string; notes: string;
};
const emptyCatalogProduct = (): CatalogDraft => ({ productType: "", productName: "", usualSpecification: "", unit: "", defaultUnitPrice: null, productionCycle: "", transportMethod: "", arrivalTime: "", settlementMethod: "", specialInvoiceTax: "", ordinaryInvoiceTax: "", orderRequiredMaterials: "", notes: "" });
const supplierCatalogDraft = (product: SupplierProduct): CatalogDraft => ({
  productType: product.product_type,
  productName: product.product_name,
  usualSpecification: product.usual_specification || "",
  unit: product.unit || "",
  defaultUnitPrice: product.default_unit_price,
  productionCycle: product.production_cycle || "",
  transportMethod: product.transport_method || "",
  arrivalTime: product.arrival_time || "",
  settlementMethod: product.settlement_method || "",
  specialInvoiceTax: product.special_invoice_tax || "",
  ordinaryInvoiceTax: product.ordinary_invoice_tax || "",
  orderRequiredMaterials: product.order_required_materials || "",
  notes: product.notes || "",
});

function NewSupplier({ user, supplier, onCancel, onDone }: { user: User; supplier?: Supplier; onCancel: () => void; onDone: () => void }) {
  const isEditing = Boolean(supplier);
  const [form, setForm] = useState({ name: supplier?.name || "", contactName: supplier?.contact_name || "", contactInfo: supplier?.contact_info || "", purchaserName: supplier?.purchaser_name || user.name, region: supplier?.region || "", paymentAccount: supplier?.payment_account || "", notes: supplier?.notes || "", email: supplier?.login_email || "", password: "" });
  const [products, setProducts] = useState<CatalogDraft[]>(supplier?.products.length ? supplier.products.map(supplierCatalogDraft) : [emptyCatalogProduct()]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const initialDraft = useRef(JSON.stringify({ form, products }));
  useUnsavedChanges(!busy && JSON.stringify({ form, products }) !== initialDraft.current);
  const change = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const updateProduct = (index: number, patch: Partial<CatalogDraft>) => setProducts((current) => current.map((product, productIndex) => productIndex === index ? { ...product, ...patch } : product));
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { await api(isEditing ? `/api/suppliers/${supplier!.id}` : "/api/suppliers", { method: isEditing ? "PATCH" : "POST", body: JSON.stringify({ ...form, products }) }); onDone(); } catch (caught) { setError(caught instanceof Error ? caught.message : isEditing ? "保存失败，请检查标记字段。" : "创建失败，请检查标记字段。"); focusFirstFormError(); } finally { setBusy(false); } }
  return <FormPage title={isEditing ? "编辑供应商" : "新建供应商"} description={isEditing ? `${supplier!.code} · 供应商编号不可修改，订单历史会继续关联此档案。` : "编号沿用 SP-xxxx 规则，并从当前最大编号自动顺延。"} onCancel={onCancel}><form className="entity-form" onSubmit={submit}><div className="form-grid three"><label>供应商名称<input value={form.name} onChange={(e) => change("name", e.target.value)} placeholder="公司全称" required /></label><label>联系人<input value={form.contactName} onChange={(e) => change("contactName", e.target.value)} placeholder="姓名" required /></label><label>联系方式<input value={form.contactInfo} onChange={(e) => change("contactInfo", e.target.value)} placeholder="电话 / 微信" required /></label><label>地区<input value={form.region} onChange={(e) => change("region", e.target.value)} placeholder="省市" /></label><label>对应采购负责人<input value={form.purchaserName} onChange={(e) => change("purchaserName", e.target.value)} required /></label><label>备注<input value={form.notes} onChange={(e) => change("notes", e.target.value)} placeholder="开票限制等" /></label></div><label className="full-textarea">收款 / 开票资料<textarea value={form.paymentAccount} onChange={(e) => change("paymentAccount", e.target.value)} placeholder="公司抬头、开户行、账号、税号等" /></label><div className="form-divider"><span>供应产品目录</span><button type="button" className="inline-add" onClick={() => setProducts((current) => [...current, emptyCatalogProduct()])}><Plus size={15} />添加产品</button></div><p className="form-help">建立目录后，新建采购单选择这家供应商时，只显示对应的产品类型和产品。</p><div className="catalog-editor">{products.map((product, index) => <div className="catalog-edit-row" key={index}><div className="catalog-edit-main"><label>产品类型<select value={product.productType} onChange={(event) => updateProduct(index, { productType: event.target.value as ProductType })}><option value="">请选择</option>{PRODUCT_TYPES.map((type) => <option key={type}>{type}</option>)}</select></label><label>产品名称<input value={product.productName} onChange={(event) => updateProduct(index, { productName: event.target.value })} placeholder="供应产品" /></label><label>常规规格<input value={product.usualSpecification} onChange={(event) => updateProduct(index, { usualSpecification: event.target.value })} /></label><label>单位<input value={product.unit} onChange={(event) => updateProduct(index, { unit: event.target.value })} placeholder="件 / 平方" /></label><label>参考单价<input type="number" min="0" step="0.01" value={product.defaultUnitPrice ?? ""} onChange={(event) => updateProduct(index, { defaultUnitPrice: event.target.value === "" ? null : Number(event.target.value) })} /></label></div><details className="catalog-conditions"><summary>补充制作、运输、结款和税点</summary><div className="form-grid four"><label>制作周期<input value={product.productionCycle} onChange={(event) => updateProduct(index, { productionCycle: event.target.value })} /></label><label>运输方式<input value={product.transportMethod} onChange={(event) => updateProduct(index, { transportMethod: event.target.value })} /></label><label>到货时间<input value={product.arrivalTime} onChange={(event) => updateProduct(index, { arrivalTime: event.target.value })} /></label><label>结款方式<input value={product.settlementMethod} onChange={(event) => updateProduct(index, { settlementMethod: event.target.value })} /></label><label>专票税点<input value={product.specialInvoiceTax} onChange={(event) => updateProduct(index, { specialInvoiceTax: event.target.value })} placeholder="例如 8%" /></label><label>普票税点<input value={product.ordinaryInvoiceTax} onChange={(event) => updateProduct(index, { ordinaryInvoiceTax: event.target.value })} /></label><label>下单所需资料<input value={product.orderRequiredMaterials} onChange={(event) => updateProduct(index, { orderRequiredMaterials: event.target.value })} /></label><label>产品备注<input value={product.notes} onChange={(event) => updateProduct(index, { notes: event.target.value })} /></label></div></details>{products.length > 1 && <button type="button" className="remove-catalog" onClick={() => setProducts((current) => current.filter((_, productIndex) => productIndex !== index))}><X size={15} />删除</button>}</div>)}</div><div className="form-divider"><span>供应商登录账号</span></div><div className="form-grid"><label>登录邮箱（可选）<input type="email" value={form.email} onChange={(e) => change("email", e.target.value)} placeholder="留空则暂不开通登录账号" required={Boolean(supplier?.login_email)} /></label><label>{isEditing ? supplier?.login_email ? "重置密码（可选）" : "创建初始密码" : "初始密码"}<input type="password" value={form.password} onChange={(e) => change("password", e.target.value)} minLength={10} placeholder={isEditing && supplier?.login_email ? "留空则保持原密码" : "至少 10 位"} required={Boolean(form.email.trim()) && !supplier?.login_email} /><small>{isEditing && supplier?.login_email ? "填写新密码后，供应商原登录会退出并改用新密码。" : "暂不开通登录账号时，邮箱和密码均可留空；开通时请同时填写。"}</small></label></div>{error && <p className="form-error" role="alert">{error}</p>}<div className="form-actions"><button type="button" className="text-button" onClick={onCancel}>取消</button><button className="primary" disabled={busy}><Building2 size={17} />{busy ? (isEditing ? "正在保存" : "正在创建") : (isEditing ? "保存修改" : "创建供应商")}</button></div></form></FormPage>;
}

type DraftItem = { model: string; productName: string; color: string; productType: ProductType | ""; quantity: number; unit: string; unitPrice: number; specification: string; materialProcess: string; installationMethod: string; packagingVolume: string; image: File | null; images?: File[] };
const emptyItem = (): DraftItem => ({ model: "", productName: "", color: "", productType: "", quantity: 1, unit: "", unitPrice: 0, specification: "", materialProcess: "", installationMethod: "", packagingVolume: "", image: null });

function NewOrder({ suppliers, user, onCancel, onDone }: { suppliers: Supplier[]; user: User; onCancel: () => void; onDone: (id: string, message?: string) => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({ supplierId: "", projectName: "", orderDate: today, requiredShipDate: "", purchaserName: user.name, internalRequirements: "" });
  const [items, setItems] = useState<DraftItem[]>([emptyItem()]);
  const [attachment, setAttachment] = useState<File[]>([]);
  const [importBusy, setImportBusy] = useState(false);
  const [importSummary, setImportSummary] = useState<{ supplierName: string; itemCount: number; imageCount: number; warnings: string[] } | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const change = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const updateItem = (index: number, patch: Partial<DraftItem>) => setItems((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  const selectedSupplier = suppliers.find((supplier) => supplier.id === form.supplierId);
  const onlinePurchase = selectedSupplier?.is_online_purchase === 1;
  const [commercialTerms, setCommercialTerms] = useState(emptyTerms);
  const [commercialConfirmed, setCommercialConfirmed] = useState(false);
  const initialDraft = useRef(JSON.stringify({ form, items, attachment: [], commercialTerms, commercialConfirmed }));
  useUnsavedChanges(!busy && JSON.stringify({ form, items, attachment: attachment.map(file => file.name), commercialTerms, commercialConfirmed }) !== initialDraft.current);
  useEffect(() => { setCommercialTerms(selectedSupplier?.commercial_terms ? { ...selectedSupplier.commercial_terms } : emptyTerms()); setCommercialConfirmed(false); }, [selectedSupplier?.id, selectedSupplier?.commercial_revision]);
  const supplierCatalog = selectedSupplier?.products || [];
  const availableTypes = PRODUCT_TYPES;
  const productsForType = (type: ProductType | "") => {
    if (!type) return [];
    return supplierCatalog.length ? supplierCatalog.filter((product) => product.product_type === type) : PRODUCT_OPTIONS[type].map((productName) => ({ id: productName, product_name: productName } as SupplierProduct));
  };
  const selectProduct = (index: number, productName: string) => {
    const catalogProduct = supplierCatalog.find((product) => product.product_name === productName && product.product_type === items[index].productType);
    updateItem(index, { productName, ...(catalogProduct ? { specification: catalogProduct.usual_specification, unit: catalogProduct.unit, unitPrice: catalogProduct.default_unit_price ?? 0 } : {}) });
  };
  async function handlePurchaseOrderFile(file: File | null) {
    if (!file) { setAttachment([]); setImportSummary(null); return; }
    setImportBusy(true); setError(""); setAttachment([file]); setImportSummary(null);
    try {
      const { importPurchaseOrder } = await import("./purchaseOrderImport");
      const imported = await importPurchaseOrder(file, suppliers);
      setForm((current) => ({ ...current, supplierId: imported.supplierId, projectName: imported.projectName, orderDate: imported.orderDate || today, requiredShipDate: imported.requiredShipDate }));
      setItems(imported.items.length ? imported.items : [emptyItem()]);
      setImportSummary({ supplierName: imported.supplierName, itemCount: imported.items.length, imageCount: imported.imageCount, warnings: imported.warnings });
    } catch (caught) {
      setAttachment([]);
      setError(caught instanceof Error ? caught.message : "采购单识别失败，请检查文件格式");
    } finally { setImportBusy(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (items.some((item) => !Number.isInteger(Number(item.quantity)) || Number(item.quantity) < 1)) { setError("每项产品数量必须是大于等于 1 的整数，请修正后再创建。"); focusFirstFormError(); return; }
    setBusy(true); setError("");
    try {
      const result = await api<{ orderId: string; itemIds: string[] }>("/api/orders", { method: "POST", body: JSON.stringify({ ...form, commercialTerms, commercialConfirmed, supplierTermsRevision: selectedSupplier?.commercial_revision || 0, items: items.map(({ image: _image, images: _images, ...item }) => item) }) });
      const uploads: Array<() => Promise<unknown>> = [];
      attachment.forEach(file => uploads.push(() => uploadFile(result.orderId, "purchase_order", file)));
      items.forEach((item, index) => { (item.images ?? (item.image ? [item.image] : [])).forEach(file => uploads.push(() => uploadFile(result.orderId, "product_image", file, result.itemIds[index]))); });
      let failedUploads = 0;
      for (let start = 0; start < uploads.length; start += 4) {
        const uploadResults = await Promise.allSettled(uploads.slice(start, start + 4).map((upload) => upload()));
        failedUploads += uploadResults.filter((uploadResult) => uploadResult.status === "rejected").length;
      }
      onDone(result.orderId, failedUploads ? `采购单已创建，${failedUploads} 个附件上传失败，请在订单内补充上传` : undefined);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "创建失败，请检查标记字段后重试。"); focusFirstFormError(); }
    finally { setBusy(false); }
  }
  if (!suppliers.length) return <FormPage title="新建采购单" description="请先建立供应商资料。" onCancel={onCancel}><div className="needs-supplier"><Building2 size={28} /><h3>还没有供应商</h3><p>返回供应商资料，先创建供应商及其登录账号。</p></div></FormPage>;
  return <FormPage title="新建采购单" description={onlinePurchase ? "网上采购由采购直接登记发货，之后由采购或仓库收货、入库。" : "订单创建后状态为“待供应商确认”。"} onCancel={onCancel}>
    <form className="entity-form order-form" onSubmit={submit}>
      <section className="order-importer" aria-busy={importBusy}><div className="importer-copy"><FileText size={21} /><div><h3>从 Excel 采购单自动填写</h3><p>识别供应商、项目、日期、产品、数量、单价、规格和表内产品图片；识别后请核对再创建。</p></div></div><FilePicker label={importBusy ? "正在识别采购单" : "选择 Excel 采购单"} file={importSummary ? attachment[0] || null : null} onFile={(file) => void handlePurchaseOrderFile(file)} accept=".xlsx,.xls" disabled={importBusy} />{importSummary && <div className="import-summary" role="status"><p><Check size={16} /><span><strong>已识别 {importSummary.itemCount} 项产品</strong><small>{importSummary.supplierName ? `已匹配供应商：${importSummary.supplierName}` : "供应商需要手动确认"} · 产品图片 {importSummary.imageCount} 张</small></span></p>{importSummary.warnings.length > 0 && <ul>{importSummary.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}</div>}</section>
      {importSummary?.warnings.includes("采购单中没有识别到有效的产品明细") && <p className="import-unrecognized-warning" role="alert">采购单中没有识别到有效的产品明细</p>}
      <div className="form-grid three">
        <label>PO 编号<input className="identity-readonly" value={form.projectName ? `${form.projectName}-自动顺序号` : "选择项目后自动生成"} readOnly aria-readonly="true" /><small>同一项目按 001、002、003 自动顺延。</small></label>
        <label>采购来源<select value={form.supplierId} onChange={(e) => change("supplierId", e.target.value)} required><option value="">请选择采购来源</option>{suppliers.filter((supplier) => supplier.is_online_purchase === 1).map((supplier) => <option key={supplier.id} value={supplier.id}>网上采购（淘宝、京东及其他网商）</option>)}{suppliers.filter((supplier) => supplier.is_online_purchase !== 1).map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.code} · {supplier.name}</option>)}</select><small>{onlinePurchase ? "不关联供应商账号或生产流程，由采购直接登记发货。" : supplierCatalog.length ? `已关联 ${supplierCatalog.length} 项供应产品；产品类型仍可自由修改。` : form.supplierId ? "尚无专属目录，显示通用产品分类" : "导入采购单后可自动匹配"}</small></label>
        <label>项目名称<input value={form.projectName} onChange={(e) => change("projectName", e.target.value)} placeholder="项目或客户名称" required /></label>
        <label>下单日期<input type="date" value={form.orderDate} onInput={(e) => change("orderDate", e.currentTarget.value)} required /></label>
        <label>要求发货日期<input type="date" min={form.orderDate} value={form.requiredShipDate} onInput={(e) => change("requiredShipDate", e.currentTarget.value)} required /></label>
        <label>采购负责人<input value={user.name} readOnly aria-readonly="true" /><small>自动记录当前登录账号</small></label>
      </div>
      <section className="commercial-block"><h3>本单实际执行条件</h3><p className="form-help">选择供应商后自动带入已保存的默认条件；请针对本单核对。创建后保存独立副本，不受供应商后续修改影响。</p><TermsFields value={commercialTerms} onChange={(value) => { setCommercialTerms(value); setCommercialConfirmed(false); }} disabled={busy} /><label className="terms-check"><input type="checkbox" checked={commercialConfirmed} onChange={(event) => setCommercialConfirmed(event.target.checked)} />我已逐项核实本单条件及价格口径</label><p className="form-help">尚未核实可以先创建 PO，财务金额会标记“待核实”，不能登记付款或发票。</p></section>
      <label>内部要求<textarea value={form.internalRequirements} onChange={(e) => change("internalRequirements", e.target.value)} placeholder="包装、验收标准、随货文件等（仅采购端可见）" /></label>
      <FilePicker label="上传采购单附件" files={attachment} onFiles={setAttachment} disabled={busy} />
      <div className="form-divider"><span>采购产品明细</span><button type="button" className="inline-add" onClick={() => setItems((current) => [...current, emptyItem()])}><Plus size={15} />添加产品</button></div>
      <div className="draft-items">{items.map((item, index) =>
        <div className="draft-item" key={index}>
          <div className="draft-item-number">{String(index + 1).padStart(2, "0")}</div>
          <div className="draft-item-grid">
            <label>型号<input value={item.model} onChange={(e) => updateItem(index, { model: e.target.value })} placeholder="规格型号 / SKU" /></label>
            <label>产品类型<select value={item.productType} onChange={(e) => updateItem(index, { productType: e.target.value as ProductType })} required><option value="">请选择产品类型</option>{availableTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select><small>修改类型不会清空已导入信息。</small></label>
            <label>产品名称<select value={item.productName} onChange={(e) => selectProduct(index, e.target.value)} disabled={!item.productType} required><option value="">{item.productType ? "请选择产品" : "请先选择产品类型"}</option>{item.productName && !productsForType(item.productType).some((product) => product.product_name === item.productName) && <option value={item.productName}>{item.productName}（采购单识别）</option>}{productsForType(item.productType).map((product) => <option key={product.id} value={product.product_name}>{product.product_name}</option>)}</select></label>
            <label>颜色<input value={item.color} onChange={(e) => updateItem(index, { color: e.target.value })} placeholder="颜色 / 色号" /></label>
            <label>数量<input type="number" min="1" step="1" inputMode="numeric" value={item.quantity} onChange={(e) => updateItem(index, { quantity: Number(e.target.value) })} required /></label>
            <label>单位<input value={item.unit} onChange={(e) => updateItem(index, { unit: e.target.value })} placeholder="件 / 平方" /></label>
            <label>单价<input type="number" min="0" step="0.01" value={item.unitPrice} onChange={(e) => updateItem(index, { unitPrice: Number(e.target.value) })} required /></label>
            <label>金额<input value={`¥ ${money.format(item.quantity * item.unitPrice)}`} disabled /></label>
            <label>包装体积<input value={item.packagingVolume} onChange={(e) => updateItem(index, { packagingVolume: e.target.value })} placeholder="如 0.5 m³" maxLength={100} /></label>
            <div className="product-requirements form-grid">
              <label>材料/工艺/配置<textarea rows={2} maxLength={4000} value={item.materialProcess} onChange={(e) => updateItem(index, { materialProcess: e.target.value })} placeholder="填写材料、制作工艺或配置要求" /></label>
              <label>安装方式<textarea rows={2} maxLength={4000} value={item.installationMethod} onChange={(e) => updateItem(index, { installationMethod: e.target.value })} placeholder="填写安装方式或安装要求" /></label>
            </div>
            <label className="wide-field">规格 / 备注<textarea rows={1} className={`specification-box${item.specification ? " has-content" : ""}`} value={item.specification} onChange={(e) => updateItem(index, { specification: e.target.value })} placeholder="填写其他规格或备注" /></label>
            <FilePicker label="上传产品图片" files={item.images ?? (item.image ? [item.image] : [])} onFiles={(files) => updateItem(index, { image: null, images: files })} accept="image/jpeg,image/png,image/webp" disabled={busy} />
          </div>
          {items.length > 1 && <button type="button" className="remove-item" onClick={() => setItems((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={`删除第 ${index + 1} 项`}><X size={17} /></button>}
        </div>
      )}</div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions"><button type="button" className="text-button" onClick={onCancel}>取消</button><button className="primary" disabled={busy}><FileText size={17} />{busy ? "正在创建" : "创建采购单"}</button></div>
    </form>
  </FormPage>;
}

function FormPage({ title, description, onCancel, children }: { title: string; description: string; onCancel: () => void; children: React.ReactNode }) {
  return <div className="form-page"><button className="back-button" onClick={onCancel}><ArrowLeft size={17} />返回</button><div className="form-page-heading"><h2>{title}</h2><p>{description}</p></div>{children}</div>;
}

function EmptyOrders({ query }: { query: string }) { return <div className="empty-state"><LayoutList size={28} /><strong>{query ? "没有找到匹配订单" : "这里还没有采购单"}</strong><p>{query ? "请更换关键词或筛选条件。" : "采购创建订单后会显示在这里。"}</p></div>; }

export default App;
