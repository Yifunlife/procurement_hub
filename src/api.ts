export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && typeof init.body === "string") headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new ApiError(payload.error || "操作失败，请稍后重试", response.status);
  return payload as T;
}

export async function uploadFile(orderId: string, kind: string, file: File, itemId?: string) {
  const form = new FormData();
  form.set("file", file);
  form.set("kind", kind);
  if (itemId) form.set("itemId", itemId);
  return api<{ ok: true }>(`/api/orders/${orderId}/attachments`, { method: "POST", body: form });
}
