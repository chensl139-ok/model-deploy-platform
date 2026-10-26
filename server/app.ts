import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z, ZodError } from 'zod';
import type { Config } from './config.js';
import { Store } from './store.js';
import { Manager } from './manager.js';
import { Assets } from './assets.js';
import { Runtimes, registeredModelSchema, runtimeProfileSchema } from './runtimes.js';
import { Images, directImageSchema, imageImportSchema, imageBuildSchema } from './images.js';
import type { ImageTools } from './image-tools.js';
import { Configurations } from './configurations.js';
import { Models } from './models.js';
import { Kubernetes } from './kubernetes.js';
import { AppError, cleanMessage } from './errors.js';

const name = z.string().min(1).max(53).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, '名称仅支持小写字母、数字和连字符，不能以连字符开头或结尾');
const uuid = z.uuid();
const createSchema = z.object({ modelId: z.string().min(1).max(100), variantId: z.string().min(1).max(100), name, weightVersionId: uuid.optional() }).strict();
const configInput = z.object({ replicas: z.number().int().min(0).max(64), image: z.string().max(1024).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/, '镜像必须固定到完整 sha256 digest').optional(), cpuCores: z.number().min(0.25).max(128).multipleOf(0.25).optional(), memoryGB: z.number().min(0.25).max(1024).multipleOf(0.25).optional(), maxConcurrency: z.number().int().min(1).max(100000).optional() }).strict();
const hashSession = (id: string) => createHash('sha256').update(id).digest('hex');
const idSchema = z.object({ id: uuid });
const safeEqual = (a: string, b: string) => { const first = Buffer.from(a); const second = Buffer.from(b); return first.length === second.length && timingSafeEqual(first, second); };

