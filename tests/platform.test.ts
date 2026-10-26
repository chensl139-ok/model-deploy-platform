import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, scryptSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { Store } from '../server/store.js';
import type { Service, RuntimeProfile, RuntimeImage } from '../shared/types.js';
import { defaultRuntime, ENGINES } from '../shared/engines.js';
import { compileRuntime } from '../server/runtimes.js';
import { imageReference } from '../server/image-tools.js';

const salt = '0123456789abcdef0123456789abcdef';
const password = 'a-strong-test-password';
const passwordHash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
const env = { IMAGE_ALLOWED_PREFIXES: 'internal.example.com/,test-registry/', NODE_ENV: 'test', APP_MODE: 'demo', PUBLIC_ORIGIN: 'http://localhost:5173' };
const origin = { origin: 'http://localhost:5173' };
const imageTools = { inspect: async (ref: string, architecture: 'amd64' | 'arm64') => ({ digest: imageReference(ref).digest || `sha256:${'d'.repeat(64)}`, platformDigest: imageReference(ref).digest || `sha256:${'d'.repeat(64)}`, architecture, os: 'linux', checkedAt: new Date().toISOString(), entrypoint: ['vllm'], cmd: [] }), copy: async () => {} };
async function demo() { return buildApp(readConfig(env), { store: new Store(':memory:'), background: false, imageTools }); }
async function preview(instance: Awaited<ReturnType<typeof buildApp>>, name = 'test-model', headers = origin) {
  const res = await instance.app.inject({ method: 'POST', url: '/api/previews', headers, payload: { modelId: 'qwen3-8b', variantId: '24gb', name } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json<{ id: string }>();
}

test('demo deploy persists its lifecycle; stop, start, restart and delete are real state changes', async t => {
  const p = await demo(); t.after(() => p.app.close());
  const check = await preview(p);
  const requestId = randomUUID();
  const created = await p.app.inject({ method: 'POST', url: '/api/services', headers: origin, payload: { previewId: check.id, requestId } });
  assert.equal(created.statusCode, 202);
  const id = created.json().serviceId;
  const replay = await p.app.inject({ method: 'POST', url: '/api/services', headers: origin, payload: { previewId: check.id, requestId } });
  assert.equal(replay.json().serviceId, id);
  await p.manager.drain();
  for (const [action, state] of [['offline', 'stopped'], ['online', 'running'], ['restart', 'running'], ['delete', undefined]] as const) {
    const service = p.manager.detail(id).service;
    const result = await p.app.inject({ method: 'POST', url: `/api/services/${id}/actions`, headers: origin, payload: { action, requestId: randomUUID(), revision: service.revision } });
    assert.equal(result.statusCode, 202, result.body);
    await p.manager.drain();
    if (state) assert.equal(p.manager.detail(id).service.status, state);
    else assert.equal((await p.app.inject(`/api/services/${id}`)).statusCode, 404);
  }
  assert.equal(p.store.activities(id).length, 5);
});

test('names are validated; client cannot submit specs, tokens or unapproved GPU configurations', async t => {
  const p = await demo(); t.after(() => p.app.close());
  for (const input of [
    { modelId: 'qwen3-8b', variantId: '24gb', name: '../bad' },
    { modelId: 'qwen3-8b', variantId: 'not-real', name: 'test' },
    { modelId: 'qwen3-8b', variantId: '24gb', name: 'test', spec: { runtime: { image: 'evil' } } },
  ]) {
    assert.equal((await p.app.inject({ method: 'POST', url: '/api/previews', headers: origin, payload: input })).statusCode, 400);
  }
});

test('CSRF origin check rejects cross-site and null origins even in local demo', async t => {
  const p = await demo(); t.after(() => p.app.close());
  for (const hostile of ['https://evil.example', 'null']) {
    const res = await p.app.inject({ method: 'POST', url: '/api/previews', headers: { origin: hostile }, payload: {} });
    assert.equal(res.statusCode, 403);
  }
});

test('previews expire, cannot be consumed twice and enforce actor binding', async t => {
  const p = await demo(); t.after(() => p.app.close());
  const check = await preview(p);
  const stored = p.store.preview(check.id)!;
  p.store.savePreview({ ...stored, actor: 'different-user' });
  assert.equal((await p.app.inject({ method: 'POST', url: '/api/services', headers: origin, payload: { previewId: check.id, requestId: randomUUID() } })).statusCode, 409);
  p.store.savePreview({ ...stored, expiresAt: '2000-01-01T00:00:00.000Z' });
  assert.equal((await p.app.inject({ method: 'POST', url: '/api/services', headers: origin, payload: { previewId: check.id, requestId: randomUUID() } })).statusCode, 409);
  p.store.savePreview(stored);
  const payload = { previewId: check.id, requestId: randomUUID() };
  assert.equal((await p.app.inject({ method: 'POST', url: '/api/services', headers: origin, payload })).statusCode, 202);
  const duplicate = await p.app.inject({ method: 'POST', url: '/api/services', headers: origin, payload: { ...payload, requestId: randomUUID() } });
  assert.equal(duplicate.statusCode, 409);
  await p.manager.drain();
});

test('concurrent duplicate names reserve exactly one service and stale actions cannot overwrite changes', async t => {
  const p = await demo(); t.after(() => p.app.close());
  const [first, second] = await Promise.all([preview(p, 'same-name'), preview(p, 'same-name')]);
  const responses = await Promise.all([first, second].map(check => p.app.inject({ method: 'POST', url: '/api/services', headers: origin, payload: { previewId: check.id, requestId: randomUUID() } })));
  assert.deepEqual(responses.map(r => r.statusCode).sort(), [202, 409]);
  await p.manager.drain();
  const service = p.manager.list().find(s => s.name === 'same-name')!;
  const bad = await p.app.inject({ method: 'POST', url: `/api/services/${service.id}/actions`, headers: origin, payload: { action: 'offline', requestId: randomUUID(), revision: '0'.repeat(64) } });
  assert.equal(bad.statusCode, 409);
  assert.equal(p.manager.detail(service.id).service.status, 'running');
});

test('authenticated sessions are HttpOnly; CSRF required; logout invalidates server session', async t => {
  const p = await buildApp(readConfig({ ...env, ADMIN_PASSWORD_HASH: passwordHash }), { store: new Store(':memory:'), background: false });
  t.after(() => p.app.close());
  assert.equal((await p.app.inject('/api/services')).statusCode, 401);
  assert.equal((await p.app.inject('/api/bootstrap')).json().models.length, 0);
  const wrong = await p.app.inject({ method: 'POST', url: '/api/login', headers: origin, payload: { username: '管理员', password } });
  assert.equal(wrong.statusCode, 401);
  const login = await p.app.inject({ method: 'POST', url: '/api/login', headers: origin, payload: { username: 'admin', password } });
  assert.equal(login.statusCode, 200);
  const setCookie = String(login.headers['set-cookie']);
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/);
  const sessionCookie = setCookie.split(';')[0];
  const boot = (await p.app.inject({ url: '/api/bootstrap', headers: { cookie: sessionCookie } })).json();
  assert.equal(boot.authenticated, true); assert.ok(boot.csrfToken);
  assert.equal((await p.app.inject({ method: 'POST', url: '/api/logout', headers: { ...origin, cookie: sessionCookie }, payload: {} })).statusCode, 403);
  const result = await p.app.inject({ method: 'POST', url: '/api/logout', headers: { ...origin, cookie: sessionCookie, 'x-csrf-token': boot.csrfToken }, payload: {} });
  assert.equal(result.statusCode, 200);
  assert.equal((await p.app.inject({ url: '/api/services', headers: { cookie: sessionCookie } })).statusCode, 401);
});

test('production config fails closed for missing password, non-HTTPS origin and public unauthenticated demo', () => {
  assert.throws(() => readConfig({ ...env, NODE_ENV: 'production' }), /ADMIN_PASSWORD_HASH/);
  assert.throws(() => readConfig({ ...env, NODE_ENV: 'production', ADMIN_PASSWORD_HASH: passwordHash }), /HTTPS/);
  assert.throws(() => readConfig({ ...env, HOST: '0.0.0.0' }), /回环/);
  assert.throws(() => readConfig({ ...env, IO_BASE_URL: 'https://user:pass@example.com' }), /无凭据/);
});

test('production responses enforce secure cookies and a self-only script policy', async t => {
  const p = await buildApp(readConfig({ ...env, NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://models.example.com', ADMIN_PASSWORD_HASH: passwordHash }), { store: new Store(':memory:'), background: false });
  t.after(() => p.app.close());
  const response = await p.app.inject({ method: 'POST', url: '/api/login', headers: { origin: 'https://models.example.com' }, payload: { username: 'admin', password } });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers['set-cookie']), /Secure/);
  assert.match(String(response.headers['content-security-policy']), /script-src 'self'/);
  assert.ok(!String(response.headers['content-security-policy']).includes('unsafe-eval'));
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('login attempts are rate limited', async t => {
  const p = await buildApp(readConfig({ ...env, ADMIN_PASSWORD_HASH: passwordHash }), { store: new Store(':memory:'), background: false });
  t.after(() => p.app.close());
  let status = 0;
  for (let i = 0; i < 11; i++) status = (await p.app.inject({ method: 'POST', url: '/api/login', headers: origin, payload: { username: 'admin', password: 'incorrect' } })).statusCode;
  assert.equal(status, 429);
});

test('persistent data survives restart and never silently changes between demo and live modes', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'launchpad-persist-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = readConfig({ ...env, DATABASE_PATH: join(dir, 'test.sqlite') });
  const first = await buildApp(config, { background: false });
  const ids = first.manager.list().map(s => s.id); await first.app.close();
  const second = await buildApp(config, { background: false });
  assert.deepEqual(second.manager.list().map(s => s.id), ids); await second.app.close();
  const liveConfig = readConfig({ ...env, APP_MODE: 'live', DATABASE_PATH: config.DATABASE_PATH, ADMIN_PASSWORD_HASH: passwordHash, IO_BASE_URL: 'http://127.0.0.1', IO_MANAGEMENT_TOKEN: 'test' });
  const store = new Store(config.DATABASE_PATH);
  await assert.rejects(buildApp(liveConfig, { store, background: false }), /不能共享数据库/); store.close();
});

interface FakeState { spec: Record<string, any>; uid: string; version: number; exists: boolean; stale: boolean; failCreate: boolean; routeStale: boolean; creates: number; actions: number; actors: string[]; registryTargets: boolean; imports: number; importStatus: string; failImport: boolean; importedBody?: any; configurationWrites: number; failConfig: boolean; lastRegistryRevision?: string; runtimePackages: number; runtimeBody?: any; failRuntime?: boolean; omitRuntimeId?: boolean; mismatchImage?: boolean; previewReject?: boolean }
async function liveFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'launchpad-io-'));
  const spec = { modelRef: { name: 'test-model', version: 'v1' }, backend: { type: 'NativeDeployment' }, runtime: { image: 'test-registry/model@sha256:' + 'a'.repeat(64) }, rollout: { replicas: 1 }, service: { enabled: true, type: 'ClusterIP', port: 8000 }, capacity: { maxConcurrentRequestsPerPod: 1 } };
  const state: FakeState = { spec: structuredClone(spec), uid: 'original-uid', version: 1, exists: false, stale: false, failCreate: false, routeStale: false, creates: 0, actions: 0, actors: [], registryTargets: true, imports: 0, importStatus: 'available', failImport: false, configurationWrites: 0, failConfig: false, runtimePackages: 0 };
  const observed = () => ({ namespace: 'test', name: 'live-test', uid: state.uid, resource_version: String(state.version), generation: state.version, spec: state.spec, status: { observedGeneration: state.version, phase: state.spec.rollout.replicas ? 'Running' : 'Stopped', readyReplicas: state.spec.rollout.replicas, internalExposure: { phase: 'Ready', gatewayAddresses: ['10.0.0.2'], gatewayPort: 80, hostname: 'model.internal' } } });
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    state.actors.push(String(req.headers['x-management-actor-id'] ?? ''));
    const send = (status: number, value?: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(value === undefined ? '' : JSON.stringify(value)); };
    const path = req.url!;
    if (path === '/management/v1/deployment-targets') return send(200, { targets: [{ cluster_id: 12, namespaces: ['test'] }] });
    if (path === '/v1/deployment-targets') return send(200, { targets: [{ target_id: 'correct-target', cluster_id: 12, namespace: 'test', gpu_type: 'RTX PRO 6000' }] });
    if (path === '/internal/v1/weight-imports' && req.method === 'POST') {
      state.imports++; state.importedBody = body;
      return state.failImport ? send(503, { error: { code: 'unavailable', message: 'import response lost' } }) : send(200, { import_id: 'import-record-1' });
    }
    if (path === '/internal/v1/weight-imports/import-record-1' && req.method === 'GET') return send(200, { status: state.importStatus });
    if (path === '/internal/v1/runtime-packages' && req.method === 'POST') {
      state.runtimePackages++; state.runtimeBody = body;
      if (state.failRuntime) return send(503, { error: 'package response lost token=[REDACTED_SECRET]' });
      return send(201, state.omitRuntimeId ? {} : { package_id: 'new-runtime-package' });
    }
    if (path.startsWith('/v1/deployment-options')) {
      state.lastRegistryRevision = new URL(path, 'http://example.com').searchParams.get('model_revision') ?? undefined;
      return send(200, { options: state.registryTargets ? [
      { target: { target_id: 'wrong-target', cluster_id: 999, namespace: 'other' }, resolved_spec: { wrong: true } },
      { target: { target_id: 'correct-target', cluster_id: 12, namespace: 'test' }, resolved_spec: { ...spec, modelRef: { ...spec.modelRef, version: state.lastRegistryRevision }, ...(state.runtimeBody ? { runtime: { image: state.mismatchImage ? 'wrong/image' : (state.runtimeBody.components[0].image_ref ?? `internal.example.com/built@sha256:${'b'.repeat(64)}`), command: state.runtimeBody.components[0].command, args: state.runtimeBody.components[0].args, env: { PRIVATE: 'upstream-private-value' } }, storage: { mounts: [{ name: 'actual-weight', mountPath: '/models/main', subPath: 'resolved/by/registry' }] }, probes: { readiness: { path: state.runtimeBody.components[0].health_path } } } : {}) } },
    ] : [] }); }
    if (path === '/management/v1/clusters/12/namespaces/test/inference-services/preview') return send(200, { valid: !state.previewReject, kubernetes_preview: { spec: body.spec } });
    if (req.method === 'POST' && path.endsWith('/inference-services')) {
      state.creates++; state.exists = true; state.spec = body.spec;
      if (state.failCreate) return send(503, { error: { code: 'paas_unavailable', message: 'upstream error token=secret-test-token' } });
      return send(201, { kubernetes: observed() });
    }
    if (req.method === 'GET') {
      if (!state.exists) return send(404, { error: 'not found' });
      return state.stale ? send(200, { live: false, stale: true }) : send(200, { live: true, stale: false, routes_stale: state.routeStale, kubernetes: observed(), observability: { metrics: 'https://metrics.example/view' } });
    }
    if (String(req.headers['x-expected-uid']) !== state.uid || String(req.headers['x-expected-resource-version']) !== String(state.version)) return send(409, { error: { code: 'workload_changed', message: 'changed' } });
    if (path.endsWith('/spec/preview') && req.method === 'POST') return send(200, { kubernetes_preview: { spec: body.spec } });
    if (path.endsWith('/spec') && req.method === 'PUT') {
      state.configurationWrites++; state.spec = body.spec; state.version++;
      return state.failConfig ? send(503, { error: { code: 'paas_unavailable', message: 'write response lost' } }) : send(200, { kubernetes: observed() });
    }
    if (req.method === 'DELETE') { state.actions++; state.exists = false; return send(204); }
    if (path.includes('/actions/')) {
      state.actions++; state.version++;
      if (path.endsWith('/offline')) state.spec.rollout.replicas = 0;
      if (path.endsWith('/online')) state.spec.rollout.replicas = body.replicas;
      if (path.endsWith('/restart')) state.spec.rollout.restartNonce = body.restart_nonce;
      return send(200, { kubernetes: observed() });
    }
    return send(404, {});
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const catalogPath = join(dir, 'catalog.json');
  writeFileSync(catalogPath, JSON.stringify([{ id: 'qwen3-8b', name: 'Test model', version: 'v1', family: 'test', initials: 'T', color: 'blue', description: 'test', framework: 'vLLM', servedModelName: 'actual-served-name', variants: [{ id: '24gb', label: '24 GB', memoryGB: 24, description: 'test', clusterId: 12, namespace: 'test', spec }] }]));
  const config = readConfig({ ...env, APP_MODE: 'live', ADMIN_PASSWORD_HASH: passwordHash, IO_BASE_URL: address, IO_MANAGEMENT_TOKEN: 'secret-test-token', REGISTRY_BASE_URL: address, REGISTRY_TOKEN: 'registry-test-token', OSS_ALLOWED_PREFIXES: 'oss://allowed-models/inference', CATALOG_PATH: catalogPath });
  const instance = await buildApp(config, { store: new Store(':memory:'), background: false, imageTools });
  const login = await instance.app.inject({ method: 'POST', url: '/api/login', headers: origin, payload: { username: 'admin', password } });
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const boot = (await instance.app.inject({ url: '/api/bootstrap', headers: { cookie } })).json();
  const headers = { ...origin, cookie, 'x-csrf-token': boot.csrfToken, 'x-management-actor-id': 'forged-user', 'x-management-token': 'forged-token' };
  return { ...instance, state, headers, close: async () => { await instance.app.close(); await new Promise<void>(resolve => upstream.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); } };
}
async function liveDeploy(p: Awaited<ReturnType<typeof liveFixture>>) {
  const check = await preview(p, 'live-test', p.headers);
  const result = await p.app.inject({ method: 'POST', url: '/api/services', headers: p.headers, payload: { previewId: check.id, requestId: randomUUID() } });
  assert.equal(result.statusCode, 202, result.body); await p.manager.drain();
  return result.json().serviceId as string;
}

