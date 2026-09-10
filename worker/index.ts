interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  SETUP_SECRET: string;
}

type Role = "purchaser" | "supplier" | "finance" | "boss" | "admin" | "management" | "engineering" | "warehouse" | "office";
const canPurchase = (role: Role) => role === "purchaser" || role === "boss" || role === "admin" || role === "management";
type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  supplier_id: string | null;
  supplier_operations: number;
  finance_settlement: number;
};
const canOperateSupplier = (user: SessionUser) => user.role === "supplier" || user.role === "admin" || user.role === "management" || user.supplier_operations === 1;
const canFinance = (user: SessionUser) => user.role === "finance" || user.role === "boss" || user.role === "admin" || user.role === "management" || user.finance_settlement === 1;

const SESSION_COOKIE = "procure_session";
const SESSION_SECONDS = 60 * 60 * 24 * 7;
const PASSWORD_ITERATIONS = 100_000;
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 5;
const PRODUCT_TYPES = new Set(["配件类", "电气类", "安全防护类", "成品设备类", "定制加工类"]);

const json = (data: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(data, { status, headers });

const error = (message: string, status = 400) => json({ error: message }, status);
const now = () => new Date().toISOString();
const businessToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date());
const id = () => crypto.randomUUID();

function bytesToHex(bytes: ArrayBuffer | Uint8Array) {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string) {
  const output = new Uint8Array(value.length / 2);
  for (let index = 0; index < output.length; index += 1) output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return output;
}

async function sha256(value: string) {
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function derivePassword(password: string, salt: Uint8Array) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt.buffer as ArrayBuffer, iterations: PASSWORD_ITERATIONS, hash: "SHA-256" },
    material,
    256,
  );
}

async function makePassword(password: string) {
  if (password.length < 10) throw new Error("密码至少需要 10 位");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { hash: bytesToHex(await derivePassword(password, salt)), salt: bytesToHex(salt) };
}

async function passwordMatches(password: string, expected: string, salt: string) {
  const actual = new Uint8Array(await derivePassword(password, hexToBytes(salt)));
  const target = hexToBytes(expected);
  if (actual.length !== target.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) difference |= actual[index] ^ target[index];
  return difference === 0;
}

function getCookie(request: Request, name: string) {
  const cookie = request.headers.get("Cookie") || "";
  const part = cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : "";
}

async function getSession(request: Request, env: Env): Promise<SessionUser | null> {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, COALESCE(sr.role, u.role) AS role, u.supplier_id, COALESCE(sp.supplier_operations,0) AS supplier_operations, COALESCE(sp.finance_settlement,0) AS finance_settlement, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN staff_roles sr ON sr.user_id = u.id LEFT JOIN staff_permissions sp ON sp.user_id = u.id
     WHERE s.token_hash = ?1 AND u.status = 'active'`,
  ).bind(await sha256(token)).first<SessionUser & { expires_at: string }>();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?1").bind(await sha256(token)).run();
    return null;
  }
  return row;
}

async function authAttemptKey(request: Request, scope: string) {
  const address = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || "local";
  return sha256(`${scope}:${address}`);
}

async function assertAuthAllowed(env: Env, key: string) {
  const attempt = await env.DB.prepare("SELECT locked_until FROM auth_attempts WHERE key = ?1").bind(key).first<{ locked_until: string | null }>();
  if (attempt?.locked_until && new Date(attempt.locked_until).getTime() > Date.now()) {
    throw new Response(JSON.stringify({ error: "尝试次数过多，请 15 分钟后再试" }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "900" } });
  }
}

async function recordAuthFailure(env: Env, key: string) {
  const timestamp = now();
  const existing = await env.DB.prepare("SELECT attempt_count, window_started_at FROM auth_attempts WHERE key = ?1").bind(key).first<{ attempt_count: number; window_started_at: string }>();
  const inWindow = existing && Date.now() - new Date(existing.window_started_at).getTime() < AUTH_WINDOW_MS;
  const count = inWindow ? existing.attempt_count + 1 : 1;
  const windowStartedAt = inWindow ? existing.window_started_at : timestamp;
  const lockedUntil = count >= AUTH_MAX_ATTEMPTS ? new Date(Date.now() + AUTH_WINDOW_MS).toISOString() : null;
  await env.DB.prepare(
    "INSERT INTO auth_attempts (key, attempt_count, window_started_at, locked_until, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(key) DO UPDATE SET attempt_count = excluded.attempt_count, window_started_at = excluded.window_started_at, locked_until = excluded.locked_until, updated_at = excluded.updated_at",
  ).bind(key, count, windowStartedAt, lockedUntil, timestamp).run();
}

async function clearAuthFailures(env: Env, key: string) {
  await env.DB.prepare("DELETE FROM auth_attempts WHERE key = ?1").bind(key).run();
}

async function requireSession(request: Request, env: Env, role?: Role) {
  const session = await getSession(request, env);
  if (!session) throw new Response(JSON.stringify({ error: "请先登录" }), { status: 401, headers: { "Content-Type": "application/json" } });
  if (role && session.role !== "admin" && session.role !== role && !(role === "purchaser" && canPurchase(session.role)) && !(role === "supplier" && canOperateSupplier(session)) && !(role === "finance" && canFinance(session))) throw new Response(JSON.stringify({ error: "没有权限执行此操作" }), { status: 403, headers: { "Content-Type": "application/json" } });
  return session;
}

async function readBody<T>(request: Request): Promise<T> {
  try {
    return await request.json<T>();
  } catch {
    throw new Response(JSON.stringify({ error: "提交内容格式不正确" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
}

async function canAccessOrder(env: Env, user: SessionUser, orderId: string) {
  const row = await env.DB.prepare("SELECT supplier_id FROM purchase_orders WHERE id = ?1 AND archived_at IS NULL").bind(orderId).first<{ supplier_id: string }>();
  return Boolean(row && (canPurchase(user.role) || (user.role === "supplier" && row.supplier_id === user.supplier_id)));
}

async function recordEvent(env: Env, orderId: string, eventType: string, detail: string, actor: SessionUser) {
  await env.DB.prepare(
    "INSERT INTO order_events (id, order_id, event_type, detail, actor_id, actor_name, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  ).bind(id(), orderId, eventType, detail, actor.id, actor.name, now()).run();
}

async function login(request: Request, env: Env) {
  const body = await readBody<{ email?: string; password?: string }>(request);
  const email = body.email?.trim().toLowerCase() || "";
  const attemptKey = await authAttemptKey(request, `login:${email}`);
  await assertAuthAllowed(env, attemptKey);
  const row = await env.DB.prepare(
    "SELECT u.id, u.email, u.name, COALESCE(sr.role, u.role) AS role, u.supplier_id, COALESCE(sp.supplier_operations,0) AS supplier_operations, COALESCE(sp.finance_settlement,0) AS finance_settlement, u.password_hash, u.password_salt, u.status FROM users u LEFT JOIN staff_roles sr ON sr.user_id = u.id LEFT JOIN staff_permissions sp ON sp.user_id = u.id WHERE u.email = ?1",
  ).bind(email).first<SessionUser & { password_hash: string; password_salt: string; status: string }>();
  if (!row || row.status !== "active" || !body.password || !(await passwordMatches(body.password, row.password_hash, row.password_salt))) {
    await recordAuthFailure(env, attemptKey);
    return error("账号或密码不正确", 401);
  }
  await clearAuthFailures(env, attemptKey);
  const token = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const timestamp = now();
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?1").bind(timestamp),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)").bind(await sha256(token), row.id, expiresAt, timestamp),
  ]);
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return json(
    { user: { id: row.id, email: row.email, name: row.name, role: row.role, supplier_id: row.supplier_id, supplier_operations: row.supplier_operations, finance_settlement: row.finance_settlement } },
    200,
    { "Set-Cookie": `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${SESSION_SECONDS}` },
  );
}

async function createInitialAdmin(request: Request, env: Env) {
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>();
  if (Number(count?.count || 0) > 0) return error("系统已完成初始化", 409);
  const body = await readBody<{ name?: string; email?: string; password?: string; setupCode?: string }>(request);
  const attemptKey = await authAttemptKey(request, "setup");
  await assertAuthAllowed(env, attemptKey);
  if (!env.SETUP_SECRET || body.setupCode !== env.SETUP_SECRET) {
    await recordAuthFailure(env, attemptKey);
    return error("初始化安全码不正确", 403);
  }
  if (!body.name?.trim() || !body.email?.trim() || !body.password) return error("请完整填写管理员资料");
  const record = await makePassword(body.password);
  const userId = id();
  const timestamp = now();
  const email = body.email.trim().toLowerCase();
  const token = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();
  await clearAuthFailures(env, attemptKey);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, email, name, role, supplier_id, password_hash, password_salt, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'purchaser', NULL, ?4, ?5, 'active', ?6, ?6)")
      .bind(userId, email, body.name.trim(), record.hash, record.salt, timestamp),
    env.DB.prepare("INSERT INTO staff_roles(user_id, role) VALUES (?1, 'boss')").bind(userId),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)")
      .bind(await sha256(token), userId, expiresAt, timestamp),
  ]);
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return json(
    { user: { id: userId, email, name: body.name.trim(), role: "boss", supplier_id: null } },
    201,
    { "Set-Cookie": `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${SESSION_SECONDS}` },
  );
}

async function logout(request: Request, env: Env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?1").bind(await sha256(token)).run();
  return json({ ok: true }, 200, { "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` });
}

