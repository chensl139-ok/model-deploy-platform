import { randomUUID, createHash } from 'node:crypto';
import type { Config } from './config.js';
import type { CatalogModel } from './catalog.js';
import { asObject } from './catalog.js';
import { AppError, cleanMessage } from './errors.js';
import { Store, type StoredWeightVersion } from './store.js';
import { Upstream } from './upstream.js';
import { Kubernetes } from './kubernetes.js';
import type { ImportWeightsInput, WeightTarget, WeightVersion } from '../shared/types.js';

const publicWeight = ({ fingerprint, importId, ...weight }: StoredWeightVersion): WeightVersion => weight;
export function validOssUri(uri: string) {
  return /^oss:\/\/[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\/.+/.test(uri) && !/[?#%\\\s\x00-\x1f]/.test(uri) && !uri.split('/').some(part => part === '.' || part === '..') && !uri.includes('@');
}
export class Assets {
  private tasks = new Set<Promise<unknown>>();
  private syncing = false;
  constructor(private config: Config, private store: Store, private catalog: CatalogModel[] | (() => CatalogModel[]), private upstream = new Upstream(config)) {
    for (const weight of store.weights().filter(w => w.status === 'importing')) {
      if (config.APP_MODE === 'demo') store.saveWeight({ ...weight, status: 'available', message: '演示准备已完成；未访问真实 OSS。', updatedAt: new Date().toISOString() });
      else if (!weight.importId) store.saveWeight({ ...weight, status: 'unknown', message: '导入请求结果未知，请按原请求标识在 Registry 核对，不会自动重复导入。', updatedAt: new Date().toISOString() });
    }
  }
  list() { return this.store.weights().map(publicWeight); }
  async targets(actor: string): Promise<WeightTarget[]> {
    if (this.config.APP_MODE === 'demo') return [{ id: '880e5ca1-6c77-4189-b3ab-616d8c95b09a', label: 'RTX PRO 6000 · inference-tob', gpuType: 'RTX PRO 6000 Blackwell', clusterId: 70001, namespace: 'inference-tob' }];
    if (this.config.DEPLOYMENT_PROVIDER === 'kubernetes') return new Kubernetes(this.config).namespaces().map(namespace => ({ id: `kubernetes:${namespace}`, clusterId: 1, namespace, gpuType: 'Kubernetes', label: `${this.config.KUBE_CONTEXT} / ${namespace}` }));
    const result = await this.upstream.request('registry', '/v1/deployment-targets', actor);
    return (Array.isArray(result.targets) ? result.targets : []).flatMap(value => {
      const t = asObject(value);
      if (typeof t.target_id !== 'string' || !Number.isInteger(Number(t.cluster_id)) || typeof t.namespace !== 'string') return [];
      const gpuType = String(t.gpu_type ?? 'GPU');
      return [{ id: t.target_id, clusterId: Number(t.cluster_id), namespace: t.namespace, gpuType, label: `${gpuType} · ${t.namespace}` }];
    });
  }
  async registerPvc(input: { modelId: string; revision: string; targetId: string; requestId: string; bindings: { role: string; claimName: string; subPath: string; contentRevision: string }[] }, actor: string) {
    if (this.config.DEPLOYMENT_PROVIDER !== 'kubernetes') throw new AppError(422, 'provider_mismatch', 'PVC 登记仅适用于原生 Kubernetes。');
    const hash = createHash('sha256').update(JSON.stringify({ ...input, actor })).digest('hex');
    const prior = this.store.weightByRequest(input.requestId);
    if (prior && this.store.asset('archived:weight', prior.id)) throw new AppError(409, 'request_archived', '原请求已归档，请使用新的请求标识。');
    if (prior) { if (prior.fingerprint !== hash) throw new AppError(409, 'request_conflict', '请求标识已被使用。'); return publicWeight(prior); }
    const target = (await this.targets(actor)).find(t => t.id === input.targetId);
    if (!target) throw new AppError(403, 'target_forbidden', '权重位置未授权。');
    if (new Set(input.bindings.map(b => b.role)).size !== input.bindings.length) throw new AppError(400, 'duplicate_role', '权重角色不能重复。');
    const kube = new Kubernetes(this.config);
    const bindings: NonNullable<WeightVersion["pvcBindings"]> = [];
    for (const b of input.bindings) { const claim = await kube.claim(target.namespace, b.claimName); bindings.push({ role: b.role, claimName: b.claimName, subPath: b.subPath, uid: String(asObject(claim.metadata).uid) }); }
    return this.store.transaction(() => {
      const concurrent = this.store.weightByRequest(input.requestId);
      if (concurrent && this.store.asset('archived:weight', concurrent.id)) throw new AppError(409, 'request_archived', '原请求已归档，请使用新的请求标识。');
      if (concurrent) { if (concurrent.fingerprint !== hash) throw new AppError(409, 'request_conflict', '请求标识已被使用。'); return publicWeight(concurrent); }
      const model = (typeof this.catalog === 'function' ? this.catalog() : this.catalog).find(m => m.id === input.modelId);
      if (!model) throw new AppError(404, 'not_found', '模型不存在。');
      if (this.store.weights().some(w => w.modelId === model.id && w.revision === input.revision && w.target.id === target.id)) throw new AppError(409, 'weight_version_exists', '此位置已有同版本权重。');
      const weight: StoredWeightVersion = { id: randomUUID(), requestId: input.requestId, fingerprint: hash, modelId: model.id, modelName: model.name, modelKey: model.modelKey ?? model.id, revision: input.revision, target, sources: input.bindings.map(b => ({ role: b.role, sourceUri: `pvc://${target.namespace}/${b.claimName}/${b.subPath}`, contentRevision: b.contentRevision })), pvcBindings: bindings, status: 'available', message: 'PVC 已绑定并记录 UID；目录内容与填写的版本指纹由管理员保证，模型加载结果见部署状态。', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      this.store.saveWeight(weight); return publicWeight(weight);
    });
  }
  async import(input: ImportWeightsInput, actor: string) {
    if (this.config.APP_MODE === 'setup') throw new AppError(503, 'platform_not_connected', '配置真实 Registry 连接后才能导入权重。');
    if (this.config.DEPLOYMENT_PROVIDER === 'kubernetes') throw new AppError(422, 'provider_mismatch', '此后端请先将权重准备到 PVC，再登记 PVC；OSS 自动导入需要 Registry / IO。');
    const hash = createHash('sha256').update(JSON.stringify({ ...input, actor })).digest('hex');
    const existing = this.store.weightByRequest(input.requestId);
    if (existing && this.store.asset('archived:weight', existing.id)) throw new AppError(409, 'request_archived', '原请求已归档，请使用新的请求标识。');
    if (existing) {
      if (existing.fingerprint !== hash) throw new AppError(409, 'request_conflict', '同一请求标识不能用于不同权重导入。');
      return publicWeight(existing);
    }
    const model = (typeof this.catalog === 'function' ? this.catalog() : this.catalog).find(m => m.id === input.modelId);
    if (!model) throw new AppError(400, 'invalid_model', '请先选择已适配的模型模板。');
    if (new Set(input.sources.map(s => s.role)).size !== input.sources.length) throw new AppError(400, 'duplicate_role', '每份权重的角色名称必须不同。');
    const prefixes = this.config.OSS_ALLOWED_PREFIXES.split(',').map(p => p.trim().replace(/\/$/, '')).filter(Boolean);
    for (const source of input.sources) {
      if (!validOssUri(source.sourceUri)) throw new AppError(400, 'invalid_oss_uri', '请填写不含凭据、查询参数或路径跳转的 oss://bucket/目录 地址。');
      if (this.config.APP_MODE === 'live' && !prefixes.some(prefix => validOssUri(prefix) && (source.sourceUri.replace(/\/$/, '') === prefix || source.sourceUri.startsWith(`${prefix}/`)))) throw new AppError(403, 'oss_prefix_forbidden', '该 OSS 目录不在管理员授权的权重来源范围内。');
    }
    const target = (await this.targets(actor)).find(t => t.id === input.targetId);
    if (!target) throw new AppError(403, 'target_forbidden', '此权重准备位置不可用或未授权。');
    const weight: StoredWeightVersion = { id: randomUUID(), requestId: input.requestId, fingerprint: hash, modelId: model.id, modelName: model.name, modelKey: model.modelKey ?? model.id, revision: input.revision, target, sources: input.sources, status: 'importing', message: '正在提交权重导入请求。', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    // Reserve the idempotency key before network I/O; concurrent requests cannot create duplicate imports.
    const reserved = this.store.transaction(() => {
      if (!(typeof this.catalog === 'function' ? this.catalog() : this.catalog).some(m => m.id === input.modelId)) throw new AppError(409, 'model_deleted', '模型已删除，请重新选择。');
      const concurrent = this.store.weightByRequest(input.requestId);
      if (concurrent && this.store.asset('archived:weight', concurrent.id)) throw new AppError(409, 'request_archived', '原请求已归档，请使用新的请求标识。');
      if (concurrent) {
        if (concurrent.fingerprint !== hash) throw new AppError(409, 'request_conflict', '同一请求标识不能用于不同权重导入。');
        return concurrent;
      }
      if (this.store.weights().some(w => w.modelId === input.modelId && w.revision === input.revision && w.target.id === input.targetId && w.status !== 'failed')) throw new AppError(409, 'weight_version_exists', '已有相同版本导入，请刷新状态。');
      this.store.saveWeight(weight);
      return weight;
    });
    if (reserved.id !== weight.id) return publicWeight(reserved);
    const task = this.submit(weight, actor);
    this.tasks.add(task); void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task));
    return publicWeight(weight);
  }
  private async submit(weight: StoredWeightVersion, actor: string) {
    try {
      if (this.config.APP_MODE === 'demo') {
        await new Promise(resolve => setTimeout(resolve, this.config.NODE_ENV === 'test' ? 5 : 2200));
        this.store.saveWeight({ ...weight, status: 'available', message: '演示权重已就绪；未访问真实 OSS 或申请 GPU。', updatedAt: new Date().toISOString() });
        return;
      }
      const result = await this.upstream.request('registry', '/internal/v1/weight-imports', actor, { method: 'POST', body: { idempotency_key: weight.requestId, model_key: weight.modelKey, model_revision: weight.revision, target_ids: [weight.target.id], weights: weight.sources.map(s => ({ role: s.role, source_uri: s.sourceUri.replace(/\/$/, ''), content_revision: s.contentRevision })) } });
      if (typeof result.import_id !== 'string') throw new AppError(502, 'invalid_import_response', 'Registry 未返回导入标识，请按原请求标识核对实际结果。');
      this.store.saveWeight({ ...weight, importId: result.import_id, message: '已提交，等待平台校验与存储准备。', updatedAt: new Date().toISOString() });
      await this.refresh(weight.id, actor);
    } catch (error) {
      const current = this.store.weight(weight.id) ?? weight;
      const definitive = error instanceof AppError && error.statusCode < 500;
      this.store.saveWeight({ ...current, status: definitive ? 'failed' : 'unknown', message: cleanMessage(error instanceof AppError ? error.message : '导入结果暂未确认，请先核对实际状态。', [this.config.REGISTRY_TOKEN]), updatedAt: new Date().toISOString() });
    }
  }
  async refresh(id: string, actor: string) {
    const weight = this.store.weight(id);
    if (!weight) throw new AppError(404, 'not_found', '没有找到此权重版本。');
    if (weight.pvcBindings) {
      try { for (const b of weight.pvcBindings) await new Kubernetes(this.config).claim(weight.target.namespace, b.claimName, b.uid); this.store.saveWeight({ ...weight, status: 'available', message: 'PVC 绑定与 UID 检查通过；目录内容在部署时加载验证。', updatedAt: new Date().toISOString() }); }
      catch (error) { this.store.saveWeight({ ...weight, status: 'failed', message: error instanceof AppError ? error.message : 'PVC 检查失败。', updatedAt: new Date().toISOString() }); }
      return publicWeight(this.store.weight(id)!);
    }
    if (this.config.APP_MODE === 'demo' || !weight.importId) return publicWeight(weight);
    try {
      const result = await this.upstream.request('registry', `/internal/v1/weight-imports/${encodeURIComponent(weight.importId)}`, actor);
      const state = String(result.status ?? '');
      const status = state === 'available' ? 'available' : ['failed', 'error'].includes(state) ? 'failed' : ['pending', 'preparing', 'importing', 'validating', 'queued', 'running'].includes(state) ? 'importing' : 'unknown';
      const message = typeof result.message === 'string' ? result.message : status === 'available' ? '权重校验与存储准备完成，可用于部署。' : status === 'failed' ? '权重准备失败，请检查来源、manifest.json 和 _READY。' : status === 'unknown' ? '平台返回了待核对的状态，暂不可用于部署。' : '平台正在校验权重并准备目标存储。';
      this.store.saveWeight({ ...weight, status, message: cleanMessage(message, [this.config.REGISTRY_TOKEN]), updatedAt: new Date().toISOString() });
    } catch (error) {
      this.store.saveWeight({ ...weight, status: 'unknown', message: error instanceof AppError ? error.message : '状态同步失败，请稍后刷新。', updatedAt: new Date().toISOString() });
    }
    return publicWeight(this.store.weight(id)!);
  }
  async sync() {
    if (this.syncing || this.config.APP_MODE === 'demo') return;
    this.syncing = true;
    try {
      const pending = this.store.weights().filter(w => w.importId && ['importing', 'unknown'].includes(w.status));
      for (let i = 0; i < pending.length; i += 4) await Promise.allSettled(pending.slice(i, i + 4).map(w => this.refresh(w.id, 'launchpad-reconciler')));
    } finally { this.syncing = false; }
  }
  async drain() { await Promise.allSettled([...this.tasks]); }
}
