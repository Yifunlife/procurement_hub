import { useState } from "react";
import { Download } from "lucide-react";
import type { FinanceOrder, PurchaseOrder } from "./types";

type Props = { kind: "purchase"; orders: PurchaseOrder[] } | { kind: "finance"; orders: FinanceOrder[] };
export function ExportButton(props: Props & { single?: boolean; selectedOnly?: boolean }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function download() {
    if (!props.orders.length || busy) return;
    setBusy(true); setError("");
    try {
      const exporter = await import("./exportData");
      const book = props.kind === "purchase" ? exporter.purchaseWorkbook(props.orders, window.location.origin) : exporter.financeWorkbook(props.orders);
      exporter.downloadWorkbook(book, props.kind === "purchase" ? "采购单" : "财务结算", props.orders.length);
    } catch { setError("导出失败，请重试；如仍失败，请减少筛选结果后导出。"); }
    finally { setBusy(false); }
  }
  return <div className="export-control"><button type="button" className="secondary" disabled={busy || !props.orders.length} onClick={() => void download()}><Download size={16} />{busy ? "正在导出…" : "导出 Excel"}</button>{!props.single && <small>{props.selectedOnly ? `已勾选 ${props.orders.length} 单，仅导出勾选内容` : `导出当前筛选的 ${props.orders.length} 单，包含其他页`}</small>}{error && <p className="form-error" role="alert">{error}</p>}</div>;
}