async function changeOwnPassword(request: Request, env: Env) {
  const actor = await requireSession(request, env);
  const body = await readBody<{ currentPassword?: string; newPassword?: string; confirmPassword?: string }>(request);
  if (Object.keys(body).some((key) => !["currentPassword", "newPassword", "confirmPassword"].includes(key))) return error("只能修改当前账号的密码", 403);
  if (typeof body.currentPassword !== "string" || typeof body.newPassword !== "string" || body.currentPassword.length > 256 || body.newPassword.length < 10 || body.newPassword.length > 256) return error("请填写原密码，新密码需要 10–256 位");
  if (body.newPassword !== body.confirmPassword) return error("两次输入的新密码不一致");
  if (body.newPassword === body.currentPassword) return error("新密码不能与原密码相同");
  const attemptKey = await authAttemptKey(request, `change-password:${actor.id}`);
  await assertAuthAllowed(env, attemptKey);
  const row = await env.DB.prepare("SELECT password_hash, password_salt FROM users WHERE id = ?1 AND status = 'active'").bind(actor.id).first<{ password_hash: string; password_salt: string }>();
  if (!row || !(await passwordMatches(body.currentPassword, row.password_hash, row.password_salt))) {
    await recordAuthFailure(env, attemptKey);
    return error("原密码不正确", 400);
  }
  const password = await makePassword(body.newPassword);
  const [result] = await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_hash = ?1, password_salt = ?2, updated_at = ?3 WHERE id = ?4 AND password_hash = ?5 AND status = 'active'").bind(password.hash, password.salt, now(), actor.id, row.password_hash),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1 AND EXISTS (SELECT 1 FROM users WHERE id = ?1 AND password_hash = ?2)").bind(actor.id, password.hash),
  ]);
  if (!result.meta.changes) return error("账号信息已变化，请重新登录后再试", 409);
  await clearAuthFailures(env, attemptKey);
  return json({ ok: true }, 200, { "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure` });
}

async function dashboard(request: Request, env: Env) {
  const user = await requireSession(request, env);
  if (user.role === "finance") return error("财务账号请使用财务结算工作台", 403);
  await generateOrderReminders(env);
  const scope = user.role === "supplier" ? "WHERE po.supplier_id = ?1 AND po.archived_at IS NULL" : "";
  const internalRequirements = (canPurchase(user.role) || user.role === "office") ? "po.internal_requirements" : "'' AS internal_requirements";
  const statement = env.DB.prepare(
    `SELECT po.id, po.po_number, po.supplier_id, po.project_name, po.order_date, po.required_ship_date,
            po.promised_ship_date, po.estimated_ship_date, po.delivery_revision, po.archived_at,
            po.commercial_terms_json, po.commercial_status, po.commercial_revision,
            CASE WHEN po.shipment_status = 'partial' AND po.status = 'ready_to_ship' THEN 'partial_shipped' ELSE po.status END AS status,
            po.purchaser_name, ${internalRequirements},
            po.production_progress, po.production_note, po.carrier, po.tracking_number, po.shipped_at,
            po.created_at, po.updated_at,
            s.code AS supplier_code, s.name AS supplier_name, s.contact_name, s.contact_info, s.is_online_purchase
     FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id ${scope}
     ORDER BY po.updated_at DESC`,
  );
  const orders = (await (user.role === "supplier" ? statement.bind(user.supplier_id).all() : statement.all())).results as Array<Record<string, unknown>>;
  if (user.role === "engineering" || user.role === "warehouse") {
    // Explicit allowlist: never return prices, terms, free-text histories or source attachments.
    const visible = [];
    for (const order of orders) {
      const products = (await env.DB.prepare("SELECT id, order_id, model, product_name, color, product_type, material_process, installation_method, quantity, unit, workflow_stage, completion_date, shipped_quantity, acceptance_status, received_quantity, stocked_quantity, received_at, received_by, stocked_at, stocked_by, freight_payment_status, freight_payment_revision, packaging_volume, packaging_volume_revision, production_completed, production_completed_at, production_completed_by, production_revision FROM order_items WHERE order_id = ?1 ORDER BY created_at").bind(order.id).all()).results;
      for (const product of products) {
        product.warehouse_history = (await env.DB.prepare("SELECT action,quantity,actor_name,COALESCE(record_date,substr(created_at,1,10)) AS record_date,created_at FROM warehouse_records WHERE item_id=?1 ORDER BY created_at,id").bind(product.id).all()).results;
        product.acceptance_history = [];
        product.correction_history = [];
        if(user.role==='warehouse') {
          product.correction_history=(await env.DB.prepare("SELECT action,quantity,reason,actor_name,created_at FROM item_corrections WHERE item_id=?1 AND action IN ('received','stocked') ORDER BY created_at,id").bind(product.id).all()).results;
        }
      }
      const deliveries = (await env.DB.prepare("SELECT id, order_id, shipment_number, quantity, is_complete, carrier, tracking_number, box_count, shipped_at, created_at FROM shipment_records WHERE order_id = ?1 ORDER BY shipped_at").bind(order.id).all()).results;
      for (const delivery of deliveries) { delivery.attachments = []; delivery.items = []; }
      const photos = (await env.DB.prepare("SELECT id,order_id,item_id,kind,purpose,file_name,content_type,created_at FROM attachments WHERE order_id=?1 AND content_type LIKE 'image/%' AND kind IN ('product_image','production_photo','scene_image') AND deleted_at IS NULL ORDER BY created_at DESC").bind(order.id).all()).results;
      visible.push(Object.fromEntries([
        ...["id", "po_number", "supplier_id", "project_name", "supplier_code", "supplier_name", "contact_name", "contact_info", "is_online_purchase", "purchaser_name", "order_date", "required_ship_date", "promised_ship_date", "estimated_ship_date", "delivery_revision", "status", "archived_at", "production_progress", "production_note", "carrier", "tracking_number", "shipped_at", "created_at", "updated_at"].map((key) => [key, order[key]]),
        ["items", products], ["shipments", deliveries],
        ...(user.role === "warehouse" ? [["attachments", photos]] : []),
      ]));
    }
    return json({ user, orders: visible, suppliers: [] });
  }
  const visibleOrderIds = orders.map((order) => String(order.id));
  let items: Array<Record<string, unknown>> = [];
  let attachments: Array<Record<string, unknown>> = [];
  let events: Array<Record<string, unknown>> = [];
  let shipments: Array<Record<string, unknown>> = [];
  let shipmentAttachments: Array<Record<string, unknown>> = [];
  let reminders: Array<Record<string, unknown>> = [];
  let deliveryHistory: Array<Record<string, unknown>> = [];
  let commercialHistory: Array<Record<string, unknown>> = [];
  if (visibleOrderIds.length) {
    const placeholders = visibleOrderIds.map((_, index) => `?${index + 1}`).join(",");
    const [itemsResult, attachmentsResult, eventsResult, shipmentsResult, shipmentAttachmentsResult, remindersResult, deliveryHistoryResult, commercialHistoryResult] = await env.DB.batch([
      env.DB.prepare(`SELECT i.*, (SELECT json_group_array(json_object('id', a.id, 'decision', a.decision, 'reason', a.reason, 'actorName', a.actor_name, 'createdAt', a.created_at, 'revision', a.production_revision, 'photoIds', json(a.photo_ids))) FROM product_acceptances a WHERE a.item_id = i.id) AS acceptance_json FROM order_items i WHERE order_id IN (${placeholders}) ORDER BY created_at`).bind(...visibleOrderIds),
      env.DB.prepare(`SELECT id, order_id, item_id, kind, purpose, file_name, content_type, created_at FROM attachments WHERE deleted_at IS NULL AND order_id IN (${placeholders}) ORDER BY created_at DESC`).bind(...visibleOrderIds),
      env.DB.prepare(`SELECT id, order_id, event_type, detail, actor_name, created_at FROM order_events WHERE order_id IN (${placeholders}) ORDER BY created_at DESC`).bind(...visibleOrderIds),
      env.DB.prepare(`SELECT id, order_id, shipment_number, quantity, is_complete, carrier, tracking_number, box_count, shipped_at, created_at, (SELECT json_group_array(json_object('itemId', si.item_id, 'productName', i.product_name, 'quantity', si.quantity)) FROM shipment_items si JOIN order_items i ON i.id = si.item_id WHERE si.shipment_id = shipment_records.id) AS items_json FROM shipment_records WHERE order_id IN (${placeholders}) ORDER BY shipped_at, created_at`).bind(...visibleOrderIds),
      env.DB.prepare(`SELECT id, shipment_id, order_id, kind, file_name, content_type FROM shipment_attachments WHERE order_id IN (${placeholders}) ORDER BY created_at`).bind(...visibleOrderIds),
      env.DB.prepare(`SELECT id, order_id, reminder_type, message, target_date, created_at FROM order_reminders WHERE order_id IN (${placeholders}) ORDER BY created_at DESC`).bind(...visibleOrderIds),
      env.DB.prepare(`SELECT * FROM order_delivery_history WHERE order_id IN (${placeholders}) ORDER BY changed_at DESC, rowid DESC`).bind(...visibleOrderIds),
      env.DB.prepare(`SELECT * FROM commercial_history WHERE order_id IN (${placeholders}) ORDER BY created_at DESC, rowid DESC`).bind(...visibleOrderIds),
    ]);
    items = itemsResult.results as Array<Record<string, unknown>>;
    attachments = attachmentsResult.results as Array<Record<string, unknown>>;
    events = eventsResult.results as Array<Record<string, unknown>>;
    shipments = shipmentsResult.results as Array<Record<string, unknown>>;
    shipmentAttachments = shipmentAttachmentsResult.results as Array<Record<string, unknown>>;
    reminders = remindersResult.results as Array<Record<string, unknown>>;
    deliveryHistory = deliveryHistoryResult.results as Array<Record<string, unknown>>;
    commercialHistory = commercialHistoryResult.results as Array<Record<string, unknown>>;
  }
  for (const item of items) { item.warehouse_history = (await env.DB.prepare("SELECT action,quantity,actor_name,COALESCE(record_date,substr(created_at,1,10)) AS record_date,created_at FROM warehouse_records WHERE item_id=?1 ORDER BY created_at,id").bind(item.id).all()).results; item.acceptance_history = JSON.parse(String(item.acceptance_json || "[]")); delete item.acceptance_json; }
  for (const item of items) item.correction_history=(await env.DB.prepare('SELECT action,quantity,reason,actor_name,created_at FROM item_corrections WHERE item_id=?1 ORDER BY created_at,id').bind(item.id).all()).results;
  for (const shipment of shipments) { shipment.attachments = shipmentAttachments.filter((attachment) => attachment.shipment_id === shipment.id); shipment.items = JSON.parse(String(shipment.items_json || "[]")); delete shipment.items_json; }
  for (const order of orders) {
    order.items = items.filter((item) => item.order_id === order.id);
    order.attachments = attachments.filter((attachment) => attachment.order_id === order.id);
    order.events = events.filter((event) => event.order_id === order.id);
    order.shipments = shipments.filter((shipment) => shipment.order_id === order.id);
    order.reminders = reminders.filter((reminder) => reminder.order_id === order.id);
    order.delivery_history = deliveryHistory.filter((entry) => entry.order_id === order.id);
    order.commercial_history = commercialHistory.filter((entry) => entry.order_id === order.id);
    order.commercial_terms = order.commercial_terms_json ? JSON.parse(String(order.commercial_terms_json)) : null;
    delete order.commercial_terms_json;
  }
  const suppliers = canPurchase(user.role) || user.role === "office"
    ? (await env.DB.prepare("SELECT s.*, u.email AS login_email FROM suppliers s LEFT JOIN users u ON u.supplier_id = s.id WHERE s.archived_at IS NULL ORDER BY s.code").all()).results as Array<Record<string, unknown>>
    : [];
  if (suppliers.length) {
    const supplierProducts = (await env.DB.prepare("SELECT * FROM supplier_products ORDER BY product_type, product_name").all()).results as Array<Record<string, unknown>>;
    for (const supplier of suppliers) supplier.products = supplierProducts.filter((product) => product.supplier_id === supplier.id);
    const defaults = (await env.DB.prepare("SELECT * FROM supplier_commercial_terms").all()).results;
    for (const supplier of suppliers) {
      const terms = defaults.find((row) => row.supplier_id === supplier.id);
      supplier.commercial_terms = terms ? JSON.parse(String(terms.terms_json)) : null;
      supplier.commercial_revision = terms?.revision || 0;
    }
  }
  return json({ user, orders, suppliers });
}

type SupplierProductBody = {
  productType?: string;
  productName?: string;
  usualSpecification?: string;
  unit?: string;
  defaultUnitPrice?: number | null;
  productionCycle?: string;
  transportMethod?: string;
  arrivalTime?: string;
  settlementMethod?: string;
  specialInvoiceTax?: string;
  ordinaryInvoiceTax?: string;
  orderRequiredMaterials?: string;
  notes?: string;
};

type SupplierBody = {
  name?: string;
  contactName?: string;
  contactInfo?: string;
  purchaserName?: string;
  region?: string;
  paymentAccount?: string;
  notes?: string;
  email?: string;
  password?: string;
  products?: SupplierProductBody[];
};

function supplierProductsFrom(body: SupplierBody) {
  const products = (body.products || []).filter((product) => product.productName?.trim() || product.productType);
  for (const product of products) {
    if (!product.productName?.trim() || !product.productType || !PRODUCT_TYPES.has(product.productType)) throw new Error("请完整填写供应产品的类型和名称");
    if (product.defaultUnitPrice != null && (!Number.isFinite(product.defaultUnitPrice) || Number(product.defaultUnitPrice) < 0)) throw new Error("产品参考单价不能小于 0");
  }
  return products;
}

function supplierProductInsert(env: Env, supplierId: string, product: SupplierProductBody, timestamp: string) {
  return env.DB.prepare(
    `INSERT INTO supplier_products (id, supplier_id, product_type, product_name, usual_specification, unit, default_unit_price, production_cycle, transport_method, arrival_time, settlement_method, special_invoice_tax, ordinary_invoice_tax, order_required_materials, notes, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16)`,
  ).bind(id(), supplierId, product.productType, product.productName!.trim(), product.usualSpecification?.trim() || "", product.unit?.trim() || "", product.defaultUnitPrice == null ? null : Number(product.defaultUnitPrice), product.productionCycle?.trim() || "", product.transportMethod?.trim() || "", product.arrivalTime?.trim() || "", product.settlementMethod?.trim() || "", product.specialInvoiceTax?.trim() || "", product.ordinaryInvoiceTax?.trim() || "", product.orderRequiredMaterials?.trim() || "", product.notes?.trim() || "", timestamp);
}

async function createSupplier(request: Request, env: Env) {
  const actor = await requireSession(request, env, "purchaser");
  const body = await readBody<SupplierBody>(request);
  const required = [body.name, body.contactName, body.contactInfo, body.purchaserName];
  if (required.some((value) => !value?.trim())) return error("请完整填写供应商资料");
  const email = body.email?.trim().toLowerCase() || "";
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error("请填写有效的登录邮箱");
  if (!email && body.password) return error("开通登录账号时请同时填写邮箱和密码，暂不开通可全部留空");
  let products: SupplierProductBody[];
  try { products = supplierProductsFrom(body); } catch (caught) { return error(caught instanceof Error ? caught.message : "供应产品资料不正确"); }
  let password: { hash: string; salt: string } | null = null;
  try { if (email) password = await makePassword(body.password || ""); } catch (caught) { return error(caught instanceof Error ? caught.message : "请设置初始密码"); }
  const supplierId = id();
  const timestamp = now();
  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE supplier_number_sequence SET current_value = current_value + 1 WHERE name = 'supplier'"),
      env.DB.prepare(`INSERT INTO suppliers (id, code, name, contact_name, contact_info, purchaser_name, region, payment_account, notes, created_at, updated_at)
        SELECT ?1, printf('%s-%04d', prefix, current_value), ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9
        FROM supplier_number_sequence WHERE name = 'supplier'`)
        .bind(supplierId, body.name!.trim(), body.contactName!.trim(), body.contactInfo!.trim(), body.purchaserName!.trim(), body.region?.trim() || "", body.paymentAccount?.trim() || "", body.notes?.trim() || "", timestamp),
      ...(password ? [env.DB.prepare("INSERT INTO users (id, email, name, role, supplier_id, password_hash, password_salt, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'supplier', ?4, ?5, ?6, 'active', ?7, ?7)")
        .bind(id(), email, body.contactName!.trim(), supplierId, password.hash, password.salt, timestamp)] : []),
      ...products.map((product) => supplierProductInsert(env, supplierId, product, timestamp)),
    ]);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "";
    if (message.includes("UNIQUE")) return error("供应商编号或登录邮箱已存在", 409);
    throw caught;
  }
  const supplier = await env.DB.prepare("SELECT code FROM suppliers WHERE id = ?1").bind(supplierId).first<{ code: string }>();
  return json({ ok: true, supplierId, supplierCode: supplier?.code, createdBy: actor.name }, 201);
}

async function updateSupplier(request: Request, env: Env, supplierId: string) {
  await requireSession(request, env, "purchaser");
  const body = await readBody<SupplierBody>(request);
  const required = [body.name, body.contactName, body.contactInfo, body.purchaserName];
  if (required.some((value) => !value?.trim())) return error("请完整填写供应商资料");
  const supplier = await env.DB.prepare("SELECT id, code FROM suppliers WHERE id = ?1 AND archived_at IS NULL").bind(supplierId).first<{ id: string; code: string }>();
  if (!supplier) return error("供应商不存在", 404);
  const existingUser = await env.DB.prepare("SELECT id FROM users WHERE supplier_id = ?1").bind(supplierId).first<{ id: string }>();
  const email = body.email?.trim().toLowerCase() || "";
  if (existingUser && !email) return error("已有登录账号的邮箱不能清空");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error("请填写有效的登录邮箱");
  if (!existingUser && email && !body.password?.trim()) return error("开通账号请设置至少 10 位的初始密码");
  if (!email && body.password) return error("开通登录账号时请同时填写邮箱和密码");

  let products: SupplierProductBody[];
  try { products = supplierProductsFrom(body); } catch (caught) { return error(caught instanceof Error ? caught.message : "供应产品资料不正确"); }
  let password: { hash: string; salt: string } | null = null;
  try { if (body.password) password = await makePassword(body.password); } catch (caught) { return error(caught instanceof Error ? caught.message : "密码不正确"); }

  const timestamp = now();
  const statements = [
    env.DB.prepare(`UPDATE suppliers SET name = ?1, contact_name = ?2, contact_info = ?3, purchaser_name = ?4, region = ?5, payment_account = ?6, notes = ?7, updated_at = ?8 WHERE id = ?9`)
      .bind(body.name!.trim(), body.contactName!.trim(), body.contactInfo!.trim(), body.purchaserName!.trim(), body.region?.trim() || "", body.paymentAccount?.trim() || "", body.notes?.trim() || "", timestamp, supplierId),
    env.DB.prepare("DELETE FROM supplier_products WHERE supplier_id = ?1").bind(supplierId),
    ...products.map((product) => supplierProductInsert(env, supplierId, product, timestamp)),
  ];
  if (existingUser) {
    statements.push(password
      ? env.DB.prepare("UPDATE users SET email = ?1, name = ?2, password_hash = ?3, password_salt = ?4, status = 'active', updated_at = ?5 WHERE id = ?6").bind(body.email!.trim().toLowerCase(), body.contactName!.trim(), password.hash, password.salt, timestamp, existingUser.id)
      : env.DB.prepare("UPDATE users SET email = ?1, name = ?2, status = 'active', updated_at = ?3 WHERE id = ?4").bind(body.email!.trim().toLowerCase(), body.contactName!.trim(), timestamp, existingUser.id));
    if (password) statements.push(env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(existingUser.id));
  } else if (email && password) {
    statements.push(env.DB.prepare("INSERT INTO users (id, email, name, role, supplier_id, password_hash, password_salt, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'supplier', ?4, ?5, ?6, 'active', ?7, ?7)")
      .bind(id(), body.email!.trim().toLowerCase(), body.contactName!.trim(), supplierId, password!.hash, password!.salt, timestamp));
  }

  try {
    await env.DB.batch(statements);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "";
    if (message.includes("UNIQUE")) return error("该登录邮箱已被其他账号使用", 409);
    throw caught;
  }
  return json({ ok: true, supplierId, supplierCode: supplier.code });
}

async function removeSupplier(request: Request, env: Env, supplierId: string) {
  await requireSession(request, env, "purchaser");
  const supplier = await env.DB.prepare("SELECT id, name FROM suppliers WHERE id = ?1").bind(supplierId).first<{ id: string; name: string }>();
  if (!supplier) return error("供应商不存在", 404);
  const orders = await env.DB.prepare("SELECT COUNT(*) AS count FROM purchase_orders WHERE supplier_id = ?1").bind(supplierId).first<{ count: number }>();
  if (Number(orders?.count || 0) > 0) return error("该供应商已有采购单，不能移除。请保留供应商档案以确保历史订单完整。", 409);
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE supplier_id = ?1)").bind(supplierId),
      env.DB.prepare("UPDATE users SET status = 'disabled', updated_at = ?2 WHERE supplier_id = ?1").bind(supplierId, now()),
      env.DB.prepare("UPDATE suppliers SET archived_at = ?2, updated_at = ?2 WHERE id = ?1").bind(supplierId, now()),
    ]);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "";
    if (message.includes("FOREIGN KEY")) return error("该供应商已有关联业务数据，不能移除", 409);
    throw caught;
  }
  return json({ ok: true, removedSupplier: supplier.name });
}

async function removeOrder(request: Request, env: Env, orderId: string) {
  const actor = await requireSession(request, env, "purchaser");
  const order = await env.DB.prepare("SELECT id, po_number FROM purchase_orders WHERE id = ?1 AND archived_at IS NULL").bind(orderId).first<{ id: string; po_number: string }>();
  if (!order) return error("采购单不存在", 404);
  const timestamp = now();
  const [result] = await env.DB.batch([
    env.DB.prepare("UPDATE purchase_orders SET archived_at = ?2, updated_at = ?2 WHERE id = ?1 AND archived_at IS NULL").bind(orderId, timestamp),
    env.DB.prepare("INSERT INTO order_events (id, order_id, event_type, detail, actor_id, actor_name, created_at) SELECT ?1, id, 'archived', '采购单已作废留档，编号、明细、历史和附件保留', ?3, ?4, ?5 FROM purchase_orders WHERE id = ?2 AND archived_at = ?5").bind(id(), orderId, actor.id, actor.name, timestamp),
  ]);
  if (!result.meta.changes) return error("采购单不存在", 404);
  return json({ ok: true, archivedOrder: order.po_number });
}

