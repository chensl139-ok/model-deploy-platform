import type { Config } from './config.js';
import { AppError, cleanMessage } from './errors.js';
import type { JsonObject } from '../shared/types.js';
import { asObject } from './catalog.js';
import { Kubernetes } from './kubernetes.js';

export class Upstream {
  constructor(private config: Config) {}
  async request(kind: 'io' | 'registry', path: string, actor: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<JsonObject> {
    if (kind === 'io' && this.config.DEPLOYMENT_PROVIDER === 'kubernetes') return new Kubernetes(this.config).request(path, options);
    const registry = kind === 'registry';
    const base = registry ? this.config.REGISTRY_BASE_URL : this.config.IO_BASE_URL;
    const token = registry ? this.config.REGISTRY_TOKEN : this.config.IO_MANAGEMENT_TOKEN;
    if (!base || !token) throw new AppError(503, 'connection_missing', '尚未配置对应平台连接，请联系管理员。');
    const secrets = [this.config.IO_MANAGEMENT_TOKEN, this.config.REGISTRY_TOKEN];
    try {
      const response = await fetch(`${base}${path}`, {
        method: options.method ?? 'GET', redirect: 'error', signal: AbortSignal.timeout(this.config.UPSTREAM_TIMEOUT_MS),
        headers: { 'Content-Type': 'application/json', ...(registry ? { 'X-Registry-Token': token } : { 'X-Management-Token': token, 'X-Management-Actor-ID': actor }), ...options.headers },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new AppError(502, 'upstream_response_too_large', '平台返回的数据过大，请联系管理员。'); }
          chunks.push(part.value);
        }
      }
      const text = Buffer.concat(chunks).toString('utf8');
      let body: JsonObject = {};
      if (text) {
        try { body = asObject(JSON.parse(text)); }
        catch { throw new AppError(502, 'invalid_upstream_response', '平台返回了无法解析的响应，请检查连接。'); }
      }
      if (!response.ok) {
        const error = asObject(body.error);
        const message = typeof error.message === 'string' ? error.message : typeof body.error === 'string' ? body.error : `平台请求失败（${response.status}）`;
        throw new AppError(response.status, typeof error.code === 'string' ? error.code : 'upstream_error', cleanMessage(message, secrets));
      }
      return body;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(503, 'upstream_unavailable', '平台连接中断或等待超时。操作结果可能已生效，请先刷新状态，勿重复提交。');
    }
  }
  path(clusterId: number, namespace: string, name?: string) {
    return `/management/v1/clusters/${clusterId}/namespaces/${encodeURIComponent(namespace)}/inference-services${name ? `/${encodeURIComponent(name)}` : ''}`;
  }
  async authorized(clusterId: number, namespace: string, actor: string) {
    const response = await this.request('io', '/management/v1/deployment-targets', actor);
    const targets = Array.isArray(response.targets) ? response.targets : [];
    if (!targets.some(value => { const t = asObject(value); return t.cluster_id === clusterId && Array.isArray(t.namespaces) && t.namespaces.includes(namespace); })) {
      throw new AppError(403, 'target_forbidden', '当前账号未获准在此部署位置操作，请联系管理员。');
    }
    return response;
  }
}
