import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, scryptSync } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from '../server/store.js';
import { Images, directImageSchema, imageBuildSchema, imageImportSchema } from '../server/images.js';
import { imageReference, allowImage, type ImageTools } from '../server/image-tools.js';
import { readConfig } from '../server/config.js';
import { compileRuntime } from '../server/runtimes.js';
import { defaultRuntime } from '../shared/engines.js';
import type { ImageBuildInput, ImageImportInput, ImageValidation, RuntimeImageInput } from '../shared/types.js';
import { buildApp } from '../server/app.js';
const a = `sha256:${'a'.repeat(64)}`; const b = `sha256:${'b'.repeat(64)}`; const c = `sha256:${'c'.repeat(64)}`;
const metadata = { engineId: 'vllm', version: 'v1', architecture: 'amd64' as const, cuda: 'declared only', notes: '' };
const direct = (): RuntimeImageInput => ({ ...metadata, imageRef: `registry.example.com/inference/vllm@${a}` });
const imported = (): ImageImportInput => ({ ...metadata, sourceRef: 'docker.io/vllm/vllm-openai:stable', destinationRepository: 'registry.example.com/inference/vllm', requestId: randomUUID() });
const built = (): ImageBuildInput => ({ ...metadata, repository: 'https://github.com/example/engine.git', commit: 'f'.repeat(40), contextDir: '.', dockerfile: 'docker/Dockerfile', buildTarget: 'runtime', targetIds: ['gpu-target'], requestId: randomUUID() });
const validation = (digest = a, arch = 'amd64', platformDigest = digest): ImageValidation => ({ digest, platformDigest, architecture: arch, os: 'linux', checkedAt: new Date().toISOString(), entrypoint: ['vllm', 'serve'], cmd: [] });
async function fixture() {
  const store = new Store(':memory:');
  const state = { inspections: [] as string[], copies: [] as { source: string; destination: string }[], inspectFail: false, copyFail: false, wrongDestination: false, wrongArch: false, builds: 0, buildBody: {} as any, buildStatus: 'queued', missingArtifact: false, failSubmit: false, missingRecord: false };
  const tools: ImageTools = {
    inspect: async (ref, arch) => { state.inspections.push(ref); if (state.inspectFail) throw new Error('private registry access denied token=[REDACTED_SECRET]'); if (ref.startsWith('docker.io/')) return validation(a, state.wrongArch ? 'arm64' : arch, b); if (ref.includes('launchpad-') || ref.endsWith(`@${b}`)) return validation(state.wrongDestination ? c : b, arch); return validation(a, state.wrongArch ? 'arm64' : arch); },
    copy: async (source, destination) => { state.copies.push({ source, destination }); if (state.copyFail) throw new Error('copy response lost'); },
  };
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const send = (code: number, body: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/v1/deployment-targets') return send(200, { targets: [{ target_id: 'gpu-target' }] });
    if (req.method === 'POST' && req.url === '/internal/v1/component-builds') { state.builds++; state.buildBody = JSON.parse(text); if (state.failSubmit) return send(503, { error: 'request response lost token=[REDACTED_SECRET]' }); return send(202, state.missingRecord ? {} : { record_id: 'build-record-1' }); }
    if (req.url === '/internal/v1/image-builds/build-record-1') return send(200, { status: state.buildStatus, ...(state.buildStatus === 'succeeded' && !state.missingArtifact ? { image_artifact_id: 'built-artifact-id' } : {}), message: 'CI state' });
    send(404, { error: 'not found' });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; const salt = '1'.repeat(32);
  const config = readConfig({ NODE_ENV: 'test', APP_MODE: 'live', ADMIN_PASSWORD_HASH: `scrypt$${salt}$${scryptSync('strong-fixture-password', salt, 64).toString('hex')}`, IO_BASE_URL: base, IO_MANAGEMENT_TOKEN: 'fixture-io-token', REGISTRY_BASE_URL: base, REGISTRY_TOKEN: 'test-secret', IMAGE_ALLOWED_PREFIXES: 'docker.io/vllm/,registry.example.com/inference/', IMAGE_IMPORT_PREFIXES: 'registry.example.com/inference/' });
  const images = new Images(config, store, tools);
  return { state, config, store, tools, images, close: async () => { await images.drain(); store.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('image references normalize Docker Hub names and reject credentials, transports and path tricks', () => {
  assert.equal(imageReference('vllm/vllm-openai:v1').reference, 'docker.io/vllm/vllm-openai:v1');
  assert.equal(imageReference('alpine').reference, 'docker.io/library/alpine:latest');
  for (const ref of ['https://host/image', 'docker://host/image', 'user:pass@host/image', 'host/image?token=a', 'host/../image', 'host/image%2ftest', 'host/Image:tag', 'registry.example.com/repo@sha256:bad', 'registry.example.com/repo:v1@' + a, 'registry.example.com/repo\n']) assert.throws(() => imageReference(ref));
  assert.throws(() => allowImage('registry.example.com/inference-evil/image:tag', 'registry.example.com/inference/'));
  assert.throws(() => allowImage('registry.example.com.evil.test/inference/image:tag', 'registry.example.com/inference/'));
});

test('direct registration stays unverified until actual digest and Linux architecture checks succeed', async t => {
  const p = await fixture(); t.after(p.close); const draft = p.images.register(direct());
  assert.equal(draft.status, 'unverified'); assert.equal(p.state.inspections.length, 0);
  const result = await p.images.validate(draft.id); assert.equal(result.status, 'available'); assert.equal(result.validation?.digest, a); assert.equal(result.validation?.os, 'linux');
  assert.equal(p.images.register(direct()).id, draft.id);
  assert.throws(() => p.images.register({ ...direct(), imageRef: `registry.example.com/inference/vllm@${b}` }));
});

test('failed validation is visible, secrets are redacted and a retry can recover without inventing availability', async t => {
  const p = await fixture(); t.after(p.close); const image = p.images.register(direct()); p.state.inspectFail = true;
  await assert.rejects(p.images.validate(image.id)); assert.equal(p.images.get(image.id).status, 'failed'); assert.ok(!p.images.get(image.id).message?.includes('test-secret'));
  p.state.inspectFail = false; p.state.wrongArch = true; await assert.rejects(p.images.validate(image.id), /不一致/); assert.equal(p.images.get(image.id).status, 'failed');
  p.state.wrongArch = false; assert.equal((await p.images.validate(image.id)).status, 'available');
});

test('registry import pins the source platform, writes a new tag and verifies the copied destination digest', async t => {
  const p = await fixture(); t.after(p.close); const input = imported(); const image = p.images.import(input, 'operator');
  await p.images.drain(); const result = p.images.get(image.id);
  assert.equal(p.state.copies.length, 1); assert.equal(p.state.copies[0].source, `docker.io/vllm/vllm-openai@${b}`);
  assert.match(p.state.copies[0].destination, /^registry\.example\.com\/inference\/vllm:launchpad-/);
  assert.equal(result.status, 'available'); assert.equal(result.imageRef, `registry.example.com/inference/vllm@${b}`); assert.equal(result.source, 'import');
  assert.equal(p.images.import(input, 'operator').id, image.id); await p.images.drain(); assert.equal(p.state.copies.length, 1);
});

test('unknown import is reconciled from the original destination without copying again', async t => {
  const p = await fixture(); t.after(p.close); p.state.copyFail = true; const input = imported(); const image = p.images.import(input, 'operator'); await p.images.drain();
  assert.equal(p.images.get(image.id).status, 'unknown'); p.images.import(input, 'operator'); await p.images.drain(); assert.equal(p.state.copies.length, 1);
  assert.equal((await p.images.refresh(image.id, 'operator')).status, 'available'); assert.equal(p.state.copies.length, 1);
});

test('import cannot claim success on a mismatching target and refuses unapproved repositories before any copy', async t => {
  const p = await fixture(); t.after(p.close); const input = imported();
  assert.throws(() => p.images.import({ ...input, destinationRepository: 'other.example.com/repo' }, 'operator'));
  assert.throws(() => p.images.import({ ...input, sourceRef: '127.0.0.1/private:latest' }, 'operator'));
  assert.equal(p.state.copies.length, 0); p.state.wrongDestination = true;
  const image = p.images.import(input, 'operator'); await p.images.drain(); assert.notEqual(p.images.get(image.id).status, 'available');
  assert.notEqual((await p.images.refresh(image.id, 'operator')).status, 'available');
});

test('source builds submit the exact component-build contract and return artifact IDs only after success', async t => {
  const p = await fixture(); t.after(p.close); const input = built(); const image = await p.images.build(input, 'operator'); await p.images.drain();
  assert.equal(p.state.builds, 1); assert.deepEqual(p.state.buildBody, { idempotency_key: input.requestId, component_build: { role: 'engine', repository: input.repository, commit: input.commit, context_dir: '.', dockerfile: 'docker/Dockerfile', target: 'runtime' }, target_ids: ['gpu-target'] });
  assert.equal(p.images.get(image.id).status, 'building'); assert.equal(p.images.get(image.id).artifactId, undefined);
  await p.images.build(input, 'operator'); assert.equal(p.state.builds, 1);
  p.state.buildStatus = 'succeeded'; const result = await p.images.refresh(image.id, 'operator'); assert.equal(result.status, 'available'); assert.equal(result.artifactId, 'built-artifact-id'); assert.equal(result.imageRef, ''); assert.equal(result.validation, undefined);
  const model = { id: 'model', name: 'Model', version: 'v1', family: 'test', initials: 'M', color: 'blue' as const, description: '', framework: 'vLLM', variants: [] };
  const runtime = compileRuntime({ ...defaultRuntime('model'), id: randomUUID(), name: 'from-build', revision: randomUUID(), packageName: 'from-build', status: 'draft', message: '', createdAt: '', updatedAt: '' }, result, model);
  const component = (runtime.registryRequest.components as any[])[0]; assert.equal(component.image_artifact_id, 'built-artifact-id'); assert.equal(component.image_ref, undefined);
});

test('lost build responses and missing success artifacts block availability and never resubmit writes', async t => {
  const p = await fixture(); t.after(p.close); p.state.failSubmit = true; const input = built(); const image = await p.images.build(input, 'operator'); await p.images.drain();
  assert.equal(p.images.get(image.id).status, 'unknown'); await p.images.build(input, 'operator'); await p.images.sync(); assert.equal(p.state.builds, 1); assert.ok(!p.images.get(image.id).message?.includes('test-secret'));
  p.state.failSubmit = false; const next = await p.images.build({ ...built(), version: 'v2' }, 'operator'); await p.images.drain(); p.state.buildStatus = 'succeeded'; p.state.missingArtifact = true;
  assert.equal((await p.images.refresh(next.id, 'operator')).status, 'unknown'); p.state.missingArtifact = false; assert.equal((await p.images.refresh(next.id, 'operator')).status, 'available');
});

test('build inputs reject moving revisions, credentials, path escapes and unauthorized GPU targets', async t => {
  const p = await fixture(); t.after(p.close);
  for (const change of [{ commit: 'main' }, { contextDir: '../outside' }, { dockerfile: '/etc/passwd' }]) assert.equal(imageBuildSchema.safeParse({ ...built(), ...change }).success, false);
  await assert.rejects(p.images.build({ ...built(), repository: 'https://user:password@github.com/example/engine.git' }, 'operator'));
  await assert.rejects(p.images.build({ ...built(), repository: 'https://evil.example.com/engine.git' }, 'operator'));
  await assert.rejects(p.images.build({ ...built(), targetIds: ['not-authorized'] }, 'operator'));
  assert.equal(p.state.builds, 0);
  assert.equal(imageImportSchema.safeParse({ ...imported(), destinationRepository: 'registry.example.com/inference/image:overwrite' }).success, false);
  assert.equal(directImageSchema.safeParse({ ...direct(), imageRef: 'registry.example.com/inference/image:latest' }).success, false);
});

test('interrupted image operations remain inspectable and are not replayed on restart', async t => {
  const p = await fixture(); t.after(p.close); const draft = p.images.register(direct());
  p.store.saveAsset('image', draft.id, { ...draft, status: 'copying', source: 'import' });
  const restarted = new Images(p.config, p.store, p.tools); assert.equal(restarted.get(draft.id).status, 'unknown'); await restarted.sync(); assert.equal(p.state.copies.length, 0);
});

test('live runtime publication cannot bypass image validation', async t => {
  const p = await fixture(); t.after(p.close);
  const app = await buildApp({ ...p.config, DATABASE_PATH: ':memory:', CATALOG_PATH: '/not-present' }, { store: new Store(':memory:'), background: false, imageTools: p.tools }); t.after(() => app.app.close());
  app.runtimes.registerModel({ id: 'model', name: 'Model', modelKey: 'model', servedModelName: 'model', family: '', description: '' });
  const image = app.images.register(direct()); const profile = app.runtimes.create({ ...defaultRuntime('model'), name: 'pending-image', imageId: image.id });
  await assert.rejects(app.runtimes.publish(profile.id, profile.revision, 'operator'), /镜像尚未完成/); assert.equal(app.runtimes.get(profile.id).status, 'draft');
});