async function removeOrderItem(request: Request, env: Env, orderId: string, itemId: string) {
  const actor = await requireSession(request, env, "purchaser");
  const item = await env.DB.prepare(`SELECT i.id,i.product_name,i.amount,po.commercial_status,po.commercial_terms_json
    FROM order_items i JOIN purchase_orders po ON po.id=i.order_id
    WHERE i.id=?1 AND i.order_id=?2 AND po.archived_at IS NULL`).bind(itemId, orderId).first<{ id: string; product_name: string; amount: number; commercial_status: string; commercial_terms_json: string | null }>();
  if (!item) return error("产品不存在", 404);
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM order_items WHERE order_id=?1").bind(orderId).first<{ count: number }>();
  if (Number(count?.count || 0) <= 1) return error("采购单至少需要保留一个产品，不能删除最后一项", 409);
  const downstream = await env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM shipment_items WHERE item_id=?1) +
    (SELECT COUNT(*) FROM warehouse_records WHERE item_id=?1) +
    (SELECT COUNT(*) FROM product_acceptances WHERE item_id=?1) +
    (SELECT COUNT(*) FROM item_corrections WHERE item_id=?1) AS count`).bind(itemId).first<{ count: number }>();
  if (Number(downstream?.count || 0) > 0) return error("该产品已有验收、发货、收货或入库记录，不能直接删除；请删除整张采购单后重新建立", 409);
  const finance = await env.DB.prepare("SELECT COUNT(*) AS count FROM financial_entries WHERE order_id=?1").bind(orderId).first<{ count: number }>();
  if (Number(finance?.count || 0) > 0) return error("该采购单已有财务记录，不能删除产品", 409);
  const attachments = (await env.DB.prepare("SELECT r2_key FROM attachments WHERE item_id=?1").bind(itemId).all()).results as Array<{ r2_key: string }>;
  const base = await env.DB.prepare("SELECT COALESCE(SUM(CAST(ROUND(amount*100) AS INTEGER)),0) AS cents FROM order_items WHERE order_id=?1 AND id<>?2").bind(orderId, itemId).first<{ cents: number }>();
  const terms = parseTerms(item.commercial_terms_json ? JSON.parse(item.commercial_terms_json) : {});
  const purchaseCents = Number(base?.cents || 0);
  const calculated = settlementAmounts(purchaseCents, terms, item.commercial_status);
  const amounts = calculated.payable === null ? { net: purchaseCents, tax: 0, payable: purchaseCents } : calculated;
  const timestamp = now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM attachments WHERE item_id=?1").bind(itemId),
    env.DB.prepare("DELETE FROM order_items WHERE id=?1 AND order_id=?2").bind(itemId, orderId),
    env.DB.prepare("UPDATE order_settlements SET net_cents=?2,tax_cents=?3,payable_cents=?4,finance_confirmed=0,invoice_required=NULL WHERE order_id=?1").bind(orderId, amounts.net, amounts.tax, amounts.payable),
    env.DB.prepare("INSERT INTO order_events(id,order_id,event_type,detail,actor_id,actor_name,created_at) VALUES (?1,?2,'item_removed',?3,?4,?5,?6)").bind(id(), orderId, `删除错误产品：${item.product_name}`, actor.id, actor.name, timestamp),
    env.DB.prepare("UPDATE purchase_orders SET updated_at=?2 WHERE id=?1").bind(orderId, timestamp),
  ]);
  await Promise.all(attachments.map((attachment) => env.FILES.delete(attachment.r2_key)));
  return json({ ok: true, removedItem: item.product_name });
}

async function updateOrderItemDetails(request: Request, env: Env, orderId: string, itemId: string) {
  const actor = await requireSession(request, env, "purchaser");
  const body = await readBody<{ model?: string; productName?: string; color?: string; productType?: string; quantity?: number; unit?: string; unitPrice?: number; specification?: string; materialProcess?: string; installationMethod?: string; packagingVolume?: string }>(request);
  const allowed = ["model", "productName", "color", "productType", "quantity", "unit", "unitPrice", "specification", "materialProcess", "installationMethod", "packagingVolume"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) return error("只能修改该产品的录入信息", 403);
  if (!body.productName?.trim() || !body.productType || !PRODUCT_TYPES.has(body.productType)) return error("请填写有效的产品名称和产品类型");
  if (!Number.isSafeInteger(body.quantity) || Number(body.quantity) < 1 || !Number.isFinite(body.unitPrice) || Number(body.unitPrice) < 0) return error("数量必须是大于等于 1 的整数，单价不能小于 0");
  for (const value of [body.model, body.color, body.unit, body.packagingVolume]) if (typeof value !== "string" || value.length > 100) return error("型号、颜色、单位和包装体积不能超过 100 字");
  for (const value of [body.specification, body.materialProcess, body.installationMethod]) if (typeof value !== "string" || value.length > 4000) return error("规格、材料工艺和安装方式不能超过 4000 字");
  const item = await env.DB.prepare(`SELECT i.*,po.commercial_status,po.commercial_terms_json
    FROM order_items i JOIN purchase_orders po ON po.id=i.order_id
    WHERE i.id=?1 AND i.order_id=?2 AND po.archived_at IS NULL`).bind(itemId, orderId).first<Record<string, unknown>>();
  if (!item) return error("产品不存在", 404);
  const quantity = Number(body.quantity), unitPrice = Number(body.unitPrice), amount = Number((quantity * unitPrice).toFixed(2));
  const monetaryChanged = quantity !== Number(item.quantity) || unitPrice !== Number(item.unit_price);
  if (monetaryChanged) {
    const downstream = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM shipment_items WHERE item_id=?1) +
      (SELECT COUNT(*) FROM warehouse_records WHERE item_id=?1) +
      (SELECT COUNT(*) FROM product_acceptances WHERE item_id=?1) +
      (SELECT COUNT(*) FROM item_corrections WHERE item_id=?1) AS count`).bind(itemId).first<{ count: number }>();
    if (Number(downstream?.count || 0) > 0) return error("该产品已有验收、发货、收货或入库记录，数量和单价不能修改", 409);
    const finance = await env.DB.prepare("SELECT COUNT(*) AS count FROM financial_entries WHERE order_id=?1").bind(orderId).first<{ count: number }>();
    if (Number(finance?.count || 0) > 0) return error("该采购单已有财务记录，数量和单价不能修改", 409);
  }
  const timestamp = now();
  const packagingChanged = body.packagingVolume!.trim() !== String(item.packaging_volume || "");
  const statements = [env.DB.prepare(`UPDATE order_items SET model=?1,product_name=?2,color=?3,product_type=?4,quantity=?5,unit=?6,unit_price=?7,amount=?8,
    specification=?9,material_process=?10,installation_method=?11,packaging_volume=?12,
    packaging_volume_revision=packaging_volume_revision+?13,packaging_volume_by=CASE WHEN ?13=1 THEN ?14 ELSE packaging_volume_by END,
    packaging_volume_at=CASE WHEN ?13=1 THEN ?15 ELSE packaging_volume_at END WHERE id=?16 AND order_id=?17`)
    .bind(body.model!.trim(), body.productName.trim(), body.color!.trim(), body.productType, quantity, body.unit!.trim(), unitPrice, amount, body.specification!.trim(), body.materialProcess!.trim(), body.installationMethod!.trim(), body.packagingVolume!.trim(), packagingChanged ? 1 : 0, actor.id, timestamp, itemId, orderId),
    env.DB.prepare("INSERT INTO order_events(id,order_id,event_type,detail,actor_id,actor_name,created_at) VALUES (?1,?2,'item_details_updated',?3,?4,?5,?6)").bind(id(), orderId, `更正产品资料：${String(item.product_name)} → ${body.productName.trim()}`, actor.id, actor.name, timestamp),
    env.DB.prepare("UPDATE purchase_orders SET updated_at=?2 WHERE id=?1").bind(orderId, timestamp),
  ];
  if (monetaryChanged) {
    const base = await env.DB.prepare("SELECT COALESCE(SUM(CAST(ROUND(amount*100) AS INTEGER)),0) AS cents FROM order_items WHERE order_id=?1 AND id<>?2").bind(orderId, itemId).first<{ cents: number }>();
    const terms = parseTerms(item.commercial_terms_json ? JSON.parse(String(item.commercial_terms_json)) : {});
    const purchaseCents = Number(base?.cents || 0) + Math.round(amount * 100);
    const calculated = settlementAmounts(purchaseCents, terms, String(item.commercial_status));
    const amounts = calculated.payable === null ? { net: purchaseCents, tax: 0, payable: purchaseCents } : calculated;
    statements.push(env.DB.prepare("UPDATE order_settlements SET net_cents=?2,tax_cents=?3,payable_cents=?4,finance_confirmed=0,invoice_required=NULL WHERE order_id=?1").bind(orderId, amounts.net, amounts.tax, amounts.payable));
  }
  await env.DB.batch(statements);
  return json({ ok: true });
}

type CreateOrderBody = {
  commercialTerms?: unknown;
  commercialConfirmed?: boolean;
  supplierTermsRevision?: number;
  poNumber?: string;
  supplierId?: string;
  projectName?: string;
  orderDate?: string;
  requiredShipDate?: string;
  purchaserName?: string;
  internalRequirements?: string;
  items?: Array<{ model?: string; productName?: string; color?: string; productType?: string; quantity?: number; unitPrice?: number; specification?: string; materialProcess?: string; installationMethod?: string; packagingVolume?: string; unit?: string }>;
};

async function createOrder(request: Request, env: Env) {
  const actor = await requireSession(request, env, "purchaser");
  const body = await readBody<CreateOrderBody>(request);
  if (![body.supplierId, body.projectName, body.orderDate, body.requiredShipDate].every(Boolean)) return error("请完整填写采购订单主表");
  if (!body.items?.length) return error("采购单至少需要一个产品");
  for (const item of body.items) {
    if ([item.materialProcess, item.installationMethod].some((value) => value !== undefined && (typeof value !== "string" || value.length > 4000))) return error("材料/工艺/配置及安装方式应为不超过 4000 字的文本");
    if (item.packagingVolume !== undefined && (typeof item.packagingVolume !== "string" || item.packagingVolume.length > 100)) return error("包装体积应为不超过 100 字的文本");
    if (!item.productName?.trim() || !item.productType || !PRODUCT_TYPES.has(item.productType) || !Number.isInteger(Number(item.quantity)) || Number(item.quantity) < 1 || !Number.isFinite(item.unitPrice) || Number(item.unitPrice) < 0) {
      return error("产品名称、类型或单价不正确；数量必须是大于等于 1 的整数");
    }
  }
  const supplier = await env.DB.prepare("SELECT id, is_online_purchase FROM suppliers WHERE id = ?1 AND archived_at IS NULL").bind(body.supplierId).first<{ id: string; is_online_purchase: number }>();
  if (!supplier) return error("所选供应商不存在");
  const onlinePurchase = supplier.is_online_purchase === 1;
  const defaults = await env.DB.prepare("SELECT terms_json, revision FROM supplier_commercial_terms WHERE supplier_id = ?1").bind(body.supplierId).first<{ terms_json: string; revision: number }>();
  if (body.supplierTermsRevision !== undefined && body.supplierTermsRevision !== (defaults?.revision || 0)) return error("供应商默认条件已更新，请重新选择供应商、核对后再创建", 409);
  const terms = parseTerms(body.commercialTerms ?? (defaults ? JSON.parse(defaults.terms_json) : {}));
  const commercialStatus = body.commercialConfirmed === true ? "confirmed" : "unverified";
  if (commercialStatus === "confirmed") assertVerifiedTerms(terms);
  const purchaseCents = body.items.reduce((sum, item) => sum + Math.round(Number((Number(item.quantity) * Number(item.unitPrice)).toFixed(2)) * 100), 0);
  const calculatedAmounts = settlementAmounts(purchaseCents, terms, commercialStatus);
  const amounts = calculatedAmounts.payable === null ? { net: purchaseCents, tax: 0, payable: purchaseCents } : calculatedAmounts;
  const orderId = id();
  const timestamp = now();
  const projectName = body.projectName!.trim().replace(/^(?:亦玩\s*)+/u, "").trim();
  if (!projectName) return error("项目名称不能只填写“亦玩”");
  const existingNumbers = await env.DB.prepare("SELECT po_number FROM purchase_orders WHERE project_name=?1").bind(projectName).all<{ po_number: string }>();
  const prefix = `${projectName}-`;
  const sequence = existingNumbers.results.reduce((highest, row) => {
    if (!row.po_number.startsWith(prefix)) return highest;
    const value = Number(row.po_number.slice(prefix.length));
    return Number.isSafeInteger(value) && value > highest ? value : highest;
  }, 0) + 1;
  const poNumber = `${projectName}-${String(sequence).padStart(3, "0")}`;
  const itemIds = body.items.map(() => id());
  const statements = [
    env.DB.prepare(
      "INSERT INTO purchase_orders (id, po_number, supplier_id, project_name, order_date, required_ship_date, status, purchaser_name, internal_requirements, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
    ).bind(orderId, poNumber, body.supplierId, projectName, body.orderDate, body.requiredShipDate, onlinePurchase ? "ready_to_ship" : "pending_confirmation", actor.name, body.internalRequirements?.trim() || "", actor.id, timestamp),
    ...body.items.map((item, index) => {
      const quantity = Number(item.quantity);
      const unitPrice = Number(item.unitPrice);
      return env.DB.prepare(
        "INSERT INTO order_items (id, order_id, model, product_name, color, product_type, quantity, unit_price, amount, specification, unit, created_at, material_process, installation_method, packaging_volume) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
      ).bind(itemIds[index], orderId, item.model?.trim() || "", item.productName!.trim(), item.color?.trim() || "", item.productType, quantity, unitPrice, Number((quantity * unitPrice).toFixed(2)), item.specification?.trim() || "", item.unit?.trim() || "", timestamp, item.materialProcess?.trim() || "", item.installationMethod?.trim() || "", item.packagingVolume?.trim() || "");
    }),
    env.DB.prepare("UPDATE purchase_orders SET commercial_terms_json = ?1, commercial_status = ?2, commercial_revision = 1 WHERE id = ?3").bind(JSON.stringify(terms), commercialStatus, orderId),
    env.DB.prepare("INSERT INTO order_settlements (order_id, net_cents, tax_cents, payable_cents) VALUES (?1, ?2, ?3, ?4)").bind(orderId, amounts.net, amounts.tax, amounts.payable),
    env.DB.prepare("INSERT INTO commercial_history (id, order_id, actual_json, status, reason, actor_id, actor_name, created_at) VALUES (?1, ?2, ?3, ?4, '创建 PO 时保存本单实际执行条件', ?5, ?6, ?7)").bind(id(), orderId, JSON.stringify(terms), commercialStatus, actor.id, actor.name, timestamp),
    env.DB.prepare("INSERT INTO order_events (id, order_id, event_type, detail, actor_id, actor_name, created_at) VALUES (?1, ?2, 'created', ?3, ?4, ?5, ?6)")
      .bind(id(), orderId, onlinePurchase ? "网上采购已下单，等待采购登记发货" : "采购单已创建，等待供应商确认", actor.id, actor.name, timestamp),
  ];
  try {
    await env.DB.batch(statements);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "";
    if (message.includes("UNIQUE")) return error("PO 编号已使用（包括作废留档订单），不能重复使用", 409);
    throw caught;
  }
  return json({ ok: true, orderId, itemIds }, 201);
}

