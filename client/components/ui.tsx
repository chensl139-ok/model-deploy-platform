import { useState, type ReactNode } from 'react';
import { App, Tooltip } from 'antd';
import { Check, Copy, Layers3 } from 'lucide-react';
import type { Model, OperationKind, Service, ServiceStatus, WeightVersion } from '../../shared/types.js';

export const operationLabels: Record<OperationKind, string> = { create: '创建部署', online: '启动服务', offline: '停止服务', restart: '重启服务', delete: '删除服务', configure: '配置变更' };
export const statusLabels: Record<ServiceStatus, string> = { preparing: '准备中', starting: '部署中', running: '运行中', stopped: '已停止', failed: '异常', unknown: '待确认' };
export const weightLabels: Record<WeightVersion['status'], string> = { importing: '准备中', available: '已就绪', failed: '失败', unknown: '待核对' };
export const resultLabels: Record<string, string> = { pending: '执行中', succeeded: '已接受', failed: '失败', unknown: '结果待确认' };
export const messageOf = (e: unknown) => e instanceof Error ? e.message : '请求失败，请稍后重试。';
export const formatDate = (date?: string) => date ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(date)) : '—';
export function relativeDate(value: string) {
  const min = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
  return min < 1 ? '刚刚' : min < 60 ? `${min} 分钟前` : min < 1440 ? `${Math.floor(min / 60)} 小时前` : `${Math.floor(min / 1440)} 天前`;
}
export function Brand() { return <div className="brand"><span className="brand-symbol"><Layers3 size={22} strokeWidth={2} /></span><div><strong>LAUNCHPAD</strong><span>INFERENCE PLATFORM</span></div></div>; }
export function IconButton({ title, children, onClick, disabled }: { title: string; children: ReactNode; onClick?: () => void; disabled?: boolean }) { return <Tooltip title={title}><button className="icon-button" aria-label={title} onClick={onClick} disabled={disabled}>{children}</button></Tooltip>; }
export function CopyButton({ value, title = '复制' }: { value: string; title?: string }) {
  const { message } = App.useApp(); const [copied, setCopied] = useState(false);
  return <IconButton title={copied ? '已复制' : title} onClick={async () => { try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { message.warning('复制不可用，请选择文本手动复制。'); } }}>{copied ? <Check size={14} /> : <Copy size={14} />}</IconButton>;
}
export function ModelMark({ model, name, large }: { model?: Model; name?: string; large?: boolean }) { return <span className={`model-mark ${large ? 'large' : ''} ${model?.color ?? 'blue'}`} aria-hidden="true">{model?.initials ?? name?.charAt(0) ?? 'M'}</span>; }
export function Status({ service }: { service: Service }) { const kind = service.stale ? 'unknown' : service.busy ? 'starting' : service.status; return <Tooltip title={service.stale ? service.staleReason : service.message}><span className={`status ${kind}`}><i className={['starting', 'preparing'].includes(kind) ? 'pulse' : ''} />{service.stale ? '观测过期' : service.busy ? '执行中' : statusLabels[kind]}</span></Tooltip>; }
export function WeightStatus({ status }: { status: WeightVersion['status'] }) { return <span className={`status ${status === 'available' ? 'running' : status === 'importing' ? 'starting' : status}`}><i className={status === 'importing' ? 'pulse' : ''} />{weightLabels[status]}</span>; }
export function Result({ status }: { status: string }) { return <span className={`result ${status}`}><i />{resultLabels[status] ?? status}</span>; }
export function PageHeading({ title, description, action }: { index: string; eyebrow: string; title: string; description: string; action?: ReactNode }) { return <div className="page-heading"><div><h1>{title}</h1><p>{description}</p></div>{action && <div className="heading-action">{action}</div>}</div>; }
export function downloadCsv(filename: string, rows: unknown[][]) {
  const escaped = rows.map(row => row.map(value => { let text = String(value ?? ''); if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; return `"${text.replace(/"/g, '""')}"`; }).join(',')).join('\r\n');
  const href = URL.createObjectURL(new Blob(['\uFEFF', escaped], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = href; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(href), 1000);
}
