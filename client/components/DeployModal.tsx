import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Modal, Select } from 'antd';
import { ArrowRight, Check, ChevronRight, Cpu, Database, Layers3, ShieldCheck } from 'lucide-react';
import type { Bootstrap, Preview, WeightVersion } from '../../shared/types.js';
import { api, ApiError } from '../api.js';
import { messageOf, ModelMark } from './ui.js';

export interface DeployIntent { modelId?: string; weightVersionId?: string; variantId?: string; profileId?: string }
export default function DeployModal({ open, boot, intent, onClose, onCreated, onImport }: { open: boolean; boot: Bootstrap; intent?: DeployIntent; onClose: () => void; onCreated: (id: string) => void; onImport: (modelId?: string) => void }) {
  const [modelId, setModelId] = useState(''); const [variantId, setVariantId] = useState(''); const [name, setName] = useState(''); const [weightId, setWeightId] = useState(''); const [weights, setWeights] = useState<WeightVersion[]>([]);
  const [advanced, setAdvanced] = useState(false); const [busy, setBusy] = useState(false); const [phase, setPhase] = useState(''); const [error, setError] = useState(''); const [assetError, setAssetError] = useState('');
  const submission = useRef<{ preview?: Preview; requestId: string }>({ requestId: '' });
  const model = boot.models.find(m => m.id === modelId); const variant = model?.variants.find(v => v.id === variantId);
  const weight = weights.find(w => w.id === weightId);
  const setModel = (id: string, initialVariant?: string) => { const selected = boot.models.find(m => m.id === id); if (!selected) return; setModelId(id); setVariantId(initialVariant ?? (selected.variants.find(v => v.recommended) ?? selected.variants[0])?.id ?? ''); setName(`${id.slice(0, 38)}-${crypto.randomUUID().slice(0, 4)}`); };
  const reset = () => { submission.current = { requestId: crypto.randomUUID() }; setError(''); };
  useEffect(() => {
    if (!open) return;
    setModelId(''); setVariantId(''); setName(''); setWeightId(intent?.weightVersionId ?? ''); setWeights([]); setAdvanced(false); setError(''); setAssetError(''); setPhase(''); reset();
    if (intent?.modelId) setModel(intent.modelId, intent.variantId);
    const controller = new AbortController();
    void api<{ items: WeightVersion[] }>('/assets/weights', { signal: controller.signal }).then(result => setWeights(result.items)).catch(e => { if (!controller.signal.aborted) setAssetError(messageOf(e)); });
    return () => controller.abort();
  }, [open, intent]);
  const deploy = async () => {
    if (!model || !variant) return; setBusy(true); setError('');
    try {
      if (!submission.current.preview) { setPhase('正在检查权重、运行配置和部署位置…'); submission.current.preview = await api<Preview>('/previews', { method: 'POST', body: { modelId, variantId, name, ...(weightId ? { weightVersionId: weightId } : {}) } }); }
      setPhase('预检通过，正在提交服务…');
      const result = await api<{ serviceId: string }>('/services', { method: 'POST', body: { previewId: submission.current.preview.id, requestId: submission.current.requestId } }); onCreated(result.serviceId);
    } catch (e) { setError(messageOf(e)); if (e instanceof ApiError && ['preview_expired', 'preview_used'].includes(e.code)) submission.current = { requestId: crypto.randomUUID() }; }
    finally { setBusy(false); setPhase(''); }
  };
  const valid = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name) && name.length <= 53 && (!weightId || weight?.status === 'available') && (!weightId || variant?.supportsWeightVersions);
  return <Modal open={open} onCancel={busy ? undefined : onClose} closable={!busy} mask={{ closable: !busy }} width={620} title={null} footer={null} destroyOnHidden>
    <div className="modal-kicker"><Layers3 size={15} />NEW INFERENCE SERVICE</div><h2 className="modal-title">部署模型</h2><p className="modal-description">选择模型与权重版本，运行配置由适配模板提供。</p>
    {!boot.models.length ? <div className="empty-state"><Database size={30} /><h3>暂无可部署模板</h3><p>请管理员先配置已验证的模型运行包。</p><Button onClick={onClose}>关闭</Button></div> : <>
      <label htmlFor="model">模型模板<span>已适配模型 / 推理框架</span></label><Select id="model" className="full-width" showSearch optionFilterProp="label" value={modelId || undefined} placeholder="选择模型与版本" options={boot.models.map(m => ({ value: m.id, label: `${m.name} / ${m.version}` }))} onChange={id => { setModel(id); setWeightId(''); reset(); }} disabled={busy} />
      {model && <div className="selected-model"><ModelMark model={model} /><div><strong>{model.name}<span className="version-chip">{model.framework}</span></strong><p>{model.description}</p></div></div>}
      <div className="label-with-action"><label htmlFor="weight-version">权重版本</label><button className="text-button" disabled={busy} onClick={() => { onClose(); onImport(modelId || undefined); }}>从 OSS 导入<ArrowRight size={12} /></button></div>
      <Select id="weight-version" aria-label="权重版本" className="full-width" disabled={!model || busy} value={weightId} onChange={id => { setWeightId(id); reset(); }} options={[{ value: '', label: `${model?.version ?? '默认版本'} · 模板内置权重` }, ...weights.filter(w => w.modelId === modelId && w.status === 'available').map(w => ({ value: w.id, label: `${w.revision} · OSS · ${w.target.namespace}` }))]} />
      {weight && <div className="weight-origin"><Database size={14} /><div><strong>OSS / {weight.revision}</strong><code>{weight.sources[0]?.sourceUri}</code></div><Check size={14} /></div>}
      {assetError && <Alert className="inline-alert" type="warning" title={`权重目录暂不可读：${assetError}`} showIcon />}
      <label className="section-label">运行规格<span>来自管理员验证的模板</span></label><div className="variant-grid">{!model ? <div className="variant-placeholder"><Cpu size={18} />选择模型后显示可用规格</div> : model.variants.map(v => <button className={`variant-card ${v.id === variantId ? 'selected' : ''}`} key={v.id} disabled={busy} onClick={() => { setVariantId(v.id); reset(); }}><div><Cpu size={17} />{v.recommended && <span className="recommended">推荐</span>}<span className="variant-radio">{v.id === variantId && <Check size={10} />}</span></div><strong>{v.label}</strong><small>{v.description}</small></button>)}</div>
      {weightId && !variant?.supportsWeightVersions && <Alert className="inline-alert" type="warning" title="当前规格使用固定运行配置，不支持切换权重。请选择支持 Registry 运行包的规格。" showIcon />}
      <button className="advanced-toggle" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced} disabled={busy}><ChevronRight size={13} className={advanced ? 'rotated' : ''} />自定义服务名称<span>{name}</span></button>{advanced && <div className="name-field"><Input aria-label="服务名称" className="mono" value={name} onChange={e => { setName(e.target.value); reset(); }} maxLength={53} disabled={busy} /><small>小写字母、数字和连字符，最多 53 字符。</small></div>}
      <div className="form-notice"><ShieldCheck size={16} /><span>{boot.mode === 'demo' ? '演示模式：仅模拟部署流程，不访问真实权重或使用 GPU。' : '提交前自动预检。实际就绪时间取决于模型加载和资源调度。'}</span></div>
      {error && <Alert className="inline-alert" type="error" title={error} showIcon />}{busy && <div className="deploy-progress" role="status"><span className="loading-dot" />{phase}</div>}
      <div className="modal-actions"><Button disabled={busy} onClick={onClose}>取消</Button><Button type="primary" disabled={!model || !variant || !valid} loading={busy} onClick={deploy}>{busy ? '正在部署' : error && submission.current.preview ? '重试提交' : '部署模型'}<ArrowRight size={14} /></Button></div>
    </>}
  </Modal>;
}