const termTextFields = ["production", "transport", "credit", "payment", "invoice", "minimum_order"] as const;
type CommercialTerms = Record<typeof termTextFields[number], string> & { order_materials?: string; notes?: string; price_basis: "unknown" | "inclusive" | "exclusive"; tax_rate_bps: number | null; currency: "CNY" };
function badInput(message: string, status = 400): never { throw error(message, status); }
function parseTerms(input: unknown): CommercialTerms {
  if (!input || typeof input !== "object" || Array.isArray(input)) badInput("商务条件格式不正确");
  const value = input as Record<string, unknown>;
  const allowed = new Set<string>([...termTextFields, "order_materials", "notes", "price_basis", "tax_rate_bps", "currency"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) badInput("商务条件包含不支持的字段");
  const terms = {} as CommercialTerms;
  for (const key of termTextFields) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || String(value[key]).length > 2000)) badInput("每项商务条件请填写不超过 2000 字的文本");
    terms[key] = String(value[key] ?? "").trim();
  }
  for (const key of ["order_materials", "notes"] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "string" || value[key].length > 2000) badInput("下单资料及补充说明请填写不超过 2000 字的文本");
    terms[key] = value[key].trim();
  }
  const basis = value.price_basis ?? "unknown";
  if (!["unknown", "inclusive", "exclusive"].includes(String(basis))) badInput("请选择有效的价格口径");
  const rate = value.tax_rate_bps ?? null;
  if (rate !== null && (typeof rate !== "number" || !Number.isInteger(rate) || rate % 100 !== 0 || rate < 0 || rate > 10000)) badInput("税率应为 0% 至 100% 的整数，不允许小数");
  if (value.currency !== undefined && value.currency !== "CNY") badInput("当前系统仅支持人民币，不能混合币种");
  return { ...terms, price_basis: basis as CommercialTerms["price_basis"], tax_rate_bps: rate as number | null, currency: "CNY" };
}
function assertVerifiedTerms(terms: CommercialTerms) {
  if (terms.price_basis === "unknown" || terms.tax_rate_bps === null || termTextFields.some((key) => !terms[key])) badInput("请核实全部执行条件、价格口径和税率；不适用的条件请明确填“无”");
}
function settlementAmounts(base: number, terms: CommercialTerms, status: string) {
  if (!Number.isSafeInteger(base) || base < 0 || base > 1_000_000_000_000) badInput("订单金额超出可处理范围");
  if (status !== "confirmed") return { net: null, tax: null, payable: null };
  assertVerifiedTerms(terms);
  const rate = BigInt(terms.tax_rate_bps!);
  const rounded = (numerator: bigint, denominator: bigint) => Number((numerator + denominator / 2n) / denominator);
  const net = terms.price_basis === "inclusive" ? rounded(BigInt(base) * 10000n, 10000n + rate) : base;
  const payable = terms.price_basis === "inclusive" ? base : base + rounded(BigInt(base) * rate, 10000n);
  return { net, tax: payable - net, payable };
}

async function saveSupplierTerms(request: Request, env: Env, supplierId: string) {
  const actor = await requireSession(request, env, "purchaser");
  const body = await readBody<{ terms: unknown; revision: number }>(request);
  if (!Number.isInteger(body.revision) || body.revision < 0) return error("请刷新供应商资料后重试", 409);
  const supplier = await env.DB.prepare("SELECT id FROM suppliers WHERE id = ?1 AND archived_at IS NULL").bind(supplierId).first();
  if (!supplier) return error("供应商不存在", 404);
  const terms = JSON.stringify(parseTerms(body.terms));
  const result = body.revision === 0
    ? await env.DB.prepare("INSERT INTO supplier_commercial_terms(supplier_id, terms_json, updated_by, updated_at) SELECT ?1, ?2, ?3, ?4 WHERE NOT EXISTS(SELECT 1 FROM supplier_commercial_terms WHERE supplier_id = ?1)").bind(supplierId, terms, actor.id, now()).run()
    : await env.DB.prepare("UPDATE supplier_commercial_terms SET terms_json = ?2, revision = revision + 1, updated_by = ?3, updated_at = ?4 WHERE supplier_id = ?1 AND revision = ?5").bind(supplierId, terms, actor.id, now(), body.revision).run();
  if (!result.meta.changes) return error("默认条件已被更新，请刷新后核对", 409);
  return json({ ok: true });
}

async function saveOrderTerms(request: Request, env: Env, orderId: string) {
  const actor = await requireSession(request, env, "purchaser");
  const body = await readBody<{ terms: unknown; confirmed: boolean; revision: number; reason: string }>(request);
  if (typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 2000) return error("请填写本次核实或变更原因（最多 2000 字）");
  if (!Number.isInteger(body.revision)) return error("请刷新订单后再编辑", 409);
  const order = await env.DB.prepare("SELECT commercial_terms_json, commercial_revision FROM purchase_orders WHERE id = ?1 AND archived_at IS NULL").bind(orderId).first<{ commercial_terms_json: string | null; commercial_revision: number }>();
  if (!order) return error("订单不存在或已作废，不能调整条件", 409);
  if (order.commercial_revision !== body.revision) return error("执行条件已更新，请刷新后核对", 409);
  const terms = parseTerms(body.terms);
  const status = body.confirmed === true ? "confirmed" : "unverified";
  const base = await env.DB.prepare("SELECT COALESCE(SUM(CAST(ROUND(amount * 100) AS INTEGER)), 0) AS cents FROM order_items WHERE order_id = ?1").bind(orderId).first<{ cents: number }>();
  const amounts = settlementAmounts(Number(base?.cents || 0), terms, status);
  const token = id(), timestamp = now(), actual = JSON.stringify(terms);
  try {
    const [result] = await env.DB.batch([
      env.DB.prepare("UPDATE purchase_orders SET commercial_terms_json = ?2, commercial_status = ?3, commercial_revision = commercial_revision + 1, commercial_change_id = ?4, updated_at = ?5 WHERE id = ?1 AND commercial_revision = ?6 AND archived_at IS NULL").bind(orderId, actual, status, token, timestamp, body.revision),
      env.DB.prepare("INSERT INTO commercial_history(id, order_id, previous_json, actual_json, status, reason, actor_id, actor_name, created_at) SELECT ?1, id, ?3, ?4, ?5, ?6, ?7, ?8, ?9 FROM purchase_orders WHERE id = ?2 AND commercial_change_id = ?1").bind(token, orderId, order.commercial_terms_json, actual, status, body.reason.trim(), actor.id, actor.name, timestamp),
      env.DB.prepare("UPDATE order_settlements SET net_cents = ?2, tax_cents = ?3, payable_cents = ?4 WHERE order_id = ?1 AND EXISTS(SELECT 1 FROM purchase_orders WHERE id = ?1 AND commercial_change_id = ?5)").bind(orderId, amounts.net, amounts.tax, amounts.payable, token),
    ]);
    if (!result.meta.changes) return error("执行条件已更新，请刷新后核对", 409);
  } catch (caught) {
    if (String(caught).includes("price basis")) return error("已有财务记录，不能改动应付金额或税额；请先与财务核对。其他执行条件仍可留痕调整。", 409);
    throw caught;
  }
  return json({ ok: true });
}

async function financeDashboard(request: Request, env: Env) {
  const reader = await requireSession(request, env);
  if (!(canFinance(reader) || reader.role === "office")) return error("没有权限", 403);
  const orders = (await env.DB.prepare(`SELECT po.id, po.po_number, po.project_name, po.archived_at, po.commercial_status, po.commercial_terms_json,
    s.name AS supplier_name, st.currency, st.net_cents, st.tax_cents, st.payable_cents, st.finance_confirmed, st.invoice_required,
    COALESCE((SELECT SUM(amount_cents) FROM financial_entries WHERE order_id = po.id AND kind = 'payment'), 0) AS paid_cents,
    COALESCE((SELECT SUM(amount_cents) FROM financial_entries WHERE order_id = po.id AND kind = 'invoice'), 0) AS invoiced_cents,
    COALESCE((SELECT SUM(amount_cents) FROM financial_entries WHERE order_id = po.id AND kind = 'cost'), 0) AS extra_cost_cents
    FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id JOIN order_settlements st ON st.order_id = po.id ORDER BY po.created_at DESC`).all()).results;
  const entries = (await env.DB.prepare("SELECT id, order_id, kind, amount_cents, record_date, reference, note, reversal_of, actor_name, created_at FROM financial_entries ORDER BY created_at DESC, rowid DESC").all()).results;
  for (const order of orders) {
    order.unpaid_cents = order.payable_cents === null ? null : Number(order.payable_cents) - Number(order.paid_cents);
    order.cost_cents = order.payable_cents === null ? null : Number(order.payable_cents) + Number(order.extra_cost_cents);
    order.entries = entries.filter((entry) => entry.order_id === order.id);
    order.commercial_terms = order.commercial_terms_json ? JSON.parse(String(order.commercial_terms_json)) : null;
    delete order.commercial_terms_json;
  }
  return json({ orders });
}

function moneyCents(value: unknown) {
  if (typeof value !== "string" || !/^\d{1,10}(\.\d{1,2})?$/.test(value)) badInput("金额请输入正数，最多两位小数");
  const [whole, decimal = ""] = value.split(".");
  const amount = Number(whole) * 100 + Number(decimal.padEnd(2, "0"));
  if (!Number.isSafeInteger(amount) || amount <= 0) badInput("金额必须大于 0");
  return amount;
}

function nonnegativeMoneyCents(value: unknown) {
  if (typeof value !== "string" || !/^\d{1,10}(\.\d{1,2})?$/.test(value)) badInput("金额请输入数字，最多两位小数");
  const [whole, decimal = ""] = value.split(".");
  const amount = Number(whole) * 100 + Number(decimal.padEnd(2, "0"));
  if (!Number.isSafeInteger(amount) || amount < 0) badInput("金额不能小于 0");
  return amount;
}

async function saveFinanceSettlement(request: Request, env: Env, orderId: string) {
  const actor = await requireSession(request, env, "finance");
  const body = await readBody<{ payableAmount?: string; taxRate?: string; invoiceRequired?: boolean }>(request);
  if (typeof body.invoiceRequired !== "boolean") return error("请选择是否开票");
  const payable = nonnegativeMoneyCents(body.payableAmount);
  if (typeof body.taxRate !== "string" || !/^\d{1,3}$/.test(body.taxRate)) return error("税率请输入整数，不要填写小数点");
  const taxRate = Number(body.taxRate);
  if (taxRate > 100) return error("税率不能超过 100%");
  const tax = Math.round(payable * taxRate / (100 + taxRate));
  let result;
  try {
    result = await env.DB.prepare("UPDATE order_settlements SET payable_cents=?2, tax_cents=?3, net_cents=?4, invoice_required=?5, finance_confirmed=1 WHERE order_id=?1 AND EXISTS(SELECT 1 FROM purchase_orders WHERE id=?1 AND archived_at IS NULL)")
      .bind(orderId, payable, tax, payable - tax, body.invoiceRequired ? 1 : 0).run();
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("financial records cannot change")) return error("该订单已有付款或发票记录，应付款与税金不能再修改", 409);
    throw cause;
  }
  if (!result.meta.changes) return error("订单已作废或结算金额已被财务记录锁定", 409);
  await recordEvent(env, orderId, "finance_settlement", `财务确认应付 ¥${(payable / 100).toFixed(2)} · ${body.invoiceRequired ? "需要开票" : "不开票"} · 税率 ${taxRate}% · 税金 ¥${(tax / 100).toFixed(2)}`, actor);
  return json({ ok: true });
}

async function createFinancialEntry(request: Request, env: Env, orderId: string) {
  const actor = await requireSession(request, env, "finance");
  const body = await readBody<{ requestId: string; kind: string; amount: string; recordDate: string; reference: string; note?: string; reversalOf?: string }>(request);
  if (typeof body.requestId !== "string" || !/^[\da-f-]{36}$/i.test(body.requestId)) return error("提交标识无效，请刷新后重试");
  if (!validDate(body.recordDate)) return error("请填写有效的记录日期");
  if (typeof body.reference !== "string" || !body.reference.trim() || body.reference.length > 200) return error("请填写流水号、发票号或成本凭证号（最多 200 字）");
  if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 2000)) return error("备注最多 2000 字");
  let kind = body.kind, amount: number;
  if (body.reversalOf) {
    const original = await env.DB.prepare("SELECT kind, amount_cents FROM financial_entries WHERE id = ?1 AND order_id = ?2 AND reversal_of IS NULL").bind(body.reversalOf, orderId).first<{ kind: string; amount_cents: number }>();
    if (!original) return error("原财务记录不存在", 404);
    if (!body.note?.trim()) return error("冲销必须填写原因");
    kind = original.kind; amount = -original.amount_cents;
  } else {
    if (!["payment", "invoice", "cost"].includes(kind)) return error("财务记录类型不正确");
    amount = moneyCents(body.amount);
  }
  const previous = await env.DB.prepare("SELECT * FROM financial_entries WHERE id = ?1").bind(body.requestId).first<Record<string, unknown>>();
  if (previous) {
    if (previous.order_id === orderId && previous.kind === kind && previous.amount_cents === amount && previous.reference === body.reference.trim() && previous.record_date === body.recordDate && previous.note === (body.note?.trim() || "") && previous.reversal_of === (body.reversalOf || null)) return json({ ok: true, replayed: true });
    return error("同一提交标识不能对应不同内容，请核对后重新登记", 409);
  }
  try {
    const result = await env.DB.prepare(`INSERT INTO financial_entries(id, order_id, kind, amount_cents, record_date, reference, note, reversal_of, actor_id, actor_name, created_at)
      SELECT ?1, po.id, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11 FROM purchase_orders po
      JOIN order_settlements st ON st.order_id = po.id WHERE po.id = ?2 AND po.archived_at IS NULL AND (po.commercial_status = 'confirmed' OR st.finance_confirmed = 1) AND st.payable_cents IS NOT NULL`)
      .bind(body.requestId, orderId, kind, amount, body.recordDate, body.reference.trim(), body.note?.trim() || "", body.reversalOf || null, actor.id, actor.name, now()).run();
    if (!result.meta.changes) return error("请先由采购核实本单执行条件；作废订单只读留档", 409);
  } catch (caught) {
    if (/UNIQUE|Duplicate active/.test(String(caught))) return error("该凭证号已登记或原记录已冲销，请刷新核对，勿重复提交", 409);
    throw caught;
  }
  return json({ ok: true }, 201);
}

async function staffAccounts(request: Request, env: Env) {
  const reader = await requireSession(request, env);
  if (!(["boss","admin"].includes(reader.role) || (reader.role === "office" && request.method === "GET"))) return error("没有权限", 403);
  if (request.method === "GET") return json({ users: (await env.DB.prepare("SELECT u.id, u.name, u.email, COALESCE(sr.role, u.role) AS role, COALESCE(sp.supplier_operations,0) AS supplier_operations, COALESCE(sp.finance_settlement,0) AS finance_settlement, u.status FROM users u LEFT JOIN staff_roles sr ON sr.user_id = u.id LEFT JOIN staff_permissions sp ON sp.user_id = u.id WHERE u.role != 'supplier' ORDER BY u.created_at").all()).results });
  const body = await readBody<{ name: string; email: string; password: string; role: string; supplierOperations?: boolean; financeSettlement?: boolean }>(request);
  if (!body.name?.trim() || !body.email?.trim() || !["purchaser", "finance", "boss", "admin", "management", "engineering", "warehouse", "office"].includes(body.role)) return error("请填写姓名、邮箱并选择内部角色");
  if (typeof body.password !== "string" || body.password.length < 10) return error("密码至少需要 10 位");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) return error("请填写有效的邮箱");
  const password = await makePassword(body.password);
  const userId = id(), timestamp = now();
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users(id, email, name, role, password_hash, password_salt, created_at, updated_at) VALUES (?1, ?2, ?3, 'purchaser', ?4, ?5, ?6, ?6)").bind(userId, body.email.trim().toLowerCase(), body.name.trim(), password.hash, password.salt, timestamp),
      env.DB.prepare("INSERT INTO staff_roles(user_id, role) VALUES (?1, ?2)").bind(userId, body.role),
      env.DB.prepare("INSERT INTO staff_permissions(user_id, supplier_operations, finance_settlement) VALUES (?1, ?2, ?3)").bind(userId, body.supplierOperations === true ? 1 : 0, body.financeSettlement === true ? 1 : 0),
    ]);
  } catch (caught) { if (String(caught).includes("UNIQUE")) return error("邮箱已被使用", 409); throw caught; }
  return json({ ok: true }, 201);
}

