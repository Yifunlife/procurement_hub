import { useEffect, useMemo, useState } from "react";
import { Upload, X } from "lucide-react";

type Props = { label: string; accept?: string; disabled?: boolean } & (
  { file: File | null; onFile: (file: File | null) => void; files?: never; onFiles?: never } |
  { files: File[]; onFiles: (files: File[]) => void; file?: never; onFile?: never }
);

export function FilePicker(props: Props) {
  const { label, accept = ".pdf,.doc,.docx,.xls,.xlsx,image/jpeg,image/png,image/webp", disabled = false } = props;
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const files = useMemo(() => props.files ?? (props.file ? [props.file] : []), [props.files, props.file]);
  const previews = useMemo(() => files.map(file => file.type.startsWith("image/") ? URL.createObjectURL(file) : ""), [files]);
  useEffect(() => () => previews.forEach(url => { if (url) URL.revokeObjectURL(url); }), [previews]);
  function select(incoming: File[]) {
    if (disabled || !incoming.length) return;
    setError("");
    if (!props.onFiles && incoming.length > 1) { setError("表单每次只能导入一份，请重新选择。"); return; }
    const invalid = incoming.find(file => !accept.split(",").some(rule => {
      rule = rule.trim().toLowerCase();
      return rule.startsWith(".") ? file.name.toLowerCase().endsWith(rule) : rule.endsWith("/*") ? file.type.startsWith(rule.slice(0, -1)) : file.type === rule;
    }) || file.size === 0 || file.size > 15 * 1024 * 1024);
    if (invalid) { setError(`${invalid.name}：格式不支持、文件为空或超过 15MB，请重新选择。`); return; }
    if (props.onFiles) {
      const next = [...files];
      incoming.forEach(file => { if (!next.some(old => old.name === file.name && old.size === file.size && old.lastModified === file.lastModified)) next.push(file); });
      if (next.filter(file => !file.type.startsWith("image/")).length > 1) { setError("表单只能保留一份；如需替换，请先移除原表单。图片可以多张追加。"); return; }
      props.onFiles(next);
    } else props.onFile(incoming[0]);
  }
  return <div className={`file-picker${disabled ? " disabled" : ""}${dragging ? " is-dragging" : ""}`}
    onDragOver={event => { event.preventDefault(); if (!disabled) setDragging(true); }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={event => { event.preventDefault(); setDragging(false); select(Array.from(event.dataTransfer.files)); }}>
    <label className="file-drop-target"><input type="file" name="attachment" aria-label={label} aria-describedby={error ? "file-picker-error" : undefined} accept={accept} multiple={Boolean(props.onFiles)} disabled={disabled} onChange={event => { select(Array.from(event.target.files || [])); event.target.value = ""; }} /><Upload size={18} aria-hidden="true" /><span><strong>{label}</strong><small>{props.onFiles ? "拖拽或点击选择 · 图片可多张，表单限一份" : "拖拽或点击选择 · 每次一份表单"}</small></span></label>
    {files.length > 0 && <ul className="pending-files">{files.map((file, index) => <li key={`${file.name}-${file.size}-${file.lastModified}`}>
      {previews[index] && <img src={previews[index]} alt={`${file.name} 预览`} width="52" height="52" />}<span>{file.name}</span><button type="button" disabled={disabled} aria-label={`移除待上传文件 ${file.name}`} onClick={() => { setError(""); if (props.onFiles) props.onFiles(files.filter((_, i) => i !== index)); else props.onFile(null); }}><X size={16} aria-hidden="true" /></button>
    </li>)}</ul>}
    {error && <p id="file-picker-error" className="form-error" role="alert">{error}</p>}
  </div>;
}