test('live IO lifecycle preserves expected UID/version, trusted actor, exact routes and served model name', async t => {
  const p = await liveFixture(); t.after(p.close);
  const id = await liveDeploy(p);
  let service = p.manager.detail(id).service;
  assert.equal(service.status, 'running'); assert.equal(service.routeReady, true);
  assert.equal(service.endpoint?.address, 'http://10.0.0.2:80'); assert.equal(service.endpoint?.hostname, 'model.internal');
  assert.equal(service.invocationModel, 'actual-served-name');
  assert.ok(p.state.actors.every(a => a === 'admin'));
  const response = await p.app.inject({ url: `/api/services/${id}`, headers: p.headers });
  assert.ok(!response.body.includes('secret-test-token')); assert.equal(response.json().service.spec, undefined); assert.equal(response.json().service.uid, undefined);
  for (const [action, expected] of [['offline', 'stopped'], ['online', 'running'], ['restart', 'running']] as const) {
    const result = await p.app.inject({ method: 'POST', url: `/api/services/${id}/actions`, headers: p.headers, payload: { action, requestId: randomUUID(), revision: service.revision } });
    assert.equal(result.statusCode, 202, result.body); await p.manager.drain();
    service = p.manager.detail(id).service; assert.equal(service.status, expected);
  }
  const deleted = await p.app.inject({ method: 'POST', url: `/api/services/${id}/actions`, headers: p.headers, payload: { action: 'delete', requestId: randomUUID(), revision: service.revision } });
  assert.equal(deleted.statusCode, 202); await p.manager.drain();
  assert.equal(p.store.get(id), undefined); assert.equal(p.state.actions, 4);
});

