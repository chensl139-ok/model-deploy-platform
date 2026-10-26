import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Modal, Select } from 'antd';
import type { Bootstrap, WeightTarget } from '../../shared/types.js';
import { api } from '../api.js';
import { messageOf } from './ui.js';

export default function PvcWeightsModal({ open, boot, modelId: initialModel, onClose, onImported }: { open: boolean; boot: Bootstrap; modelId?: string; onClose: () => void; onImported: () => void }) {
  const [modelId, setModel] = useState(''); const [revision, setRevision] = useState(''); const [target, setTarget] = useState(''); const [targets, setTargets] = useState<WeightTarget[]>([]);
  const [bindings, setBindings] = useState([{ role: 'main', claimName: '', subPath: '', contentRevision: '' }]); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const requestId = useRef('');
  useEffect(() => { if (!open) return; setModel(initialModel ?? ''); setRevision(''); setError(''); setBindings([{ role: 'main', claimName: '', subPath: '', contentRevision: '' }]); requestId.current = crypto.randomUUID(); const c = new AbortController(); void api<{items: WeightTarget[]}>('/assets/targets', { signal: c.signal }).then(r => { setTargets(r.items); setTarget(r.items[0]?.id ?? ''); }).catch(e => { if (!c.signal.aborted) setError(messageOf(e)); }); return () => c.abort(); }, [open, initialModel]);
  const change = () => { requestId.current = crypto.randomUUID(); setError(''); };
  const valid = modelId && target && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(revision) && bindings.every(b => b.role && b.claimName && /^sha256:[a-f0-9]{64}$/.test(b.contentRevision));
  return <Modal open={open} title="登记 PVC 权重" onCancel={busy ? undefined : onClose} footer={null} width={700} mask={{ closable: !busy }}>
    <p className="modal-description">引用集群中已准备的模型目录。平台检查 PVC 绑定与身份，模型文件在部署时加载验证。</p>
    <div className="form-grid"><div><label htmlFor="pvc-model">模型</label><Select id="pvc-model" value={modelId || undefined} options={boot.models.map(m => ({ value: m.id, label: m.name }))} onChange={v => { setModel(v); change(); }} /></div><div><label htmlFor="pvc-version">权重版本</label><Input id="pvc-version" value={revision} onChange={e => { setRevision(e.target.value); change(); }} /></div></div>
    <label htmlFor="pvc-target">位置</label><Select id="pvc-target" className="full-width" value={target} options={targets.map(t => ({ value: t.id, label: t.label }))} onChange={v => { setTarget(v); change(); }} />
    {bindings.map((b, i) => <section className="weight-source-card" key={i}><div className="form-grid">{([['role', '角色'], ['claimName', 'PVC 名称'], ['subPath', '子目录（可空）'], ['contentRevision', '内容 SHA256（管理员提供）']] as const).map(([key, label]) => <div key={key}><label htmlFor={`pvc-${i}-${key}`}>{label}</label><Input id={`pvc-${i}-${key}`} value={b[key]} onChange={e => { setBindings(items => items.map((item, n) => n === i ? { ...item, [key]: e.target.value } : item)); change(); }} /></div>)}</div>{bindings.length > 1 && <Button type="text" danger onClick={() => { setBindings(items => items.filter((_, n) => n !== i)); change(); }}>移除此组件</Button>}</section>)}
    {bindings.length < 8 && <Button onClick={() => { setBindings(items => [...items, { role: '', claimName: '', subPath: '', contentRevision: '' }]); change(); }}>添加权重组件</Button>}
    {error && <Alert className="inline-alert" type="error" title={error} />}
    <div className="modal-actions"><Button disabled={busy} onClick={onClose}>取消</Button><Button type="primary" loading={busy} disabled={!valid} onClick={async () => { setBusy(true); setError(''); try { await api('/assets/pvc-weights', { method: 'POST', body: { modelId, revision, targetId: target, bindings, requestId: requestId.current } }); onImported(); onClose(); } catch (e) { setError(messageOf(e)); } finally { setBusy(false); } }}>检查并登记</Button></div>
  </Modal>;
}
