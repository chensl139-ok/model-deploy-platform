/** Real cluster acceptance. No mocked Registry, image tools or model server. */
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID, scryptSync, createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import assert from 'node:assert/strict';
import { buildApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { defaultRuntime } from '../shared/engines.js';
import type { JsonObject } from '../shared/types.js';

const context = 'orbstack'; const namespace = 'launchpad-test';
const image = 'ghcr.io/ggml-org/llama.cpp@sha256:8c74db29f1a2bef3f0a331b52c4d6214601dfceed4bee0b94cc48b3b23ff257d';
const modelUrl = 'https://huggingface.co/bartowski/SmolLM2-135M-Instruct-GGUF/resolve/09816acd5d99df7be770d85ea30822623dab342c/SmolLM2-135M-Instruct-Q4_K_M.gguf';
const modelHash = '2e8040ceae7815abe0dcb3540b9995eaa1fa0d2ca9e797d0a635ae4433c68c2d';
const file = process.env.SMOKE_MODEL_FILE ?? '/private/tmp/launchpad-smollm.gguf';
const runId = Date.now().toString(36); const modelId = `smollm-${runId}`;
const evidence: JsonObject = { startedAt: new Date().toISOString(), context, namespace, image, modelUrl, modelHash, steps: [] };
const record = (step: string, detail: unknown = true) => { (evidence.steps as unknown[]).push({ step, detail, at: new Date().toISOString() }); console.log(step, typeof detail === 'string' ? detail : 'OK'); };
const kubectl = (args: string[], input?: unknown) => JSON.parse(execFileSync('kubectl', ['--context', context, '--request-timeout=30s', ...args], { input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8', timeout: 45000, maxBuffer: 4 * 1024 * 1024 }));
const pause = () => new Promise(r => setTimeout(r, 2000));
const nodes = kubectl(['get', 'nodes', '-o', 'json']); assert.ok(nodes.items.some((n: any) => n.metadata.labels['kubernetes.io/arch'] === 'arm64')); record('orbstack-ready');
if (!existsSync(file)) execFileSync('curl', ['-fL', '--retry', '2', modelUrl, '-o', file], { stdio: 'inherit', timeout: 300000 });
assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), modelHash); record('weights-sha256-verified');
kubectl(['apply', '-f', '-', '-o', 'json'], { apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace, labels: { 'app.kubernetes.io/managed-by': 'launchpad-smoke' } } });
kubectl(['apply', '-f', '-', '-o', 'json'], { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'smollm-weights', namespace }, spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } } });
const helperName = `weights-${runId}`;
kubectl(['create', '-f', '-', '-o', 'json'], { apiVersion: 'v1', kind: 'Pod', metadata: { name: helperName, namespace }, spec: { restartPolicy: 'Never', automountServiceAccountToken: false, containers: [{ name: 'copy', image, imagePullPolicy: 'IfNotPresent', command: ['/bin/sh', '-c', 'sleep 900'], volumeMounts: [{ name: 'weights', mountPath: '/models' }] }], volumes: [{ name: 'weights', persistentVolumeClaim: { claimName: 'smollm-weights' } }] } });
try {
  execFileSync('kubectl', ['--context', context, 'wait', '-n', namespace, '--for=condition=Ready', `pod/${helperName}`, '--timeout=180s'], { timeout: 190000 });
  const existingHash = execFileSync('kubectl', ['--context', context, 'exec', '-n', namespace, helperName, '--', '/bin/sh', '-c', 'test ! -f /models/model.gguf || sha256sum /models/model.gguf'], { encoding: 'utf8' });
  if (!existingHash.startsWith(modelHash)) {
  const copy = spawn('kubectl', ['--context', context, 'exec', '-i', '-n', namespace, helperName, '--', '/bin/sh', '-c', 'cat > /models/model.gguf && chmod 444 /models/model.gguf'], { stdio: ['pipe', 'inherit', 'inherit'] });
  const exited = new Promise<void>((resolve, reject) => { copy.on('error', reject); copy.on('close', code => code === 0 ? resolve() : reject(new Error(`copy exit ${code}`))); });
  await pipeline(createReadStream(file), copy.stdin); await exited;
  }
  const hash = execFileSync('kubectl', ['--context', context, 'exec', '-n', namespace, helperName, '--', 'sha256sum', '/models/model.gguf'], { encoding: 'utf8' }); assert.equal(hash.split(' ')[0], modelHash);
  record('pvc-file-upload-and-sha256-verified');
} finally { execFileSync('kubectl', ['--context', context, 'delete', 'pod', helperName, '-n', namespace, '--wait=false'], { stdio: 'ignore' }); }
const secret = randomBytes(24).toString('hex'); const salt = randomBytes(16).toString('hex');
const config = readConfig({ ...process.env, NODE_ENV: 'development', APP_MODE: 'live', DEPLOYMENT_PROVIDER: 'kubernetes', KUBE_CONTEXT: context, KUBE_NAMESPACES: namespace, KUBE_INSTANCE_ID: 'launchpad-local', PUBLIC_ORIGIN: 'http://localhost:3200', DATABASE_PATH: './data/orbstack.sqlite', CATALOG_PATH: './config/nonexistent-orbstack-catalog.json', ADMIN_PASSWORD_HASH: `scrypt$${salt}$${scryptSync(secret, salt, 64).toString('hex')}`, IMAGE_ALLOWED_PREFIXES: 'ghcr.io/ggml-org/', PORT: '3200' });
const instance = await buildApp(config, { background: false });
let headers: Record<string, string> = { origin: config.PUBLIC_ORIGIN, 'content-type': 'application/json' };
const call = async (url: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', expect?: number) => {
  const response = await instance.app.inject({ method: method as any, url: `/api${url}`, headers, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
  if (expect) assert.equal(response.statusCode, expect, response.body); else assert.ok(response.statusCode < 300, `${url}: ${response.statusCode} ${response.body}`);
  return response.json();
};
try {
  const login = await instance.app.inject({ method: 'POST', url: '/api/login', headers, payload: { username: 'admin', password: secret } }); assert.equal(login.statusCode, 200);
  headers.cookie = String(login.headers['set-cookie']).split(';')[0]; headers['x-csrf-token'] = (await call('/bootstrap')).csrfToken;
  assert.equal((await call('/connection')).available, true); record('platform-auth-and-live-kubernetes-connection');
  await call('/models', { id: modelId, name: 'SmolLM2 135M · OrbStack 验收', modelKey: modelId, servedModelName: 'smollm2', description: '真实 CPU 推理验收，GGUF Q4_K_M。', family: 'SmolLM2' });
  const img = await call('/runtime-images', { engineId: 'custom', version: runId, imageRef: image, architecture: 'arm64', cuda: 'CPU', notes: 'llama.cpp 官方 CPU server；真实镜像清单校验。' });
  const verified = await call(`/runtime-images/${img.id}/validate`, {}); assert.equal(verified.status, 'available'); record('real-oci-manifest-arm64-verification', verified.validation);
  const weight = await call('/assets/pvc-weights', { modelId, revision: 'q4-k-m', targetId: `kubernetes:${namespace}`, requestId: randomUUID(), bindings: [{ role: 'main', claimName: 'smollm-weights', subPath: '', contentRevision: `sha256:${modelHash}` }] }); record('platform-pvc-registration');
  const input = { ...defaultRuntime(modelId, 'custom'), name: `SmolLM2 ${runId}`, version: '1', engineId: 'custom', imageId: img.id, mode: 'argv', command: ['/app/llama-server'], args: ['--model', '{{MODEL_PATH}}/model.gguf', '--host', '0.0.0.0', '--port', '{{PORT}}', '--alias', '{{SERVED_MODEL_NAME}}', '--ctx-size', '512', '--threads', '2', '--n-gpu-layers', '0'], healthPath: '/health', livenessPath: '/health', port: 8000, startupTimeoutSeconds: 120, cpuCores: 0.5, memoryGB: 0.5, gpuCount: 0, gpuMemoryGB: 0, sharedMemoryGB: 0, mounts: [{ role: 'main', mountPath: '/models/main', envName: 'MODEL_PATH' }] };
  const profile = await call('/runtime-profiles', input); const published = await call(`/runtime-profiles/${profile.id}/publish`, { revision: profile.revision }); assert.equal(published.status, 'published');
  const preview = await call('/runtime-previews', { profileId: profile.id, weightVersionId: weight.id, name: `smollm-${runId}` }); record('server-side-admission-dry-run');
  const deployed = await call('/services', { previewId: preview.id, requestId: randomUUID() }); await instance.manager.drain();
  const id = deployed.serviceId;
  const wait = async (predicate: (s: any) => boolean, timeout = 180000, serviceId = id) => { const deadline = Date.now() + timeout; let detail: any; do { await instance.manager.refresh(serviceId, 'admin'); detail = await call(`/services/${serviceId}`); if (predicate(detail.service)) return detail; await pause(); } while (Date.now() < deadline); throw new Error(`wait timed out: ${JSON.stringify(detail)}`); };
  let detail = await wait(s => s.status === 'running' && s.routeReady); record('real-deployment-ready', { uid: instance.store.get(id)?.uid, endpoint: detail.service.endpoint });
  const completion = async () => { const address = detail.service.endpoint.address; const deadline = Date.now() + 60000; let reachable = false; while (Date.now() < deadline) { try { reachable = (await fetch(`${address}/health`, { signal: AbortSignal.timeout(5000) })).ok; } catch {} if (reachable) break; await pause(); } assert.ok(reachable, 'inference health unreachable from Mac'); const response = await fetch(`${address}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'smollm2', messages: [{ role: 'user', content: 'Say hello in one sentence.' }], max_tokens: 24, temperature: 0 }), signal: AbortSignal.timeout(45000) }); assert.ok(response.ok, await response.clone().text()); const result: any = await response.json(); assert.ok(result.choices?.[0]?.message?.content?.length); assert.ok(result.usage.completion_tokens > 0); return result; };
  record('actual-model-chat-completion', await completion());
  assert.equal((await call(`/models/${modelId}/removal`)).canDelete, false); await call(`/models/${modelId}`, { confirmation: modelId }, 'DELETE', 409); record('model-delete-blocked-by-service');
  const action = async (action: string, serviceId = id) => { for (let n = 0; n < 6; n++) { await instance.manager.refresh(serviceId, 'admin'); const d = await call(`/services/${serviceId}`); const r = await instance.app.inject({ method: 'POST', url: `/api/services/${serviceId}/actions`, headers, payload: { action, requestId: randomUUID(), revision: d.service.revision } }); if (r.statusCode === 409) { await pause(); continue; } assert.equal(r.statusCode, 202, r.body); await instance.manager.drain(); return; } throw new Error(`action conflict: ${action}`); };
  const configure = async (replicas: number) => { for (let n = 0; n < 6; n++) { await instance.manager.refresh(id, 'admin'); const d = await call(`/services/${id}`); const r = await instance.app.inject({ method: 'POST', url: `/api/services/${id}/config/preview`, headers, payload: { revision: d.service.revision, config: { replicas } } }); if (r.statusCode === 409) { await pause(); continue; } assert.equal(r.statusCode, 200, r.body); await call(`/services/${id}/config`, { previewId: r.json().id, requestId: randomUUID() }); await instance.manager.drain(); return; } throw new Error('configuration kept conflicting'); };
  await configure(2); detail = await wait(s => s.status === 'running' && s.readyReplicas === 2); record('scale-to-two-real-pods');
  const oldPods = kubectl(['get', 'pods', '-n', namespace, '-l', `launchpad.platform/service=${detail.service.name}`, '-o', 'json']).items.map((p: any) => p.metadata.uid);
  await action('restart'); detail = await wait(s => s.status === 'running' && s.readyReplicas === 2); const newPods = kubectl(['get', 'pods', '-n', namespace, '-l', `launchpad.platform/service=${detail.service.name}`, '-o', 'json']).items.filter((p: any) => !p.metadata.deletionTimestamp).map((p: any) => p.metadata.uid); assert.ok(newPods.some((uid: string) => !oldPods.includes(uid))); record('restart-replaced-real-pod-uid');
  await action('offline'); await wait(s => s.status === 'stopped' && s.readyReplicas === 0); record('offline-scaled-to-zero');
  await action('online'); detail = await wait(s => s.status === 'running' && s.readyReplicas === 2); record('online-restored-two-replicas-and-chat-completion', await completion());
  const bad = await call('/runtime-profiles', { ...input, version: 'bad', command: ['/bin/sh'], args: ['-c', 'echo expected-smoke-failure; exit 7'] });
  await call(`/runtime-profiles/${bad.id}/publish`, { revision: bad.revision });
  const badPreview = await call('/runtime-previews', { profileId: bad.id, weightVersionId: weight.id, name: `bad-${runId}` });
  const failed = await call('/services', { previewId: badPreview.id, requestId: randomUUID() }); await instance.manager.drain();
  const badDetail = await wait(s => s.status === 'failed', 60000, failed.serviceId); assert.ok(badDetail.service.diagnostics.conditions.some((c: any) => c.type === 'PodError')); record('real-failed-command-detected');
  const logs = await call(`/services/${failed.serviceId}/logs`); assert.ok(logs.items.some((l: any) => l.text.includes('expected-smoke-failure'))); record('real-container-logs-read');
  await action('delete', failed.serviceId); const badDeadline = Date.now() + 60000; while (instance.store.get(failed.serviceId) && Date.now() < badDeadline) { await instance.manager.refresh(failed.serviceId, 'admin'); await pause(); } assert.ok(!instance.store.get(failed.serviceId)); record('failed-deployment-deleted');
  await action('delete'); const deadline = Date.now() + 60000; while (instance.store.get(id) && Date.now() < deadline) { await instance.manager.refresh(id, 'admin'); await pause(); } assert.equal(instance.store.get(id), undefined);
  const remaining = kubectl(['get', 'deployments,services,pods', '-n', namespace, '-l', `launchpad.platform/service=smollm-${runId}`, '-o', 'json']); assert.equal(remaining.items.length, 0); record('deployment-service-pods-deleted');
  await call(`/runtime-profiles/${profile.id}`, { confirmation: profile.id }, 'DELETE');
  await call(`/runtime-profiles/${bad.id}`, { confirmation: bad.id }, 'DELETE');
  await call(`/assets/weights/${weight.id}`, { confirmation: weight.id }, 'DELETE');
  await call(`/runtime-images/${img.id}`, { confirmation: img.id }, 'DELETE');
  record('independent-profile-weight-and-image-deletion');
  await call(`/models/${modelId}`, { confirmation: modelId }, 'DELETE'); assert.ok(!(await call('/models')).items.some((m: any) => m.id === modelId)); assert.ok(!instance.runtimes.list().some(p => p.modelId === modelId)); assert.ok(!instance.assets.list().some(w => w.modelId === modelId)); record('catalog-delete-and-dependent-local-records-archived');
  assert.ok(kubectl(['get', 'pvc', 'smollm-weights', '-n', namespace, '-o', 'json']).metadata.uid); record('pvc-preserved-after-model-delete');
  evidence.passed = true;
} catch (error) { evidence.passed = false; evidence.error = error instanceof Error ? error.message : String(error); throw error; }
finally { await instance.app.close(); mkdirSync('artifacts', { recursive: true }); evidence.finishedAt = new Date().toISOString(); writeFileSync('artifacts/orbstack-acceptance.json', JSON.stringify(evidence, null, 2)); if (evidence.passed) console.log('PVC retained in launchpad-test for repeated acceptance; application services are deleted.'); }