test('stale reads retain known state, suppress unsafe writes, and independently suppress stale routes', async t => {
  const p = await liveFixture(); t.after(p.close); const id = await liveDeploy(p);
  p.state.stale = true; await p.manager.refresh(id, 'admin');
  let service = p.manager.detail(id).service;
  assert.equal(service.stale, true); assert.equal(service.status, 'running');
  const action = await p.app.inject({ method: 'POST', url: `/api/services/${id}/actions`, headers: p.headers, payload: { action: 'offline', requestId: randomUUID(), revision: service.revision } });
  assert.equal(action.statusCode, 409); assert.equal(p.state.actions, 0);
  p.state.stale = false; p.state.routeStale = true; await p.manager.refresh(id, 'admin');
  service = p.manager.detail(id).service; assert.equal(service.routeReady, false); assert.equal(service.endpoint, undefined);
});

test('an upstream object replaced with the same name cannot be controlled via an old service', async t => {
  const p = await liveFixture(); t.after(p.close); const id = await liveDeploy(p);
  p.state.uid = 'new-unrelated-object';
  const service = p.manager.detail(id).service;
  const result = await p.app.inject({ method: 'POST', url: `/api/services/${id}/actions`, headers: p.headers, payload: { action: 'delete', requestId: randomUUID(), revision: service.revision } });
  assert.equal(result.statusCode, 409); assert.equal(p.state.actions, 0); assert.equal(p.state.exists, true);
});

test('accepted-but-unknown create is never replayed or falsely confirmed, and upstream secrets are redacted', async t => {
  const p = await liveFixture(); t.after(p.close); p.state.failCreate = true;
  const id = await liveDeploy(p);
  assert.equal(p.store.pending()[0].status, 'unknown');
  for (let i = 0; i < 3; i++) await p.manager.refresh(id, 'admin');
  assert.equal(p.store.pending()[0].status, 'unknown'); assert.equal(p.manager.detail(id).service.busy, true);
  assert.equal(p.state.creates, 1);
  const response = await p.app.inject({ url: `/api/services/${id}`, headers: p.headers });
  assert.ok(!response.body.includes('secret-test-token')); assert.ok(response.body.includes('[REDACTED]'));
});

