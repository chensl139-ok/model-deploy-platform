import { useState } from 'react';
import { App, Button, Dropdown } from 'antd';
import { ChevronDown, Copy, Ellipsis, Play, RefreshCw, Settings2, Square, Trash2 } from 'lucide-react';
import type { Action, Service } from '../../shared/types.js';
import { api } from '../api.js';
import { messageOf } from './ui.js';

export default function ServiceMenu({ service, after, onConfigure, onClone, large }: { service: Service; after: () => void; onConfigure?: () => void; onClone?: () => void; large?: boolean }) {
  const { modal, message } = App.useApp(); const [working, setWorking] = useState(false);
  const unavailable = service.busy || service.stale;
  const run = (action: Action) => {
    const names: Record<Action, string> = { online: '启动', offline: '停止', restart: '重启', delete: '删除' };
    const warnings: Record<Action, string> = { online: `将恢复 ${service.resumeReplicas ?? 1} 个运行实例，模型加载完成后可恢复调用。`, offline: '停止后释放计算实例，保留模型权重与服务配置，之后可再次启动。', restart: '重启会影响当前实例，期间服务可能短暂不可用。', delete: '删除服务对象及其平台登记，无法从平台撤销。外部权重和存储的保留方式由集群策略决定。' };
    const requestId = crypto.randomUUID();
    modal.confirm({ title: `${names[action]} ${service.name}？`, content: warnings[action], okText: `确认${names[action]}`, cancelText: '取消', okButtonProps: { danger: action === 'delete' }, onOk: async () => {
      setWorking(true); try { await api(`/services/${service.id}/actions`, { method: 'POST', body: { action, requestId, revision: service.revision } }); message.success('操作已提交，运行状态将持续同步'); after(); } catch (e) { message.error(messageOf(e)); after(); throw e; } finally { setWorking(false); }
    } });
  };
  const items = [
    ...(onConfigure ? [{ key: 'configure', label: '调整运行配置', icon: <Settings2 size={14} />, disabled: unavailable }] : []),
    ...(onClone ? [{ key: 'clone', label: '部署同款服务', icon: <Copy size={14} /> }] : []),
    ...(service.status === 'stopped' ? [{ key: 'online', label: '启动服务', icon: <Play size={14} />, disabled: unavailable }] : []),
    ...(['running', 'starting'].includes(service.status) ? [{ key: 'offline', label: '停止服务', icon: <Square size={14} />, disabled: unavailable }, { key: 'restart', label: '重启服务', icon: <RefreshCw size={14} />, disabled: unavailable }] : []),
    { key: 'delete', label: '删除服务', icon: <Trash2 size={14} />, danger: true, disabled: unavailable },
  ];
  return <Dropdown placement="bottomRight" trigger={['click']} menu={{ items, onClick: ({ key }) => key === 'configure' ? onConfigure?.() : key === 'clone' ? onClone?.() : run(key as Action) }}>{large ? <Button loading={working}>服务操作<ChevronDown size={13} /></Button> : <button className="icon-button" aria-label={`${service.name} 的更多操作`} disabled={working}><Ellipsis size={18} /></button>}</Dropdown>;
}
