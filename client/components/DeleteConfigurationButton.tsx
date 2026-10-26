import { useState } from 'react';
import { Alert, Button, Modal } from 'antd';
import { Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { IconButton, messageOf } from './ui.js';
interface Removal { name: string; canDelete: boolean; blockers: string[]; backgroundWork: boolean }
export default function DeleteConfigurationButton({ path, label, onDeleted }: { path: string; label: string; onDeleted: () => void }) {
  const [open, setOpen] = useState(false); const [result, setResult] = useState<Removal>(); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  return <><IconButton title={`删除${label}`} onClick={async () => { setOpen(true); setError(''); setResult(undefined); setBusy(true); try { setResult(await api<Removal>(`${path}/removal`)); } catch (e) { setError(messageOf(e)); } finally { setBusy(false); } }}><Trash2 size={14} /></IconButton>
    <Modal open={open} title={`删除${label}`} onCancel={busy ? undefined : () => setOpen(false)} footer={<><Button disabled={busy} onClick={() => setOpen(false)}>取消</Button><Button type="primary" danger aria-label="确认删除配置" loading={busy} disabled={!result?.canDelete} onClick={async () => { setBusy(true); setError(''); try { await api(path, { method: 'DELETE', body: { confirmation: path.split('/').at(-1) } }); setOpen(false); onDeleted(); } catch (e) { setError(messageOf(e)); } finally { setBusy(false); } }}>确认删除</Button></>}>
      {result && (result.canDelete ? <><p>移除「{result.name}」的平台登记并保留归档。远端镜像、运行包和权重文件保留。</p>{result.backgroundWork && <Alert type="warning" showIcon title="已提交的外部任务可能继续运行，此操作只移除平台登记。" />}</> : <Alert type="warning" title="请先解除引用" description={<ul>{result.blockers.map(b => <li key={b}>{b}</li>)}</ul>} />)}
      {error && <Alert className="inline-alert" type="error" title={error} />}
    </Modal>
  </>;
}