async function editStaffAccount(request: Request, env: Env, userId: string) {
  const actor = await requireSession(request, env, "boss");
  const body = await readBody<{ name?: string; email?: string; password?: string; role?: string; supplierOperations?: boolean; financeSettlement?: boolean }>(request);
  if (Object.keys(body).some((key) => !["name", "email", "password", "role", "supplierOperations", "financeSettlement"].includes(key))) return error("只能修改账号资料和权限", 403);
  if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 100 || typeof body.email !== "string" || body.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) return error("请填写姓名及有效的登录邮箱");
  if (body.role !== undefined && (typeof body.role !== "string" || !["purchaser", "finance", "boss", "admin", "management", "engineering", "warehouse", "office"].includes(body.role))) return error("请选择有效的内部角色");
  if (body.password !== undefined && (typeof body.password !== "string" || (body.password !== "" && (body.password.length < 10 || body.password.length > 256)))) return error("新密码需要 10–256 位，留空则不修改");
  const existing = await env.DB.prepare("SELECT u.id,u.name,u.email,COALESCE(sr.role,u.role) AS role,COALESCE(sp.supplier_operations,0) AS supplier_operations,COALESCE(sp.finance_settlement,0) AS finance_settlement FROM users u LEFT JOIN staff_roles sr ON sr.user_id=u.id LEFT JOIN staff_permissions sp ON sp.user_id=u.id WHERE u.id=?1 AND u.role!='supplier' AND u.status='active'").bind(userId).first<{ id: string; name: string; email: string; role: Role; supplier_operations: number; finance_settlement: number }>();
  if (!existing) return error("内部账号不存在", 404);
  const password = body.password ? await makePassword(body.password) : null;
  const name = body.name.trim(), email = body.email.trim().toLowerCase(), role = (body.role || existing.role) as Role;
  const supplierOperations = body.supplierOperations === undefined ? existing.supplier_operations : body.supplierOperations === true ? 1 : 0;
  const financeSettlement = body.financeSettlement === undefined ? existing.finance_settlement : body.financeSettlement === true ? 1 : 0;
  const statements = [
    password ? env.DB.prepare("UPDATE users SET name=?1, email=?2, password_hash=?3, password_salt=?4, updated_at=?5 WHERE id=?6").bind(name, email, password.hash, password.salt, now(), userId)
      : env.DB.prepare("UPDATE users SET name=?1, email=?2, updated_at=?3 WHERE id=?4").bind(name, email, now(), userId),
    env.DB.prepare("INSERT INTO staff_roles(user_id,role) VALUES (?1,?2) ON CONFLICT(user_id) DO UPDATE SET role=excluded.role").bind(userId, role),
    env.DB.prepare("INSERT INTO account_changes(id,user_id,actor_id,old_name,new_name,old_email,new_email,password_reset,created_at,old_role,new_role,old_supplier_operations,new_supplier_operations,old_finance_settlement,new_finance_settlement) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)").bind(id(),userId,actor.id,existing.name,name,existing.email,email,password?1:0,now(),existing.role,role,existing.supplier_operations,supplierOperations,existing.finance_settlement,financeSettlement),
    env.DB.prepare("INSERT INTO staff_permissions(user_id,supplier_operations,finance_settlement) VALUES (?1,?2,?3) ON CONFLICT(user_id) DO UPDATE SET supplier_operations=excluded.supplier_operations,finance_settlement=excluded.finance_settlement").bind(userId, supplierOperations, financeSettlement),
  ];
  const permissionsChanged = role !== existing.role || supplierOperations !== existing.supplier_operations || financeSettlement !== existing.finance_settlement;
  if (password || email !== existing.email || permissionsChanged) statements.push(env.DB.prepare("DELETE FROM sessions WHERE user_id=?1").bind(userId));
  try { await env.DB.batch(statements); }
  catch (caught) { if (String(caught).includes("UNIQUE")) return error("邮箱已被使用，请换一个邮箱", 409); throw caught; }
  return json({ ok: true, loginRequired: actor.id === userId && Boolean(password || email !== existing.email || permissionsChanged) });
}

async function correctItem(request: Request, env: Env, orderId: string, itemId: string) {
  const actor=await requireSession(request,env);
  const body=await readBody<{action:string;quantity:number;reason:string;revision:number;received:number;stocked:number;requestId:string}>(request);
  if (body.action==='acceptance' ? !canPurchase(actor.role) : !['warehouse','boss','admin'].includes(actor.role)) return error('没有权限更正此项记录',403);
  if (!['acceptance','received','stocked'].includes(body.action) || !Number.isSafeInteger(body.quantity) || body.quantity<1 || ![body.revision,body.received,body.stocked].every(value=>Number.isSafeInteger(value)&&value>=0) || typeof body.reason!=='string' || !body.reason.trim() || body.reason.length>2000 || typeof body.requestId!=='string' || !/^[a-zA-Z0-9-]{16,80}$/.test(body.requestId)) return error('请填写有效的撤销数量与更正原因');
  const prior=await env.DB.prepare('SELECT * FROM item_corrections WHERE id=?1').bind(body.requestId).first();
  if(prior) return prior.actor_id===actor.id && prior.order_id===orderId && prior.item_id===itemId && prior.action===body.action && prior.quantity===body.quantity && prior.reason===body.reason.trim() ? json({ok:true}) : error('登记标识已使用',409);
  try {
    await env.DB.prepare('INSERT INTO item_corrections(id,order_id,item_id,action,quantity,reason,expected_revision,expected_received,expected_stocked,actor_id,actor_name,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)').bind(body.requestId,orderId,itemId,body.action,body.quantity,body.reason.trim(),body.revision,body.received,body.stocked,actor.id,actor.name,now()).run();
  } catch(cause) { if(/更正状态|UNIQUE/.test(String(cause))) return error('状态已变化或存在后续记录，请刷新；已入库数量需先撤销入库，已发货产品不能撤销验收',409); throw cause; }
  return json({ok:true});
}

async function updateFreightPayment(request: Request, env: Env, orderId: string, itemId: string) {
  const actor = await requireSession(request, env, "purchaser");
  if (!(await canAccessOrder(env, actor, orderId))) return error("采购单不存在或已作废",404);
  const body = await readBody<{status?: string; revision?: number}>(request);
  if (Object.keys(body).some(key => !["status","revision"].includes(key)) || !["paid","unpaid"].includes(body.status || "") || !Number.isSafeInteger(body.revision)) return error("请选择已支付或未支付");
  const result = await env.DB.prepare(`UPDATE order_items SET freight_payment_status=?1,freight_payment_revision=freight_payment_revision+1,freight_payment_by=?2,freight_payment_at=?3
    WHERE id=?4 AND order_id=?5 AND freight_payment_revision=?6 AND freight_payment_status!=?1
    AND EXISTS(SELECT 1 FROM purchase_orders WHERE id=?5 AND archived_at IS NULL)`)
    .bind(body.status,actor.id,now(),itemId,orderId,body.revision).run();
  if (!result.meta.changes) return error("状态已更新或产品不存在，请刷新核对",409);
  return json({ok:true});
}

async function updatePackagingVolume(request: Request, env: Env, orderId: string, itemId: string) {
  const actor = await requireSession(request, env, "purchaser");
  if (!(await canAccessOrder(env, actor, orderId))) return error("采购单不存在或已作废", 404);
  const body = await readBody<{ volume?: string; revision?: number }>(request);
  if (Object.keys(body).some((key) => !["volume", "revision"].includes(key)) || typeof body.volume !== "string" || body.volume.length > 100 || !Number.isSafeInteger(body.revision)) return error("请填写不超过 100 字的包装体积");
  const volume = body.volume.trim();
  const result = await env.DB.prepare(`UPDATE order_items SET packaging_volume=?1,packaging_volume_revision=packaging_volume_revision+1,packaging_volume_by=?2,packaging_volume_at=?3
    WHERE id=?4 AND order_id=?5 AND packaging_volume_revision=?6 AND packaging_volume!=?1
    AND EXISTS(SELECT 1 FROM purchase_orders WHERE id=?5 AND archived_at IS NULL)`)
    .bind(volume, actor.id, now(), itemId, orderId, body.revision).run();
  if (!result.meta.changes) return error("包装体积已更新或没有变化，请刷新核对", 409);
  return json({ ok: true });
}

async function warehouseAction(request: Request, env: Env, orderId: string, itemId: string) {
  const actor = await requireSession(request, env);
  const body = await readBody<{ action?: string; quantity?: number; requestId?: string; recordDate?: string }>(request);
  if (Object.keys(body).some(key => !["action","quantity","requestId","recordDate"].includes(key)) || !["received","stocked"].includes(body.action || "")) return error("请选择收货或入库");
  if (!Number.isSafeInteger(body.quantity) || Number(body.quantity)<1) return error("数量必须为大于等于 1 的整数");
  if (typeof body.requestId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(body.requestId)) return error("缺少登记标识，请刷新重试");
  const businessDate = body.action === "received" ? (body.recordDate || businessToday()) : businessToday();
  if (!validDate(businessDate) || businessDate > businessToday()) return error("请选择不晚于今天的有效收货时间");
  const prior = await env.DB.prepare("SELECT * FROM warehouse_records WHERE id=?1").bind(body.requestId).first();
  if (prior) return prior.order_id===orderId && prior.item_id===itemId && prior.action===body.action && prior.quantity===body.quantity && prior.actor_id===actor.id && (prior.record_date || String(prior.created_at).slice(0,10))===businessDate ? json({ok:true}) : error("登记标识已使用，请刷新",409);
  const item = await env.DB.prepare("SELECT i.id, po.order_date, s.is_online_purchase FROM order_items i JOIN purchase_orders po ON po.id=i.order_id JOIN suppliers s ON s.id=po.supplier_id WHERE i.id=?1 AND i.order_id=?2").bind(itemId,orderId).first<{id:string;order_date:string;is_online_purchase:number}>();
  if (!item) return error("产品不存在",404);
  if (!["warehouse", "admin", "boss"].includes(actor.role) && !(item.is_online_purchase === 1 && canPurchase(actor.role))) return error("只有仓库部、采购或管理员可以确认网上采购的收货、入库", 403);
  if (businessDate < item.order_date) return error("收货时间不能早于下单日期");
  const timestamp = now();
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO warehouse_records(id,order_id,item_id,action,quantity,actor_id,actor_name,record_date,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)").bind(body.requestId,orderId,itemId,body.action,body.quantity,actor.id,actor.name,businessDate,timestamp),
      env.DB.prepare("INSERT INTO order_events(id,order_id,event_type,detail,actor_id,actor_name,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)").bind(id(),orderId,body.action === "received" ? "warehouse_received" : "warehouse_stocked",`${body.action === "received" ? "仓库收货" : "确认入库"} ${body.quantity} 件 · 业务日期 ${businessDate}`,actor.id,actor.name,timestamp),
    ]);
  } catch (caught) {
    if (/UNIQUE|仓库数量|CHECK/.test(String(caught))) return error("数量超过已发未收或已收未入库数量，请刷新核对",409);
    throw caught;
  }
  return json({ ok: true });
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

async function updateDeliveryEstimate(request: Request, env: Env, orderId: string) {
  const actor = await requireSession(request, env, "supplier");
  if (!(await canAccessOrder(env, actor, orderId))) return error("采购单不存在", 404);
  const body = await readBody<{ estimatedShipDate?: string; reason?: string; revision?: number }>(request);
  if (Object.keys(body).some((key) => !["estimatedShipDate", "reason", "revision"].includes(key))) return error("只能调整预计发货日期和原因", 403);
  if (!validDate(body.estimatedShipDate)) return error("请填写有效的预计发货日期");
  if (typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 2000) return error("请填写调整原因（不超过 2000 字）");
  if (!Number.isInteger(body.revision)) return error("请刷新订单后再调整交期", 409);
  const order = await env.DB.prepare("SELECT order_date, status, estimated_ship_date FROM purchase_orders WHERE id = ?1").bind(orderId).first<{ order_date: string; status: string; estimated_ship_date: string | null }>();
  if (!order || !["in_production", "ready_to_ship"].includes(order.status)) return error("仅生产中、待发货或部分发货订单可调整预计交期", 409);
  if (body.estimatedShipDate < order.order_date) return error("预计发货日期不能早于下单日期");
  if (body.estimatedShipDate === order.estimated_ship_date) return error("预计发货日期没有变化");
  // The database trigger appends history in the same transaction as this update.
  const result = await env.DB.prepare(`UPDATE purchase_orders SET estimated_ship_date = ?1, delivery_change_reason = ?2,
    delivery_actor_id = ?3, delivery_actor_name = ?4, delivery_revision = delivery_revision + 1, updated_at = ?5
    WHERE id = ?6 AND delivery_revision = ?7 AND archived_at IS NULL AND status IN ('in_production', 'ready_to_ship')`)
    .bind(body.estimatedShipDate, body.reason.trim(), actor.id, actor.name, now(), orderId, body.revision).run();
  if (!result.meta.changes) return error("交期或订单状态已更新，请刷新后核对再提交", 409);
  return json({ ok: true });
}

async function updateInternal(request: Request, env: Env, orderId: string) {
  const actor = await requireSession(request, env, "purchaser");
  const body = await readBody<{ requiredShipDate?: string; internalRequirements?: string; revision?: number }>(request);
  if (Object.keys(body).some((key) => !["requiredShipDate", "internalRequirements", "revision"].includes(key))) return error("编号、供应商、数量、价格和原承诺日期不能通过此操作修改", 403);
  const order = await env.DB.prepare("SELECT status, order_date FROM purchase_orders WHERE id = ?1 AND archived_at IS NULL").bind(orderId).first<{ status: string; order_date: string }>();
  if (!order) return error("采购单不存在", 404);
  if (order.status === "completed") return error("已完结采购单不能修改");
  if (!Number.isInteger(body.revision)) return error("请刷新订单后再修改", 409);
  if (body.requiredShipDate !== undefined && !validDate(body.requiredShipDate)) return error("请填写有效的要求发货日期");
  if (body.requiredShipDate && body.requiredShipDate < order.order_date) return error("要求发货日期不能早于下单日期");
  const result = await env.DB.prepare(`UPDATE purchase_orders SET required_ship_date = COALESCE(?1, required_ship_date), internal_requirements = COALESCE(?2, internal_requirements), updated_at = ?3,
    delivery_actor_id = ?5, delivery_actor_name = ?6, delivery_change_reason = '采购调整要求发货日期', delivery_revision = delivery_revision + 1
    WHERE id = ?4 AND delivery_revision = ?7 AND archived_at IS NULL AND status != 'completed'`)
    .bind(body.requiredShipDate || null, body.internalRequirements ?? null, now(), orderId, actor.id, actor.name, body.revision).run();
  if (!result.meta.changes) return error("订单已更新，请刷新后核对再保存", 409);
  await recordEvent(env, orderId, "internal_updated", "采购更新了要求发货日期或内部要求", actor);
  return json({ ok: true });
}

