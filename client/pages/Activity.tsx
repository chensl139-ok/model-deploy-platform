import { useState } from 'react';
import { Alert, Input, Select } from 'antd';
import { ArrowUpRight, Download, History, RefreshCw, Search } from 'lucide-react';
import type { AuditActivity } from '../../shared/types.js';
import { usePolling } from '../hooks.js';
import { CopyButton, downloadCsv, formatDate, IconButton, operationLabels, PageHeading, Result } from '../components/ui.js';

export default function ActivityPage({ onDetail }: { onDetail: (id: string) => void }) {
  const { data, error, refresh, loading } = usePolling<{ items: AuditActivity[] }>('/activities');
  const [search, setSearch] = useState(''); const [status, setStatus] = useState('all');
  const items = (data?.items ?? []).filter(item => (status === 'all' || item.status === status) && `${item.serviceName} ${item.actor} ${item.id}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="page"><PageHeading index="03" eyebrow="OPERATIONS" title="操作记录" description="追踪部署与运行变更，保留操作者、请求标识和控制面处理结果。" action={<IconButton title="导出操作记录" onClick={() => downloadCsv('operations.csv', [['时间', '服务', '动作', '操作者', '结果', '请求标识', '说明'], ...items.map(item => [item.createdAt, item.serviceName, operationLabels[item.kind], item.actor, item.status, item.id, item.message])])}><Download size={17} /></IconButton>} />
    {error && <Alert type="warning" title={error} showIcon className="inline-alert" />}
    <section className="panel"><div className="panel-toolbar"><div className="panel-title"><History size={16} />最近操作<span className="count-chip">{items.length}</span></div><div className="table-tools"><Select aria-label="筛选操作结果" value={status} onChange={setStatus} options={[{ value: 'all', label: '全部结果' }, { value: 'pending', label: '执行中' }, { value: 'succeeded', label: '已接受' }, { value: 'failed', label: '失败' }, { value: 'unknown', label: '待核对' }]} /><Input aria-label="搜索操作记录" placeholder="服务、操作者或请求标识" prefix={<Search size={14} />} value={search} onChange={e => setSearch(e.target.value)} allowClear /><IconButton title="刷新操作记录" onClick={refresh}><RefreshCw size={15} /></IconButton></div></div>
      <div className="table-scroll"><table className="data-table audit-table"><thead><tr><th>时间 / 操作者</th><th>服务</th><th>操作</th><th>结果</th><th>说明</th><th>请求标识</th></tr></thead><tbody>{items.map(item => <tr key={item.id}><td><span className="mono">{formatDate(item.createdAt)}</span><small className="cell-note">{item.actor}</small></td><td>{item.deleted ? <span className="muted">{item.serviceName}<small className="cell-note">已删除</small></span> : <button className="table-link mono" onClick={() => onDetail(item.serviceId)}>{item.serviceName}<ArrowUpRight size={12} /></button>}</td><td>{operationLabels[item.kind]}</td><td><Result status={item.status} /></td><td className="audit-message">{item.message}</td><td><div className="request-id"><code title={item.id}>{item.id.slice(0, 8)}</code><CopyButton value={item.id} title="复制完整请求标识" /></div></td></tr>)}</tbody></table></div>
      {!items.length && <div className="empty-state"><History size={25} /><h3>{loading ? '正在读取操作记录' : '暂无匹配记录'}</h3><p>创建部署或调整服务后，可在这里追踪处理结果。</p></div>}<div className="table-footer"><span>展示最近 200 条服务操作</span><span>请求已接受与实例就绪分别验收</span></div>
    </section>
  </div>;
}
