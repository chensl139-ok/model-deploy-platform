import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Checkbox, Input, Modal, Select, Spin } from 'antd';
import { ArrowRight, Database, FolderInput, Plus, Trash2 } from 'lucide-react';
import type { Bootstrap, WeightSource, WeightTarget, WeightVersion } from '../../shared/types.js';
import { api } from '../api.js';
import { messageOf } from './ui.js';

export default function ImportWeightsModal({ open, boot, modelId: initialModel, onClose, onImported }: { open: boolean; boot: Bootstrap; modelId?: string; onClose: () => void; onImported: () => void }) {
  const { message } = App.useApp();
  const [modelId, setModelId] = useState(''); const [revision, setRevision] = useState(''); const [targetId, setTargetId] = useState(''); const [targets, setTargets] = useState<WeightTarget[]>([]);
  const [sources, setSources] = useState<WeightSource[]>([]); const [prepared, setPrepared] = useState(false); const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(false); const [error, setError] = useState('');
  const requestId = useRef('');
  useEffect(() => {
    if (!open) return;
    setModelId(initialModel ?? ''); setRevision(''); setTargetId(''); setTargets([]); setSources([{ role: 'main', sourceUri: '', contentRevision: '' }]); setPrepared(false); setError(''); requestId.current = crypto.randomUUID();
    const controller = new AbortController(); setLoading(true);
    void api<{ items: WeightTarget[] }>('/assets/targets', { signal: controller.signal }).then(result => { setTargets(result.items); if (result.items.length === 1) setTargetId(result.items[0].id); }).catch(e => { if (!controller.signal.aborted) setError(messageOf(e)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, initialModel]);
  const change = () => { requestId.current = crypto.randomUUID(); setError(''); };
  const updateSource = (index: number, key: keyof WeightSource, value: string) => { setSources(current => current.map((s, i) => i === index ? { ...s, [key]: value } : s)); change(); };
  const valid = modelId && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(revision) && targetId && prepared && sources.length && sources.every(source => /^oss:\/\/.+\/.+/.test(source.sourceUri) && /^sha256:[a-f0-9]{64}$/.test(source.contentRevision) && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(source.role));
  const submit = async () => {
    setBusy(true); setError('');
    try { await api<WeightVersion>('/assets/weights', { method: 'POST', body: { modelId, revision, targetId, sources, requestId: requestId.current } }); message.success('权重导入已提交，准备状态会持续更新'); onImported(); onClose(); }
    catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  };
  return <Modal open={open} onCancel={busy ? undefined : onClose} closable={!busy} mask={{ closable: !busy }} width={720} title={null} footer={null} destroyOnHidden>
    <div className="modal-kicker"><Database size={15} />MODEL ARTIFACTS / OSS</div><h2 className="modal-title">从 OSS 导入权重</h2><p className="modal-description">引用已上传的完整模型目录。平台校验并准备存储，完成后可选择该版本部署。</p>
    <div className="form-grid"><div><label htmlFor="weight-model">模型</label><Select id="weight-model" placeholder="选择已登记模型" value={modelId || undefined} disabled={busy} options={boot.models.map(model => ({ value: model.id, label: model.name }))} onChange={id => { setModelId(id); change(); }} /></div><div><label htmlFor="weight-revision">权重版本</label><Input id="weight-revision" aria-label="权重版本" className="mono" value={revision} onChange={e => { setRevision(e.target.value); change(); }} placeholder="例如 v2 或 2026-10-22" disabled={busy} /></div></div>
    <label htmlFor="weight-target">准备位置</label><Select id="weight-target" loading={loading} className="full-width" placeholder={loading ? '正在查询已授权位置…' : '选择权重准备位置'} value={targetId || undefined} disabled={busy || loading} options={targets.map(target => ({ value: target.id, label: target.label }))} onChange={id => { setTargetId(id); change(); }} />
    {!loading && !targets.length && !error && <Alert className="inline-alert" type="warning" title="当前没有可用位置，请管理员配置 Registry 连接与目标授权。" showIcon />}
    <div className="source-heading"><h3>权重目录</h3>{boot.mode === 'demo' && <button className="text-button" disabled={busy} onClick={() => { const model = modelId || boot.models[0]?.id || ''; setModelId(model); setRevision('v2'); setSources([{ role: 'main', sourceUri: `oss://demo-models/inference/${model}/v2/main/`, contentRevision: `sha256:${'a'.repeat(64)}` }]); setPrepared(true); change(); }}>填入演示样例</button>}</div>
    <div className="weight-sources">{sources.map((source, index) => <div className="weight-source-card" key={index}><div className="source-card-heading"><span><FolderInput size={15} />权重组件 {String(index + 1).padStart(2, '0')}</span>{sources.length > 1 && <Button type="text" aria-label={`移除权重组件 ${index + 1}`} size="small" disabled={busy} icon={<Trash2 size={14} />} onClick={() => { setSources(current => current.filter((_, i) => i !== index)); change(); }} />}</div><div className="source-role-uri"><div><label htmlFor={`role-${index}`}>角色</label><Input id={`role-${index}`} className="mono" value={source.role} onChange={e => updateSource(index, 'role', e.target.value)} disabled={busy} placeholder="main" /></div><div><label htmlFor={`uri-${index}`}>OSS 目录</label><Input id={`uri-${index}`} aria-label={index ? `OSS 目录 ${index + 1}` : 'OSS 目录'} className="mono" value={source.sourceUri} onChange={e => updateSource(index, 'sourceUri', e.target.value)} disabled={busy} placeholder="oss://bucket/models/my-model/v2/main/" /></div></div><label htmlFor={`revision-${index}`}>内容校验指纹</label><Input id={`revision-${index}`} className="mono" value={source.contentRevision} onChange={e => updateSource(index, 'contentRevision', e.target.value)} disabled={busy} placeholder="sha256: + 64 位小写摘要" /><small>填写清单生成命令输出的 content_revision，不能用随意填写的文件哈希替代。</small></div>)}</div>
    {sources.length < 8 && <Button type="dashed" className="add-source" block icon={<Plus size={14} />} disabled={busy} onClick={() => { setSources(current => [...current, { role: 'codec', sourceUri: '', contentRevision: '' }]); change(); }}>添加权重组件</Button>}
    <div className="oss-requirements"><Checkbox checked={prepared} disabled={busy} onChange={e => { setPrepared(e.target.checked); change(); }}>完整模型目录与 manifest.json 已上传，最后上传了 _READY</Checkbox><p>{boot.mode === 'demo' ? '演示模式仅模拟状态，不访问真实 OSS。' : 'OSS 目录需位于管理员授权前缀内。这里只引用已有文件，不上传或覆盖 OSS 内容。'}</p></div>
    {error && <Alert className="inline-alert" type="error" title={error} showIcon />}
    <div className="modal-actions"><span className="modal-footnote">{loading && <Spin size="small" />}凭据仅由服务端使用</span><Button disabled={busy} onClick={onClose}>取消</Button><Button type="primary" loading={busy} disabled={!valid || loading} onClick={submit}>校验并导入<ArrowRight size={14} /></Button></div>
  </Modal>;
}