async function updateOrderIdentity(request: Request, env: Env, orderId: string) {
  const actor = await requireSession(request, env);
  if (!canPurchase(actor.role)) return error("没有权限修改采购单基本信息", 403);
  const body = await readBody<{ poNumber?: string; supplierId?: string; projectName?: string; orderDate?: string; requiredShipDate?: string; purchaserName?: string; previousPoNumber?: string; previousSupplierId?: string; previousName?: string; revision?: number }>(request);
  if (Object.keys(body).some((key) => !["poNumber", "supplierId", "projectName", "orderDate", "requiredShipDate", "purchaserName", "previousPoNumber", "previousSupplierId", "previousName", "revision"].includes(key))) return error("此操作只能修改采购单基本信息", 403);
  const order = await env.DB.prepare(`SELECT po.po_number,po.supplier_id,s.name AS supplier_name,po.project_name,po.order_date,po.required_ship_date,po.purchaser_name,po.status,po.delivery_revision
    FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id WHERE po.id=?1 AND po.archived_at IS NULL`).bind(orderId).first<{ po_number: string; supplier_id: string; supplier_name: string; project_name: string; order_date: string; required_ship_date: string; purchaser_name: string; status: string; delivery_revision: number }>();
  if (!order) return error("采购单不存在", 404);
  if (body.previousPoNumber !== order.po_number || body.previousSupplierId !== order.supplier_id || body.previousName !== order.project_name || body.revision !== order.delivery_revision) return error("采购单已更新，请刷新后再修改", 409);
  const poNumber = order.po_number;
  const supplierId = body.supplierId?.trim() || "";
  const projectName = body.projectName?.trim().replace(/^(?:亦玩\s*)+/u, "").trim() || "";
  const purchaserName = order.purchaser_name;
  if (body.poNumber !== undefined && body.poNumber.trim() !== order.po_number) return error("PO 编号由项目名称自动生成，不能修改", 403);
  if (body.purchaserName !== undefined && body.purchaserName.trim() !== order.purchaser_name) return error("采购负责人由创建账号自动记录，不能修改", 403);
  if (!supplierId || !projectName) return error("请完整填写供应商和项目名称");
  if (!validDate(body.orderDate) || !validDate(body.requiredShipDate)) return error("请填写有效的下单日期和要求发货日期");
  if (body.requiredShipDate! < body.orderDate!) return error("要求发货日期不能早于下单日期");
  if (poNumber.length > 80) return error("PO 编号不能超过 80 个字");
  if (projectName.length > 120) return error("项目名称不能超过 120 个字");
  const supplierChanged = supplierId !== order.supplier_id;
  if (supplierChanged && order.status !== "pending_confirmation") return error("只能在待供应商确认阶段更正供应商", 409);
  const supplier = await env.DB.prepare(`SELECT s.name,t.terms_json FROM suppliers s LEFT JOIN supplier_commercial_terms t ON t.supplier_id=s.id
    WHERE s.id=?1 AND s.archived_at IS NULL`).bind(supplierId).first<{ name: string; terms_json: string | null }>();
  if (!supplier) return error("供应商不存在或已停用", 404);
  const timestamp = now();
  try {
    const requiredChanged = body.requiredShipDate !== order.required_ship_date;
    const revisionChanged = requiredChanged || supplierChanged;
    const terms = supplier.terms_json || JSON.stringify({ production: "", transport: "", credit: "", payment: "", invoice: "", minimum_order: "", price_basis: "unknown", tax_rate_bps: null, currency: "CNY" });
    const token = supplierChanged ? id() : null;
    const statements = [env.DB.prepare(`UPDATE purchase_orders SET po_number=?1,supplier_id=?2,project_name=?3,order_date=?4,required_ship_date=?5,purchaser_name=?6,updated_at=?7,
      delivery_actor_id=?8,delivery_actor_name=?9,delivery_change_reason='采购更正基本信息',delivery_revision=delivery_revision+?10,
      commercial_terms_json=CASE WHEN ?11 IS NULL THEN commercial_terms_json ELSE ?12 END,commercial_status=CASE WHEN ?11 IS NULL THEN commercial_status ELSE 'unverified' END,
      commercial_revision=commercial_revision+CASE WHEN ?11 IS NULL THEN 0 ELSE 1 END,commercial_change_id=COALESCE(?11,commercial_change_id)
      WHERE id=?13 AND po_number=?14 AND supplier_id=?15 AND project_name=?16 AND delivery_revision=?17 AND archived_at IS NULL`)
      .bind(poNumber, supplierId, projectName, body.orderDate, body.requiredShipDate, purchaserName, timestamp, actor.id, actor.name, revisionChanged ? 1 : 0, token, terms, orderId, order.po_number, order.supplier_id, order.project_name, order.delivery_revision)];
    if (supplierChanged) statements.push(env.DB.prepare("UPDATE order_settlements SET net_cents=NULL,tax_cents=NULL,payable_cents=NULL WHERE order_id=?1 AND EXISTS(SELECT 1 FROM purchase_orders WHERE id=?1 AND commercial_change_id=?2)").bind(orderId, token));
    const [result] = await env.DB.batch(statements);
    if (!result.meta.changes) return error("采购单已更新，请刷新后再修改", 409);
  } catch (caught) {
    if (String(caught).includes("UNIQUE")) return error("PO 编号已存在，请更换后再保存", 409);
    if (String(caught).includes("price basis")) return error("该订单已有财务记录，不能更换供应商，请先与财务核对", 409);
    throw caught;
  }
  const changes = [supplierChanged && `供应商：${order.supplier_name} → ${supplier.name}`, order.project_name !== projectName && `项目：${order.project_name} → ${projectName}`, order.order_date !== body.orderDate && `下单日期：${order.order_date} → ${body.orderDate}`, order.required_ship_date !== body.requiredShipDate && `要求发货：${order.required_ship_date} → ${body.requiredShipDate}`].filter(Boolean).join("；");
  await recordEvent(env, orderId, "order_info_updated", changes || "采购单基本信息已核对，内容未变化", actor);
  return json({ ok: true });
}

async function updateItemProduction(request: Request, env: Env, orderId: string, itemId: string) {
  const actor = await requireSession(request, env);
  if (actor.role !== "supplier" && !canPurchase(actor.role)) return error("没有权限修改产品阶段", 403);
  if (!(await canAccessOrder(env, actor, orderId))) return error("采购单不存在", 404);
  const order = await env.DB.prepare("SELECT status, order_date FROM purchase_orders WHERE id = ?1").bind(orderId).first<{ status: string; order_date: string }>();
  const editableStatuses = new Set(["in_production", "ready_to_ship", "partial_shipped"]);
  const mayOperateBeforeConfirmation = actor.role === "admin" || actor.supplier_operations === 1;
  if (!order || (!mayOperateBeforeConfirmation && !editableStatuses.has(order.status))) return error("当前订单状态不能修改产品进度", 409);
  const body = await readBody<{ quantity?: number; completionDate?: string | null; workflowStage?: string; photoNotProvided?: boolean }>(request);
  if (Object.keys(body).some((key) => !["completionDate", "workflowStage", "photoNotProvided"].includes(key))) return error("供应商只能修改产品完成时间、生产节点和实图提供状态，不能修改采购数量、价格或要求交期", 403);
  if (body.quantity === undefined && body.completionDate === undefined && body.workflowStage === undefined) return error("请提交需要更新的产品信息");
  if (body.photoNotProvided !== undefined && (typeof body.photoNotProvided !== "boolean" || !["production_complete", "ready_to_ship"].includes(body.workflowStage || ""))) return error("未提供实物图只能在确认生产完成时选择");
  if (body.quantity !== undefined) return error("产品数量由采购单固定，供应商不能修改", 403);
  const workflowStages = new Set(["queued", "in_production", "production_complete", "ready_to_ship", "shipment_complete"]);
  const item = await env.DB.prepare("SELECT id, product_name, completion_date, workflow_stage, shipped_quantity FROM order_items WHERE id = ?1 AND order_id = ?2").bind(itemId, orderId).first<{ id: string; product_name: string; completion_date: string | null; workflow_stage: string; shipped_quantity: number }>();
  if (!item) return error("采购产品不存在", 404);
  if (item.shipped_quantity > 0) return error("此产品已有发货记录，生产信息已锁定", 409);
  const completionDate = body.completionDate === undefined ? item.completion_date : body.completionDate?.trim() || null;
  if (completionDate && !/^\d{4}-\d{2}-\d{2}$/.test(completionDate)) return error("完成时间格式不正确");
  if (completionDate && completionDate < order.order_date) return error("完成时间不能早于下单日期");
  const workflowStage = body.workflowStage === undefined ? item.workflow_stage : body.workflowStage;
  if (body.workflowStage === "shipment_complete") return error("发货完成由提交发货登记后自动更新", 409);
  if (!workflowStages.has(workflowStage)) return error("产品进度节点不正确");
  if (["production_complete", "ready_to_ship"].includes(workflowStage) && !body.photoNotProvided) {
    const photo = await env.DB.prepare("SELECT id FROM attachments WHERE order_id = ?1 AND item_id = ?2 AND kind = 'production_photo' AND deleted_at IS NULL LIMIT 1").bind(orderId, itemId).first();
    if (!photo) return error("请先上传该产品的生产完成实拍照片", 409);
  }
  const timestamp = now();
  const productionCompleted = ["production_complete", "ready_to_ship", "shipment_complete"].includes(workflowStage);
  const assignments: string[] = [];
  const values: unknown[] = [];
  const assign = (column: string, value: unknown) => { values.push(value); assignments.push(`${column} = ?${values.length}`); };
  if (body.completionDate !== undefined) assign("completion_date", completionDate);
  if (body.workflowStage !== undefined) {
    assign("workflow_stage", workflowStage);
    assign("production_completed", productionCompleted ? 1 : 0);
    assign("production_photo_waived", body.photoNotProvided ? 1 : 0);
    const wasCompleted = ["production_complete", "ready_to_ship", "shipment_complete"].includes(item.workflow_stage);
    if (productionCompleted && !wasCompleted) {
      assign("production_completed_at", timestamp);
      assign("production_completed_by", actor.name);
    } else if (!productionCompleted && wasCompleted) {
      assign("production_completed_at", null);
      assign("production_completed_by", null);
    }
  }
  values.push(itemId, orderId);
  const updated = await env.DB.prepare(`UPDATE order_items SET ${assignments.join(", ")} WHERE id = ?${values.length - 1} AND order_id = ?${values.length} AND shipped_quantity = 0 AND EXISTS (SELECT 1 FROM purchase_orders WHERE id = order_items.order_id AND archived_at IS NULL AND (${mayOperateBeforeConfirmation ? "1=1" : "status IN ('in_production', 'ready_to_ship', 'partial_shipped')"}))`).bind(...values).run();
  if (!updated.meta.changes) return error("产品已发货或订单状态已更新，请刷新", 409);
  if (mayOperateBeforeConfirmation && order.status === "pending_confirmation" && body.workflowStage && body.workflowStage !== "queued") {
    await env.DB.prepare("UPDATE purchase_orders SET status = 'in_production', updated_at = ?1 WHERE id = ?2 AND status = 'pending_confirmation' AND archived_at IS NULL").bind(timestamp, orderId).run();
  }
  const totals = await env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN workflow_stage IN ('production_complete', 'ready_to_ship', 'shipment_complete') THEN 1 ELSE 0 END) AS completed FROM order_items WHERE order_id = ?1")
    .bind(orderId).first<{ total: number; completed: number }>();
  const total = Number(totals?.total || 0);
  const completed = Number(totals?.completed || 0);
  const progress = total ? Math.round((completed / total) * 100) : 0;
  await env.DB.prepare("UPDATE purchase_orders SET production_progress = ?1, updated_at = ?2 WHERE id = ?3").bind(progress, timestamp, orderId).run();
  const stageLabels: Record<string, string> = { queued: "排单中", in_production: "生产中", production_complete: "生产完成", ready_to_ship: "生产完成", shipment_complete: "发货完成" };
  const changes = [body.completionDate !== undefined && `完成时间 ${completionDate || "未填写"}`, body.workflowStage !== undefined && `节点 ${stageLabels[workflowStage]}`, body.photoNotProvided && "未提供实物图"].filter(Boolean).join(" · ");
  await recordEvent(env, orderId, "item_production", `更新产品：${item.product_name} · ${changes}（整体 ${progress}%）`, actor);
  return json({ ok: true, progress, completed, total });
}


async function acceptProduct(request: Request, env: Env, orderId: string, itemId: string) {
  const actor = await requireSession(request, env, "purchaser");
  if (!(await canAccessOrder(env, actor, orderId))) return error("采购单不存在", 404);
  const body = await readBody<{ decision?: string; reason?: string; revision?: number }>(request);
  if (!["approved", "rejected"].includes(body.decision || "") || !Number.isInteger(body.revision)) return error("验收参数不正确");
  const reason = actor.role === "admin" && body.decision === "approved" ? "管理员直接验收" : typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length > 2000 || (body.decision === "rejected" && !reason)) return error("退回整改必须填写原因，最多 2000 字");
  const reviewId = id(), timestamp = now();
  const mayOperateBeforeConfirmation = actor.role === "admin" || actor.supplier_operations === 1;
  const [, result] = await env.DB.batch([
    env.DB.prepare(`UPDATE purchase_orders SET status = 'in_production', updated_at = ?1
      WHERE id = ?2 AND status = 'pending_confirmation' AND archived_at IS NULL AND ?3 = 1
        AND EXISTS (SELECT 1 FROM order_items i WHERE i.id = ?4 AND i.order_id = ?2 AND i.production_revision = ?5
          AND i.acceptance_status = 'pending' AND i.shipped_quantity = 0 AND i.workflow_stage IN ('production_complete','ready_to_ship')
          AND (i.production_photo_waived = 1 OR EXISTS (SELECT 1 FROM attachments WHERE item_id = i.id AND kind = 'production_photo' AND deleted_at IS NULL)))`)
      .bind(timestamp, orderId, mayOperateBeforeConfirmation ? 1 : 0, itemId, body.revision),
    env.DB.prepare(`INSERT INTO product_acceptances (id,order_id,item_id,production_revision,decision,reason,photo_ids,actor_id,actor_name,created_at)
      SELECT ?1,i.order_id,i.id,i.production_revision,?4,?5,
        (SELECT json_group_array(id) FROM attachments WHERE item_id = i.id AND kind = 'production_photo' AND deleted_at IS NULL),?6,?7,?8
      FROM order_items i JOIN purchase_orders p ON p.id = i.order_id
      WHERE i.id = ?2 AND i.order_id = ?3 AND i.production_revision = ?9 AND i.acceptance_status = 'pending'
        AND i.shipped_quantity = 0 AND p.archived_at IS NULL
        AND (?10 = 1 OR (?11 = 1 AND i.workflow_stage IN ('production_complete','ready_to_ship')
          AND p.status IN ('pending_confirmation','in_production','ready_to_ship')
          AND (i.production_photo_waived = 1 OR EXISTS (SELECT 1 FROM attachments WHERE item_id = i.id AND kind = 'production_photo' AND deleted_at IS NULL))) OR (i.workflow_stage IN ('production_complete','ready_to_ship')
          AND p.status IN ('in_production','ready_to_ship')
          AND (i.production_photo_waived = 1 OR EXISTS (SELECT 1 FROM attachments WHERE item_id = i.id AND kind = 'production_photo' AND deleted_at IS NULL))))`)
      .bind(reviewId, itemId, orderId, body.decision, reason, actor.id, actor.name, timestamp, body.revision, actor.role === "admin" && body.decision === "approved" ? 1 : 0, mayOperateBeforeConfirmation ? 1 : 0),
    env.DB.prepare(`INSERT INTO order_events (id,order_id,event_type,detail,actor_id,actor_name,created_at)
      SELECT ?1,?2,'product_acceptance',?3 || i.product_name || ?4,?5,?6,?7
      FROM product_acceptances a JOIN order_items i ON i.id=a.item_id WHERE a.id=?8`)
      .bind(id(), orderId, body.decision === "approved" ? "采购验收通过：" : "采购退回整改：", reason ? " · " + reason : "", actor.id, actor.name, timestamp, reviewId),
  ]);
  if (!result.meta.changes) return error("产品尚未完成、缺少实拍、已发货或验收版本已变化，请刷新核对", 409);
  return json({ ok: true });
}

