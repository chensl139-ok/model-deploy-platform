import { randomUUID, createHash } from 'node:crypto';
import type { Action, ConfigInput, ConfigPreview, CreateInput, JsonObject, Preview, RuntimeDeploymentInput, RuntimeDeploymentPreview, RuntimeProfileDetail } from '../shared/types.js';
import type { Config } from './config.js';
import { asObject, loadCatalog, publicModels, type CatalogModel } from './catalog.js';
import { Store, publicService, type Operation, type StoredService } from './store.js';
import { Upstream } from './upstream.js';
import { AppError, cleanMessage } from './errors.js';
import { containsSpec, prepareConfig, runtimeConfig } from './runtime.js';
import { Kubernetes } from './kubernetes.js';

const now = () => new Date().toISOString();
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uncertain = (error: unknown) => !(error instanceof AppError) || error.statusCode >= 500;
const errorMessage = (error: unknown) => error instanceof AppError ? error.message : '操作未能完成，请刷新后重试。';
export class Manager {
  private baseCatalog: CatalogModel[];
  get catalog(): CatalogModel[] { return [...new Map([...this.baseCatalog, ...this.store.assets<CatalogModel>('model')].map(m => [m.id, m])).values()].filter(m => !this.store.asset('deleted-model', m.id)); }
  upstream: Upstream;
  tasks = new Set<Promise<unknown>>();
  private syncing = false;
  private writeEpoch = new Map<string, number>();
  constructor(public config: Config, public store: Store) {
    const mode = store.db.prepare("SELECT value FROM settings WHERE key='mode'").get() as { value: string } | undefined;
    if (mode?.value === 'setup' && config.APP_MODE === 'live') store.db.prepare("UPDATE settings SET value='live' WHERE key='mode'").run();
    else if (mode && mode.value !== config.APP_MODE) throw new Error('演示与真实环境不能共享数据库，请为真实环境配置独立的 DATABASE_PATH');
    store.db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES ('mode',?)").run(config.APP_MODE);
    if (config.APP_MODE === 'live') {
      const binding = JSON.stringify({ provider: config.DEPLOYMENT_PROVIDER, ...(config.DEPLOYMENT_PROVIDER === 'kubernetes' ? { context: config.KUBE_CONTEXT, namespaces: config.KUBE_NAMESPACES, instance: config.KUBE_INSTANCE_ID } : {}) });
      const saved = store.db.prepare("SELECT value FROM settings WHERE key='deployment-binding'").get() as { value: string } | undefined;
      if (saved && saved.value !== binding) throw new Error('不能将已有数据库切换到其他部署后端或 Kubernetes 上下文，请使用独立 DATABASE_PATH');
      store.db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES ('deployment-binding',?)").run(binding);
    }
    this.baseCatalog = loadCatalog(config);
    this.upstream = new Upstream(config);
    if (config.APP_MODE === 'demo' && store.list().length === 0 && !store.db.prepare('SELECT id FROM services LIMIT 1').get()) this.seed();
    if (config.APP_MODE === 'demo') for (const service of store.list()) {
      if (!service.spec) { service.spec = this.demoSpec(service); store.save(service); }
    }
    // Never replay a write automatically after a process restart.
    for (const op of store.pending()) {
      if (op.status === 'pending') this.finish(op, 'unknown', '服务进程曾中断，正在核对实际结果；不会自动重复执行操作。');
    }
  }
  models() { return publicModels(this.catalog); }
  private requireConnection() { if (this.config.APP_MODE === 'setup') throw new AppError(503, 'platform_not_connected', '尚未接入真实管理接口，不能执行部署操作。'); }
  requireService(id: string) {
    const service = this.store.get(id);
    if (!service) throw new AppError(404, 'not_found', '该服务不存在或已经删除。');
    return service;
  }
  list() { return this.store.list().map(publicService); }
  detail(id: string) { const service = this.requireService(id); return { service: publicService(service), activities: this.store.activities(id), runtime: runtimeConfig(service) }; }
  audit() { return this.store.audit(); }
  private demoSpec(service: StoredService): JsonObject {
    return { modelRef: { name: service.invocationModel, version: service.modelVersion }, backend: { type: 'NativeDeployment' }, runtime: { image: `registry.example.com/inference/${service.modelId}@sha256:${fingerprint(service.modelId)}`, resources: { requests: { cpu: '2', memory: '8Gi', [service.gpuMemoryGB === 96 ? 'nvidia.com/gpu' : service.gpuMemoryGB === 48 ? 'nvidia.com/mig-2g.48gb' : 'nvidia.com/mig-1g.24gb']: '1' }, limits: { cpu: '4', memory: '16Gi' } } }, rollout: { replicas: service.desiredReplicas }, capacity: { maxConcurrentRequestsPerPod: 4 } };
  }
  seed() {
    const fixtures = [
      { model: this.catalog[0], name: 'qwen3-playground', stopped: false, hours: 48 },
      { model: this.catalog[1], name: 'reasoning-lab', stopped: false, hours: 18 },
      { model: this.catalog[2], name: 'qwen3-evaluation', stopped: true, hours: 5 },
    ];
    for (const fixture of fixtures) {
      const variant = fixture.model.variants[0];
      const service = this.makeService({ modelId: fixture.model.id, variantId: variant.id, name: fixture.name });
      service.createdAt = new Date(Date.now() - fixture.hours * 3600000).toISOString();
      service.updatedAt = service.createdAt;
      service.status = fixture.stopped ? 'stopped' : 'running';
      service.desiredReplicas = fixture.stopped ? 0 : 1;
      service.readyReplicas = service.desiredReplicas;
      service.message = fixture.stopped ? '已停止，计算资源已释放。' : '演示实例正在运行。';
      service.busy = false;
      service.routeReady = !fixture.stopped;
      service.observedAt = now();
      service.spec = this.demoSpec(service);
      if (!fixture.stopped) service.endpoint = { address: `https://${service.name}.demo.example` };
      this.store.save(service);
      const op: Operation = { id: randomUUID(), serviceId: service.id, kind: 'create', status: 'succeeded', fingerprint: '', actor: '演示用户', message: '服务已创建（演示数据）', createdAt: service.createdAt, updatedAt: service.createdAt };
      this.store.saveOperation(op);
    }
  }
  makeService(input: CreateInput): StoredService {
    const model = this.catalog.find(m => m.id === input.modelId);
    const variant = model?.variants.find(v => v.id === input.variantId);
    if (!model || !variant) throw new AppError(400, 'invalid_template', '模型或运行规格已变更，请重新选择。');
    return {
      id: randomUUID(), name: input.name, modelId: model.id, modelName: model.name, modelVersion: model.version, invocationModel: model.servedModelName ?? model.modelKey ?? model.id,
      framework: model.framework, variantId: variant.id, gpuLabel: variant.label, gpuMemoryGB: variant.memoryGB,
      clusterId: variant.clusterId, namespace: variant.namespace, targetId: variant.targetId,
      status: 'preparing', message: '配置已检查，等待创建。', live: true, stale: false,
      routeReady: false, readyReplicas: null, desiredReplicas: 1, busy: false, revision: '',
      createdAt: now(), updatedAt: now(), observability: [],
    };
  }
  async preview(input: CreateInput, actor: string): Promise<Preview> {
    this.requireConnection();
    if (this.config.DEPLOYMENT_PROVIDER === 'kubernetes') throw new AppError(422, 'runtime_required', '原生 Kubernetes 请使用推理运行配置部署。');
    const service = this.makeService(input);
    if (this.store.list().some(s => s.clusterId === service.clusterId && s.namespace === service.namespace && s.name === service.name)) {
      throw new AppError(409, 'name_exists', '此名称已被使用，请换一个名称。');
    }
    const model = this.catalog.find(m => m.id === input.modelId)!;
    const variant = model.variants.find(v => v.id === input.variantId)!;
    const weightVersion = input.weightVersionId ? this.store.weight(input.weightVersionId) : undefined;
    if (input.weightVersionId) {
      if (!weightVersion || weightVersion.modelId !== model.id || weightVersion.status !== 'available') throw new AppError(409, 'weights_not_ready', '所选权重版本未就绪或不属于当前模型。');
      if (weightVersion.target.clusterId !== variant.clusterId || weightVersion.target.namespace !== variant.namespace || (this.config.APP_MODE === 'live' && weightVersion.target.id !== variant.targetId)) throw new AppError(409, 'weight_target_mismatch', '此权重版本未在所选运行位置准备好，请选择对应规格。');
      if (this.config.APP_MODE === 'live' && !variant.runtimePackageId) throw new AppError(422, 'weight_template_unsupported', '从 OSS 导入的版本需要通过 Registry 运行包解析挂载，当前固定 Spec 模板不支持切换权重。');
      service.modelVersion = weightVersion.revision;
      service.weightSource = { revision: weightVersion.revision, sources: weightVersion.sources, versionId: weightVersion.id };
    }
    let glueProfile: JsonObject | undefined;
    if (this.config.APP_MODE === 'live') {
      await this.upstream.authorized(service.clusterId, service.namespace, actor);
      if (variant.runtimePackageId) {
        const query = new URLSearchParams({ runtime_package_id: variant.runtimePackageId, model_key: weightVersion?.modelKey ?? model.modelKey ?? model.id, model_revision: weightVersion?.revision ?? model.modelRevision ?? model.version });
        const response = await this.upstream.request('registry', `/v1/deployment-options?${query}`, actor);
        const option = (Array.isArray(response.options) ? response.options : []).map(asObject).find(o => {
          const target = asObject(o.target);
          return target.target_id === variant.targetId && Number(target.cluster_id) === variant.clusterId && target.namespace === variant.namespace;
        });
        if (!option || !Object.keys(asObject(option.resolved_spec)).length) throw new AppError(409, 'weights_not_ready', '此模型在目标位置还没有可用部署配置，请管理员检查权重和运行包。');
        service.spec = asObject(option.resolved_spec);
        if (option.glue_profile) glueProfile = asObject(option.glue_profile);
      } else {
        service.spec = structuredClone(variant.spec!);
      }
      // Lightweight service controls only support a normal single deployment, not distributed roles.
      if (asObject(service.spec.backend).type !== 'NativeDeployment') throw new AppError(422, 'unsupported_backend', '此轻量平台仅支持普通 NativeDeployment 模板。');
      service.desiredReplicas = typeof asObject(service.spec.rollout).replicas === 'number' ? asObject(service.spec.rollout).replicas as number : 1;
      const result = await this.upstream.request('io', `${this.upstream.path(service.clusterId, service.namespace)}/preview`, actor, { method: 'POST', body: { name: service.name, spec: service.spec, ...(glueProfile ? { glue_profile: glueProfile } : {}) } });
      if (result.valid !== true) throw new AppError(422, 'preview_failed', '部署预检未通过，请联系管理员检查模板。');
    }
    if (this.config.APP_MODE === 'demo') service.spec = this.demoSpec(service);
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + 5 * 60000).toISOString();
    this.store.savePreview({ id, actor, service, glueProfile, expiresAt });
    return {
      id, expiresAt, name: service.name, modelName: model.name, modelVersion: service.modelVersion,
      gpuLabel: variant.label, targetLabel: `${service.clusterId} / ${service.namespace}`,
      checks: [
        { label: '模型配置', description: this.config.APP_MODE === 'demo' ? '演示模板已准备' : '已解析管理员维护的模型模板' },
        { label: '部署位置', description: this.config.APP_MODE === 'demo' ? '演示环境，不占用真实 GPU' : '已核对集群与命名空间权限' },
        { label: '部署预检', description: this.config.APP_MODE === 'demo' ? '演示检查通过' : '控制面预检通过；资源及推理仍待运行验证' },
      ],
    };
  }
  async previewRuntime(input: RuntimeDeploymentInput, runtime: RuntimeProfileDetail, actor: string): Promise<RuntimeDeploymentPreview> {
    this.requireConnection();
    const { profile, image, command } = runtime;
    if (this.config.APP_MODE === 'live' && image.status !== 'available') throw new AppError(409, 'image_not_verified', '此镜像的验证或产物状态不可用，不能创建新部署。');
    const weight = this.store.weight(input.weightVersionId);
    const model = this.catalog.find(m => m.id === profile.modelId);
    if (!model || !weight || weight.modelId !== model.id || weight.status !== 'available') throw new AppError(409, 'weights_not_ready', '请选择当前模型已就绪的权重版本。');
    if (profile.status !== 'published' || !profile.packageId) throw new AppError(409, 'runtime_not_published', '运行配置尚未发布到 Registry。');
    const expectedRoles = profile.mounts.map(m => m.role).sort(); const actualRoles = weight.sources.map(s => s.role).sort();
    if (JSON.stringify(expectedRoles) !== JSON.stringify(actualRoles)) throw new AppError(422, 'weight_role_mismatch', `运行配置要求权重角色 ${expectedRoles.join(', ')}，所选版本提供 ${actualRoles.join(', ')}。`);
    const { clusterId, namespace } = weight.target;
    if (this.store.list().some(s => s.clusterId === clusterId && s.namespace === namespace && s.name === input.name)) throw new AppError(409, 'name_exists', '此位置已有同名服务。');
    let spec: JsonObject; let glueProfile: JsonObject | undefined;
    if (this.config.APP_MODE === 'live') {
      await this.upstream.authorized(clusterId, namespace, actor);
      if (this.config.DEPLOYMENT_PROVIDER === 'kubernetes') spec = await new Kubernetes(this.config).resolve(runtime, weight);
      else {
      const query = new URLSearchParams({ runtime_package_id: profile.packageId, model_key: weight.modelKey, model_revision: weight.revision });
      const options = await this.upstream.request('registry', `/v1/deployment-options?${query}`, actor);
      const option = (Array.isArray(options.options) ? options.options : []).map(asObject).find(o => { const target = asObject(o.target); return target.target_id === weight.target.id && Number(target.cluster_id) === clusterId && target.namespace === namespace; });
      if (!option || !Object.keys(asObject(option.resolved_spec)).length) throw new AppError(409, 'deployment_option_missing', '所选运行包与权重在该目标没有可部署配置，请检查镜像和权重准备。');
      spec = structuredClone(asObject(option.resolved_spec));
      if (option.glue_profile) glueProfile = asObject(option.glue_profile);
      if (asObject(spec.backend).type !== 'NativeDeployment') throw new AppError(422, 'unsupported_backend', '此流程当前支持单 Pod 内多 GPU/多进程部署；跨节点 LWS/PD 拓扑需要专门的部署配置。');
      if ((!image.artifactId && asObject(spec.runtime).image !== image.imageRef) || (image.artifactId && (typeof asObject(spec.runtime).image !== 'string' || !/@sha256:[a-f0-9]{64}$/.test(String(asObject(spec.runtime).image))))) throw new AppError(422, 'runtime_image_mismatch', 'Registry 解析的镜像与选定版本不一致，拒绝部署，请核对运行包。');
      }
    } else {
      const component = asObject((runtime.registryRequest.components as JsonObject[])[0]);
      spec = { modelRef: { name: model.modelKey ?? model.id, version: weight.revision }, backend: { type: 'NativeDeployment' }, runtime: { image: image.imageRef, command: component.command, args: component.args, resources: { requests: { cpu: String(profile.cpuCores), memory: `${profile.memoryGB}Gi`, ...(profile.gpuCount ? { [profile.gpuResourceName]: String(profile.gpuCount) } : {}) } }, ports: [{ name: 'http', containerPort: profile.port }] }, service: { enabled: true, type: 'ClusterIP', port: profile.port } };
    }
    spec.rollout = { ...asObject(spec.rollout), replicas: input.replicas ?? 1 };
    spec.capacity = { ...asObject(spec.capacity), maxConcurrentRequestsPerPod: profile.maxConcurrency };
    if (this.config.APP_MODE === 'live') {
      const result = await this.upstream.request('io', `${this.upstream.path(clusterId, namespace)}/preview`, actor, { method: 'POST', body: { name: input.name, spec, ...(glueProfile ? { glue_profile: glueProfile } : {}) } });
      if (result.valid !== true || !Object.keys(asObject(result.kubernetes_preview)).length) throw new AppError(422, 'preview_failed', '控制面没有确认部署配置有效，请查看返回错误并修正配置。');
    }
    const service: StoredService = { id: randomUUID(), name: input.name, modelId: model.id, modelName: model.name, modelVersion: weight.revision, invocationModel: model.servedModelName ?? model.modelKey ?? model.id, framework: this.engineName(profile.engineId), variantId: profile.id, gpuLabel: profile.gpuCount ? `${profile.gpuCount} × ${weight.target.gpuType} (${profile.gpuResourceName})` : `${profile.cpuCores} CPU / ${profile.memoryGB} GiB`, gpuMemoryGB: profile.gpuMemoryGB, clusterId, namespace, targetId: weight.target.id, status: 'preparing', message: '运行配置已预检，等待确认部署。', live: true, stale: false, routeReady: false, readyReplicas: null, desiredReplicas: input.replicas ?? 1, busy: false, revision: '', createdAt: now(), updatedAt: now(), observability: [], spec, weightSource: { revision: weight.revision, sources: weight.sources, versionId: weight.id }, deployment: { profileId: profile.id, profileName: `${profile.name} / ${profile.version}`, engineId: profile.engineId, imageRef: String(asObject(spec.runtime).image ?? image.imageRef), command, healthPath: profile.healthPath, livenessPath: profile.livenessPath, startupTimeoutSeconds: profile.startupTimeoutSeconds, registryPackageId: profile.packageId } };
    const id = randomUUID(); const expiresAt = new Date(Date.now() + 5 * 60000).toISOString();
    if (!this.store.weight(weight.id) || this.store.asset('archived:runtime', profile.id)) throw new AppError(409, 'configuration_deleted', '部署依赖已删除，请重新选择。');
    if (!this.catalog.some(m => m.id === model.id)) throw new AppError(409, 'model_deleted', '模型已删除，请重新选择。');
    this.store.savePreview({ id, expiresAt, actor, service, glueProfile });
    // A Registry spec may contain credentials. The browser receives a redacted review copy only.
    const review = JSON.parse(JSON.stringify(spec)) as JsonObject;
    const scrub = (value: unknown): unknown => Array.isArray(value) ? value.map(scrub) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, ['env', 'envVars', 'envFrom', 'startupScripts', 'command', 'args'].includes(key) ? '[由运行配置生成；请在配置详情中查看]' : /password|token|credential/i.test(key) ? '[REDACTED]' : scrub(child)])) : value;
    return { id, expiresAt, name: input.name, modelName: model.name, modelVersion: weight.revision, gpuLabel: service.gpuLabel, targetLabel: `${clusterId} / ${namespace}`, profileId: profile.id, image: String(asObject(spec.runtime).image ?? image.imageRef), command, spec: scrub(review) as JsonObject, warnings: [this.config.APP_MODE === 'demo' ? '当前为演示模式，不校验真实镜像或执行 GPU 部署。' : '预检已通过，部署后仍需确认模型加载和实际推理。', ...(['vllm-omni', 'sglang-omni'].includes(profile.engineId) ? ['Omni 阶段配置与依赖需包含在镜像或权重目录中；跨节点拓扑不在此流程内。'] : [])], checks: [{ label: '权重角色', description: expectedRoles.join(' / ') }, { label: '运行包', description: profile.packageId }, { label: '部署位置', description: `${clusterId} / ${namespace}` }, { label: '预检', description: this.config.APP_MODE === 'demo' ? '模拟检查' : this.config.DEPLOYMENT_PROVIDER === 'kubernetes' ? 'Kubernetes 服务端预检通过' : 'Registry 解析与 IO preview 已通过' }] };
  }
  private engineName(id: string) { return ({ vllm: 'vLLM', sglang: 'SGLang', 'vllm-omni': 'vLLM-Omni', 'sglang-omni': 'SGLang Omni', custom: '自定义引擎' } as Record<string, string>)[id] ?? id; }
  create(previewId: string, requestId: string, actor: string) {
    this.requireConnection();
    const hash = fingerprint({ previewId, actor });
    const previous = this.replay(requestId, hash);
    if (previous) return previous;
    const preview = this.store.preview(previewId);
    if (!preview || preview.actor !== actor || Date.parse(preview.expiresAt) < Date.now()) throw new AppError(409, 'preview_expired', '预检结果已过期，请重新检查。');
    if (preview.consumedBy) throw new AppError(409, 'preview_used', '此预检已经提交，请在服务列表查看结果。');
    const service = preview.service;
    if (!this.catalog.some(m => m.id === service.modelId)) throw new AppError(409, 'model_deleted', '模型已删除，请重新选择。');
    const operation: Operation = { id: requestId, serviceId: service.id, kind: 'create', actor, fingerprint: hash, requestedSpec: service.spec ? structuredClone(service.spec) : undefined, status: 'pending', message: '正在提交部署请求', createdAt: now(), updatedAt: now() };
    try {
      this.store.transaction(() => {
        this.store.save({ ...service, busy: true, message: '正在提交部署请求。' });
        this.store.saveOperation(operation);
        this.store.savePreview({ ...preview, consumedBy: requestId });
      });
    } catch { throw new AppError(409, 'name_exists', '此名称或请求已被使用，请刷新列表确认。'); }
    this.writeEpoch.set(service.id, (this.writeEpoch.get(service.id) ?? 0) + 1);
    this.launch(async () => {
      try {
        if (this.config.APP_MODE === 'demo') {
          await this.demoTransition(service, operation);
          return;
        }
        await this.upstream.authorized(service.clusterId, service.namespace, actor);
        const result = await this.upstream.request('io', this.upstream.path(service.clusterId, service.namespace), actor, {
          method: 'POST', body: { name: service.name, request_id: requestId, spec: service.spec, ...(preview.glueProfile ? { glue_profile: preview.glueProfile } : {}) },
        });
        const kubernetes = asObject(result.kubernetes);
        this.applyObserved(service, kubernetes, result);
        service.creationConfirmed = Boolean(service.uid);
        service.busy = false;
        service.updatedAt = now();
        this.store.save(service);
        this.finish(operation, 'succeeded', '部署请求已接受，等待实例运行。');
        await this.refresh(service.id, actor);
      } catch (error) { this.operationFailed(service, operation, error); }
    });
    return { serviceId: service.id, operationId: operation.id, status: operation.status };
  }
  replay(id: string, hash: string) {
    const existing = this.store.operation(id);
    if (!existing) return;
    if (existing.fingerprint !== hash) throw new AppError(409, 'request_conflict', '同一请求标识不能用于不同操作。');
    return { serviceId: existing.serviceId, operationId: id, status: existing.status };
  }
  private async editable(id: string, revision: string, actor: string) {
    let service = this.requireService(id);
    if (service.busy || this.store.pending().some(o => o.serviceId === id)) throw new AppError(409, 'operation_pending', '服务仍有操作未确认，请先等待或核对结果。');
    if (publicService(service).revision !== revision) throw new AppError(409, 'workload_changed', '服务已变化，请重新读取配置并确认差异。');
    if (this.config.APP_MODE === 'live') {
      const identity = `${service.uid}:${service.resourceVersion}`;
      await this.refresh(id, actor); service = this.requireService(id);
      if (service.stale || !service.live || !service.uid || !service.resourceVersion || service.missing) throw new AppError(409, 'stale_service', '无法获取实时对象，暂不允许变更。');
      if (`${service.uid}:${service.resourceVersion}` !== identity) throw new AppError(409, 'workload_changed', '控制面版本已变化，请刷新并重新预检。');
    }
    return service;
  }
  async previewConfiguration(id: string, revision: string, input: ConfigInput, actor: string): Promise<ConfigPreview> {
    this.requireConnection();
    const service = await this.editable(id, revision, actor);
    const { spec, changes } = prepareConfig(service, input);
    if (this.config.DEPLOYMENT_PROVIDER === 'kubernetes' && input.image && input.image !== runtimeConfig(service).image && !this.store.assets<import('../shared/types.js').RuntimeImage>('image').some(image => image.imageRef === input.image && image.status === 'available' && image.validation?.architecture === asObject(spec.kubernetes).architecture)) throw new AppError(422, 'image_not_verified', '请先在镜像版本库验证与当前节点架构一致的新镜像摘要。');
    if (this.config.APP_MODE === 'live') {
      const result = await this.upstream.request('io', `${this.path(service)}/spec/preview`, actor, { method: 'POST', headers: { 'X-Expected-UID': service.uid!, 'X-Expected-Resource-Version': service.resourceVersion! }, body: { spec } });
      if (result.valid === false || !Object.keys(asObject(result.kubernetes_preview)).length) throw new AppError(422, 'preview_failed', '控制面未确认此配置可接受，无法提交变更。');
    }
    // A concurrent operation may have started while the remote preview was running.
    const current = this.requireService(id);
    if (current.busy || publicService(current).revision !== publicService(service).revision) throw new AppError(409, 'workload_changed', '预检期间服务发生变化，请重新检查。');
    const preview = { id: randomUUID(), actor, serviceId: id, revision: publicService(service).revision, expiresAt: new Date(Date.now() + 5 * 60000).toISOString(), spec, changes };
    this.store.saveConfigPreview(preview);
    return { id: preview.id, expiresAt: preview.expiresAt, changes, warnings: ['资源与镜像变更可能触发实例滚动更新，实际就绪状态会持续同步。', ...(input.replicas > service.desiredReplicas ? ['增加实例会额外申请 GPU，预检不保证当前资源可调度。'] : []), ...(input.maxConcurrency !== undefined && input.maxConcurrency !== runtimeConfig(service).maxConcurrency ? ['容量声明不等于修改推理引擎的调度参数，需与模型实际能力一致。'] : [])] };
  }
  configure(id: string, previewId: string, requestId: string, actor: string) {
    this.requireConnection();
    const hash = fingerprint({ id, previewId, actor });
    const replay = this.replay(requestId, hash); if (replay) return replay;
    const preview = this.store.configPreview(previewId);
    if (!preview || preview.serviceId !== id || preview.actor !== actor || Date.parse(preview.expiresAt) < Date.now() || preview.consumedBy) throw new AppError(409, 'preview_expired', '变更预检已失效或已使用，请重新检查。');
    const service = this.requireService(id);
    if (service.busy || service.stale || !service.live || this.store.pending().some(o => o.serviceId === id) || publicService(service).revision !== preview.revision) throw new AppError(409, 'workload_changed', '配置预检后服务已变化，请刷新后重新确认。');
    const operation: Operation = { id: requestId, serviceId: id, kind: 'configure', actor, fingerprint: hash, baselineUid: service.uid, baselineVersion: service.resourceVersion, requestedSpec: preview.spec, changes: preview.changes, status: 'pending', message: '正在发布已预检的配置变更。', createdAt: now(), updatedAt: now() };
    this.store.transaction(() => { this.store.saveOperation(operation); this.store.save({ ...service, busy: true }); this.store.saveConfigPreview({ ...preview, consumedBy: requestId }); });
    this.writeEpoch.set(id, (this.writeEpoch.get(id) ?? 0) + 1);
    this.launch(async () => {
      try {
        if (this.config.APP_MODE === 'demo') {
          this.store.save({ ...service, busy: true, message: '正在应用运行配置…' });
          await new Promise(resolve => setTimeout(resolve, this.config.NODE_ENV === 'test' ? 5 : 1400));
          const replicas = asObject(preview.spec.rollout).replicas as number;
          if (replicas === 0 && service.desiredReplicas > 0) service.resumeReplicas = service.desiredReplicas;
          this.store.save({ ...this.requireService(id), spec: preview.spec, resumeReplicas: service.resumeReplicas, desiredReplicas: replicas, readyReplicas: replicas, status: replicas ? 'running' : 'stopped', routeReady: replicas > 0, endpoint: replicas ? { address: `https://${service.name}.demo.example` } : undefined, message: '演示运行配置已更新。', busy: false, updatedAt: now(), observedAt: now() });
          this.finish(operation, 'succeeded', '运行配置变更已完成（演示）。'); return;
        }
        const result = await this.upstream.request('io', `${this.path(service)}/spec`, actor, { method: 'PUT', headers: { 'X-Expected-UID': service.uid!, 'X-Expected-Resource-Version': service.resourceVersion! }, body: { request_id: requestId, spec: preview.spec } });
        this.applyObserved(service, asObject(result.kubernetes), result);
        this.store.save({ ...service, busy: false, updatedAt: now() });
        this.finish(operation, 'succeeded', '控制面已接受配置变更，等待运行状态收敛。');
        await this.refresh(id, actor);
      } catch (error) { this.operationFailed(service, operation, error); }
    });
    return { serviceId: id, operationId: requestId, status: 'pending' };
  }
  async action(id: string, kind: Action, requestId: string, revision: string, actor: string) {
    this.requireConnection();
    const hash = fingerprint({ id, kind, revision, actor });
    const previous = this.replay(requestId, hash);
    if (previous) return previous;
    let service = this.requireService(id);
    if (service.busy || this.store.pending().some(o => o.serviceId === id)) throw new AppError(409, 'operation_pending', '上一项操作尚未确认结果，请先刷新服务状态。');
    if (revision !== publicService(service).revision) throw new AppError(409, 'workload_changed', '服务状态已发生变化，请刷新后重新确认操作。');
    const originalIdentity = `${service.uid}:${service.resourceVersion}`;
    if (this.config.APP_MODE === 'live') {
      await this.refresh(id, actor);
      service = this.requireService(id);
      if (kind === 'delete' && service.missing && !service.uid) {
        const operation: Operation = { id: requestId, serviceId: id, kind, actor, fingerprint: hash, status: 'succeeded', message: '已确认集群中不存在此服务，仅移除本地失败记录。', createdAt: now(), updatedAt: now() };
        this.store.transaction(() => { this.store.save({ ...service, deleted: true }); this.store.saveOperation(operation); });
        return { serviceId: id, operationId: requestId, status: 'succeeded' };
      }
      if (!service.live || service.stale || !service.uid || !service.resourceVersion) throw new AppError(409, 'stale_service', '无法取得实时服务状态，暂时不能修改。');
      if (`${service.uid}:${service.resourceVersion}` !== originalIdentity) throw new AppError(409, 'workload_changed', '服务版本已变化，请查看最新状态后重新操作。');
    }
    if (kind === 'online' && service.status !== 'stopped') throw new AppError(409, 'invalid_state', '仅已停止的服务可以启动。');
    if ((kind === 'offline' || kind === 'restart') && !['running', 'starting'].includes(service.status)) throw new AppError(409, 'invalid_state', '服务当前状态不支持此操作。');
    if (kind === 'offline' && service.desiredReplicas > 0) service.resumeReplicas = service.desiredReplicas;
    const resumeReplicas = Math.max(1, service.resumeReplicas ?? 1);
    const operation: Operation = { id: requestId, serviceId: id, kind, actor, fingerprint: hash, nonce: kind === 'restart' ? requestId : undefined, baselineUid: service.uid, baselineVersion: service.resourceVersion, status: 'pending', message: '正在提交操作', createdAt: now(), updatedAt: now() };
    try {
      this.store.transaction(() => {
        const current = this.requireService(id);
        if (current.busy) throw new Error('busy');
        this.store.save({ ...current, resumeReplicas: service.resumeReplicas, busy: true });
        this.store.saveOperation(operation);
      });
    } catch { throw new AppError(409, 'operation_pending', '服务已有其他操作正在执行，请稍后刷新。'); }
    this.writeEpoch.set(id, (this.writeEpoch.get(id) ?? 0) + 1);
    this.launch(async () => {
      try {
        if (this.config.APP_MODE === 'demo') { await this.demoTransition(service, operation); return; }
        const headers = { 'X-Expected-UID': service.uid!, 'X-Expected-Resource-Version': service.resourceVersion! };
        if (kind === 'delete') {
          await this.upstream.request('io', this.path(service), actor, { method: 'DELETE', headers });
          // Keep a tombstone while the actual deletion is still converging.
          this.finish(operation, 'unknown', '删除请求已接受，正在确认对象回收。');
          this.store.save({ ...service, busy: true, message: '删除请求已接受，等待对象消失。' });
        } else {
          const result = await this.upstream.request('io', `${this.path(service)}/actions/${kind}`, actor, {
            method: 'POST', headers, body: { request_id: requestId, ...(kind === 'online' ? { replicas: resumeReplicas } : {}), ...(kind === 'restart' ? { restart_nonce: operation.nonce } : {}) },
          });
          this.applyObserved(service, asObject(result.kubernetes), result);
          service.busy = false;
          service.updatedAt = now();
          this.store.save(service);
          this.finish(operation, 'succeeded', '操作已接受，正在同步运行状态。');
        }
        await this.refresh(id, actor);
      } catch (error) { this.operationFailed(service, operation, error); }
    });
    return { serviceId: id, operationId: requestId, status: 'pending' };
  }
  private operationFailed(service: StoredService, op: Operation, error: unknown) {
    const unknown = uncertain(error);
    const current = this.store.get(service.id);
    if (!current) return;
    const message = errorMessage(error);
    this.store.save({ ...current, busy: unknown, stale: unknown || current.stale, live: unknown ? false : current.live, ...(op.kind === 'create' && !unknown ? { status: 'failed' as const } : {}), message, updatedAt: now() });
    this.finish(op, unknown ? 'unknown' : 'failed', message);
  }
  private finish(operation: Operation, status: Operation['status'], message: string) {
    this.writeEpoch.set(operation.serviceId, (this.writeEpoch.get(operation.serviceId) ?? 0) + 1);
    this.store.saveOperation({ ...operation, status, message, updatedAt: now() });
  }
  private launch(fn: () => Promise<void>) {
    const task = Promise.resolve().then(fn);
    this.tasks.add(task);
    void task.catch(() => {}).finally(() => this.tasks.delete(task));
  }
  async drain() { await Promise.allSettled([...this.tasks]); }
  private path(service: StoredService) { return this.upstream.path(service.clusterId, service.namespace, service.name); }
  private async demoTransition(service: StoredService, op: Operation) {
    const delay = this.config.NODE_ENV === 'test' ? 5 : 1600;
    const pause = () => new Promise(resolve => setTimeout(resolve, delay));
    if (op.kind === 'create' || op.kind === 'online' || op.kind === 'restart') {
      const desiredReplicas = op.kind === 'restart' ? Math.max(1, service.desiredReplicas) : Math.max(1, service.resumeReplicas ?? 1);
      const spec = structuredClone(service.spec ?? this.demoSpec(service)); spec.rollout = { ...asObject(spec.rollout), replicas: desiredReplicas };
      this.store.save({ ...service, spec, busy: true, status: 'starting', message: op.kind === 'restart' ? '正在重启实例…' : '正在准备运行环境…', updatedAt: now(), desiredReplicas, readyReplicas: 0, routeReady: false, endpoint: undefined });
      await pause();
      const current = this.requireService(service.id);
      this.store.save({ ...current, status: 'starting', message: '正在加载模型并检查服务…', updatedAt: now() });
      await pause();
      this.store.save({ ...this.requireService(service.id), status: 'running', message: '演示实例已就绪。真实环境还需验证模型推理。', busy: false, readyReplicas: desiredReplicas, observedAt: now(), updatedAt: now(), routeReady: true, endpoint: { address: `https://${service.name}.demo.example` } });
    } else {
      await pause();
      const current = this.requireService(service.id);
      const spec = structuredClone(current.spec ?? this.demoSpec(current)); spec.rollout = { ...asObject(spec.rollout), replicas: 0 };
      this.store.save({ ...current, spec, deleted: op.kind === 'delete', busy: false, status: 'stopped', message: '已停止，计算资源已释放。', desiredReplicas: 0, readyReplicas: 0, routeReady: false, endpoint: undefined, updatedAt: now(), observedAt: now() });
    }
    this.finish(op, 'succeeded', ({ create: '演示部署已完成', online: '演示服务已启动', offline: '演示服务已停止', restart: '演示服务已重启', delete: '演示服务已删除', configure: '演示配置已更新' })[op.kind]);
  }
  private applyObserved(service: StoredService, kubernetes: JsonObject, detail: JsonObject) {
    const spec = asObject(kubernetes.spec);
    const status = asObject(kubernetes.status);
    const desired = asObject(spec.rollout).replicas;
    if (desired === 0 && service.desiredReplicas > 0) service.resumeReplicas = service.desiredReplicas;
    if (typeof desired === 'number') service.desiredReplicas = desired;
    if (typeof kubernetes.uid === 'string') service.uid = kubernetes.uid;
    if (typeof kubernetes.resource_version === 'string') service.resourceVersion = kubernetes.resource_version;
    if (Object.keys(spec).length) service.spec = spec;
    service.readyReplicas = typeof status.readyReplicas === 'number' ? status.readyReplicas : null;
    const phase = String(status.phase ?? '');
    const converged = !(typeof kubernetes.generation === 'number' && typeof status.observedGeneration === 'number' && status.observedGeneration < kubernetes.generation);
    if (['Failed', 'Error', 'Degraded'].includes(phase)) { service.status = 'failed'; service.message = typeof status.message === 'string' ? cleanMessage(status.message, [this.config.IO_MANAGEMENT_TOKEN, this.config.REGISTRY_TOKEN]) : '运行异常，请检查平台状态与观测信息。'; }
    else if (service.desiredReplicas === 0 && converged && (service.readyReplicas === 0 || ['Stopped', 'Offline', 'ScaledToZero'].includes(phase))) { service.status = 'stopped'; service.message = '实例已停止。'; }
    else if (phase === 'Running' && converged && service.desiredReplicas > 0) { service.status = 'running'; service.message = '控制面报告运行就绪，真实推理需另行验证。'; }
    else if (['Pending', 'Starting', 'Creating', 'Updating', 'Running', 'Deploying', 'Scaling', 'Reconciling'].includes(phase) || !converged) { service.status = 'starting'; service.message = service.desiredReplicas === 0 ? '正在停止实例…' : '正在等待运行状态收敛…'; }
    else { service.status = 'unknown'; service.message = '暂未取得可识别的运行状态。'; }
    if (this.config.DEPLOYMENT_PROVIDER === 'kubernetes' && service.gpuLabel.includes('CPU')) { const current = runtimeConfig(service); service.gpuLabel = `${current.cpuCores ?? '—'} CPU / ${current.memoryGB ?? '—'} GiB`; }
    service.live = true; service.stale = false; service.staleReason = undefined; service.observedAt = now();
    service.missing = false;
    service.routeReady = false; service.endpoint = undefined;
    const exposure = asObject(status.internalExposure);
    service.diagnostics = { phase: phase || 'Unknown', generation: typeof kubernetes.generation === 'number' ? kubernetes.generation : undefined, observedGeneration: typeof status.observedGeneration === 'number' ? status.observedGeneration : undefined, routePhase: typeof exposure.phase === 'string' ? exposure.phase : 'Unknown', conditions: (Array.isArray(status.conditions) ? status.conditions : []).slice(0, 20).map(asObject).map(c => ({ type: String(c.type ?? 'Unknown').slice(0, 80), status: String(c.status ?? 'Unknown').slice(0, 20), reason: String(c.reason ?? '').slice(0, 120), message: cleanMessage(String(c.message ?? ''), [this.config.IO_MANAGEMENT_TOKEN, this.config.REGISTRY_TOKEN]) })) };
    if (detail.routes_stale !== true && exposure.phase === 'Ready' && service.status === 'running') {
      const addresses = Array.isArray(exposure.gatewayAddresses) ? exposure.gatewayAddresses : [];
      const first = addresses.find(a => typeof a === 'string') as string | undefined;
      const port = exposure.gatewayPort;
      if (first && /^[a-zA-Z0-9.:\[\]-]+$/.test(first) && typeof port === 'number' && port > 0 && port <= 65535 && typeof exposure.hostname === 'string' && /^[a-zA-Z0-9.-]+$/.test(exposure.hostname)) {
        const host = first.includes(':') && !first.startsWith('[') ? `[${first}]` : first;
        service.endpoint = { address: `http://${host}:${port}`, hostname: exposure.hostname };
        service.routeReady = true;
      }
    }
    // Only render explicitly returned links. Never guess control-plane URLs or execute model endpoint requests.
    service.observability = Object.entries(asObject(detail.observability)).flatMap(([label, value]) => {
      if (typeof value !== 'string') return [];
      try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? [{ label, url: u.toString() }] : []; } catch { return []; }
    });
  }
  async refresh(id: string, actor: string) {
    let service = this.requireService(id);
    if (this.config.APP_MODE === 'demo') return publicService(service);
    if (this.store.pending().some(op => op.serviceId === id && op.status === 'pending')) return publicService(service);
    const epoch = this.writeEpoch.get(id) ?? 0;
    try {
      const detail = await this.upstream.request('io', this.path(service), actor);
      service = this.requireService(id);
      if ((this.writeEpoch.get(id) ?? 0) !== epoch || this.store.pending().some(op => op.serviceId === id && op.status === 'pending')) return publicService(service);
      if (detail.live !== true || detail.stale !== false || !Object.keys(asObject(detail.kubernetes)).length) throw new AppError(503, 'stale_observation', '平台暂时只能返回历史状态，已保留最近一次观测结果。');
      const kubernetes = asObject(detail.kubernetes);
      if (service.uid && kubernetes.uid !== service.uid) throw new AppError(409, 'identity_changed', '同名服务已被替换，请管理员核对资源身份后处理。');
      const prev = JSON.stringify({ uid: service.uid, rv: service.resourceVersion, status: service.status, desired: service.desiredReplicas });
      const knownUid = service.uid;
      this.applyObserved(service, kubernetes, detail);
      if (prev !== JSON.stringify({ uid: service.uid, rv: service.resourceVersion, status: service.status, desired: service.desiredReplicas })) service.updatedAt = now();
      const pending = this.store.pending().find(o => o.serviceId === id);
      if (pending?.status === 'unknown') {
        const rollout = asObject(asObject(kubernetes.spec).rollout);
        const matchingCreate = pending.kind === 'create' && ((service.creationConfirmed && knownUid === kubernetes.uid && Boolean(knownUid)) || (this.config.DEPLOYMENT_PROVIDER === 'kubernetes' && detail.creationRequestId === pending.id)) && pending.requestedSpec && containsSpec(kubernetes.spec, pending.requestedSpec);
        const matchingConfiguration = pending.kind === 'configure' && pending.baselineUid === kubernetes.uid && pending.requestedSpec && containsSpec(kubernetes.spec, pending.requestedSpec);
        const applied = matchingCreate || matchingConfiguration || (pending.kind === 'offline' && rollout.replicas === 0) || (pending.kind === 'online' && rollout.replicas === Math.max(1, service.resumeReplicas ?? 1)) || (pending.kind === 'restart' && rollout.restartNonce === pending.nonce);
        if (applied) { this.finish(pending, 'succeeded', '已从实时状态确认操作生效。'); service.busy = false; }
        else { service.busy = true; service.message = '上一操作结果尚未确认，已暂停进一步修改；请联系管理员核对。'; }
      }
      this.store.save(service);
    } catch (error) {
      if ((this.writeEpoch.get(id) ?? 0) !== epoch) return this.store.get(id) ? publicService(this.requireService(id)) : undefined;
      if (error instanceof AppError && error.statusCode === 404) {
        const pending = this.store.pending().find(o => o.serviceId === id);
        if (pending?.kind === 'delete') {
          this.store.save({ ...service, deleted: true, busy: false });
          this.finish(pending, 'succeeded', '部署对象已删除；附属资源回收取决于控制面策略。');
        } else {
          this.store.save({ ...service, status: 'failed', live: true, stale: false, missing: true, busy: Boolean(pending), message: '目标集群中未找到服务。请管理员核对，不会自动重建。', observedAt: now() });
        }
      } else {
        this.store.save({ ...service, live: false, stale: true, staleReason: errorMessage(error) });
      }
    }
    return this.store.get(id) ? publicService(this.requireService(id)) : undefined;
  }
  async sync() {
    if (this.syncing || this.config.APP_MODE === 'demo') return;
    this.syncing = true;
    try {
      // Bound concurrent upstream reads; no overlapping polling rounds.
      const services = this.store.list();
      for (let i = 0; i < services.length; i += 4) await Promise.allSettled(services.slice(i, i + 4).map(s => this.refresh(s.id, 'launchpad-reconciler')));
      this.store.cleanup();
    } finally { this.syncing = false; }
  }
}