test('Registry deployment options match target id, cluster and namespace rather than first array item', async t => {
  const p = await liveFixture(); t.after(p.close);
  const variant = p.manager.catalog[0].variants[0]; delete variant.spec;
  variant.runtimePackageId = 'runtime-package'; variant.targetId = 'correct-target';
  const id = await liveDeploy(p);
  assert.equal(p.state.spec.backend.type, 'NativeDeployment'); assert.equal(p.manager.detail(id).service.clusterId, 12);
  p.state.registryTargets = false;
  const result = await p.app.inject({ method: 'POST', url: '/api/previews', headers: p.headers, payload: { modelId: 'qwen3-8b', variantId: '24gb', name: 'another-service' } });
  assert.equal(result.statusCode, 409); assert.equal(p.state.creates, 1);
});

test('configuration changes require preview, retain GPU requests and publish one idempotent update with an audit diff', async t => {
  const p = await demo(); t.after(() => p.app.close());
  const service = p.manager.list().find(s => s.status === 'running')!;
  const before = p.manager.detail(service.id);
  const preview = await p.app.inject({ method: 'POST', url: `/api/services/${service.id}/config/preview`, headers: origin, payload: { revision: service.revision, config: { replicas: 2, cpuCores: 8, memoryGB: 32, maxConcurrency: 8 } } });
  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(p.manager.detail(service.id).runtime.replicas, 1);
  assert.equal(preview.json().changes.length, 4);
  const payload = { previewId: preview.json().id, requestId: randomUUID() };
  const first = await p.app.inject({ method: 'POST', url: `/api/services/${service.id}/config`, headers: origin, payload });
  const replay = await p.app.inject({ method: 'POST', url: `/api/services/${service.id}/config`, headers: origin, payload });
  assert.equal(first.statusCode, 202); assert.equal(replay.json().operationId, first.json().operationId);
  await p.manager.drain();
  const after = p.manager.detail(service.id);
  assert.equal(after.runtime.replicas, 2); assert.equal(after.service.readyReplicas, 2);
  assert.equal(after.runtime.cpuCores, 8); assert.equal(after.runtime.memoryGB, 32);
  assert.equal(after.service.gpuMemoryGB, before.service.gpuMemoryGB);
  const stored = p.store.get(service.id)!.spec as any;
  assert.equal(stored.runtime.resources.requests['nvidia.com/mig-2g.48gb'], '1');
  assert.equal(stored.runtime.resources.limits.cpu, '8'); assert.equal(stored.runtime.resources.limits.memory, '32Gi');
  const audit = (await p.app.inject('/api/activities')).json().items.find((item: any) => item.id === payload.requestId);
  assert.equal(audit.kind, 'configure'); assert.equal(audit.changes.length, 4); assert.equal(audit.requestedSpec, undefined);
  const restart = await p.app.inject({ method: 'POST', url: `/api/services/${service.id}/actions`, headers: origin, payload: { action: 'restart', revision: after.service.revision, requestId: randomUUID() } });
  assert.equal(restart.statusCode, 202); await p.manager.drain(); assert.equal(p.manager.detail(service.id).service.desiredReplicas, 2);
});

test('configuration rejects unsafe fields, repository swaps, no-op updates and expired previews', async t => {
  const p = await demo(); t.after(() => p.app.close()); const service = p.manager.list().find(s => s.status === 'running')!;
  const call = (config: unknown) => p.app.inject({ method: 'POST', url: `/api/services/${service.id}/config/preview`, headers: origin, payload: { revision: service.revision, config } });
  assert.equal((await call({ replicas: 1, spec: { command: ['bad'] } })).statusCode, 400);
  assert.equal((await call({ replicas: 65 })).statusCode, 400);
  assert.equal((await call({ replicas: 1 })).statusCode, 400);
  assert.equal((await call({ replicas: 1, image: `other.example.com/evil@sha256:${'b'.repeat(64)}` })).statusCode, 422);
  const response = await call({ replicas: 2 }); assert.equal(response.statusCode, 200);
  const checked = p.store.configPreview(response.json().id)!;
  p.store.saveConfigPreview({ ...checked, expiresAt: '2000-01-01T00:00:00.000Z' });
  assert.equal((await p.app.inject({ method: 'POST', url: `/api/services/${service.id}/config`, headers: origin, payload: { previewId: checked.id, requestId: randomUUID() } })).statusCode, 409);
});

test('live configuration preview and PUT use the exact original identity and full preserved spec', async t => {
  const p = await liveFixture(); t.after(p.close); const id = await liveDeploy(p);
  p.state.spec.runtime.env = { PRIVATE_VALUE: 'do-not-expose-this' };
  await p.manager.refresh(id, 'admin'); const service = p.manager.detail(id).service;
  const check = await p.app.inject({ method: 'POST', url: `/api/services/${id}/config/preview`, headers: p.headers, payload: { revision: service.revision, config: { replicas: 2, maxConcurrency: 6 } } });
  assert.equal(check.statusCode, 200, check.body); assert.equal(p.state.configurationWrites, 0);
  const body = { previewId: check.json().id, requestId: randomUUID() };
  assert.equal((await p.app.inject({ method: 'POST', url: `/api/services/${id}/config`, headers: p.headers, payload: body })).statusCode, 202);
  await p.manager.drain(); assert.equal(p.state.configurationWrites, 1); assert.equal(p.state.spec.rollout.replicas, 2);
  assert.equal(p.state.spec.runtime.env.PRIVATE_VALUE, 'do-not-expose-this');
  const detail = await p.app.inject({ url: `/api/services/${id}`, headers: p.headers });
  assert.ok(!detail.body.includes('do-not-expose-this')); assert.equal(detail.json().service.desiredReplicas, 2);
  const audit = await p.app.inject({ url: '/api/activities', headers: p.headers }); assert.ok(!audit.body.includes('do-not-expose-this'));
});

test('concurrent control-plane edits reject a checked configuration instead of silently overwriting', async t => {
  const p = await liveFixture(); t.after(p.close); const id = await liveDeploy(p); const service = p.manager.detail(id).service;
  const check = await p.app.inject({ method: 'POST', url: `/api/services/${id}/config/preview`, headers: p.headers, payload: { revision: service.revision, config: { replicas: 2 } } }); assert.equal(check.statusCode, 200);
  p.state.version++;
  assert.equal((await p.app.inject({ method: 'POST', url: `/api/services/${id}/config`, headers: p.headers, payload: { previewId: check.json().id, requestId: randomUUID() } })).statusCode, 202);
  await p.manager.drain();
  assert.equal(p.state.configurationWrites, 0); assert.equal(p.manager.detail(id).activities[0].status, 'failed'); assert.equal(p.state.spec.rollout.replicas, 1);
});

test('accepted configuration with lost response is reconciled against the same UID without replaying PUT', async t => {
  const p = await liveFixture(); t.after(p.close); const id = await liveDeploy(p); const service = p.manager.detail(id).service;
  const check = await p.app.inject({ method: 'POST', url: `/api/services/${id}/config/preview`, headers: p.headers, payload: { revision: service.revision, config: { replicas: 2 } } });
  p.state.failConfig = true;
  await p.app.inject({ method: 'POST', url: `/api/services/${id}/config`, headers: p.headers, payload: { previewId: check.json().id, requestId: randomUUID() } }); await p.manager.drain();
  assert.equal(p.store.pending()[0].kind, 'configure'); await p.manager.refresh(id, 'admin');
  assert.equal(p.state.configurationWrites, 1); assert.equal(p.store.pending().length, 0); assert.equal(p.manager.detail(id).service.desiredReplicas, 2);
});

