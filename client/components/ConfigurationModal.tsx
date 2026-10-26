import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Input, InputNumber, Modal } from 'antd';
import { ArrowLeft, ArrowRight, Check, GitCompareArrows, Settings2 } from 'lucide-react';
import type { ConfigInput, ConfigPreview, ServiceDetail } from '../../shared/types.js';
import { api, ApiError } from '../api.js';
import { messageOf } from './ui.js';

export default function ConfigurationModal({ detail, onClose, onSaved }: { detail: ServiceDetail | null; onClose: () => void; onSaved: () => void }) {
  const { message } = App.useApp();
  const [replicas, setReplicas] = useState(1); const [image, setImage] = useState('');
  const [cpu, setCpu] = useState<number | null>(null); const [memory, setMemory] = useState<number | null>(null); const [capacity, setCapacity] = useState<number | null>(null);
  const [preview, setPreview] = useState<ConfigPreview>(); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const requestId = useRef('');
  useEffect(() => { if (detail) { setReplicas(detail.runtime.replicas); setImage(detail.runtime.image); setCpu(detail.runtime.cpuCores); setMemory(detail.runtime.memoryGB); setCapacity(detail.runtime.maxConcurrency); setPreview(undefined); setError(''); requestId.current = crypto.randomUUID(); } }, [detail]);
  const inspect = async () => {
    if (!detail) return;
    setBusy(true); setError('');
    const config: ConfigInput = { replicas, ...(image !== detail.runtime.image ? { image } : {}), ...(cpu !== null ? { cpuCores: cpu } : {}), ...(memory !== null ? { memoryGB: memory } : {}), ...(capacity !== null ? { maxConcurrency: capacity } : {}) };
    try { setPreview(await api<ConfigPreview>(`/services/${detail.service.id}/config/preview`, { method: 'POST', body: { revision: detail.service.revision, config } })); }
    catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  };
  const publish = async () => {
    if (!detail || !preview) return; setBusy(true); setError('');
    try { await api(`/services/${detail.service.id}/config`, { method: 'POST', body: { previewId: preview.id, requestId: requestId.current } }); message.success('配置变更已提交，请关注运行状态'); onSaved(); onClose(); }
    catch (e) { setError(messageOf(e)); if (e instanceof ApiError && ['preview_expired', 'workload_changed'].includes(e.code)) setPreview(undefined); } finally { setBusy(false); }
  };
  return <Modal open={Boolean(detail)} onCancel={busy ? undefined : onClose} mask={{ closable: !busy }} closable={!busy} width={660} title={null} footer={null} destroyOnHidden>
    <div className="modal-kicker"><Settings2 size={15} />CONFIGURATION CHANGE</div><h2 className="modal-title">{preview ? '确认配置差异' : '扩缩容与配置'}</h2><p className="modal-description">{detail?.service.name} · {preview ? '预检已通过，确认后发布变更。' : '模型身份、权重挂载与 GPU 类型保持模板配置。'}</p>
    {!preview ? <div className="config-form">
      <div className="form-grid"><div><label htmlFor="replicas">目标实例数量</label><InputNumber id="replicas" aria-label="目标实例数量" min={0} max={64} precision={0} value={replicas} onChange={value => setReplicas(value ?? 0)} disabled={busy} /><small>支持 0–64 个副本；0 表示停止，每个副本独立申请资源。</small></div><div><label htmlFor="capacity">单实例容量声明</label><InputNumber id="capacity" min={1} max={100000} value={capacity} onChange={setCapacity} disabled={busy} /><small>用于控制面容量声明，不改引擎启动参数。</small></div><div><label htmlFor="cpu">CPU 申请 / 核</label><InputNumber id="cpu" min={0.25} max={128} step={0.25} value={cpu} onChange={setCpu} disabled={busy} placeholder="保持当前" /></div><div><label htmlFor="memory">内存申请 / GiB</label><InputNumber id="memory" min={0.25} max={1024} step={0.25} value={memory} onChange={setMemory} disabled={busy} placeholder="保持当前" /></div></div>
      <label htmlFor="image">运行镜像</label><Input.TextArea id="image" aria-label="运行镜像" className="mono" autoSize={{ minRows: 2, maxRows: 4 }} value={image} onChange={e => setImage(e.target.value)} disabled={busy} /><small>更新镜像须使用同一仓库的完整 @sha256 digest。</small>
      <div className="form-notice"><GitCompareArrows size={16} /><span>下一步检查完整目标配置并展示差异，不会立即修改运行中的服务。</span></div>
    </div> : <div className="config-review"><div className="check-success"><Check size={16} />配置预检通过<span>有效期至 {new Date(preview.expiresAt).toLocaleTimeString('zh-CN', { hour12: false })}</span></div><div className="diff-table"><div className="diff-header"><span>配置项</span><span>当前值</span><span>目标值</span></div>{preview.changes.map(change => <div className="diff-row" key={change.field}><strong>{change.field}</strong><code>{change.before}</code><code>{change.after}</code></div>)}</div><div className="review-notes">{preview.warnings.map(warning => <p key={warning}>{warning}</p>)}</div></div>}
    {error && <Alert className="inline-alert" title={error} type="error" showIcon />}
    <div className="modal-actions"><Button disabled={busy} onClick={preview ? () => { setPreview(undefined); setError(''); requestId.current = crypto.randomUUID(); } : onClose}>{preview && <ArrowLeft size={14} />}{preview ? '返回编辑' : '取消'}</Button><Button type="primary" loading={busy} onClick={preview ? publish : inspect}>{preview ? '确认发布变更' : '预检并查看差异'}<ArrowRight size={14} /></Button></div>
  </Modal>;
}
