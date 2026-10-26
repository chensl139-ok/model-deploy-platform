import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CatalogModel } from './catalog.js';
import { asObject } from './catalog.js';
import type { Config } from './config.js';
import { Store } from './store.js';
import { Upstream } from './upstream.js';
import { AppError, cleanMessage } from './errors.js';
import { ENGINES, shellQuote } from '../shared/engines.js';
import type { RegisteredModelInput, RuntimeImage, RuntimeProfile, RuntimeProfileInput } from '../shared/types.js';
const label = z.string().trim().min(1).max(100);
const version = z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const engineId = z.enum(['vllm', 'sglang', 'vllm-omni', 'sglang-omni', 'custom']);
const path = z.string().min(2).max(512).regex(/^\/[a-zA-Z0-9_./-]+$/).refine(p => !p.split('/').includes('..') && !p.includes('//'), '路径不能包含跳转或空路径段');
export const registeredModelSchema = z.object({ id: z.string().max(80).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/), name: label, modelKey: z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/), servedModelName: z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/), description: z.string().max(2000), family: z.string().max(100) }).strict();
export const runtimeProfileSchema = z.object({
  name: label, version, modelId: z.string().min(1).max(100), engineId, imageId: z.uuid(), mode: z.enum(['argv', 'script', 'image-default']),
  command: z.array(z.string().min(1).max(2048)).max(32), args: z.array(z.string().max(4096)).max(128), script: z.string().max(16384),
  port: z.number().int().min(1).max(65535), healthPath: z.string().min(1).max(256).regex(/^\/[^\s?#]*$/), livenessPath: z.string().min(1).max(256).regex(/^\/[^\s?#]*$/), startupTimeoutSeconds: z.number().int().min(60).max(14400),
  cpuCores: z.number().min(0.25).max(512).multipleOf(0.25), memoryGB: z.number().min(0.25).max(4096).multipleOf(0.25), gpuResourceName: z.string().max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/), gpuCount: z.number().int().min(0).max(64), gpuMemoryGB: z.number().min(0).max(8192), sharedMemoryGB: z.number().min(0).max(1024), maxConcurrency: z.number().int().min(1).max(100000),
  mounts: z.array(z.object({ role: version, mountPath: path, envName: z.string().max(80).regex(/^[A-Z_][A-Z0-9_]*$/) }).strict()).min(1).max(8),
  env: z.record(z.string().max(80).regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4096)),
}).strict().superRefine((p, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (p.mode === 'argv' && !p.command.length) issue('命令模式需要填写 entrypoint');
  if (p.mode === 'script' && !p.script.trim()) issue('脚本模式需要填写实际启动脚本');
  if (p.mode === 'image-default' && Object.keys(p.env).length) issue('镜像默认入口模式请通过启动脚本设置环境变量');
  for (const key of ['role', 'mountPath', 'envName'] as const) if (new Set(p.mounts.map(m => m[key])).size !== p.mounts.length) issue('权重角色、挂载路径和环境变量名必须各自唯一');
  if (p.mounts.some(m => m.mountPath === '/' || ['/proc', '/sys', '/dev', '/etc'].some(prefix => m.mountPath === prefix || m.mountPath.startsWith(prefix + '/')))) issue('请选择独立的模型挂载目录，例如 /models/main');
  if (Object.keys(p.env).length > 64 || p.mounts.some(m => Object.hasOwn(p.env, m.envName))) issue('环境变量不能覆盖权重路径变量，最多 64 项');
  if (p.sharedMemoryGB > p.memoryGB) issue('共享内存不能大于实例内存');
});
export function compileRuntime(profile: RuntimeProfile, image: RuntimeImage, model: CatalogModel) {
  const values: Record<string, string> = { MODEL_PATH: profile.mounts.find(m => m.envName === 'MODEL_PATH')?.mountPath ?? profile.mounts[0].mountPath, SERVED_MODEL_NAME: model.servedModelName ?? model.modelKey ?? model.id, PORT: String(profile.port) };
  const substitute = (value: string) => value.replace(/\{\{([^{}]+)\}\}/g, (_match, name: string) => { if (!(name in values)) throw new AppError(400, 'unknown_placeholder', `未知命令占位符：${name}`); return values[name]; });
  const command = profile.command.map(substitute); const args = profile.args.map(substitute);
  const exports = Object.entries(profile.env).map(([key, value]) => `export ${key}=${shellQuote(value)}`).join('\n');
  let script = profile.mode === 'script' ? profile.script : `exec ${[...command, ...args].map(shellQuote).join(' ')}`;
  if (exports) script = `set -eu\n${exports}\n${script}`;
  const component = { component_name: 'runtime', component_type: 'primary', ...(image.artifactId ? { image_artifact_id: image.artifactId } : { image_ref: image.imageRef }), container_port: profile.port, health_path: profile.healthPath, liveness_path: profile.livenessPath, startup_timeout_seconds: profile.startupTimeoutSeconds, cpu_request_milli: Math.round(profile.cpuCores * 1000), memory_request_bytes: profile.memoryGB * 1024 ** 3, gpu_count: profile.gpuCount, gpu_resource_name: profile.gpuResourceName, shared_memory_bytes: profile.sharedMemoryGB * 1024 ** 3, weight_requirements: profile.mounts.map(m => ({ weight_role: m.role, mount_path: m.mountPath, env_name: m.envName, read_only: true })),
    ...(profile.mode === 'image-default' ? {} : profile.mode === 'script' || exports ? { startup_interpreter: '/bin/sh', startup_script: script } : { command, args }),
  };
  return { command: profile.mode === 'image-default' ? '使用镜像 ENTRYPOINT / CMD' : profile.mode === 'script' || exports ? script : [...command, ...args].map(shellQuote).join(' '), registryRequest: { package_name: profile.packageName, version: profile.version, display_name: `${profile.name} / ${profile.version}`, service_component_name: 'runtime', service_port: profile.port, components: [component] } };
}
export class Runtimes {
  private tasks = new Set<Promise<unknown>>();
  constructor(private config: Config, private store: Store, private catalog: () => CatalogModel[], private upstream = new Upstream(config)) {
    for (const profile of this.list().filter(p => p.status === 'publishing')) this.save({ ...profile, status: 'unknown', message: '发布进程曾中断，请在 Registry 按 package_name 核对；不会自动重复发布。' });
  }
  engines() { return ENGINES; }
  async tags(engineId: string, page: number, query: string) {
    const engine = ENGINES.find(e => e.id === engineId);
    if (!engine?.repository) throw new AppError(400, 'repository_unavailable', '自定义引擎请在内部镜像仓库查询版本。');
    try {
      const url = new URL(`https://hub.docker.com/v2/repositories/${engine.repository}/tags`);
      url.search = new URLSearchParams({ page: String(page), page_size: '20', name: query }).toString();
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('registry error');
      const bytes = await response.text(); if (bytes.length > 1024 * 1024) throw new Error('oversize');
      const body = asObject(JSON.parse(bytes));
      return { repository: engine.repository, page, hasNext: Boolean(body.next), items: (Array.isArray(body.results) ? body.results : []).map(asObject).map(tag => ({ name: String(tag.name ?? ''), digest: typeof tag.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(tag.digest) ? tag.digest : '', updatedAt: String(tag.last_updated ?? ''), architectures: [...new Set((Array.isArray(tag.images) ? tag.images : []).map(asObject).map(i => String(i.architecture ?? '')).filter(Boolean))] })), message: '这是上游参考版本列表。请将所需镜像同步至已获准的内部仓库，核对摘要、CUDA、架构和实际依赖后登记。' };
    } catch { throw new AppError(502, 'image_catalog_unavailable', '无法查询上游镜像版本。可稍后重试，或在内部仓库查询并手动登记；不会返回虚构版本。'); }
  }
  registerModel(input: RegisteredModelInput) {
    if (this.catalog().some(m => m.id === input.id || (m.modelKey ?? m.id) === input.modelKey)) throw new AppError(409, 'model_exists', '此模型标识或 Registry model_key 已登记或归档，请使用新标识。');
    const model: CatalogModel = { ...input, version: '未选择权重版本', initials: input.name.charAt(0).toUpperCase(), color: 'blue', framework: '可选引擎', variants: [] };
    this.store.transaction(() => { const previous = this.store.asset('deleted-model', input.id); if (previous) { this.store.saveAsset('model-deletion-history', randomUUID(), previous); this.store.deleteAsset('deleted-model', input.id); } this.store.saveAsset('model', input.id, model); }); return model;
  }
  images() { return this.store.assets<RuntimeImage>('image'); }
  list() { return this.store.assets<RuntimeProfile>('runtime'); }
  get(id: string) { const profile = this.store.asset<RuntimeProfile>('runtime', id); if (!profile || this.store.asset('archived:runtime', id)) throw new AppError(404, 'not_found', '运行配置不存在。'); return profile; }
  detail(id: string) {
    const profile = this.get(id); const image = this.images().find(i => i.id === profile.imageId); const model = this.catalog().find(m => m.id === profile.modelId);
    if (!model || !image) throw new AppError(409, 'profile_dependency_missing', '运行配置引用的模型或镜像不存在。');
    return { profile, image, ...compileRuntime(profile, image, model) };
  }
  save(profile: RuntimeProfile) { const result = { ...profile, revision: randomUUID(), updatedAt: new Date().toISOString() }; this.store.saveAsset('runtime', result.id, result); return result; }
  create(input: RuntimeProfileInput, id?: string, revision?: string) {
    if (!this.catalog().some(m => m.id === input.modelId)) throw new AppError(400, 'invalid_model', '请先登记模型。');
    const image = this.images().find(i => i.id === input.imageId);
    if (!image || image.engineId !== input.engineId) throw new AppError(400, 'invalid_image', '镜像必须属于所选推理引擎。');
    const before = id ? this.get(id) : undefined;
    if (before && (before.revision !== revision || !['draft', 'failed'].includes(before.status))) throw new AppError(409, 'profile_changed', '此配置已发布、正在发布或已被修改。请创建新版本。');
    if (this.list().some(p => p.id !== id && p.name === input.name && p.version === input.version)) throw new AppError(409, 'profile_version_exists', '同名运行配置的版本不可重复，请使用新版本。');
    const profileId = id ?? randomUUID();
    const profile: RuntimeProfile = { ...input, id: profileId, packageName: before?.packageName ?? `launchpad-${profileId}`, revision: '', status: 'draft', message: '草稿。尚未提交 Registry 校验。', createdAt: before?.createdAt ?? new Date().toISOString(), updatedAt: '' };
    compileRuntime(profile, image, this.catalog().find(m => m.id === input.modelId)!);
    return this.save(profile);
  }
  async publish(id: string, revision: string, actor: string) {
    if (this.config.APP_MODE === 'setup') throw new AppError(503, 'platform_not_connected', '配置真实 Registry 连接后才能发布运行包。');
    const detail = this.detail(id); const profile = detail.profile;
    if (this.config.APP_MODE === 'live' && detail.image.status !== 'available') throw new AppError(409, 'image_not_verified', '镜像尚未完成验证、构建或导入，不能发布运行包。');
    if (profile.status === 'published') return profile;
    if (profile.revision !== revision || !['draft', 'failed'].includes(profile.status)) throw new AppError(409, 'profile_changed', '此运行配置不能重复发布。请刷新并核对状态。');
    this.save({ ...profile, status: 'publishing', message: '正在校验镜像并创建 Registry 运行包。' });
    const task = (async () => {
      try {
        if (this.config.APP_MODE === 'demo') return this.save({ ...profile, status: 'published', packageId: `demo-${profile.id}`, message: '演示登记完成；未校验真实镜像。' });
        if (this.config.DEPLOYMENT_PROVIDER === 'kubernetes') {
          if (!detail.image.imageRef || !detail.image.validation) throw new AppError(422, 'image_digest_required', '原生 Kubernetes 需要已验证的镜像摘要，构建产物请先登记镜像地址。');
          return this.save({ ...profile, status: 'published', packageId: `kubernetes-${profile.id}`, message: '运行配置已冻结；部署时执行 Kubernetes 服务端预检。' });
        }
        const result = await this.upstream.request('registry', '/internal/v1/runtime-packages', actor, { method: 'POST', body: detail.registryRequest });
        if (typeof result.package_id !== 'string' || !result.package_id) throw new AppError(502, 'invalid_package_response', 'Registry 没有返回 package_id，请按 package_name 核对。');
        return this.save({ ...profile, packageId: result.package_id, status: 'published', message: 'Registry 已接受运行包。部署前仍需预检，运行后验证实际推理。' });
      } catch (error) {
        return this.save({ ...profile, status: error instanceof AppError && error.statusCode < 500 ? 'failed' : 'unknown', message: cleanMessage(error instanceof AppError ? error.message : '发布结果未知，请在 Registry 核对，不会自动重试。', [this.config.REGISTRY_TOKEN, this.config.IO_MANAGEMENT_TOKEN]) });
      }
    })();
    this.tasks.add(task); void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task));
    return task;
  }
  async drain() { await Promise.allSettled([...this.tasks]); }
}