const demoWeightTarget = '880e5ca1-6c77-4189-b3ab-616d8c95b09a';
const weightInput = (targetId = demoWeightTarget) => ({ modelId: 'qwen3-8b', revision: 'oss-v2', targetId, requestId: randomUUID(), sources: [{ role: 'main', sourceUri: 'oss://allowed-models/inference/qwen/v2/main/', contentRevision: `sha256:${'a'.repeat(64)}` }] });

test('OSS weight import becomes a selectable deployment version and preserves source provenance', async t => {
  const p = await demo(); t.after(() => p.app.close());
  const input = weightInput();
  const response = await p.app.inject({ method: 'POST', url: '/api/assets/weights', headers: origin, payload: input }); assert.equal(response.statusCode, 202, response.body);
  const weightId = response.json().id;
  assert.equal((await p.app.inject({ method: 'POST', url: '/api/previews', headers: origin, payload: { modelId: input.modelId, variantId: '24gb', name: 'oss-model-service', weightVersionId: weightId } })).statusCode, 409);
  await p.assets.drain();
  const check = await p.app.inject({ method: 'POST', url: '/api/previews', headers: origin, payload: { modelId: input.modelId, variantId: '24gb', name: 'oss-model-service', weightVersionId: weightId } }); assert.equal(check.statusCode, 200, check.body);
  assert.equal(check.json().modelVersion, 'oss-v2');
  const result = await p.app.inject({ method: 'POST', url: '/api/services', headers: origin, payload: { previewId: check.json().id, requestId: randomUUID() } }); await p.manager.drain();
  const service = p.manager.detail(result.json().serviceId).service;
  assert.equal(service.modelVersion, 'oss-v2'); assert.equal(service.weightSource?.sources[0].sourceUri, input.sources[0].sourceUri);
  assert.equal(service.weightSource?.sources[0].contentRevision, input.sources[0].contentRevision);
  const replay = await p.app.inject({ method: 'POST', url: '/api/assets/weights', headers: origin, payload: input }); assert.equal(replay.json().id, weightId);
});

test('OSS input rejects credentials, traversal, invalid checksums, repeated roles and unapproved path prefixes', async t => {
  const p = await liveFixture(); t.after(p.close);
  for (const uri of ['oss://allowed-models/inference-evil/qwen', 'oss://allowed-models/inference/../escape', 'oss://allowed-models/inference/%2e%2e/escape', 'oss://allowed-models/inference/model?token=abc', 'oss://user@allowed-models/inference/model']) {
    const input = weightInput('correct-target'); input.sources[0].sourceUri = uri;
    const result = await p.app.inject({ method: 'POST', url: '/api/assets/weights', headers: p.headers, payload: input }); assert.ok([400, 403].includes(result.statusCode), result.body);
  }
  const badHash = weightInput('correct-target'); badHash.sources[0].contentRevision = 'not-a-real-revision';
  assert.equal((await p.app.inject({ method: 'POST', url: '/api/assets/weights', headers: p.headers, payload: badHash })).statusCode, 400);
  const duplicate = weightInput('correct-target'); duplicate.sources.push({ ...duplicate.sources[0] });
  assert.equal((await p.app.inject({ method: 'POST', url: '/api/assets/weights', headers: p.headers, payload: duplicate })).statusCode, 400);
  assert.equal(p.state.imports, 0);
});

test('real OSS import follows Registry target and manifest contracts and resolves the imported revision at deployment', async t => {
  const p = await liveFixture(); t.after(p.close);
  const input = weightInput('correct-target');
  const response = await p.app.inject({ method: 'POST', url: '/api/assets/weights', headers: p.headers, payload: input }); assert.equal(response.statusCode, 202, response.body); await p.assets.drain();
  assert.equal(p.state.imports, 1); assert.deepEqual(p.state.importedBody.target_ids, ['correct-target']);
  assert.equal(p.state.importedBody.weights[0].source_uri, input.sources[0].sourceUri.replace(/\/$/, '')); assert.equal(p.state.importedBody.weights[0].content_revision, input.sources[0].contentRevision);
  const weight = p.assets.list()[0]; assert.equal(weight.status, 'available');
  const variant = p.manager.catalog[0].variants[0]; delete variant.spec; variant.runtimePackageId = 'approved-runtime'; variant.targetId = 'correct-target';
  const check = await p.app.inject({ method: 'POST', url: '/api/previews', headers: p.headers, payload: { modelId: input.modelId, variantId: '24gb', name: 'from-oss', weightVersionId: weight.id } }); assert.equal(check.statusCode, 200, check.body);
  assert.equal(p.state.lastRegistryRevision, 'oss-v2');
  const result = await p.app.inject({ method: 'POST', url: '/api/services', headers: p.headers, payload: { previewId: check.json().id, requestId: randomUUID() } }); await p.manager.drain();
  assert.equal(p.manager.detail(result.json().serviceId).service.weightSource?.versionId, weight.id);
});

test('ambiguous OSS import is not resubmitted automatically or by an idempotent replay', async t => {
  const p = await liveFixture(); t.after(p.close); p.state.failImport = true;
  const input = weightInput('correct-target');
  const response = await p.app.inject({ method: 'POST', url: '/api/assets/weights', headers: p.headers, payload: input }); assert.equal(response.statusCode, 202); await p.assets.drain();
  assert.equal(p.assets.list()[0].status, 'unknown');
  await p.app.inject({ method: 'POST', url: '/api/assets/weights', headers: p.headers, payload: input }); await p.assets.sync();
  assert.equal(p.state.imports, 1); assert.equal(p.assets.list()[0].status, 'unknown');
});

test('concurrent OSS retries reserve one import and conflicting use of the same request id is rejected', async t => {
  const p = await liveFixture(); t.after(p.close);
  const input = weightInput('correct-target');
  const call = (payload: ReturnType<typeof weightInput>) => p.app.inject({ method: 'POST', url: '/api/assets/weights', headers: p.headers, payload });
  const [first, retry, conflict] = await Promise.all([call(input), call(input), call({ ...input, revision: 'other-version' })]);
  assert.equal(first.statusCode, 202, first.body); assert.equal(retry.statusCode, 202, retry.body);
  assert.equal(first.json().id, retry.json().id); assert.equal(conflict.statusCode, 409, conflict.body);
  await p.assets.drain(); assert.equal(p.state.imports, 1); assert.equal(p.assets.list().length, 1);
  assert.equal(p.assets.list()[0].requestId, input.requestId);
});