async function createShipment(request: Request, env: Env, orderId: string) {
  const actor = await requireSession(request, env);
  if (!(await canAccessOrder(env, actor, orderId))) return error("采购单不存在", 404);
  const order = await env.DB.prepare("SELECT po.status, po.shipment_status, po.order_date, s.is_online_purchase FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id WHERE po.id = ?1")
    .bind(orderId).first<{ status: string; shipment_status: string; order_date: string; is_online_purchase: number }>();
  if (!order || !["pending_confirmation", "in_production", "ready_to_ship"].includes(order.status) || order.shipment_status === "complete") return error("当前状态不能登记发货", 409);
  const onlinePurchase = order.is_online_purchase === 1;
  if (!(onlinePurchase ? canPurchase(actor.role) : canOperateSupplier(actor))) return error("当前账号不能登记发货", 403);
  if (order.status !== "ready_to_ship") {
    const eligible = await env.DB.prepare("SELECT 1 FROM order_items WHERE order_id = ?1 AND shipped_quantity < quantity AND acceptance_status = 'approved' AND workflow_stage IN ('production_complete','ready_to_ship') LIMIT 1").bind(orderId).first();
    if (!eligible) return error("请先完成产品验收并进入待发货", 409);
  }

  const form = await request.formData();
  const shippedAt = String(form.get("shippedAt") || "");
  const quantity = Number(form.get("quantity"));
  const isComplete = String(form.get("isComplete") || "") === "true";
  const carrier = String(form.get("carrier") || "").trim();
  const trackingNumber = String(form.get("trackingNumber") || "").trim();
  const boxCount = Number(form.get("boxCount"));
  const photos = form.getAll("photo");
  const deliveryNotes = form.getAll("deliveryNote");
  if (!shippedAt || !Number.isInteger(quantity) || quantity < 1 || !carrier || !trackingNumber || !Number.isInteger(boxCount) || boxCount <= 0) return error("请完整填写发货登记，发货数量和箱数必须是整数");
  if (shippedAt < order.order_date) return error("实际发货日期不能早于下单日期");
  if (!onlinePurchase && !deliveryNotes.length) return error("请上传送货单附件");
  const files: { file: File; buffer: ArrayBuffer; kind: string }[] = [];
  for (const [kind, entries] of [["shipment_photo", photos], ["delivery_note", deliveryNotes]] as const) {
    for (const file of entries) {
      if (!(file instanceof File) || !file.size || file.size > 15 * 1024 * 1024) return error("文件不能为空，且单个文件不能超过 15MB");
      if (BLOCKED_UPLOAD_TYPES.has(file.type)) return error("不支持 SVG、HTML 或 XML 文件");
      const buffer = await file.arrayBuffer();
      if ((kind === "shipment_photo" || file.type.startsWith("image/")) && (!RASTER_TYPES.has(file.type) || sniffRaster(buffer) !== file.type)) return error("图片只支持经过校验的 JPG、PNG 或 WebP");
      files.push({ file, buffer, kind });
    }
  }
  if (files.filter(entry => entry.kind === "delivery_note" && !entry.file.type.startsWith("image/")).length > 1) return error("送货单表单只能上传一份，图片可以多张");

  let lines: Array<{ itemId: string; quantity: number }>;
  try { lines = JSON.parse(String(form.get("items") || "[]")); } catch { return error("发货产品明细格式不正确"); }
  if (!Array.isArray(lines) || !lines.length || lines.some(line => !line || typeof line.itemId !== "string" || !Number.isInteger(line.quantity) || line.quantity <= 0) || new Set(lines.map(line => line.itemId)).size !== lines.length) return error("请选择本次发货产品并填写整数数量");
  if (lines.reduce((sum, line) => sum + line.quantity, 0) !== quantity) return error("产品明细数量与本次发货总数不一致");
  const productRows = (await env.DB.prepare("SELECT id, quantity, shipped_quantity, acceptance_status, workflow_stage, production_photo_waived FROM order_items WHERE order_id = ?1").bind(orderId).all()).results as Array<{ id: string; quantity: number; shipped_quantity: number; acceptance_status: string; workflow_stage: string; production_photo_waived: number }>;
  for (const line of lines) { const product = productRows.find(item => item.id === line.itemId); if (!product || line.quantity > product.quantity - product.shipped_quantity) return error("产品不属于本单或本次发货超过产品剩余数量"); }
  if (!onlinePurchase && lines.some(line => productRows.find(item => item.id === line.itemId)?.acceptance_status !== "approved")) return error("本次发货产品尚未通过采购验收，不能发货", 409);
  if (!onlinePurchase && lines.some(line => !["production_complete", "ready_to_ship"].includes(productRows.find(item => item.id === line.itemId)?.workflow_stage || ""))) return error("本次发货产品尚未进入待发货，不能发货", 409);
  const photographedItems = (await env.DB.prepare("SELECT DISTINCT item_id FROM attachments WHERE order_id = ?1 AND kind = 'production_photo' AND deleted_at IS NULL AND item_id IS NOT NULL").bind(orderId).all()).results;
  if (!onlinePurchase && lines.some(line => !photographedItems.some(photo => photo.item_id === line.itemId) && productRows.find(item => item.id === line.itemId)?.production_photo_waived !== 1)) return error("本次发货产品缺少实拍照片，且未记录“未提供实物图”", 409);
  const totals = await env.DB.prepare(
    `SELECT (SELECT COALESCE(SUM(quantity), 0) FROM order_items WHERE order_id = ?1) AS ordered,
            (SELECT COALESCE(SUM(quantity), 0) FROM shipment_records WHERE order_id = ?1) AS shipped`,
  ).bind(orderId).first<{ ordered: number; shipped: number }>();
  if (productRows.reduce((sum, item) => sum + item.shipped_quantity, 0) !== Number(totals?.shipped || 0)) return error("历史部分发货缺少产品明细，请先由采购核实，不能推测产品已发数量", 409);
  const remaining = Number(totals?.ordered || 0) - Number(totals?.shipped || 0);
  if (quantity > remaining + 0.0001) return error(`本次发货数量超过待发数量 ${remaining}`);
  const shipsAllRemaining = Math.abs(quantity - remaining) < 0.0001;
  if (isComplete !== shipsAllRemaining) return error(shipsAllRemaining ? "本次数量已全部发完，请勾选“全部发完”" : `勾选全部发完时，本次数量应为 ${remaining}`);

  const shipmentId = id();
  const timestamp = now();
  const attachments = files.map(entry => { const fileId = id(); return { ...entry, fileId, key: `${orderId}/shipment/${shipmentId}/${fileId}-${safeFileName(entry.file.name)}` }; });
  try {
    for (const entry of attachments) await env.FILES.put(entry.key, entry.buffer, { httpMetadata: { contentType: entry.file.type || "application/octet-stream" } });
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO shipment_records (id, shipment_number, order_id, quantity, is_complete, carrier, tracking_number, box_count, shipped_at, created_by, created_at)
        SELECT ?1, printf('SH-%03d', COALESCE(MAX(CAST(substr(shipment_number, 4) AS INTEGER)), 0) + 1), ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10 FROM shipment_records HAVING COALESCE(SUM(CASE WHEN order_id = ?2 THEN quantity ELSE 0 END), 0) = ?11`)
        .bind(shipmentId, orderId, quantity, isComplete ? 1 : 0, carrier, trackingNumber, boxCount, shippedAt, actor.id, timestamp, Number(totals?.shipped || 0)),
      ...lines.map(line => env.DB.prepare("INSERT INTO shipment_items (shipment_id, item_id, quantity) VALUES (?1, ?2, ?3)").bind(shipmentId, line.itemId, line.quantity)),
      ...attachments.map(entry => env.DB.prepare("INSERT INTO shipment_attachments (id, shipment_id, order_id, kind, file_name, content_type, r2_key, uploaded_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)")
        .bind(entry.fileId, shipmentId, orderId, entry.kind, entry.file.name, entry.file.type || "application/octet-stream", entry.key, actor.id, timestamp)),
      env.DB.prepare("UPDATE purchase_orders SET status = ?1, shipment_status = ?2, carrier = ?3, tracking_number = ?4, shipped_at = ?5, updated_at = ?6 WHERE id = ?7 AND status IN ('pending_confirmation','in_production','ready_to_ship')")
        .bind(isComplete ? "shipped" : "ready_to_ship", isComplete ? "complete" : "partial", carrier, trackingNumber, shippedAt, timestamp, orderId),

      env.DB.prepare("INSERT INTO order_events (id, order_id, event_type, detail, actor_id, actor_name, created_at) VALUES (?1, ?2, 'shipment', ?3, ?4, ?5, ?6)")
        .bind(id(), orderId, `${isComplete ? "全部发货" : "部分发货"} ${quantity} 件 · ${carrier} · ${trackingNumber}`, actor.id, actor.name, timestamp),
    ]);
  } catch (caught) {
    await Promise.all(attachments.map(entry => env.FILES.delete(entry.key)));
    throw caught;
  }
  const shipment = await env.DB.prepare("SELECT shipment_number FROM shipment_records WHERE id = ?1").bind(shipmentId).first<{ shipment_number: string }>();
  return json({ ok: true, shipmentId, shipmentNumber: shipment?.shipment_number, status: isComplete ? "shipped" : "partial_shipped" }, 201);
}

async function transition(request: Request, env: Env, orderId: string, action: string) {
  const actor = await requireSession(request, env);
  if (action === "received") return error("请由仓库部在产品明细中逐项确认收货", 403);
  if (actor.role === "engineering") return error("部门管理只读查看", 403);
  if (!(await canAccessOrder(env, actor, orderId))) return error("采购单不存在", 404);
  const order = await env.DB.prepare("SELECT status, order_date FROM purchase_orders WHERE id = ?1").bind(orderId).first<{ status: string; order_date: string }>();
  if (!order) return error("采购单不存在", 404);
  const timestamp = now();
  if (action === "confirm") {
    if (!canOperateSupplier(actor) || order.status !== "pending_confirmation") return error("当前状态不能确认采购单", 409);
    const body = await readBody<{ promisedShipDate?: string }>(request);
    if (Object.keys(body).some((key) => key !== "promisedShipDate")) return error("确认订单只能提交原承诺发货日期", 403);
    if (!validDate(body.promisedShipDate)) return error("请填写有效的承诺发货日期");
    if (body.promisedShipDate < order.order_date) return error("承诺发货日期不能早于下单日期");
    const result = await env.DB.prepare(`UPDATE purchase_orders SET status = 'in_production', promised_ship_date = ?1, estimated_ship_date = ?1, production_progress = 0, updated_at = ?2,
      delivery_actor_id = ?4, delivery_actor_name = ?5, delivery_change_reason = '供应商首次确认承诺交期', delivery_revision = delivery_revision + 1
      WHERE id = ?3 AND status = 'pending_confirmation' AND archived_at IS NULL`).bind(body.promisedShipDate, timestamp, orderId, actor.id, actor.name).run();
    if (!result.meta.changes) return error("订单状态已被更新，请刷新后重试", 409);
    await recordEvent(env, orderId, "confirmed", `${actor.role === "supplier" ? "供应商" : "采购代供应商"}确认订单，承诺 ${body.promisedShipDate} 发货`, actor);
  } else if (action === "progress") {
    if (!canOperateSupplier(actor) || order.status !== "in_production") return error("当前状态不能更新生产进度", 409);
    const body = await readBody<{ note?: string }>(request);
    await env.DB.prepare("UPDATE purchase_orders SET production_note = ?1, updated_at = ?2 WHERE id = ?3").bind(body.note?.trim() || "", timestamp, orderId).run();
    await recordEvent(env, orderId, "progress", `更新生产说明${body.note ? `：${body.note.trim()}` : ""}`, actor);
  } else if (action === "production-complete") {
    if (!canOperateSupplier(actor) || order.status !== "in_production") return error("当前状态不能完成生产", 409);
    const unapproved = await env.DB.prepare("SELECT id FROM order_items WHERE order_id = ?1 AND acceptance_status != 'approved' LIMIT 1").bind(orderId).first();
    if (unapproved) return error("请等待采购验收通过后再发货", 409);
    const missingPhoto = await env.DB.prepare("SELECT id FROM order_items i WHERE order_id = ?1 AND i.production_photo_waived = 0 AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.item_id = i.id AND a.kind = 'production_photo' AND a.deleted_at IS NULL) LIMIT 1").bind(orderId).first();
    if (missingPhoto) return error("请先为每个产品上传生产实拍照片", 409);
    const incomplete = await env.DB.prepare("SELECT COUNT(*) AS count FROM order_items WHERE order_id = ?1 AND workflow_stage NOT IN ('production_complete', 'ready_to_ship', 'shipment_complete')").bind(orderId).first<{ count: number }>();
    if (Number(incomplete?.count || 0) > 0) return error("请先勾选全部产品已完成", 409);
    const [result] = await env.DB.batch([
      env.DB.prepare("UPDATE purchase_orders SET status = 'ready_to_ship', production_progress = 100, updated_at = ?1 WHERE id = ?2 AND status = 'in_production'").bind(timestamp, orderId),
      env.DB.prepare("UPDATE order_items SET workflow_stage = 'ready_to_ship', production_completed = 1 WHERE order_id = ?1 AND workflow_stage IN ('production_complete', 'ready_to_ship')").bind(orderId),
    ]);
    if (!result.meta.changes) return error("订单状态已被更新，请刷新后重试", 409);
    await recordEvent(env, orderId, "production_complete", "生产完成，等待发货", actor);
  } else if (action === "complete") {
    if (!canPurchase(actor.role) || order.status !== "received") return error("请先确认到货", 409);
    const result = await env.DB.prepare("UPDATE purchase_orders SET status = 'completed', updated_at = ?1 WHERE id = ?2 AND status = 'received'").bind(timestamp, orderId).run();
    if (!result.meta.changes) return error("订单状态已被更新，请刷新后重试", 409);
    await recordEvent(env, orderId, "completed", "采购单已完结", actor);
  } else {
    return error("未知操作", 404);
  }
  return json({ ok: true });
}

function safeFileName(fileName: string) {
  return fileName.normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(0, 120) || "file";
}

const RASTER_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const BLOCKED_UPLOAD_TYPES = new Set(["image/svg+xml", "text/html", "application/xhtml+xml", "text/xml", "application/xml"]);

function sniffRaster(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

async function upload(request: Request, env: Env, orderId: string) {
  const actor = await requireSession(request, env);
  if (!(await canAccessOrder(env, actor, orderId))) return error("采购单不存在", 404);
  const order = await env.DB.prepare("SELECT status FROM purchase_orders WHERE id = ?1").bind(orderId).first<{ status: string }>();
  if (!order) return error("采购单不存在", 404);
  const form = await request.formData();
  const file = form.get("file");
  const requestedKind = String(form.get("kind") || "");
  const scene = requestedKind === "scene_image";
  const kind = scene ? "product_image" : requestedKind;
  const itemId = String(form.get("itemId") || "") || null;
  if (scene && (!canPurchase(actor.role) || itemId)) return error("仅采购或管理员可上传订单场景大图",403);
  if (!(file instanceof File)) return error("请选择文件");
  const allowed = canPurchase(actor.role) ? new Set(["purchase_order", "product_image", "production_photo"]) : new Set(["production_photo", "shipment_photo"]);
  if (!allowed.has(kind)) return error("当前账号不能上传此类附件", 403);
  if (kind === "production_photo" && !["pending_confirmation", "in_production", "ready_to_ship"].includes(order.status)) return error("发货后不能修改产品实拍照片", 409);
  if (kind === "production_photo" && !itemId) return error("请为生产照片选择对应产品");
  if (actor.role === "supplier" && kind === "shipment_photo" && order.status !== "ready_to_ship") return error("只能在待发货阶段上传发货照片", 409);
  if (file.size > 15 * 1024 * 1024) return error("单个文件不能超过 15MB");
  if (BLOCKED_UPLOAD_TYPES.has(file.type)) return error("不支持 SVG、HTML 或 XML 文件");
  const fileBuffer = await file.arrayBuffer();
  const detectedRaster = sniffRaster(fileBuffer);
  if (kind !== "purchase_order") {
    if (!RASTER_TYPES.has(file.type) || detectedRaster !== file.type) return error("照片和产品图片只支持经过校验的 JPG、PNG 或 WebP");
  } else if (file.type.startsWith("image/") && (!RASTER_TYPES.has(file.type) || detectedRaster !== file.type)) {
    return error("图片附件只支持经过校验的 JPG、PNG 或 WebP");
  }
  if (itemId) {
    const item = await env.DB.prepare("SELECT id, shipped_quantity FROM order_items WHERE id = ?1 AND order_id = ?2").bind(itemId, orderId).first<{ id: string; shipped_quantity: number }>();
    if (!item) return error("产品明细不存在");
    if (kind === "production_photo" && item.shipped_quantity > 0) return error("该产品已发货，实拍照片已锁定", 409);
  }
  const attachmentId = id();
  const key = `${orderId}/${kind}/${attachmentId}-${safeFileName(file.name)}`;
  await env.FILES.put(key, fileBuffer, { httpMetadata: { contentType: file.type || "application/octet-stream" } });
  await env.DB.prepare("INSERT INTO attachments (id, order_id, item_id, kind, file_name, content_type, r2_key, uploaded_by, created_at, purpose) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)")
    .bind(attachmentId, orderId, itemId, kind, file.name, file.type || "application/octet-stream", key, actor.id, now(),scene ? "scene" : null).run();
  if (kind === "production_photo" && itemId) await env.DB.prepare("UPDATE order_items SET production_photo_waived = 0 WHERE id = ?1 AND order_id = ?2").bind(itemId, orderId).run();
  await recordEvent(env, orderId, "attachment", `上传了${scene ? "场景大图" : kind === "production_photo" ? "生产照片" : kind === "shipment_photo" ? "发货照片" : kind === "product_image" ? "产品图片" : "采购单附件"}：${file.name}`, actor);
  return json({ ok: true, attachmentId }, 201);
}

async function deleteProductionPhoto(request: Request, env: Env, attachmentId: string) {
  const actor = await requireSession(request, env);
  if (!(actor.role === "admin" || (canPurchase(actor.role) && actor.supplier_operations === 1))) return error("没有权限删除产品实拍", 403);
  const attachment = await env.DB.prepare("SELECT a.id,a.deleted_at FROM attachments a JOIN order_items i ON i.id=a.item_id JOIN purchase_orders p ON p.id=a.order_id WHERE a.id=?1 AND a.kind='production_photo' AND i.shipped_quantity=0 AND p.archived_at IS NULL").bind(attachmentId).first();
  if (!attachment) return error("照片不存在、已发货或订单已作废，不能删除",409);
  if (attachment.deleted_at) return json({ok:true});
  try {
    await env.DB.prepare("UPDATE attachments SET deleted_at=?1,deleted_by=?2 WHERE id=?3 AND deleted_at IS NULL").bind(now(),actor.id,attachmentId).run();
  } catch (caught) {
    if (String(caught).includes("实拍照片已锁定")) return error("照片已锁定，请刷新核对",409);
    throw caught;
  }
  return json({ok:true});
}

async function download(request: Request, env: Env, attachmentId: string) {
  const actor = await requireSession(request, env);
  if (actor.role === "finance" || actor.role === "engineering") return error("当前账号不能访问采购执行附件", 403);
  const attachment = await env.DB.prepare(
    "SELECT a.*, po.supplier_id, po.archived_at FROM attachments a JOIN purchase_orders po ON po.id = a.order_id WHERE a.id = ?1",
  ).bind(attachmentId).first<{ kind: string; r2_key: string; file_name: string; content_type: string; supplier_id: string; archived_at: string | null }>();
  if (actor.role === "office" && !attachment?.content_type?.startsWith("image/")) return error("总经办不能下载表单", 403);
  if (actor.role === "warehouse" && attachment?.kind !== "production_photo") return error("仓库只能查看产品实拍", 403);
  if (!attachment || (actor.role === "supplier" && (actor.supplier_id !== attachment.supplier_id || attachment.archived_at))) return error("附件不存在", 404);
  const object = await env.FILES.get(attachment.r2_key);
  if (!object) return error("附件文件不存在", 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", attachment.content_type);
  const disposition = RASTER_TYPES.has(attachment.content_type) ? "inline" : "attachment";
  headers.set("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(attachment.file_name)}`);
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", "private, max-age=300");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
  return new Response(object.body, { headers });
}

