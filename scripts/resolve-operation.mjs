import { parseArgs } from 'node:util';
import { readConfig } from '../dist/server/config.js';
import { Store } from '../dist/server/store.js';
import { Upstream } from '../dist/server/upstream.js';

const { values } = parseArgs({ options: { service: { type: 'string' }, uid: { type: 'string' }, decision: { type: 'string' }, confirm: { type: 'boolean', default: false } } });
const config = readConfig();
if (config.APP_MODE !== 'live') throw new Error('此工具只用于真实环境');
const store = new Store(config.DATABASE_PATH);
try {
  const service = store.get(values.service ?? '');
  const operation = store.pending().find(op => op.serviceId === values.service && op.status === 'unknown');
  if (!service || !operation) throw new Error('未找到待人工核对的服务与未知操作');
  const upstream = new Upstream(config);
  const detail = await upstream.request('io', upstream.path(service.clusterId, service.namespace, service.name), `${config.ADMIN_USERNAME}-operator`);
  if (detail.live !== true || detail.stale !== false) throw new Error('没有实时状态，不能解除保护');
  const k = detail.kubernetes;
  if (!k || typeof k.uid !== 'string' || typeof k.resource_version !== 'string') throw new Error('资源身份不完整');
  console.log(JSON.stringify({ service: service.name, operationId: operation.id, action: operation.kind, uid: k.uid, resourceVersion: k.resource_version, requestedDecision: values.decision ?? null, willApply: values.confirm }, null, 2));
  if (values.confirm) {
    if (values.uid !== k.uid) throw new Error('必须明确传入本次实际读取的 --uid');
    if (values.decision === 'adopt') {
      if (operation.kind !== 'create' || !operation.requestedSpec) throw new Error('adopt 仅适用于保存了原始 Spec 的未知创建操作');
      const includes = (actual, expected) => {
        if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => includes(actual[i], v));
        if (expected && typeof expected === 'object') return actual && typeof actual === 'object' && Object.entries(expected).every(([key, value]) => includes(actual[key], value));
        return actual === expected;
      };
      if (!includes(k.spec, operation.requestedSpec)) throw new Error('实时配置与原始创建目标不一致，不能接管');
    } else if (values.decision === 'failed') {
      if (operation.kind === 'create' || operation.kind === 'delete') throw new Error('创建或删除结果未知时不能直接标记失败');
      if (operation.baselineUid !== k.uid) throw new Error('资源已被替换，不能解除保护');
    } else throw new Error('--decision 仅支持 adopt 或 failed');
    store.transaction(() => {
      store.save({ ...service, uid: k.uid, resourceVersion: k.resource_version, spec: k.spec, creationConfirmed: values.decision === 'adopt' || service.creationConfirmed, busy: false, updatedAt: new Date().toISOString() });
      store.saveOperation({ ...operation, actor: `${config.ADMIN_USERNAME}-operator`, status: values.decision === 'adopt' ? 'succeeded' : 'failed', message: values.decision === 'adopt' ? '管理员核对原始配置与实际 UID 后，确认接管创建结果。' : '管理员确认操作未生效，解除后续操作保护。', updatedAt: new Date().toISOString() });
    });
    console.log('本地登记已更新。此工具没有修改任何上游工作负载。');
  } else console.log('只读核对完成。先停止平台后台进程，再明确 uid、decision 与 --confirm 执行登记修复。');
} finally { store.close(); }