async function customRuntime(p: Awaited<ReturnType<typeof demo>>, headers = origin, engineId = 'vllm') {
  const call = async (url: string, payload: object) => { const result = await p.app.inject({ method: 'POST', url, headers, payload }); assert.ok(result.statusCode < 300, result.body); return result.json(); };
  const model = { id: `custom-${engineId}`, name: `Internal ${engineId}`, modelKey: `internal/${engineId}`, servedModelName: `served-${engineId}`, description: 'Custom model without a hardcoded variant', family: 'internal' };
  await call('/api/models', model);
  const image = await call('/api/runtime-images', { engineId, version: 'release-2026', imageRef: `internal.example.com/${engineId}@sha256:${'d'.repeat(64)}`, architecture: 'amd64', cuda: 'validated by operator', notes: '' });
  if (p.manager.config.APP_MODE !== 'setup') await call(`/api/runtime-images/${image.id}/validate`, {});
  const input = { ...defaultRuntime(model.id, engineId), name: `${engineId}-production`, imageId: image.id, healthPath: '/readyz', livenessPath: '/livez', startupTimeoutSeconds: 2400, gpuCount: 2 };
  const profile = await call('/api/runtime-profiles', input) as RuntimeProfile;
  return { call, model, image, input, profile };
}

test('arbitrary model, versioned engine images and editable drafts are queryable without file edits', async t => {
  const p = await demo(); t.after(() => p.app.close()); const runtime = await customRuntime(p);
  assert.ok(p.manager.models().some(m => m.id === runtime.model.id && m.variants.length === 0));
  const detail = await p.app.inject(`/api/runtime-profiles/${runtime.profile.id}`); assert.equal(detail.statusCode, 200);
  assert.ok(detail.json().command.includes('served-vllm')); assert.ok(detail.json().command.includes('/models/main'));
  const update = await p.app.inject({ method: 'PUT', url: `/api/runtime-profiles/${runtime.profile.id}`, headers: origin, payload: { revision: runtime.profile.revision, profile: { ...runtime.input, startupTimeoutSeconds: 3000 } } });
  assert.equal(update.statusCode, 200); assert.equal(update.json().startupTimeoutSeconds, 3000);
  assert.equal((await p.app.inject({ method: 'PUT', url: `/api/runtime-profiles/${runtime.profile.id}`, headers: origin, payload: { revision: runtime.profile.revision, profile: runtime.input } })).statusCode, 409);
  assert.equal((await p.app.inject({ method: 'POST', url: '/api/runtime-images', headers: origin, payload: { engineId: runtime.image.engineId, version: runtime.image.version, architecture: runtime.image.architecture, cuda: runtime.image.cuda, notes: runtime.image.notes, imageRef: 'internal.example.com/vllm:latest' } })).statusCode, 400);
  assert.equal((await p.app.inject({ method: 'POST', url: '/api/runtime-images', headers: origin, payload: { engineId: runtime.image.engineId, version: runtime.image.version, architecture: runtime.image.architecture, cuda: runtime.image.cuda, notes: runtime.image.notes, imageRef: `internal.example.com/vllm@sha256:${'c'.repeat(64)}` } })).statusCode, 409);
});

test('all four engine commands, probes, GPU counts and role mounts are compiled into the Registry contract', async t => {
  const p = await demo(); t.after(() => p.app.close());
  for (const engine of ENGINES.filter(e => e.id !== 'custom')) {
    const r = await customRuntime(p, origin, engine.id); const detail = p.runtimes.detail(r.profile.id); const component = (detail.registryRequest.components as any[])[0];
    assert.equal(component.image_ref, r.image.imageRef); assert.equal(component.health_path, '/readyz'); assert.equal(component.liveness_path, '/livez');
    assert.equal(component.startup_timeout_seconds, 2400); assert.equal(component.gpu_count, 2); assert.equal(component.cpu_request_milli, 4000);
    assert.deepEqual(component.weight_requirements, [{ weight_role: 'main', mount_path: '/models/main', env_name: 'MODEL_PATH', read_only: true }]);
    assert.ok(detail.command.includes('/models/main')); assert.ok(detail.command.includes(`served-${engine.id}`));
    assert.deepEqual(component.command, engine.command);
    if (engine.id === 'vllm-omni') assert.ok(component.args.includes('--omni'));
    if (engine.id === 'sglang-omni') assert.ok(component.args.includes('--model-name'));
  }
});

test('runtime profile validation rejects role collisions, unsafe mounts, missing commands, wrong engines and unknown placeholders', async t => {
  const p = await demo(); t.after(() => p.app.close()); const r = await customRuntime(p);
  for (const changed of [ { command: [] }, { mounts: [{ role: 'main', mountPath: '/etc/model', envName: 'MODEL_PATH' }] }, { mounts: [r.input.mounts[0], r.input.mounts[0]] }, { env: { MODEL_PATH: '/changed' } }, { engineId: 'sglang' }, { args: ['{{UNKNOWN}}'] }, { sharedMemoryGB: 100 } ]) {
    const result = await p.app.inject({ method: 'POST', url: '/api/runtime-profiles', headers: origin, payload: { ...r.input, version: randomUUID(), ...changed } });
    assert.equal(result.statusCode, 400, result.body);
  }
  const script = { ...r.profile, mode: 'script' as const, script: 'exec custom-engine "$MODEL_PATH"', env: { ARG: "safe'$(touch /tmp/not-executed)" } };
  const model = p.manager.catalog.find(m => m.id === r.model.id)!;
  const compiled = compileRuntime(script, r.image as RuntimeImage, model);
  assert.ok(compiled.command.includes("'\"'\"'")); assert.ok(compiled.command.endsWith(script.script));
  assert.equal((compiled.registryRequest.components as any[])[0].startup_interpreter, '/bin/sh');
});

test('published custom runtime and OSS weight can deploy a non-template model through live Registry and IO preview/create', async t => {
  const p = await liveFixture(); t.after(p.close); const r = await customRuntime(p, p.headers, 'sglang-omni');
  const published = await r.call(`/api/runtime-profiles/${r.profile.id}/publish`, { revision: r.profile.revision });
  assert.equal(published.status, 'published'); assert.equal(published.packageId, 'new-runtime-package'); assert.equal(p.state.runtimePackages, 1);
  assert.equal(p.state.runtimeBody.components[0].command[0], 'sgl-omni');
  const connection = (await p.app.inject({ url: '/api/connection', headers: p.headers })).json();
  assert.equal(connection.available, true); assert.equal(connection.checks.length, 2); assert.ok(connection.checks.every((check: any) => check.available && check.configured));
  const weight = await r.call('/api/assets/weights', { ...weightInput('correct-target'), modelId: r.model.id }); await p.assets.drain();
  assert.equal(p.state.importedBody.model_key, r.model.modelKey);
  const check = await r.call('/api/runtime-previews', { profileId: r.profile.id, weightVersionId: weight.id, name: 'custom-omni-service' });
  assert.equal(p.state.creates, 0); assert.ok(!JSON.stringify(check).includes('upstream-private-value')); assert.ok(check.command.includes('sgl-omni'));
  const created = await r.call('/api/services', { previewId: check.id, requestId: randomUUID() }); await p.manager.drain();
  const detail = p.manager.detail(created.serviceId);
  assert.equal(detail.service.modelId, r.model.id); assert.equal(detail.service.framework, 'SGLang Omni'); assert.equal(detail.service.weightSource?.versionId, weight.id);
  assert.equal(p.state.spec.runtime.image, r.image.imageRef); assert.equal(p.state.spec.storage.mounts[0].subPath, 'resolved/by/registry'); assert.equal(p.state.spec.runtime.env.PRIVATE, 'upstream-private-value');
  assert.equal(detail.service.deployment?.healthPath, '/readyz'); assert.equal(detail.service.invocationModel, r.model.servedModelName);
  assert.ok(!JSON.stringify(detail).includes('upstream-private-value'));
  const update = await p.app.inject({ method: 'PUT', url: `/api/runtime-profiles/${r.profile.id}`, headers: p.headers, payload: { revision: published.revision, profile: r.input } }); assert.equal(update.statusCode, 409);
});

