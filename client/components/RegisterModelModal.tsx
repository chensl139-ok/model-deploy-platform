import { useEffect, useState } from 'react';
import { Alert, Button, Input, Modal } from 'antd';
import { Database } from 'lucide-react';
import type { RegisteredModelInput } from '../../shared/types.js';
import { api } from '../api.js';
import { messageOf } from './ui.js';
const empty = { id: '', name: '', modelKey: '', servedModelName: '', description: '', family: '' };
export default function RegisterModelModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [value, setValue] = useState<RegisteredModelInput>(empty); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => { if (open) { setValue(empty); setError(''); } }, [open]);
  const field = (key: keyof RegisteredModelInput, text: string) => setValue(current => ({ ...current, [key]: text }));
  return <Modal open={open} onCancel={busy ? undefined : onClose} title={null} footer={null} width={640}>
    <div className="modal-kicker"><Database size={15} />MODEL REGISTRY</div><h2 className="modal-title">登记模型</h2><p className="modal-description">登记你自己的模型。模型身份、权重版本和推理引擎分开管理，不要求使用内置模板。</p>
    <div className="form-grid"><div><label htmlFor="register-model-id">平台模型标识</label><Input id="register-model-id" value={value.id} placeholder="my-model" onChange={e => { const id = e.target.value; setValue(current => ({ ...current, id, modelKey: current.modelKey === current.id ? id : current.modelKey, servedModelName: current.servedModelName === current.id ? id : current.servedModelName })); }} /></div><div><label htmlFor="register-model-name">显示名称</label><Input id="register-model-name" value={value.name} onChange={e => field('name', e.target.value)} placeholder="模型名称" /></div></div>
    <div className="form-grid"><div><label htmlFor="register-model-key">Registry model_key</label><Input id="register-model-key" value={value.modelKey} onChange={e => field('modelKey', e.target.value)} /><small>与 OSS 权重登记使用同一个身份</small></div><div><label htmlFor="register-served-name">对外调用的 model 名称</label><Input id="register-served-name" value={value.servedModelName} onChange={e => field('servedModelName', e.target.value)} /></div></div>
    <label htmlFor="register-model-family">模型系列</label><Input id="register-model-family" value={value.family} onChange={e => field('family', e.target.value)} placeholder="例如 Qwen / DeepSeek / 自研" />
    <label htmlFor="register-model-description">备注</label><Input.TextArea id="register-model-description" value={value.description} onChange={e => field('description', e.target.value)} rows={3} placeholder="模型架构、量化方式、用途与兼容性说明" />
    {error && <Alert className="inline-alert" type="error" title={error} />}
    <div className="modal-actions"><Button disabled={busy} onClick={onClose}>取消</Button><Button type="primary" loading={busy} disabled={!value.id || !value.name || !value.modelKey || !value.servedModelName} onClick={async () => { setBusy(true); setError(''); try { await api('/models', { method: 'POST', body: value }); onSaved(); onClose(); } catch (e) { setError(messageOf(e)); } finally { setBusy(false); } }}>登记模型</Button></div>
  </Modal>;
}
