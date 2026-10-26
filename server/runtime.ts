import type { ConfigInput, ConfigPreview, JsonObject, RuntimeConfig } from '../shared/types.js';
import { asObject } from './catalog.js';
import { AppError } from './errors.js';
import type { StoredService } from './store.js';

function quantity(value: unknown, memory = false): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const match = String(value).match(/^(\d+(?:\.\d+)?)(m|Ki|Mi|Gi|Ti|K|M|G|T)?$/);
  if (!match) return null;
  const v = Number(match[1]); const unit = match[2] ?? '';
  if (!memory) return unit === 'm' ? v / 1000 : !unit ? v : null;
  const factors: Record<string, number> = { '': 1, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, K: 1000, M: 1000 ** 2, G: 1000 ** 3, T: 1000 ** 4 };
  return factors[unit] ? Math.round(v * factors[unit] / 1024 ** 3 * 1000) / 1000 : null;
}
export function runtimeConfig(service: StoredService): RuntimeConfig {
  const spec = service.spec ?? {};
  const runtime = asObject(spec.runtime); const requests = asObject(asObject(runtime.resources).requests);
  const reason = !service.spec ? '尚未取得运行配置' : asObject(spec.backend).type !== 'NativeDeployment' ? '当前服务拓扑不支持此编辑方式' : !runtime.image ? '原生容器模板需要专门的编辑器，当前仅支持 runtime 配置' : undefined;
  return { replicas: service.desiredReplicas, image: typeof runtime.image === 'string' ? runtime.image : '', cpuCores: quantity(requests.cpu), memoryGB: quantity(requests.memory, true), maxConcurrency: typeof asObject(spec.capacity).maxConcurrentRequestsPerPod === 'number' ? asObject(spec.capacity).maxConcurrentRequestsPerPod as number : null, editable: !reason, reason };
}
export function prepareConfig(service: StoredService, input: ConfigInput): { spec: JsonObject; changes: ConfigPreview['changes'] } {
  const previous = runtimeConfig(service);
  if (!previous.editable) throw new AppError(422, 'configuration_not_editable', previous.reason!);
  const spec = structuredClone(service.spec!);
  const runtime = asObject(spec.runtime);
  const changes: ConfigPreview['changes'] = [];
  const record = (field: string, before: string | number | null, after: string | number) => { if (before !== after) changes.push({ field, before: before === null ? '未设置' : String(before), after: String(after) }); };
  record('目标实例', previous.replicas, input.replicas);
  spec.rollout = { ...asObject(spec.rollout), replicas: input.replicas };
  if (input.image !== undefined && input.image !== previous.image) {
    const repository = (image: string) => image.split('@')[0].replace(/:[^/:]+$/, '');
    if (repository(input.image) !== repository(previous.image)) throw new AppError(422, 'image_repository_changed', '只允许更新同一镜像仓库的 digest；更换模型或仓库请使用新模板部署。');
    record('镜像', previous.image, input.image); runtime.image = input.image;
  }
  const resources = asObject(runtime.resources); const requests = asObject(resources.requests); const limits = asObject(resources.limits);
  if (input.cpuCores !== undefined && input.cpuCores !== previous.cpuCores) {
    record('CPU 申请（核）', previous.cpuCores, input.cpuCores); requests.cpu = String(input.cpuCores);
    if (limits.cpu !== undefined && (quantity(limits.cpu) === null || quantity(limits.cpu)! < input.cpuCores)) limits.cpu = String(input.cpuCores);
  }
  if (input.memoryGB !== undefined && input.memoryGB !== previous.memoryGB) {
    record('内存申请（GiB）', previous.memoryGB, input.memoryGB); requests.memory = `${input.memoryGB}Gi`;
    if (limits.memory !== undefined && (quantity(limits.memory, true) === null || quantity(limits.memory, true)! < input.memoryGB)) limits.memory = `${input.memoryGB}Gi`;
  }
  if (input.cpuCores !== undefined || input.memoryGB !== undefined) runtime.resources = { ...resources, requests, ...(resources.limits ? { limits } : {}) };
  if (input.maxConcurrency !== undefined && input.maxConcurrency !== previous.maxConcurrency) {
    record('单实例容量声明', previous.maxConcurrency, input.maxConcurrency);
    spec.capacity = { ...asObject(spec.capacity), maxConcurrentRequestsPerPod: input.maxConcurrency };
  }
  spec.runtime = runtime;
  if (!changes.length) throw new AppError(400, 'no_changes', '没有检测到配置变更。');
  return { spec, changes };
}
export function containsSpec(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => containsSpec(actual[i], v));
  if (expected && typeof expected === 'object') return Boolean(actual && typeof actual === 'object' && !Array.isArray(actual) && Object.entries(expected).every(([key, value]) => containsSpec((actual as JsonObject)[key], value)));
  return actual === expected;
}