test('runtime publication is reserved once and ambiguous Registry writes are never replayed', async t => {
  const p = await liveFixture(); t.after(p.close); const r = await customRuntime(p, p.headers); p.state.failRuntime = true;
  const responses = await Promise.all([r.call(`/api/runtime-profiles/${r.profile.id}/publish`, { revision: r.profile.revision }), p.app.inject({ method: 'POST', url: `/api/runtime-profiles/${r.profile.id}/publish`, headers: p.headers, payload: { revision: r.profile.revision } })]);
  assert.equal(responses[0].status, 'unknown'); assert.equal(responses[1].statusCode, 409);
  assert.ok(!responses[0].message.includes('registry-test-token')); assert.equal(p.state.runtimePackages, 1);
  const retry = await p.app.inject({ method: 'POST', url: `/api/runtime-profiles/${r.profile.id}/publish`, headers: p.headers, payload: { revision: p.runtimes.get(r.profile.id).revision } });
  assert.equal(retry.statusCode, 409); assert.equal(p.state.runtimePackages, 1);
});

test('custom deployment rejects unready or mismatched weights, unexpected runtime image and negative IO preview', async t => {
  const p = await liveFixture(); t.after(p.close); const r = await customRuntime(p, p.headers);
  const weight = await r.call('/api/assets/weights', { ...weightInput('correct-target'), modelId: r.model.id }); await p.assets.drain();
  const check = () => p.app.inject({ method: 'POST', url: '/api/runtime-previews', headers: p.headers, payload: { profileId: r.profile.id, weightVersionId: weight.id, name: 'blocked-custom-model' } });
  assert.equal((await check()).statusCode, 409); await r.call(`/api/runtime-profiles/${r.profile.id}/publish`, { revision: r.profile.revision });
  const stored = p.store.weight(weight.id)!; p.store.saveWeight({ ...stored, sources: [{ ...stored.sources[0], role: 'codec' }] }); assert.equal((await check()).statusCode, 422); p.store.saveWeight(stored);
  p.state.mismatchImage = true; assert.equal((await check()).statusCode, 422); p.state.mismatchImage = false;
  p.state.previewReject = true; assert.equal((await check()).statusCode, 422); assert.equal(p.state.creates, 0);
});

test('default setup workspace has no simulated services and blocks deployment writes while retaining real drafts', async t => {
  const config = readConfig({ NODE_ENV: 'test', CATALOG_PATH: '/nonexistent/catalog.json' }); assert.equal(config.APP_MODE, 'setup');
  const p = await buildApp(config, { store: new Store(':memory:'), background: false, imageTools }); t.after(() => p.app.close());
  assert.deepEqual(p.manager.list(), []); assert.deepEqual(p.manager.models(), []);
  const r = await customRuntime(p);
  for (const url of [`/api/runtime-profiles/${r.profile.id}/publish`, '/api/runtime-previews', '/api/assets/weights', '/api/services']) {
    const response = await p.app.inject({ method: 'POST', url, headers: origin, payload: {} });
    assert.equal(response.statusCode, 503, response.body); assert.equal(response.json().error.code, 'platform_not_connected');
  }
  assert.equal(p.runtimes.get(r.profile.id).status, 'draft'); assert.equal(p.assets.list().length, 0); assert.equal(p.manager.list().length, 0);
  const bootstrap = (await p.app.inject('/api/bootstrap')).json(); assert.equal(bootstrap.mode, 'setup'); assert.equal(bootstrap.connection.configured, false);
  const connection = (await p.app.inject('/api/connection')).json(); assert.equal(connection.available, false); assert.equal(connection.checks.length, 2);
});

test('setup assets survive connection to live mode; a live database cannot silently revert to unauthenticated setup', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'launchpad-setup-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const database = join(dir, 'live.sqlite'); const catalog = join(dir, 'missing-catalog.json');
  const first = await buildApp(readConfig({ NODE_ENV: 'test', DATABASE_PATH: database, CATALOG_PATH: catalog }), { background: false });
  const r = await customRuntime(first); await first.app.close();
  const connected = await buildApp(readConfig({ ...env, APP_MODE: 'live', DATABASE_PATH: database, CATALOG_PATH: catalog, ADMIN_PASSWORD_HASH: passwordHash, IO_BASE_URL: 'http://127.0.0.1:1', IO_MANAGEMENT_TOKEN: 'fixture-only' }), { background: false });
  assert.ok(connected.manager.models().some(m => m.id === r.model.id)); assert.equal(connected.runtimes.get(r.profile.id).status, 'draft'); assert.equal(connected.runtimes.images().length, 1); await connected.app.close();
  const store = new Store(database);
  await assert.rejects(buildApp(readConfig({ NODE_ENV: 'test', DATABASE_PATH: database }), { store, background: false }), /不能共享数据库/); store.close();
});

test('missing runtime package identity is an unknown result and interrupted publication is not replayed on restart', async t => {
  const p = await liveFixture(); t.after(p.close); const r = await customRuntime(p, p.headers); p.state.omitRuntimeId = true;
  const result = await r.call(`/api/runtime-profiles/${r.profile.id}/publish`, { revision: r.profile.revision });
  assert.equal(result.status, 'unknown'); assert.equal(p.state.runtimePackages, 1);
  p.store.saveAsset('runtime', r.profile.id, { ...r.profile, status: 'publishing' });
  const { Runtimes } = await import('../server/runtimes.js');
  const restarted = new Runtimes(p.manager.config, p.store, () => p.manager.catalog);
  assert.equal(restarted.get(r.profile.id).status, 'unknown'); assert.equal(p.state.runtimePackages, 1);
});

test('upstream image version lookup uses only fixed engine repositories and never substitutes fake tags on failure', async t => {
  const p = await demo(); t.after(() => p.app.close()); const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  let target = ''; let fail = false;
  globalThis.fetch = async (input, options) => { target = String(input); assert.equal(options?.redirect, 'error'); if (fail) throw new Error('network down'); return new Response(JSON.stringify({ next: null, results: [{ name: 'verified-tag', digest: `sha256:${'a'.repeat(64)}`, last_updated: '2026-10-22', images: [{ architecture: 'amd64' }] }] }), { status: 200 }); };
  const response = await p.app.inject('/api/engines/vllm/tags?page=2&query=stable'); assert.equal(response.statusCode, 200);
  const url = new URL(target); assert.equal(url.host, 'hub.docker.com'); assert.equal(url.pathname, '/v2/repositories/vllm/vllm-openai/tags'); assert.equal(url.searchParams.get('page'), '2'); assert.equal(response.json().items[0].name, 'verified-tag');
  assert.equal((await p.app.inject('/api/engines/custom/tags')).statusCode, 400);
  fail = true; const unavailable = await p.app.inject('/api/engines/sglang-omni/tags'); assert.equal(unavailable.statusCode, 502); assert.equal(unavailable.json().items, undefined);
});

