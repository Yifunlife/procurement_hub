import { useState, type FormEvent } from "react";
import { api } from "./api";
import { roleLabel } from "./Commercial";
import type { User } from "./types";

export function Account({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (newPassword !== confirmPassword) { setError("两次输入的新密码不一致"); return; }
    setBusy(true); setError("");
    try {
      await api("/api/account/password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword, confirmPassword }) });
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword(""); setSaved(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "修改失败，请重试"); }
    finally { setBusy(false); }
  }
  return <section className="finance-surface">
    <h2>个人账号信息</h2>
    <dl className="terms-summary"><div><dt>姓名</dt><dd>{user.name}</dd></div><div><dt>登录邮箱</dt><dd>{user.email}</dd></div><div><dt>账号角色</dt><dd>{roleLabel[user.role]}</dd></div></dl>
    {saved ? <div role="status"><p>密码已修改，所有旧登录已失效。请使用新密码重新登录。</p><button className="primary" onClick={onLogout}>返回登录</button></div> : <form className="entity-form" onSubmit={submit}>
      <h3>修改密码</h3>
      <p>新密码至少 10 位。修改成功后，所有设备都需要重新登录。姓名、邮箱和角色由管理员维护。</p>
      <div className="form-grid">
        <label>原密码<input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} maxLength={256} required disabled={busy} /></label>
        <label>新密码<input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={10} maxLength={256} required disabled={busy} /></label>
        <label>确认新密码<input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={10} maxLength={256} required disabled={busy} /></label>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions"><button className="primary" disabled={busy}>{busy ? "正在修改" : "确认修改密码"}</button></div>
    </form>}
  </section>;
}