async function downloadShipmentAttachment(request: Request, env: Env, attachmentId: string) {
  const actor = await requireSession(request, env);
  if (actor.role === "finance" || actor.role === "engineering" || actor.role === "warehouse" || actor.role === "office") return error("当前账号不能访问采购执行附件", 403);
  const attachment = await env.DB.prepare(
    "SELECT a.r2_key, a.file_name, a.content_type, po.supplier_id, po.archived_at FROM shipment_attachments a JOIN purchase_orders po ON po.id = a.order_id WHERE a.id = ?1",
  ).bind(attachmentId).first<{ r2_key: string; file_name: string; content_type: string; supplier_id: string; archived_at: string | null }>();
  if (!attachment || (actor.role === "supplier" && (actor.supplier_id !== attachment.supplier_id || attachment.archived_at))) return error("附件不存在", 404);
  const object = await env.FILES.get(attachment.r2_key);
  if (!object) return error("附件文件不存在", 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", attachment.content_type);
  headers.set("Content-Disposition", `${RASTER_TYPES.has(attachment.content_type) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.file_name)}`);
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", "private, max-age=300");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
  return new Response(object.body, { headers });
}

async function handleApi(request: Request, env: Env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith("/api/auth/") && path !== "/api/account/password" && !path.startsWith("/api/setup/") && request.method !== "GET") {
    const actor = await requireSession(request, env);
    if (["office","engineering"].includes(actor.role)) return error("此账号只读，不能修改业务资料", 403);
  }
  if (path === "/api/setup/status" && request.method === "GET") {
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>();
    return json({ needsSetup: Number(count?.count || 0) === 0 });
  }
  if (path === "/api/setup/admin" && request.method === "POST") return createInitialAdmin(request, env);
  if (path === "/api/auth/login" && request.method === "POST") return login(request, env);
  if (path === "/api/auth/logout" && request.method === "POST") return logout(request, env);
  if (path === "/api/account/password" && request.method === "POST") return changeOwnPassword(request, env);
  if (path === "/api/auth/session" && request.method === "GET") {
    const user = await getSession(request, env);
    return json({ authenticated: Boolean(user), user });
  }
  if (path === "/api/dashboard" && request.method === "GET") return dashboard(request, env);
  if (path === "/api/finance" && request.method === "GET") return financeDashboard(request, env);
  if (path === "/api/staff" && ["GET", "POST"].includes(request.method)) return staffAccounts(request, env);
  const staffMatch = path.match(/^\/api\/staff\/([^/]+)$/);
  const warehouseMatch = path.match(/^\/api\/orders\/([^/]+)\/items\/([^/]+)\/warehouse$/);
  const freightMatch = path.match(/^\/api\/orders\/([^/]+)\/items\/([^/]+)\/freight-payment$/);
  const packagingVolumeMatch = path.match(/^\/api\/orders\/([^/]+)\/items\/([^/]+)\/packaging-volume$/);
  const itemDetailsMatch = path.match(/^\/api\/orders\/([^/]+)\/items\/([^/]+)\/details$/);
  const correctionMatch = path.match(/^\/api\/orders\/([^/]+)\/items\/([^/]+)\/corrections$/);
  if(correctionMatch && request.method==='POST') return correctItem(request,env,correctionMatch[1],correctionMatch[2]);
  if (freightMatch && request.method === "PATCH") return updateFreightPayment(request, env, freightMatch[1], freightMatch[2]);
  if (packagingVolumeMatch && request.method === "PATCH") return updatePackagingVolume(request, env, packagingVolumeMatch[1], packagingVolumeMatch[2]);
  if (itemDetailsMatch && request.method === "PATCH") return updateOrderItemDetails(request, env, itemDetailsMatch[1], itemDetailsMatch[2]);
  if (warehouseMatch && request.method === "POST") return warehouseAction(request, env, warehouseMatch[1], warehouseMatch[2]);
  if (staffMatch && request.method === "PATCH") return editStaffAccount(request, env, staffMatch[1]);
  const supplierTermsMatch = path.match(/^\/api\/suppliers\/([^/]+)\/commercial-terms$/);
  if (supplierTermsMatch && request.method === "PATCH") return saveSupplierTerms(request, env, supplierTermsMatch[1]);
  const orderTermsMatch = path.match(/^\/api\/orders\/([^/]+)\/commercial-terms$/);
  if (orderTermsMatch && request.method === "PATCH") return saveOrderTerms(request, env, orderTermsMatch[1]);
  const financialEntryMatch = path.match(/^\/api\/orders\/([^/]+)\/financial-entries$/);
  if (financialEntryMatch && request.method === "POST") return createFinancialEntry(request, env, financialEntryMatch[1]);
  const financeSettlementMatch = path.match(/^\/api\/orders\/([^/]+)\/finance-settlement$/);
  if (financeSettlementMatch && request.method === "PATCH") return saveFinanceSettlement(request, env, financeSettlementMatch[1]);
  if (path === "/api/suppliers" && request.method === "POST") return createSupplier(request, env);
  const supplierMatch = path.match(/^\/api\/suppliers\/([^/]+)$/);
  if (supplierMatch && request.method === "PATCH") return updateSupplier(request, env, supplierMatch[1]);
  if (supplierMatch && request.method === "DELETE") return removeSupplier(request, env, supplierMatch[1]);
  if (path === "/api/orders" && request.method === "POST") return createOrder(request, env);
  const orderMatch = path.match(/^\/api\/orders\/([^/]+)$/);
  if (orderMatch && request.method === "DELETE") return removeOrder(request, env, orderMatch[1]);
  const internalMatch = path.match(/^\/api\/orders\/([^/]+)\/internal$/);
  if (internalMatch && request.method === "PATCH") return updateInternal(request, env, internalMatch[1]);
  const identityMatch = path.match(/^\/api\/orders\/([^/]+)\/identity$/);
  if (identityMatch && request.method === "PATCH") return updateOrderIdentity(request, env, identityMatch[1]);
  const deliveryMatch = path.match(/^\/api\/orders\/([^/]+)\/delivery-estimate$/);
  if (deliveryMatch && request.method === "PATCH") return updateDeliveryEstimate(request, env, deliveryMatch[1]);
  const itemProductionMatch = path.match(/^\/api\/orders\/([^/]+)\/items\/([^/]+)\/production$/);
  if (itemProductionMatch && request.method === "PATCH") return updateItemProduction(request, env, itemProductionMatch[1], itemProductionMatch[2]);
  const orderItemMatch = path.match(/^\/api\/orders\/([^/]+)\/items\/([^/]+)$/);
  if (orderItemMatch && request.method === "DELETE") return removeOrderItem(request, env, orderItemMatch[1], orderItemMatch[2]);
  const acceptanceMatch = path.match(/^\/api\/orders\/([^/]+)\/items\/([^/]+)\/acceptance$/);
  if (acceptanceMatch && request.method === "POST") return acceptProduct(request, env, acceptanceMatch[1], acceptanceMatch[2]);
  const shipmentMatch = path.match(/^\/api\/orders\/([^/]+)\/shipments$/);
  if (shipmentMatch && request.method === "POST") return createShipment(request, env, shipmentMatch[1]);
  const actionMatch = path.match(/^\/api\/orders\/([^/]+)\/(confirm|progress|production-complete|received|complete)$/);
  if (actionMatch && request.method === "POST") return transition(request, env, actionMatch[1], actionMatch[2]);
  const uploadMatch = path.match(/^\/api\/orders\/([^/]+)\/attachments$/);
  if (uploadMatch && request.method === "POST") return upload(request, env, uploadMatch[1]);
  const downloadMatch = path.match(/^\/api\/attachments\/([^/]+)$/);
  if (downloadMatch && request.method === "DELETE") return deleteProductionPhoto(request, env, downloadMatch[1]);
  if (downloadMatch && request.method === "GET") return download(request, env, downloadMatch[1]);
  const shipmentDownloadMatch = path.match(/^\/api\/shipment-attachments\/([^/]+)$/);
  if (shipmentDownloadMatch && request.method === "GET") return downloadShipmentAttachment(request, env, shipmentDownloadMatch[1]);
  return error("接口不存在", 404);
}

function dateInShanghai(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const part = (type: string) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

async function generateOrderReminders(env: Env) {
  const today = dateInShanghai();
  const rows = (await env.DB.prepare(
    `SELECT po.id, COALESCE(po.promised_ship_date, po.required_ship_date) AS target_date,
            (SELECT COALESCE(SUM(quantity), 0) FROM order_items WHERE order_id = po.id) AS ordered_quantity,
            (SELECT COALESCE(SUM(quantity), 0) FROM shipment_records WHERE order_id = po.id) AS shipped_quantity
     FROM purchase_orders po
     WHERE po.archived_at IS NULL AND po.status IN ('pending_confirmation', 'in_production', 'ready_to_ship')`,
  ).all()).results as Array<{ id: string; target_date: string; ordered_quantity: number; shipped_quantity: number }>;
  const statements: D1PreparedStatement[] = [];
  for (const row of rows) {
    const remaining = Number(row.ordered_quantity) - Number(row.shipped_quantity);
    if (!row.target_date || remaining <= 0) continue;
    const days = Math.round((Date.parse(`${row.target_date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
    let type: "seven_days" | "three_days" | "one_day" | "due_today" | "overdue" | null = null;
    let message = "";
    if (days === 7) { type = "seven_days"; message = "距离发货还有7天，请确认交期。"; }
    else if (days === 3) { type = "three_days"; message = "距离发货还有3天，请确认交期。"; }
    else if (days === 1) { type = "one_day"; message = "明天必须发货，请及时登记发货信息。"; }
    else if (days === 0) { type = "due_today"; message = `今天必须发货，当前仍有 ${remaining} 件待发。`; }
    else if (days < 0) { type = "overdue"; message = `已延期 ${Math.abs(days)} 天，当前仍有 ${remaining} 件待发。`; }
    if (!type) continue;
    const reminderKey = `${row.target_date}:${type}${type === "overdue" ? `:${Math.abs(days)}` : ""}`;
    statements.push(env.DB.prepare("INSERT OR IGNORE INTO order_reminders (id, order_id, reminder_key, reminder_type, message, target_date, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
      .bind(id(), row.id, reminderKey, type, message, row.target_date, now()));
  }
  if (statements.length) await env.DB.batch(statements);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) return await handleApi(request, env);
      return env.ASSETS.fetch(request);
    } catch (caught) {
      if (caught instanceof Response) return caught;
      console.error(caught);
      return error("系统暂时无法处理该请求，请稍后重试", 500);
    }
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(generateOrderReminders(env));
  },
} satisfies ExportedHandler<Env>;
