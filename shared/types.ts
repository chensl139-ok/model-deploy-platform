export type ServiceStatus = 'preparing' | 'starting' | 'running' | 'stopped' | 'failed' | 'unknown';
export type Action = 'online' | 'offline' | 'restart' | 'delete';
export type OperationKind = 'create' | Action | 'configure';
export type JsonObject = Record<string, unknown>;

export interface Variant {
  id: string;
  label: string;
  memoryGB: number;
  description: string;
  recommended?: boolean;
  supportsWeightVersions?: boolean;
}
export interface Model {
  id: string;
  name: string;
  version: string;
  family: string;
  description: string;
  initials: string;
  color: string;
  framework: string;
  modelKey?: string;
  servedModelName?: string;
  variants: Variant[];
}
export interface Service {
  id: string;
  name: string;
  modelId: string;
  modelName: string;
  modelVersion: string;
  invocationModel: string;
  framework: string;
  variantId: string;
  gpuLabel: string;
  gpuMemoryGB: number;
  clusterId: number;
  namespace: string;
  status: ServiceStatus;
  message: string;
  live: boolean;
  stale: boolean;
  staleReason?: string;
  routeReady: boolean;
  endpoint?: { address: string; hostname?: string };
  readyReplicas: number | null;
  desiredReplicas: number;
  resumeReplicas?: number;
  createdAt: string;
  updatedAt: string;
  observedAt?: string;
  busy: boolean;
  observability: { label: string; url: string }[];
  revision: string;
  diagnostics?: Diagnostics;
  weightSource?: { revision: string; sources: WeightSource[]; versionId?: string };
  deployment?: { profileId: string; profileName: string; engineId: string; imageRef: string; command: string; healthPath: string; livenessPath: string; startupTimeoutSeconds: number; registryPackageId: string };
}
export interface Diagnostics {
  phase: string;
  generation?: number;
  observedGeneration?: number;
  routePhase: string;
  conditions: { type: string; status: string; reason: string; message: string }[];
}
export interface RuntimeConfig {
  replicas: number;
  image: string;
  cpuCores: number | null;
  memoryGB: number | null;
  maxConcurrency: number | null;
  editable: boolean;
  reason?: string;
}
export interface ConfigInput {
  replicas: number;
  image?: string;
  cpuCores?: number;
  memoryGB?: number;
  maxConcurrency?: number;
}
export interface ConfigPreview {
  id: string;
  expiresAt: string;
  changes: { field: string; before: string; after: string }[];
  warnings: string[];
}
export interface Activity {
  id: string;
  serviceId: string;
  kind: OperationKind;
  status: 'pending' | 'succeeded' | 'failed' | 'unknown';
  message: string;
  actor: string;
  createdAt: string;
  updatedAt: string;
  changes?: ConfigPreview['changes'];
}
export interface AuditActivity extends Activity { serviceName: string; modelName: string; deleted: boolean }
export interface ServiceDetail { service: Service; activities: Activity[]; runtime: RuntimeConfig }
export interface Bootstrap {
  provider?: 'registry-io' | 'kubernetes';
  mode: 'setup' | 'demo' | 'live';
  authenticated: boolean;
  authRequired: boolean;
  csrfToken?: string;
  user: string;
  models: Model[];
  connection: { configured: boolean; message: string };
}
export interface WeightSource { role: string; sourceUri: string; contentRevision: string }
export interface WeightTarget { id: string; label: string; clusterId: number; namespace: string; gpuType: string }
export interface WeightVersion {
  pvcBindings?: { role: string; claimName: string; uid: string; subPath: string }[];
  id: string;
  requestId: string;
  modelId: string;
  modelName: string;
  modelKey: string;
  revision: string;
  target: WeightTarget;
  sources: WeightSource[];
  status: 'importing' | 'available' | 'failed' | 'unknown';
  message: string;
  createdAt: string;
  updatedAt: string;
}
export interface ImportWeightsInput { modelId: string; revision: string; targetId: string; sources: WeightSource[]; requestId: string }
export interface CreateInput { modelId: string; variantId: string; name: string; weightVersionId?: string }
export interface Preview {
  id: string;
  expiresAt: string;
  name: string;
  modelName: string;
  modelVersion: string;
  gpuLabel: string;
  targetLabel: string;
  checks: { label: string; description: string }[];
}

export interface RegisteredModelInput { id: string; name: string; modelKey: string; servedModelName: string; description: string; family: string }
export interface EngineDefinition { id: string; name: string; repository: string; docs: string; command: string[]; args: string[]; note: string }
export interface RuntimeImageInput { engineId: string; version: string; imageRef: string; architecture: 'amd64' | 'arm64'; cuda: string; notes: string }
export interface RuntimeImage extends RuntimeImageInput {
  id: string; createdAt: string; updatedAt?: string;
  source?: 'direct' | 'import' | 'build';
  status?: 'unverified' | 'verifying' | 'submitting' | 'building' | 'copying' | 'available' | 'failed' | 'unknown';
  message?: string; requestId?: string; recordId?: string; artifactId?: string;
  sourceRef?: string; requestedSourceRef?: string; destinationRepository?: string; destinationTag?: string;
  repository?: string; commit?: string; contextDir?: string; dockerfile?: string; buildTarget?: string; targetIds?: string[];
  validation?: ImageValidation;
}
export interface ImageValidation { digest: string; platformDigest: string; architecture: string; os: string; checkedAt: string; entrypoint: string[]; cmd: string[] }
export interface ImageImportInput extends Omit<RuntimeImageInput, 'imageRef'> { sourceRef: string; destinationRepository: string; requestId: string }
export interface ImageBuildInput extends Omit<RuntimeImageInput, 'imageRef'> { repository: string; commit: string; contextDir: string; dockerfile: string; buildTarget?: string; targetIds: string[]; requestId: string }
export interface RuntimeProfileInput {
  name: string; version: string; modelId: string; engineId: string; imageId: string;
  mode: 'argv' | 'script' | 'image-default'; command: string[]; args: string[]; script: string;
  port: number; healthPath: string; livenessPath: string; startupTimeoutSeconds: number;
  cpuCores: number; memoryGB: number; gpuResourceName: string; gpuCount: number; gpuMemoryGB: number;
  sharedMemoryGB: number; maxConcurrency: number;
  mounts: { role: string; mountPath: string; envName: string }[]; env: Record<string, string>;
}
export interface RuntimeProfile extends RuntimeProfileInput {
  id: string; revision: string; packageName: string; packageId?: string;
  status: 'draft' | 'publishing' | 'published' | 'failed' | 'unknown';
  message: string; createdAt: string; updatedAt: string;
}
export interface RuntimeProfileDetail { profile: RuntimeProfile; image: RuntimeImage; command: string; registryRequest: JsonObject }
export interface RuntimeDeploymentInput { profileId: string; weightVersionId: string; name: string; replicas?: number }
export interface RuntimeDeploymentPreview extends Preview { command: string; image: string; warnings: string[]; spec: JsonObject; profileId: string }