export async function buildApp(config: Config, options: { store?: Store; background?: boolean; logger?: boolean; imageTools?: ImageTools } = {}) {
  const store = options.store ?? new Store(config.DATABASE_PATH);
  const manager = new Manager(config, store);
  const assets = new Assets(config, store, () => manager.catalog);
  const runtimes = new Runtimes(config, store, () => manager.catalog);
  const configurations = new Configurations(store);
  const models = new Models(store, () => manager.catalog);
  const images = new Images(config, store, options.imageTools);
  const app = Fastify({
    logger: options.logger ? { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers.x-csrf-token', 'res.headers.set-cookie'] } : false,
    trustProxy: config.TRUST_PROXY === 'true' ? 'loopback, linklocal, uniquelocal' : false,
    bodyLimit: 32 * 1024,
    requestTimeout: 60000,
  });
  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: config.NODE_ENV === 'production' ? { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:'], fontSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"],
  } } : false });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  const actor = (request: FastifyRequest) => {
    if (!config.authRequired) return { actor: '本地用户', csrf: '' };
    const token = request.cookies.lp_session;
    return token ? store.session(hashSession(token)) : undefined;
  };
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (!path.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (write) {
      const origin = request.headers.origin;
      if (origin && !config.allowedOrigins.includes(origin)) throw new AppError(403, 'invalid_origin', '请求来源不受信任。');
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new AppError(403, 'invalid_origin', '请求来源不受信任。');
      if (!origin && request.headers['sec-fetch-site'] !== 'same-origin' && config.NODE_ENV !== 'test') throw new AppError(403, 'origin_required', '写入请求必须来自平台页面。');
    }
    if (['/api/bootstrap', '/api/login', '/api/health'].includes(path)) return;
    const session = actor(request);
    if (!session) throw new AppError(401, 'unauthenticated', '登录已过期，请重新登录。');
    if (write && config.authRequired && !safeEqual(String(request.headers['x-csrf-token'] ?? ''), session.csrf)) throw new AppError(403, 'csrf_invalid', '页面凭据已过期，请刷新后重试。');
    if (write && request.method !== 'DELETE' && config.APP_MODE === 'setup' && (path === '/api/previews' || path === '/api/runtime-previews' || path.startsWith('/api/services') || path.startsWith('/api/assets/weights') || path.endsWith('/publish'))) throw new AppError(503, 'platform_not_connected', '尚未接入真实 Registry / IO。可以登记模型、镜像和配置草稿；配置服务端连接后才能导入、发布或部署，不会模拟成功。');
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: { code: 'invalid_request', message: error.issues[0]?.message ?? '请求参数不正确。' } });
    if (error instanceof AppError) return reply.code(error.statusCode).send({ error: { code: error.code, message: cleanMessage(error.message, [config.IO_MANAGEMENT_TOKEN, config.REGISTRY_TOKEN]) }, requestId: request.id });
    const possible = error as { statusCode?: number; name?: string };
    const status = typeof possible.statusCode === 'number' && possible.statusCode >= 400 && possible.statusCode < 500 ? possible.statusCode : 500;
    request.log.error({ errorType: possible.name, requestId: request.id }, 'Request failed');
    return reply.code(status).send({ error: { code: status === 429 ? 'rate_limited' : 'request_failed', message: status === 429 ? '操作过于频繁，请稍后重试。' : status === 500 ? '服务暂时无法处理请求，请稍后重试。' : '请求格式不正确。' }, requestId: request.id });
  });
  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/bootstrap', async request => {
    const session = actor(request);
    return {
      mode: config.APP_MODE, provider: config.DEPLOYMENT_PROVIDER, authenticated: Boolean(session), authRequired: config.authRequired,
      user: session?.actor ?? '', csrfToken: session?.csrf,
      models: session ? manager.models() : [],
      connection: { configured: config.DEPLOYMENT_PROVIDER === 'kubernetes' || config.APP_MODE === 'demo' || (config.APP_MODE === 'live' && Boolean(config.IO_BASE_URL && config.IO_MANAGEMENT_TOKEN && config.REGISTRY_BASE_URL && config.REGISTRY_TOKEN)), message: config.APP_MODE === 'demo' ? '演示环境 · 数据独立保存，不操作真实 GPU' : config.APP_MODE === 'setup' ? '待接入 · 可管理真实配置草稿，部署操作在连接配置前禁用' : config.DEPLOYMENT_PROVIDER === 'kubernetes' ? `Kubernetes · ${config.KUBE_CONTEXT}` : '真实环境 · 通过 Registry 与 IO 执行部署' },
    };
  });
  app.post('/api/login', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const input = z.object({ username: z.string().max(80), password: z.string().min(1).max(256) }).strict().parse(request.body);
    if (!config.authRequired) return { ok: true };
    const [, salt, expected] = config.ADMIN_PASSWORD_HASH.split('$');
    const actual = scryptSync(input.password, salt, 64).toString('hex');
    if (!safeEqual(actual, expected) || !safeEqual(input.username, config.ADMIN_USERNAME)) throw new AppError(401, 'invalid_credentials', '用户名或密码不正确。');
    const token = randomBytes(32).toString('hex');
    const csrf = randomBytes(32).toString('hex');
    store.cleanup();
    store.saveSession(hashSession(token), csrf, config.ADMIN_USERNAME, Date.now() + config.SESSION_TTL_HOURS * 3600000);
    reply.setCookie('lp_session', token, { path: '/', httpOnly: true, secure: config.NODE_ENV === 'production', sameSite: 'strict', maxAge: config.SESSION_TTL_HOURS * 3600 });
    return { ok: true };
  });
  app.post('/api/logout', async (request, reply) => {
    if (request.cookies.lp_session) store.deleteSession(hashSession(request.cookies.lp_session));
    reply.clearCookie('lp_session', { path: '/' });
    return { ok: true };
  });
  app.get('/api/services', async () => ({ items: manager.list() }));
  app.get('/api/activities', async () => ({ items: manager.audit() }));
  app.get('/api/models', async () => ({ items: manager.models() }));
  app.post('/api/models', async (request, reply) => reply.code(201).send(runtimes.registerModel(registeredModelSchema.parse(request.body))));
  app.get('/api/models/:modelId/removal', async request => models.removal(z.object({ modelId: z.string().max(100) }).parse(request.params).modelId));
  app.delete('/api/models/:modelId', async request => models.delete(z.object({ modelId: z.string().max(100) }).parse(request.params).modelId, z.object({ confirmation: z.string().max(100) }).strict().parse(request.body).confirmation, actor(request)!.actor));
  app.post('/api/assets/pvc-weights', async (request, reply) => {
    const input = z.object({ modelId: z.string().max(100), revision: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/), targetId: z.string().max(200), requestId: uuid, bindings: z.array(z.object({ role: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/), claimName: name, subPath: z.string().max(512).regex(/^(?:[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*)?$/).refine(p => !p.split('/').some(s => s === '..' || s === '.')), contentRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict()).min(1).max(8) }).strict().parse(request.body);
    return reply.code(201).send(await assets.registerPvc(input, actor(request)!.actor));
  });
  for (const [path, kind] of [['runtime-images', 'image'], ['runtime-profiles', 'runtime'], ['assets/weights', 'weight']] as const) {
    app.get(`/api/${path}/:id/removal`, async request => configurations.removal(kind, idSchema.parse(request.params).id));
    app.delete(`/api/${path}/:id`, async request => configurations.delete(kind, idSchema.parse(request.params).id, z.object({ confirmation: uuid }).strict().parse(request.body).confirmation, actor(request)!.actor));
  }
  app.get('/api/engines', async () => ({ items: runtimes.engines() }));
  app.get('/api/engines/:engineId/tags', async request => {
    const p = z.object({ engineId: z.string().max(40) }).parse(request.params);
    const q = z.object({ page: z.coerce.number().int().min(1).max(100).default(1), query: z.string().max(100).default('') }).parse(request.query);
    return runtimes.tags(p.engineId, q.page, q.query);
  });
  app.get('/api/runtime-images', async () => ({ items: images.list() }));
  app.post('/api/runtime-images', async (request, reply) => reply.code(201).send(images.register(directImageSchema.parse(request.body))));
  app.post('/api/runtime-images/:id/validate', async request => { z.object({}).strict().parse(request.body); return images.validate(idSchema.parse(request.params).id); });
  app.post('/api/runtime-images/:id/refresh', async request => { z.object({}).strict().parse(request.body); const id = idSchema.parse(request.params).id; if (store.asset('archived:image', id)) throw new AppError(404, 'not_found', '镜像版本已删除。'); return images.refresh(id, actor(request)!.actor); });
  app.post('/api/image-imports', async (request, reply) => reply.code(202).send(images.import(imageImportSchema.parse(request.body), actor(request)!.actor)));
  app.post('/api/image-builds', async (request, reply) => reply.code(202).send(await images.build(imageBuildSchema.parse(request.body), actor(request)!.actor)));
  app.get('/api/runtime-profiles', async () => ({ items: runtimes.list() }));
  app.post('/api/runtime-profiles', async (request, reply) => reply.code(201).send(runtimes.create(runtimeProfileSchema.parse(request.body))));
  app.get('/api/runtime-profiles/:id', async request => runtimes.detail(idSchema.parse(request.params).id));
  app.put('/api/runtime-profiles/:id', async request => {
    const p = idSchema.parse(request.params); const input = z.object({ revision: uuid, profile: runtimeProfileSchema }).strict().parse(request.body);
    return runtimes.create(input.profile, p.id, input.revision);
  });
  app.post('/api/runtime-profiles/:id/publish', async request => {
    const p = idSchema.parse(request.params); const input = z.object({ revision: uuid }).strict().parse(request.body);
    return runtimes.publish(p.id, input.revision, actor(request)!.actor);
  });
  app.post('/api/runtime-previews', async request => {
    const input = z.object({ profileId: uuid, weightVersionId: uuid, name, replicas: z.number().int().min(1).max(64).default(1) }).strict().parse(request.body);
    return manager.previewRuntime(input, runtimes.detail(input.profileId), actor(request)!.actor);
  });
  app.get('/api/assets/weights', async () => ({ items: assets.list() }));
  app.get('/api/assets/targets', async request => ({ items: await assets.targets(actor(request)!.actor) }));
  app.post('/api/assets/weights', async (request, reply) => {
    const input = z.object({ modelId: z.string().min(1).max(100), revision: z.string().max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, '版本仅支持字母、数字、点、下划线和连字符'), targetId: z.string().min(1).max(200), requestId: uuid, sources: z.array(z.object({ role: z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/), sourceUri: z.string().min(1).max(2048), contentRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/, '内容版本需要填写清单生成命令输出的 sha256 值') }).strict()).min(1).max(8) }).strict().parse(request.body);
    return reply.code(202).send(await assets.import(input, actor(request)!.actor));
  });
  app.post('/api/assets/weights/:id/refresh', async request => {
    const p = idSchema.parse(request.params); z.object({}).strict().parse(request.body);
    return assets.refresh(p.id, actor(request)!.actor);
  });
  app.get('/api/services/:id/logs', async request => {
    if (config.DEPLOYMENT_PROVIDER !== 'kubernetes') throw new AppError(422, 'logs_external', '此后端请使用服务观测入口查看日志。');
    const service = manager.requireService(idSchema.parse(request.params).id);
    return new Kubernetes(config).logs(service.namespace, service.name);
  });
  app.get('/api/services/:id', async request => { const p = idSchema.parse(request.params); return manager.detail(p.id); });
  app.post('/api/services/:id/config/preview', async request => {
    const p = idSchema.parse(request.params);
    const input = z.object({ revision: z.string().length(64), config: configInput }).strict().parse(request.body);
    return manager.previewConfiguration(p.id, input.revision, input.config, actor(request)!.actor);
  });
  app.post('/api/services/:id/config', async (request, reply) => {
    const p = idSchema.parse(request.params);
    const input = z.object({ previewId: uuid, requestId: uuid }).strict().parse(request.body);
    return reply.code(202).send(manager.configure(p.id, input.previewId, input.requestId, actor(request)!.actor));
  });
  app.post('/api/previews', async request => manager.preview(createSchema.parse(request.body), actor(request)!.actor));
  app.post('/api/services', async (request, reply) => {
    const input = z.object({ previewId: uuid, requestId: uuid }).strict().parse(request.body);
    const result = manager.create(input.previewId, input.requestId, actor(request)!.actor);
    return reply.code(202).send(result);
  });
  app.post('/api/services/:id/refresh', async request => {
    const p = idSchema.parse(request.params);
    z.object({}).strict().parse(request.body);
    await manager.refresh(p.id, actor(request)!.actor);
    return manager.detail(p.id);
  });
  app.post('/api/services/:id/actions', async (request, reply) => {
    const p = idSchema.parse(request.params);
    const input = z.object({ action: z.enum(['online', 'offline', 'restart', 'delete']), requestId: uuid, revision: z.string().length(64) }).strict().parse(request.body);
    return reply.code(202).send(await manager.action(p.id, input.action, input.requestId, input.revision, actor(request)!.actor));
  });
  app.get('/api/connection', async request => {
    if (config.APP_MODE === 'demo') return { available: true, message: '演示环境正常，不连接真实集群。' };
    if (config.DEPLOYMENT_PROVIDER === 'kubernetes') return new Kubernetes(config).connection();
    const checks = await Promise.all((['io', 'registry'] as const).map(async kind => {
      const baseUrl = kind === 'io' ? config.IO_BASE_URL : config.REGISTRY_BASE_URL;
      const configured = Boolean(baseUrl && (kind === 'io' ? config.IO_MANAGEMENT_TOKEN : config.REGISTRY_TOKEN));
      try {
        const result = await manager.upstream.request(kind, kind === 'io' ? '/management/v1/deployment-targets' : '/v1/deployment-targets', actor(request)!.actor);
        return { kind, baseUrl, configured, available: true, targetCount: Array.isArray(result.targets) ? result.targets.length : 0, message: '接口连通，已读取授权目标。' };
      } catch (error) { return { kind, baseUrl, configured, available: false, targetCount: 0, message: cleanMessage(error instanceof AppError ? error.message : '连接检查失败。', [config.IO_MANAGEMENT_TOKEN, config.REGISTRY_TOKEN]) }; }
    }));
    const available = checks.every(c => c.available);
    return { available, message: available ? 'Registry 与 IO 均已连通。仍需分别验收镜像、权重、Pod 和实际推理。' : '部署依赖尚未全部就绪，请按下方结果配置或排查连接。', checks };
  });
  const webRoot = resolve('dist/client');
  if (existsSync(webRoot)) {
    await app.register(staticFiles, { root: webRoot, prefix: '/', maxAge: 0 });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: { code: 'not_found', message: '接口不存在。' } });
      if (!request.url.includes('.') && ['GET', 'HEAD'].includes(request.method)) return reply.sendFile('index.html');
      return reply.code(404).send();
    });
  }
  let timer: NodeJS.Timeout | undefined;
  let sync: Promise<void> | undefined;
  if (options.background !== false) {
    const runSync = () => { if (!sync) sync = Promise.all([manager.sync(), assets.sync(), images.sync()]).then(() => undefined).finally(() => { sync = undefined; }); };
    runSync();
    timer = setInterval(runSync, config.SYNC_INTERVAL_MS);
    timer.unref();
  }
  app.addHook('onClose', async () => { if (timer) clearInterval(timer); await sync; await manager.drain(); await assets.drain(); await runtimes.drain(); await images.close(); store.close(); });
  return { app, manager, assets, runtimes, images, store };
}
