import { spawn } from 'node:child_process';
import type { Config } from './config.js';
import type { JsonObject, RuntimeProfileDetail, WeightVersion } from '../shared/types.js';
import { asObject } from './catalog.js';
import { AppError, cleanMessage } from './errors.js';

const ownerLabel = 'launchpad.platform/instance';
const specAnnotation = 'launchpad.platform/spec';
const object = asObject;
const arr = (v: unknown) => Array.isArray(v) ? v.map(object) : [];
export class Kubernetes {
  constructor(private config: Config) {}
  namespaces() { return this.config.KUBE_NAMESPACES.split(',').map(n => n.trim()).filter(Boolean); }
  authorize(namespace: string) { if (!this.namespaces().includes(namespace)) throw new AppError(403, 'target_forbidden', '命名空间不在平台授权范围内。'); }
  async run(args: string[], input?: unknown): Promise<JsonObject> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.KUBECTL_PATH, ['--context', this.config.KUBE_CONTEXT, '--request-timeout=30s', ...args], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks: Buffer[] = []; const errors: Buffer[] = []; let size = 0; let ended = false;
      const finish = (error?: Error, result?: JsonObject) => { if (ended) return; ended = true; clearTimeout(timer); error ? reject(error) : resolve(result ?? {}); };
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new AppError(503, 'kubernetes_timeout', 'Kubernetes 请求超时；写入结果需刷新核对。')); }, 45000);
      for (const [stream, target] of [[child.stdout, chunks], [child.stderr, errors]] as const) stream.on('data', (data: Buffer) => { size += data.length; if (size > 4 * 1024 * 1024) { child.kill('SIGKILL'); finish(new AppError(502, 'kubernetes_response_large', 'Kubernetes 返回内容过大。')); } else target.push(data); });
      child.on('error', () => finish(new AppError(503, 'kubectl_unavailable', '无法运行 kubectl，请检查服务端安装与权限。')));
      child.on('close', code => {
        const message = cleanMessage(Buffer.concat(errors).toString(), [this.config.IO_MANAGEMENT_TOKEN, this.config.REGISTRY_TOKEN]).slice(0, 1500);
        if (code !== 0) return finish(new AppError(/NotFound|not found/.test(message) ? 404 : /Conflict|modified|AlreadyExists/.test(message) ? 409 : /Forbidden|Unauthorized/.test(message) ? 403 : /Invalid|BadRequest|invalid/.test(message) ? 422 : 503, 'kubernetes_error', message || 'Kubernetes 请求失败。'));
        try { const text = Buffer.concat(chunks).toString(); if (args[0] === 'get' && args[1] === '--raw' && args[2]?.includes('/log?')) finish(undefined, { text: cleanMessage(text, [this.config.IO_MANAGEMENT_TOKEN, this.config.REGISTRY_TOKEN], 32768) }); else finish(undefined, text.trim() ? object(JSON.parse(text)) : {}); }
        catch { if (args[0] === 'get' && args[1] === '--raw' && args[2]?.includes('/log?')) finish(undefined, { text: cleanMessage(Buffer.concat(chunks).toString(), [this.config.IO_MANAGEMENT_TOKEN, this.config.REGISTRY_TOKEN], 32768) }); else finish(new AppError(502, 'kubernetes_response_invalid', 'Kubernetes 返回内容无法解析。')); }
      });
      child.stdin.on('error', () => {}); child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
    });
  }
  async connection() {
    const checks = [];
    for (const namespace of this.namespaces()) {
      await this.run(['get', 'namespace', namespace, '-o', 'json']);
      // A server-side dry run validates RBAC/admission without creating resources.
      const name = 'launchpad-connection-check';
      await this.run(['create', '--dry-run=server', '-f', '-', '-o', 'json'], { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace }, spec: { replicas: 0, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { containers: [{ name: 'runtime', image: 'registry.k8s.io/pause:3.10' }] } } } });
      checks.push({ kind: 'kubernetes', baseUrl: `${this.config.KUBE_CONTEXT} / ${namespace}`, configured: true, available: true, targetCount: 1, message: '集群连通，Deployment 创建预检通过。' });
    }
    return { available: true, message: 'Kubernetes 已连通。', checks };
  }
  async claim(namespace: string, name: string, uid?: string) {
    this.authorize(namespace);
    const claim = await this.run(['get', 'pvc', name, '-n', namespace, '-o', 'json']);
    if (object(claim.status).phase !== 'Bound' || object(claim.metadata).deletionTimestamp || (uid && object(claim.metadata).uid !== uid)) throw new AppError(409, 'pvc_not_ready', 'PVC 未绑定、已被替换或正在删除。');
    return claim;
  }
  async resolve(runtime: RuntimeProfileDetail, weight: WeightVersion): Promise<JsonObject> {
    const p = runtime.profile;
    if (!weight.pvcBindings?.length) throw new AppError(422, 'pvc_required', '原生 Kubernetes 使用已登记的 PVC 权重。OSS 导入请使用 Registry / IO 后端。');
    const nodes = await this.run(['get', 'nodes', '-o', 'json']);
    const architecture = runtime.image.validation?.architecture;
    if (!architecture || !arr(nodes.items).some(n => object(object(n.metadata).labels)['kubernetes.io/arch'] === architecture && arr(object(n.status).conditions).some(c => c.type === 'Ready' && c.status === 'True'))) throw new AppError(422, 'architecture_unavailable', '集群没有与已验证镜像架构匹配的就绪节点。');
    for (const binding of weight.pvcBindings) await this.claim(weight.target.namespace, binding.claimName, binding.uid);
    const component = object((runtime.registryRequest.components as JsonObject[])[0]);
    const environment = p.mounts.map(m => ({ name: m.envName, value: m.mountPath }));
    const requests = { cpu: String(p.cpuCores), memory: `${p.memoryGB}Gi`, ...(p.gpuCount ? { [p.gpuResourceName]: String(p.gpuCount) } : {}) };
    return { backend: { type: 'NativeDeployment' }, modelRef: { name: weight.modelKey, version: weight.revision }, runtime: { image: runtime.image.imageRef, ...(component.startup_script ? { command: [component.startup_interpreter, '-c'], args: [component.startup_script] } : component.command ? { command: component.command, args: component.args } : {}), env: environment, resources: { requests, limits: requests }, ports: [{ name: 'http', containerPort: p.port }] },
      kubernetes: { architecture, port: p.port, healthPath: p.healthPath, livenessPath: p.livenessPath, startupTimeoutSeconds: p.startupTimeoutSeconds, sharedMemoryGB: p.sharedMemoryGB, pvcBindings: weight.pvcBindings, mounts: p.mounts }, rollout: { replicas: 1 }, capacity: { maxConcurrentRequestsPerPod: p.maxConcurrency } };
  }
  manifests(namespace: string, name: string, spec: JsonObject) {
    this.authorize(namespace);
    const k = object(spec.kubernetes); const labels = { 'app.kubernetes.io/managed-by': 'launchpad', [ownerLabel]: this.config.KUBE_INSTANCE_ID, 'launchpad.platform/service': name };
    const bindings = arr(k.pvcBindings); const mounts = arr(k.mounts);
    const probe = (path: unknown) => ({ httpGet: { path, port: Number(k.port) }, timeoutSeconds: 3, periodSeconds: 5, failureThreshold: 6 });
    const container = { name: 'runtime', ...object(spec.runtime), imagePullPolicy: 'IfNotPresent', volumeMounts: mounts.map((m, i) => { const b = bindings.find(b => b.role === m.role); if (!b) throw new AppError(422, 'weight_role_mismatch', 'PVC 权重角色不匹配。'); return { name: `weights-${i}`, mountPath: m.mountPath, readOnly: true, ...(b.subPath ? { subPath: b.subPath } : {}) }; }), readinessProbe: probe(k.healthPath), livenessProbe: probe(k.livenessPath), startupProbe: { ...probe(k.healthPath), failureThreshold: Math.ceil(Number(k.startupTimeoutSeconds) / 5) } };
    const volumes: JsonObject[] = mounts.map((m, i) => ({ name: `weights-${i}`, persistentVolumeClaim: { claimName: bindings.find(b => b.role === m.role)!.claimName, readOnly: true } }));
    if (Number(k.sharedMemoryGB) > 0) { volumes.push({ name: 'shm', emptyDir: { medium: 'Memory', sizeLimit: `${k.sharedMemoryGB}Gi` } }); container.volumeMounts.push({ name: 'shm', mountPath: '/dev/shm', readOnly: false }); }
    const deployment = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace, labels, annotations: { [specAnnotation]: JSON.stringify(spec) } }, spec: { replicas: object(spec.rollout).replicas ?? 1, revisionHistoryLimit: 2, selector: { matchLabels: labels }, template: { metadata: { labels, annotations: { 'launchpad.platform/restart': String(object(spec.rollout).restartNonce ?? '') } }, spec: { automountServiceAccountToken: false, imagePullSecrets: this.config.KUBE_IMAGE_PULL_SECRETS.split(',').map(name => name.trim()).filter(Boolean).map(name => ({ name })), nodeSelector: { 'kubernetes.io/arch': k.architecture }, containers: [container], volumes, terminationGracePeriodSeconds: 30 } } } };
    const service = { apiVersion: 'v1', kind: 'Service', metadata: { name, namespace, labels }, spec: { selector: labels, ports: [{ name: 'http', port: k.port, targetPort: k.port }], type: 'ClusterIP' } };
    return { deployment, service };
  }
  own(resource: JsonObject) { if (object(object(resource.metadata).labels)[ownerLabel] !== this.config.KUBE_INSTANCE_ID) throw new AppError(409, 'resource_not_owned', '同名资源不属于此平台实例，拒绝修改。'); }
  async deployment(namespace: string, name: string) { const d = await this.run(['get', 'deployment', name, '-n', namespace, '-o', 'json']); this.own(d); return d; }
  async preview(namespace: string, name: string, spec: JsonObject, headers?: Record<string, string>) {
    const { deployment, service } = this.manifests(namespace, name, spec);
    if (headers) { const before = await this.deployment(namespace, name); this.cas(before, headers); deployment.metadata = { ...deployment.metadata, ...object(before.metadata), annotations: { ...object(object(before.metadata).annotations), ...deployment.metadata.annotations } }; await this.run(['replace', '--dry-run=server', '-f', '-', '-o', 'json'], deployment); }
    else {
      await this.run(['create', '--dry-run=server', '-f', '-', '-o', 'json'], deployment);
      await this.run(['create', '--dry-run=server', '-f', '-', '-o', 'json'], service);
    }
    return { valid: true, kubernetes_preview: { deployment, service } };
  }
  cas(before: JsonObject, headers?: Record<string, string>) { const m = object(before.metadata); if (!headers || m.uid !== headers['X-Expected-UID'] || m.resourceVersion !== headers['X-Expected-Resource-Version']) throw new AppError(409, 'workload_changed', '集群资源已变化，请刷新后重新操作。'); }
  async observed(namespace: string, name: string, existing?: JsonObject): Promise<JsonObject> {
    const d = existing ?? await this.deployment(namespace, name); const m = object(d.metadata); const ds = object(d.spec); const status = object(d.status);
    const spec = JSON.parse(String(object(m.annotations)[specAnnotation])) as JsonObject;
    const podSpec = object(object(ds.template).spec); const container = arr(podSpec.containers).find(c => c.name === 'runtime')!;
    spec.runtime = { ...object(spec.runtime), image: container.image, command: container.command, args: container.args, env: container.env, resources: container.resources, ports: container.ports };
    spec.rollout = { ...object(spec.rollout), replicas: ds.replicas ?? 1 };
    const pods = await this.run(['get', 'pods', '-n', namespace, '-l', `launchpad.platform/service=${name},${ownerLabel}=${this.config.KUBE_INSTANCE_ID}`, '-o', 'json']);
    const conditions = arr(status.conditions).map(c => ({ type: c.type, status: c.status, reason: c.reason ?? '', message: c.message ?? '' }));
    let failed = false;
    for (const pod of arr(pods.items)) for (const c of arr(object(pod.status).conditions)) if (c.status === 'False' && c.type === 'PodScheduled') conditions.push({ type: 'PodScheduled', status: 'False', reason: String(c.reason ?? ''), message: cleanMessage(String(c.message ?? '')) });
    for (const pod of arr(pods.items)) for (const cs of [...arr(object(pod.status).initContainerStatuses), ...arr(object(pod.status).containerStatuses)]) {
      const state = object(cs.state); const waiting = object(state.waiting); const terminated = object(state.terminated);
      if (['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError', 'RunContainerError'].includes(String(waiting.reason)) || Number(terminated.exitCode) > 0) { failed = true; conditions.push({ type: 'PodError', status: 'True', reason: String(waiting.reason ?? terminated.reason), message: cleanMessage(String(waiting.message ?? terminated.message ?? cs.name)) }); }
    }
    const desired = Number(ds.replicas ?? 1); const ready = Number(status.readyReplicas ?? 0);
    const converged = Number(status.observedGeneration ?? 0) >= Number(m.generation);
    const phase = failed ? 'Failed' : converged && desired === 0 && Number(status.replicas ?? 0) === 0 ? 'Stopped' : converged && ready === desired && Number(status.updatedReplicas ?? 0) === desired && desired > 0 ? 'Running' : 'Starting';
    let exposure: JsonObject = { phase: 'Pending' };
    try { const svc = await this.run(['get', 'service', name, '-n', namespace, '-o', 'json']); this.own(svc); const slices = await this.run(['get', 'endpointslices', '-n', namespace, '-l', `kubernetes.io/service-name=${name}`, '-o', 'json']); const hasReadyEndpoint = arr(slices.items).some(slice => arr(slice.endpoints).some(endpoint => object(endpoint.conditions).ready === true && Array.isArray(endpoint.addresses) && endpoint.addresses.length > 0)); if (phase === 'Running' && hasReadyEndpoint && object(svc.spec).clusterIP) exposure = { phase: 'Ready', gatewayAddresses: [object(svc.spec).clusterIP], gatewayPort: object(spec.kubernetes).port, hostname: `${name}.${namespace}.svc.cluster.local` }; }
    catch (error) { if (!(error instanceof AppError && error.statusCode === 404)) throw error; }
    return { live: true, stale: false, creationRequestId: object(m.annotations)['launchpad.platform/request-id'], kubernetes: { uid: m.uid, resource_version: m.resourceVersion, generation: m.generation, spec, status: { phase, readyReplicas: ready, observedGeneration: status.observedGeneration ?? 0, internalExposure: exposure, conditions, ...(failed ? { message: conditions.find(c => c.type === 'PodError')?.message } : {}) } } };
  }
  async logs(namespace: string, name: string) {
    this.authorize(namespace); await this.deployment(namespace, name);
    const pods = await this.run(['get', 'pods', '-n', namespace, '-l', `launchpad.platform/service=${name},${ownerLabel}=${this.config.KUBE_INSTANCE_ID}`, '-o', 'json']);
    const items = [];
    for (const pod of arr(pods.items).slice(0, 8)) {
      const podName = String(object(pod.metadata).name);
      const raw = await this.run(['get', '--raw', `/api/v1/namespaces/${namespace}/pods/${podName}/log?container=runtime&tailLines=100&limitBytes=32768`]).catch(() => undefined);
      items.push({ pod: podName, text: raw?.text ?? '日志暂不可用（容器可能尚未启动）' });
    }
    return { items };
  }
  async request(path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<JsonObject> {
    if (path === '/management/v1/deployment-targets') return { targets: [{ cluster_id: 1, namespaces: this.namespaces() }] };
    const match = path.match(/^\/management\/v1\/clusters\/1\/namespaces\/([^/]+)\/inference-services(?:\/([^/]+))?(.*)$/);
    if (!match) throw new AppError(422, 'unsupported_native_route', '原生 Kubernetes 不支持此控制面操作。');
    const namespace = decodeURIComponent(match[1]); this.authorize(namespace);
    const body = object(options.body); let name = match[2] ? decodeURIComponent(match[2]) : String(body.name ?? ''); const suffix = match[3]; const method = options.method ?? 'GET';
    if (name === 'preview') return this.preview(namespace, String(body.name), object(body.spec));
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name)) throw new AppError(400, 'invalid_name', '服务名称无效。');
    if (!match[2] && method === 'POST') {
      const spec = object(body.spec);
      for (const b of arr(object(spec.kubernetes).pvcBindings)) await this.claim(namespace, String(b.claimName), String(b.uid));
      const { deployment, service } = this.manifests(namespace, name, spec);
      deployment.metadata.annotations = { ...deployment.metadata.annotations, 'launchpad.platform/request-id': String(body.request_id) } as typeof deployment.metadata.annotations;
      const d = await this.run(['create', '-f', '-', '-o', 'json'], deployment);
      const ownedService = { ...service, metadata: { ...service.metadata, ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name, uid: object(d.metadata).uid, controller: true, blockOwnerDeletion: false }] } };
      try { await this.run(['create', '-f', '-', '-o', 'json'], ownedService); }
      catch { throw new AppError(503, 'partial_creation', 'Deployment 已创建，但 Service 创建未确认，请刷新核对并排查同名 Service。'); }
      return this.observed(namespace, name, d);
    }
    if (method === 'GET') return this.observed(namespace, name);
    const before = await this.deployment(namespace, name); this.cas(before, options.headers);
    if (suffix === '/spec/preview') return this.preview(namespace, name, object(body.spec), options.headers);
    if (method === 'DELETE') {
      const svc = await this.run(['get', 'service', name, '-n', namespace, '-o', 'json']).catch(e => { if (e instanceof AppError && e.statusCode === 404) return undefined; throw e; });
      if (svc) { this.own(svc); await this.run(['delete', '--raw', `/api/v1/namespaces/${namespace}/services/${name}`, '-f', '-'], { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: object(svc.metadata).uid, resourceVersion: object(svc.metadata).resourceVersion } }); }
      await this.run(['delete', '--raw', `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`, '-f', '-'], { apiVersion: 'v1', kind: 'DeleteOptions', propagationPolicy: 'Foreground', preconditions: { uid: object(before.metadata).uid, resourceVersion: object(before.metadata).resourceVersion } });
      return {};
    }
    let spec = JSON.parse(String(object(object(before.metadata).annotations)[specAnnotation])) as JsonObject;
    if (suffix === '/spec' && method === 'PUT') spec = object(body.spec);
    else { const action = suffix.split('/').at(-1); spec.rollout = { ...object(spec.rollout), ...(action === 'restart' ? { restartNonce: body.restart_nonce } : { replicas: action === 'offline' ? 0 : Number(body.replicas ?? 1) }) }; }
    const { deployment } = this.manifests(namespace, name, spec);
    deployment.metadata = { ...deployment.metadata, ...object(before.metadata), annotations: { ...object(object(before.metadata).annotations), ...deployment.metadata.annotations } };
    const d = await this.run(['replace', '-f', '-', '-o', 'json'], deployment);
    return this.observed(namespace, name, d);
  }
}