test('built image artifacts publish by artifact ID and use the actual Registry-resolved digest at deployment', async t => {
  const p = await liveFixture(); t.after(p.close); const r = await customRuntime(p, p.headers);
  const image = p.images.get(r.image.id); p.store.saveAsset('image', image.id, { ...image, imageRef: '', source: 'build', status: 'available', artifactId: 'ci-built-artifact' });
  await r.call(`/api/runtime-profiles/${r.profile.id}/publish`, { revision: r.profile.revision });
  assert.equal(p.state.runtimeBody.components[0].image_artifact_id, 'ci-built-artifact'); assert.equal(p.state.runtimeBody.components[0].image_ref, undefined);
  const weight = await r.call('/api/assets/weights', { ...weightInput('correct-target'), modelId: r.model.id }); await p.assets.drain();
  const checked = await r.call('/api/runtime-previews', { profileId: r.profile.id, weightVersionId: weight.id, name: 'built-engine-service' });
  assert.equal(checked.image, `internal.example.com/built@sha256:${'b'.repeat(64)}`);
  const created = await r.call('/api/services', { previewId: checked.id, requestId: randomUUID() }); await p.manager.drain();
  assert.equal(p.manager.detail(created.serviceId).service.deployment?.imageRef, checked.image);
});

test('model deletion protects all service references, archives local dependencies and invalidates deployment previews', async t => {
  const p = await demo(); t.after(() => p.app.close());
  const r = await customRuntime(p);
  const weight = await r.call('/api/assets/weights', { ...weightInput('880e5ca1-6c77-4189-b3ab-616d8c95b09a'), modelId: r.model.id }); await p.assets.drain();
  const published = await r.call(`/api/runtime-profiles/${r.profile.id}/publish`, { revision: r.profile.revision }); assert.equal(published.status, 'published');
  const preview = await r.call('/api/runtime-previews', { profileId: r.profile.id, weightVersionId: weight.id, name: 'deletion-guarded-model' });
  const remove = () => p.app.inject({ method: 'DELETE', url: `/api/models/${r.model.id}`, headers: origin, payload: { confirmation: r.model.id } });
  const created = await r.call('/api/services', { previewId: preview.id, requestId: randomUUID() }); await p.manager.drain();
  assert.equal((await remove()).statusCode, 409);
  await p.manager.action(created.serviceId, 'offline', randomUUID(), p.manager.detail(created.serviceId).service.revision, '本地用户'); await p.manager.drain();
  assert.equal((await remove()).statusCode, 409, 'Stopped services still reference model configuration');
  await p.manager.action(created.serviceId, 'delete', randomUUID(), p.manager.detail(created.serviceId).service.revision, '本地用户'); await p.manager.drain();
  const unused = await r.call('/api/runtime-previews', { profileId: r.profile.id, weightVersionId: weight.id, name: 'unused-preview' });
  const wrong = await p.app.inject({ method: 'DELETE', url: `/api/models/${r.model.id}`, headers: origin, payload: { confirmation: 'wrong-model' } }); assert.equal(wrong.statusCode, 400);
  assert.equal((await remove()).statusCode, 200);
  assert.ok(!p.manager.models().some(m => m.id === r.model.id)); assert.ok(!p.runtimes.list().some(p => p.modelId === r.model.id)); assert.ok(!p.assets.list().some(w => w.modelId === r.model.id));
  assert.ok(p.store.asset('deleted-model', r.model.id)); assert.ok(p.images.get(r.image.id)); assert.ok(p.manager.audit().some(a => a.serviceId === created.serviceId && a.deleted));
  assert.equal((await p.app.inject({ method: 'POST', url: '/api/services', headers: origin, payload: { previewId: unused.id, requestId: randomUUID() } })).statusCode, 409);
});

test('model deletion blocks ambiguous asset work and hides file catalog entries persistently', async t => {
  const p = await demo(); t.after(() => p.app.close()); const r = await customRuntime(p);
  p.store.saveAsset('runtime', r.profile.id, { ...r.profile, status: 'unknown' });
  const blocked = await p.app.inject({ method: 'DELETE', url: `/api/models/${r.model.id}`, headers: origin, payload: { confirmation: r.model.id } }); assert.equal(blocked.statusCode, 409);
  p.store.saveAsset('runtime', r.profile.id, { ...r.profile, status: 'draft' });
  assert.equal((await p.app.inject({ method: 'DELETE', url: `/api/models/${r.model.id}`, headers: origin, payload: { confirmation: r.model.id } })).statusCode, 200);
  // Re-registering a deleted identifier keeps the old deletion archive.
  assert.equal((await p.app.inject({ method: 'POST', url: '/api/models', headers: origin, payload: { id: r.model.id, name: 'Again', modelKey: 'different', servedModelName: 'different', description: '', family: '' } })).statusCode, 201);
  assert.ok(p.store.assets('model-deletion-history').length);
});

test('all user-created configuration kinds can be removed; references block removal and archived workers cannot resurrect records', async t => {
  const p = await demo(); t.after(() => p.app.close()); const r = await customRuntime(p);
  const remove = (path: string, id: string) => p.app.inject({ method: 'DELETE', url: `/api/${path}/${id}`, headers: origin, payload: { confirmation: id } });
  assert.equal((await remove('runtime-images', r.image.id)).statusCode, 409, 'active profile references image');
  assert.equal((await remove('runtime-profiles', r.profile.id)).statusCode, 200);
  assert.equal((await remove('runtime-images', r.image.id)).statusCode, 200);
  assert.equal(p.images.list().length, 0); assert.equal(p.runtimes.list().length, 0);
  assert.equal((await p.app.inject('/api/runtime-images')).json().items.length, 0);
  // A late CI/read result updates retained history without returning to the active list.
  p.store.saveAsset('image', r.image.id, { ...r.image, status: 'available' }); assert.equal(p.images.list().length, 0);
  p.store.saveAsset('runtime', r.profile.id, { ...r.profile, status: 'published' }); assert.equal(p.runtimes.list().length, 0);
  const weight = await r.call('/api/assets/weights', { ...weightInput('880e5ca1-6c77-4189-b3ab-616d8c95b09a'), modelId: r.model.id }); await p.assets.drain();
  const stored = p.store.weight(weight.id)!;
  assert.equal((await remove('assets/weights', weight.id)).statusCode, 200); assert.equal(p.assets.list().length, 0);
  p.store.saveWeight({ ...stored, status: 'available' }); assert.equal(p.assets.list().length, 0); assert.equal(p.store.weight(weight.id), undefined);
});

test('multi-replica stop/start preserves the previous count including an explicit zero-replica configuration', async t => {
  const p = await demo(); t.after(() => p.app.close());
  const service = p.manager.list().find(s => s.status === 'running')!;
  const change = async (replicas: number) => { const check = await p.manager.previewConfiguration(service.id, p.manager.detail(service.id).service.revision, { replicas }, '本地用户'); p.manager.configure(service.id, check.id, randomUUID(), '本地用户'); await p.manager.drain(); };
  await change(3);
  await p.manager.action(service.id, 'offline', randomUUID(), p.manager.detail(service.id).service.revision, '本地用户'); await p.manager.drain();
  assert.equal(p.manager.detail(service.id).service.resumeReplicas, 3);
  await p.manager.action(service.id, 'online', randomUUID(), p.manager.detail(service.id).service.revision, '本地用户'); await p.manager.drain(); assert.equal(p.manager.detail(service.id).runtime.replicas, 3);
  await change(0);
  await p.manager.action(service.id, 'online', randomUUID(), p.manager.detail(service.id).service.revision, '本地用户'); await p.manager.drain(); assert.equal(p.manager.detail(service.id).runtime.replicas, 3);
});
