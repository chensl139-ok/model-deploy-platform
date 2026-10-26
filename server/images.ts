import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { Store } from './store.js';
import type { Config } from './config.js';
import { AppError, cleanMessage } from './errors.js';
import { asObject } from './catalog.js';
import { Upstream } from './upstream.js';
import { allowImage, imageReference, SkopeoTools, type ImageTools } from './image-tools.js';
import type { ImageBuildInput, ImageImportInput, RuntimeImage, RuntimeImageInput } from '../shared/types.js';
const metadata = { engineId: z.enum(['vllm', 'sglang', 'vllm-omni', 'sglang-omni', 'custom']), version: z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/), architecture: z.enum(['amd64', 'arm64']), cuda: z.string().max(100), notes: z.string().max(2000) };
const reference = z.string().min(1).max(1024).superRefine((value, ctx) => { try { imageReference(value); } catch (e) { ctx.addIssue({ code: 'custom', message: e instanceof Error ? e.message : '镜像地址无效。' }); } });
export const directImageSchema = z.object({ ...metadata, imageRef: reference.refine(value => Boolean(imageReference(value).digest), '直接使用须固定到 sha256 摘要；仓库导入可以填写 tag') }).strict();
export const imageImportSchema = z.object({ ...metadata, sourceRef: reference, destinationRepository: reference.refine(value => { const p = imageReference(value); return !p.digest && !p.tag; }, '目标只填写仓库路径，不含 tag 或 digest；系统创建唯一 tag，避免覆盖已有版本'), requestId: z.uuid() }).strict();
const relative = z.string().min(1).max(512).regex(/^[a-zA-Z0-9_./-]+$/).refine(p => !p.startsWith('/') && !p.split('/').includes('..') && !p.includes('//'), '构建路径必须在源码仓库内部');
export const imageBuildSchema = z.object({ ...metadata, repository: z.url().max(2048), commit: z.string().regex(/^[a-f0-9]{40}$/, '源码版本需要完整的 40 位小写 commit'), contextDir: relative, dockerfile: relative, buildTarget: z.string().max(100).regex(/^[A-Za-z0-9_.-]*$/).optional(), targetIds: z.array(z.string().min(1).max(200)).max(8), requestId: z.uuid() }).strict();
interface StoredImage extends RuntimeImage { fingerprint?: string; actor?: string }
const time = () => new Date().toISOString();
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const publicImage = ({ fingerprint, actor, ...value }: StoredImage): RuntimeImage => value;
export class Images {
  private tasks = new Set<Promise<unknown>>(); private syncing = false; private reads = new Set<string>();
  constructor(private config: Config, private store: Store, private tools: ImageTools = new SkopeoTools(config), private upstream = new Upstream(config)) {
    for (const image of this.list()) {
      if (['verifying', 'submitting', 'copying'].includes(image.status ?? '')) this.save({ ...this.get(image.id), status: image.status === 'verifying' ? 'unverified' : 'unknown', message: image.status === 'verifying' ? '校验进程曾中断，可重新校验。' : '进程曾中断，请同步实际结果，不会自动重复构建或复制。' });
    }
  }
  list() { return this.store.assets<StoredImage>('image').map(publicImage); }
  get(id: string) { const image = this.store.asset<StoredImage>('image', id); if (!image) throw new AppError(404, 'not_found', '镜像版本不存在。'); return image; }
  private save(image: StoredImage) { const result = { ...image, updatedAt: time() }; this.store.saveAsset('image', image.id, result); return publicImage(result); }
  private sameVersion(input: Pick<RuntimeImageInput, 'engineId' | 'version' | 'architecture'>) { return this.list().find(i => i.engineId === input.engineId && i.version === input.version && i.architecture === input.architecture); }
  register(input: RuntimeImageInput) {
    const canonical = imageReference(input.imageRef).reference;
    const existing = this.sameVersion(input);
    if (existing) { if ((existing.source ?? 'direct') !== 'direct' || existing.imageRef !== canonical) throw new AppError(409, 'image_version_exists', '此引擎版本与架构已登记其他镜像或来源，请使用新版本。'); return existing; }
    return this.save({ ...input, imageRef: canonical, id: randomUUID(), source: 'direct', status: 'unverified', message: '格式已检查，尚未验证镜像存在性与架构。', createdAt: time() });
  }
  async validate(id: string) {
    const image = this.get(id);
    if (this.store.asset('archived:image', id)) throw new AppError(404, 'not_found', '镜像版本已删除。');
    if ((image.source ?? 'direct') !== 'direct') throw new AppError(409, 'wrong_image_flow', '构建或导入任务请使用同步状态操作。');
    if (image.status === 'verifying' || this.reads.has(id)) throw new AppError(409, 'verification_pending', '此镜像正在校验，请稍后刷新。');
    if (this.reads.size >= 4) throw new AppError(429, 'image_check_limit', '已有 4 项镜像校验进行中，请稍后重试。');
    allowImage(image.imageRef, this.config.IMAGE_ALLOWED_PREFIXES);
    this.save({ ...image, status: 'verifying', message: '正在读取清单并验证 digest 与目标 Linux 架构。' }); this.reads.add(id);
    const task = (async () => {
      try {
        const validation = await this.tools.inspect(image.imageRef, image.architecture);
        if (validation.digest !== imageReference(image.imageRef).digest || validation.architecture !== image.architecture || validation.os !== 'linux') throw new AppError(422, 'image_validation_mismatch', '镜像清单或架构与登记值不一致。');
        return this.save({ ...image, validation, status: 'available', message: '清单、digest 与 Linux 架构已验证；引擎/CUDA/模型兼容性仍需运行验收。' });
      } catch (error) { this.save({ ...image, status: 'failed', message: this.message(error) }); throw error; }
      finally { this.reads.delete(id); }
    })();
    this.track(task); return task;
  }
  private reserve(input: ImageImportInput | ImageBuildInput, actor: string, source: 'import' | 'build') {
    const hash = fingerprint({ ...input, actor, source }); const replay = this.store.assets<StoredImage>('image', true).find(i => i.requestId === input.requestId);
    if (replay && this.store.asset('archived:image', replay.id)) throw new AppError(409, 'request_archived', '原镜像任务已归档，请使用新的请求标识。');
    if (replay) { if (this.get(replay.id).fingerprint !== hash) throw new AppError(409, 'request_conflict', '同一请求标识不能用于不同镜像任务。'); return { image: this.get(replay.id), fresh: false }; }
    if (this.sameVersion(input)) throw new AppError(409, 'image_version_exists', '该引擎版本与架构已有任务或镜像记录，请查看现有状态。');
    if (this.list().filter(i => ['copying', 'submitting', 'building'].includes(i.status ?? '')).length >= 4) throw new AppError(429, 'image_job_limit', '已有 4 个镜像任务进行中，请等待任务完成。');
    const id = randomUUID(); const image: StoredImage = { ...input, id, imageRef: '', source, status: source === 'build' ? 'submitting' : 'copying', message: source === 'build' ? '正在提交源码构建。' : '正在校验来源并复制镜像。', createdAt: time(), actor, fingerprint: hash, ...(source === 'import' ? { destinationTag: `launchpad-${id}`, requestedSourceRef: (input as ImageImportInput).sourceRef } : {}) };
    this.save(image); return { image, fresh: true };
  }
  import(input: ImageImportInput, actor: string) {
    if (this.config.APP_MODE === 'demo') throw new AppError(409, 'real_image_operations_only', '镜像复制不提供演示成功，请使用真实配置工作空间。');
    allowImage(input.sourceRef, this.config.IMAGE_ALLOWED_PREFIXES); allowImage(input.destinationRepository, this.config.IMAGE_IMPORT_PREFIXES);
    const { image, fresh } = this.reserve(input, actor, 'import'); if (!fresh) return publicImage(image);
    this.track((async () => {
      let copying = false;
      try {
        const validation = await this.tools.inspect(input.sourceRef, input.architecture);
        if (validation.os !== 'linux' || validation.architecture !== input.architecture || !/^sha256:[a-f0-9]{64}$/.test(validation.platformDigest)) throw new AppError(422, 'image_architecture_mismatch', '来源镜像不符合所选 Linux 架构，已停止导入。');
        const source = `${imageReference(input.sourceRef).repository}@${validation.platformDigest}`;
        const destination = `${imageReference(input.destinationRepository).repository}:${image.destinationTag}`;
        const snapshot = { ...image, sourceRef: source, validation }; this.save(snapshot);
        copying = true; await this.tools.copy(source, destination, input.architecture);
        await this.finishImport(snapshot);
      } catch (error) { this.save({ ...this.get(image.id), status: copying ? 'unknown' : 'failed', message: `${this.message(error)}${copying ? ' 请同步目标状态核对复制结果，不会自动重复复制。' : ''}` }); }
    })());
    return publicImage(image);
  }
  private async finishImport(image: StoredImage) {
    const destination = image.imageRef || `${imageReference(image.destinationRepository!).repository}:${image.destinationTag}`;
    const validation = await this.tools.inspect(destination, image.architecture);
    if (validation.digest !== image.validation?.platformDigest || validation.architecture !== image.architecture || validation.os !== 'linux') throw new AppError(422, 'import_digest_mismatch', '目标仓库清单与已锁定的来源平台摘要不一致，不能用于部署。');
    return this.save({ ...image, imageRef: `${imageReference(destination).repository}@${validation.digest}`, validation, status: 'available', message: '已复制到目标仓库，并复核 digest 与 Linux 架构。未验证实际推理。' });
  }
  async build(input: ImageBuildInput, actor: string) {
    if (this.config.APP_MODE !== 'live') throw new AppError(503, 'platform_not_connected', '源码构建需要连接真实 Registry 构建服务。');
    const source = new URL(input.repository);
    if (source.protocol !== 'https:' || source.username || source.password || source.search || source.hash || !this.config.IMAGE_SOURCE_HOSTS.split(',').map(s => s.trim()).includes(source.host) || !source.pathname.endsWith('.git')) throw new AppError(400, 'invalid_source_repository', '使用允许域名上的 HTTPS .git 仓库地址，不含凭据或查询参数，commit 单独填写。');
    if (input.targetIds.length) {
      const result = await this.upstream.request('registry', '/v1/deployment-targets', actor); const allowed = (Array.isArray(result.targets) ? result.targets : []).map(asObject);
      if (input.targetIds.some(id => !allowed.some(target => target.target_id === id))) throw new AppError(403, 'target_forbidden', '构建 GPU 目标未获授权。');
    }
    if (!this.config.REGISTRY_BASE_URL || !this.config.REGISTRY_TOKEN) throw new AppError(503, 'connection_missing', '请先配置 Registry 构建服务连接。');
    const { image, fresh } = this.reserve(input, actor, 'build'); if (!fresh) return publicImage(image);
    this.track((async () => {
      try {
        const result = await this.upstream.request('registry', '/internal/v1/component-builds', actor, { method: 'POST', body: { idempotency_key: input.requestId, component_build: { role: 'engine', repository: input.repository, commit: input.commit, context_dir: input.contextDir, dockerfile: input.dockerfile, ...(input.buildTarget ? { target: input.buildTarget } : {}) }, ...(input.targetIds.length ? { target_ids: input.targetIds } : {}) } });
        if (typeof result.record_id !== 'string' || !result.record_id) throw new AppError(502, 'missing_build_record', '构建服务未返回 record_id，请按原请求标识核对。');
        this.save({ ...image, status: 'building', recordId: result.record_id, message: '构建请求已接受，等待 CI 构建结果。' });
        await this.refresh(image.id, actor);
      } catch (error) { this.save({ ...this.get(image.id), status: error instanceof AppError && error.statusCode < 500 ? 'failed' : 'unknown', message: this.message(error) }); }
    })()); return publicImage(image);
  }
  async refresh(id: string, actor: string) {
    const image = this.get(id); if (this.reads.has(id)) return publicImage(image);
    this.reads.add(id);
    try {
      if (image.source === 'build' && image.recordId) {
        if (image.status === 'available') return publicImage(image);
        const result = await this.upstream.request('registry', `/internal/v1/image-builds/${encodeURIComponent(image.recordId)}`, actor);
        const status = String(result.status ?? '');
        if (status === 'succeeded') {
          if (typeof result.image_artifact_id !== 'string' || !result.image_artifact_id) throw new AppError(502, 'missing_build_artifact', '构建显示成功，但未返回 image_artifact_id，暂不可部署。');
          // Components use the Registry artifact ID directly; an image_ref is not invented.
          return this.save({ ...image, artifactId: result.image_artifact_id, status: 'available', message: 'Registry 构建成功，已取得镜像产物。架构与引擎兼容性仍需部署验收。' });
        }
        if (['failed', 'cancelled', 'canceled'].includes(status)) return this.save({ ...image, status: 'failed', message: this.message(typeof result.message === 'string' ? new Error(result.message) : new Error('源码构建失败，请在构建服务核对日志。')) });
        if (!['pending', 'queued', 'running', 'building', 'preparing'].includes(status)) throw new AppError(502, 'unknown_build_status', '构建服务返回未知状态，暂不可部署。');
        return this.save({ ...image, status: 'building', message: typeof result.message === 'string' ? this.message(new Error(result.message)) : '构建进行中。' });
      }
      if (image.source === 'import' && image.validation && ['unknown', 'available'].includes(image.status ?? '')) return await this.finishImport(image);
      return publicImage(image);
    } catch (error) { return this.save({ ...image, status: 'unknown', message: this.message(error) }); }
    finally { this.reads.delete(id); }
  }
  async sync() {
    if (this.syncing) return; this.syncing = true;
    try { const pending = this.list().filter(i => i.source === 'build' && i.recordId && ['building', 'unknown'].includes(i.status ?? '')); for (let i = 0; i < pending.length; i += 4) await Promise.allSettled(pending.slice(i, i + 4).map(image => this.refresh(image.id, 'launchpad-image-reconciler'))); }
    finally { this.syncing = false; }
  }
  private message(error: unknown) { return cleanMessage(error instanceof Error ? error.message : '镜像操作未完成，请核对实际结果。', [this.config.IO_MANAGEMENT_TOKEN, this.config.REGISTRY_TOKEN]); }
  private track<T>(task: Promise<T>) { this.tasks.add(task); void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task)); }
  async drain() { await Promise.allSettled([...this.tasks]); }
  async close() { this.tools.shutdown?.(); await this.drain(); }
}
