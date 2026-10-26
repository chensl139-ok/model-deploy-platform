import { z } from 'zod';
import { resolve } from 'node:path';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_MODE: z.enum(['setup', 'demo', 'live']).default('setup'),
  DEPLOYMENT_PROVIDER: z.enum(['registry-io', 'kubernetes']).default('registry-io'),
  KUBE_CONTEXT: z.string().default(''),
  KUBE_NAMESPACES: z.string().default(''),
  KUBE_INSTANCE_ID: z.string().regex(/^[a-z0-9-]{1,63}$/).default('launchpad'),
  KUBE_IMAGE_PULL_SECRETS: z.string().default(''),
  KUBECTL_PATH: z.string().default('kubectl'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3200),
  ADDITIONAL_ORIGINS: z.string().default(''),
  PUBLIC_ORIGIN: z.url().default('http://localhost:5173'),
  DATABASE_PATH: z.string().optional(),
  CATALOG_PATH: z.string().default('./config/catalog.json'),
  IO_BASE_URL: z.string().default(''),
  IO_MANAGEMENT_TOKEN: z.string().default(''),
  REGISTRY_BASE_URL: z.string().default(''),
  REGISTRY_TOKEN: z.string().default(''),
  OSS_ALLOWED_PREFIXES: z.string().default(''),
  IMAGE_ALLOWED_PREFIXES: z.string().default('docker.io/vllm/,docker.io/lmsysorg/,docker.io/hongccc/,matrix-registry-vpc.cn-shanghai.cr.aliyuncs.com/inference/,matrix-registry-vpc.cn-shanghai.cr.aliyuncs.com/matrix/tob-inference'),
  IMAGE_IMPORT_PREFIXES: z.string().default(''),
  IMAGE_SOURCE_HOSTS: z.string().default('github.com,git.sotatts.online'),
  SKOPEO_PATH: z.string().default('skopeo'),
  REGISTRY_AUTH_FILE: z.string().default(''),
  IMAGE_INSPECT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(45000),
  IMAGE_COPY_TIMEOUT_MS: z.coerce.number().int().min(1000).max(14400000).default(3600000),
  ADMIN_USERNAME: z.string().min(1).max(80).default('admin'),
  ADMIN_PASSWORD_HASH: z.string().default(''),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(45000),
  SYNC_INTERVAL_MS: z.coerce.number().int().min(1000).default(10000),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
});

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const v = schema.parse(env);
  for (const key of ['IO_BASE_URL', 'REGISTRY_BASE_URL'] as const) {
    if (v[key]) {
      const url = new URL(v[key]);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error(`${key} 必须是无凭据、无查询参数的 HTTP(S) 地址`);
      }
    }
  }
  const additionalOrigins = v.ADDITIONAL_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
  for (const value of additionalOrigins) { const u = new URL(value); if (u.origin !== value || u.username || u.password || (u.protocol !== 'https:' && !(['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && u.protocol === 'http:'))) throw new Error('ADDITIONAL_ORIGINS 只允许 HTTPS 来源或本机回环 HTTP 来源'); }
  const authRequired = v.APP_MODE === 'live' || v.NODE_ENV === 'production' || Boolean(v.ADMIN_PASSWORD_HASH);
  if (authRequired && !/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(v.ADMIN_PASSWORD_HASH)) {
    throw new Error('真实环境或生产环境必须配置 ADMIN_PASSWORD_HASH，请运行 npm run password');
  }
  if (v.NODE_ENV === 'production' && new URL(v.PUBLIC_ORIGIN).protocol !== 'https:') {
    throw new Error('生产环境 PUBLIC_ORIGIN 必须使用 HTTPS');
  }
  if (!authRequired && !['127.0.0.1', '::1', 'localhost'].includes(v.HOST)) {
    throw new Error('无登录的本地演示仅允许绑定回环地址');
  }
  if (v.APP_MODE === 'live' && v.DEPLOYMENT_PROVIDER === 'registry-io' && (!v.IO_BASE_URL || !v.IO_MANAGEMENT_TOKEN)) {
    throw new Error('真实模式必须配置 IO_BASE_URL 和 IO_MANAGEMENT_TOKEN');
  }
  if (v.DEPLOYMENT_PROVIDER === 'kubernetes' && (v.APP_MODE !== 'live' || !v.KUBE_CONTEXT || !v.KUBE_NAMESPACES || !v.KUBE_NAMESPACES.split(',').every(n => /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(n.trim())))) throw new Error('原生 Kubernetes 必须使用 live 模式并显式配置 KUBE_CONTEXT、KUBE_NAMESPACES');
  if (v.KUBE_IMAGE_PULL_SECRETS && !v.KUBE_IMAGE_PULL_SECRETS.split(',').every(n => /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(n.trim()))) throw new Error('KUBE_IMAGE_PULL_SECRETS 必须是逗号分隔的 Secret 名称');
  return {
    ...v, authRequired, allowedOrigins: [new URL(v.PUBLIC_ORIGIN).origin, ...additionalOrigins],
    DATABASE_PATH: resolve(v.DATABASE_PATH ?? (v.APP_MODE === 'demo' ? './data/launchpad.sqlite' : './data/launchpad-live.sqlite')), CATALOG_PATH: resolve(v.CATALOG_PATH),
    IO_BASE_URL: v.IO_BASE_URL.replace(/\/$/, ''), REGISTRY_BASE_URL: v.REGISTRY_BASE_URL.replace(/\/$/, ''),
  };
}
export type Config = ReturnType<typeof readConfig>;
