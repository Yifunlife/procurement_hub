export type Role = "purchaser" | "supplier" | "finance" | "boss" | "admin" | "management" | "engineering" | "warehouse" | "office";
export type CommercialTerms = {
  production: string; transport: string; credit: string; payment: string; invoice: string; minimum_order: string;
  order_materials?: string; notes?: string;
  price_basis: "unknown" | "inclusive" | "exclusive";
  tax_rate_bps: number | null;
  currency: "CNY";
};
export type CommercialHistory = { id: string; previous_json: string | null; actual_json: string; status: string; reason: string; actor_name: string; created_at: string };
export type FinancialEntry = { id: string; kind: "payment" | "invoice" | "cost"; amount_cents: number; record_date: string; reference: string; note: string; reversal_of: string | null; actor_name: string; created_at: string };
export type FinanceOrder = {
  id: string; po_number: string; project_name: string; supplier_name: string; archived_at: string | null;
  commercial_status: string; commercial_terms: CommercialTerms | null; currency: "CNY";
  net_cents: number | null; tax_cents: number | null; payable_cents: number | null;
  finance_confirmed: number; invoice_required: number | null;
  paid_cents: number; invoiced_cents: number; extra_cost_cents: number; unpaid_cents: number | null; cost_cents: number | null;
  entries: FinancialEntry[];
};
export type Status = "pending_confirmation" | "in_production" | "ready_to_ship" | "partial_shipped" | "shipped" | "received" | "completed";
export type ProductType = "配件类" | "电气类" | "安全防护类" | "成品设备类" | "定制加工类";
export type ProductWorkflowStage = "queued" | "in_production" | "production_complete" | "ready_to_ship" | "shipment_complete";

export type User = {
  id: string;
  email: string;
  name: string;
  role: Role;
  supplier_id: string | null;
  supplier_operations?: number;
  finance_settlement?: number;
};

export type Supplier = {
  commercial_terms: CommercialTerms | null;
  commercial_revision: number;
  id: string;
  code: string;
  name: string;
  contact_name: string;
  contact_info: string;
  purchaser_name: string;
  region: string;
  payment_account: string;
  notes: string;
  login_email: string | null;
  created_at: string;
  products: SupplierProduct[];
};

export type SupplierProduct = {
  id: string;
  supplier_id: string;
  product_type: ProductType;
  product_name: string;
  usual_specification: string;
  unit: string;
  default_unit_price: number | null;
  production_cycle: string;
  transport_method: string;
  arrival_time: string;
  settlement_method: string;
  special_invoice_tax: string;
  ordinary_invoice_tax: string;
  order_required_materials: string;
  notes: string;
};

export type OrderItem = {
  id: string;
  order_id: string;
  product_name: string;
  color: string;
  model: string;
  product_type: ProductType;
  quantity: number;
  unit_price: number;
  amount: number;
  received_at: string | null;
  received_quantity: number;
  stocked_quantity: number;
  warehouse_history?: Array<{ action: string; quantity: number; actor_name: string; record_date: string; created_at: string }>;
  correction_history?: Array<{ action: string; quantity: number; reason: string; actor_name: string; created_at: string }>;
  freight_payment_status?: "unknown" | "paid" | "unpaid";
  freight_payment_revision?: number;
  packaging_volume?: string;
  packaging_volume_revision?: number;
  received_by: string | null;
  stocked_at: string | null;
  stocked_by: string | null;
  specification: string;
  material_process: string;
  installation_method: string;
  unit: string;
  production_completed: number;
  production_completed_at: string | null;
  production_completed_by: string | null;
  completion_date: string | null;
  workflow_stage: ProductWorkflowStage;
  shipped_quantity: number;
  acceptance_status: "pending" | "approved" | "rejected";
  production_revision: number;
  production_photo_waived: number;
  acceptance_history: Array<{ id: string; decision: "approved" | "rejected"; reason: string; actorName: string; createdAt: string; revision: number; photoIds: string[] }>;
};

export type Attachment = {
  id: string;
  order_id: string;
  item_id: string | null;
  kind: "purchase_order" | "product_image" | "production_photo" | "shipment_photo";
  purpose?: "scene" | null;
  file_name: string;
  content_type: string;
  created_at: string;
};

export type OrderEvent = {
  id: string;
  order_id: string;
  event_type: string;
  detail: string;
  actor_name: string;
  created_at: string;
};

export type ShipmentRecord = {
  items: Array<{ itemId: string; productName: string; quantity: number }>;
  id: string;
  order_id: string;
  shipment_number: string;
  quantity: number;
  is_complete: number;
  carrier: string;
  tracking_number: string;
  box_count: number;
  shipped_at: string;
  created_at: string;
  attachments: Array<{
    id: string;
    kind: "shipment_photo" | "delivery_note";
    file_name: string;
    content_type: string;
  }>;
};

export type OrderReminder = {
  id: string;
  order_id: string;
  reminder_type: "seven_days" | "three_days" | "one_day" | "due_today" | "overdue";
  message: string;
  target_date: string;
  created_at: string;
};

export type PurchaseOrder = {
  commercial_terms: CommercialTerms | null;
  commercial_revision: number;
  commercial_status: "unverified" | "confirmed";
  commercial_history: CommercialHistory[];
  id: string;
  po_number: string;
  supplier_id: string;
  supplier_code: string;
  supplier_name: string;
  contact_name: string;
  contact_info: string;
  project_name: string;
  order_date: string;
  required_ship_date: string;
  promised_ship_date: string | null;
  estimated_ship_date: string | null;
  delivery_revision: number;
  archived_at: string | null;
  delivery_history: Array<{
    id: string;
    kind: "baseline" | "initial" | "estimate" | "required";
    previous_date: string | null;
    new_date: string;
    reason: string;
    actor_name: string;
    changed_at: string | null;
  }>;
  status: Status;
  purchaser_name: string;
  internal_requirements: string;
  production_progress: number;
  production_note: string;
  carrier: string;
  tracking_number: string;
  shipped_at: string | null;
  updated_at: string;
  items: OrderItem[];
  attachments: Attachment[];
  events: OrderEvent[];
  shipments: ShipmentRecord[];
  reminders: OrderReminder[];
};

export type DashboardData = {
  user: User;
  orders: PurchaseOrder[];
  suppliers: Supplier[];
};
