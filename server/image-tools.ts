import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import type { Config } from './config.js';
import { AppError, cleanMessage } from './errors.js';
import type { ImageValidation } from '../shared/types.js';

export function imageReference(value: string) {
  if (!value || value.length > 1024 || /[\s?#%\\\x00-\x1f]/.test(value) || value.includes('://')) throw new AppError(400, 'invalid_image_reference', '镜像地址不能包含协议、凭据、查询参数或空白。');
  const parts = value.split('@');
  if (parts.length > 2 || (parts[1] !== undefined && !/^sha256:[a-f0-9]{64}$/.test(parts[1]))) throw new AppError(400, 'invalid_image_digest', '镜像摘要必须为 sha256: 加 64 位小写十六进制。');
  let name = parts[0]; let tag = '';
  const colon = name.lastIndexOf(':'); if (colon > name.lastIndexOf('/')) { tag = name.slice(colon + 1); name = name.slice(0, colon); if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) throw new AppError(400, 'invalid_image_tag', '镜像 tag 格式不正确。'); }
  if (parts[1] && tag) throw new AppError(400, 'invalid_image_reference', '请使用 tag 或 digest，不要同时填写。');
  const segments = name.split('/'); const first = segments[0];
  const qualified = segments.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost');
  const host = qualified ? segments.shift()! : 'docker.io';
  if (!/^[a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?$/.test(host)) throw new AppError(400, 'invalid_registry_host', '仓库域名格式不正确。');
  if (segments.length === 1 && !qualified) segments.unshift('library');
  if (!segments.length || segments.some(p => !/^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/.test(p))) throw new AppError(400, 'invalid_image_repository', '仓库路径仅支持合法的小写镜像仓库名称。');
  const repository = `${host === 'index.docker.io' ? 'docker.io' : host}/${segments.join('/')}`;
  return { repository, host, tag, digest: parts[1] ?? '', reference: `${repository}${parts[1] ? `@${parts[1]}` : `:${tag || 'latest'}`}` };
}
export function allowImage(reference: string, prefixes: string) {
  const repository = imageReference(reference).repository;
  const allowed = prefixes.split(',').map(p => p.trim().replace(/\/+$/, '')).filter(Boolean);
  if (!allowed.some(prefix => repository === prefix || repository.startsWith(prefix + '/'))) throw new AppError(403, 'image_repository_forbidden', '该镜像仓库不在管理员允许的范围内，请配置对应的镜像来源或导入目标前缀。');
}
export interface ImageTools {
  inspect(reference: string, architecture: 'amd64' | 'arm64'): Promise<ImageValidation>;
  copy(source: string, destination: string, architecture: 'amd64' | 'arm64'): Promise<void>;
  shutdown?(): void;
}
export class SkopeoTools implements ImageTools {
  private children = new Set<ChildProcess>();
  constructor(private config: Config) {}
  private run(args: string[], timeout: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.SKOPEO_PATH, args, { shell: false, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir(), LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
      this.children.add(child);
      const output: Buffer[] = []; let size = 0; let stderr = ''; let problem: AppError | undefined;
      const timer = setTimeout(() => { problem = new AppError(504, 'image_tool_timeout', '镜像操作超时；复制结果需先核对，不能直接重复提交。'); child.kill('SIGKILL'); }, timeout); timer.unref();
      child.stdout.on('data', (data: Buffer) => { size += data.length; if (size > 8 * 1024 * 1024) { problem = new AppError(502, 'image_metadata_too_large', '镜像清单过大，已停止读取。'); child.kill('SIGKILL'); } else output.push(data); });
      child.stderr.on('data', (data: Buffer) => { if (stderr.length < 8192) stderr += data.toString(); });
      child.once('error', () => { clearTimeout(timer); this.children.delete(child); reject(new AppError(503, 'image_tool_unavailable', '镜像工具不可用。请在平台服务器安装 skopeo；生产镜像已包含此依赖。')); });
      child.once('close', code => { clearTimeout(timer); this.children.delete(child); if (problem) reject(problem); else if (code !== 0) reject(new AppError(422, 'image_registry_check_failed', cleanMessage(`镜像仓库操作失败：${stderr.slice(-1600) || '请核对镜像存在性、仓库权限与证书。'}`, [this.config.IO_MANAGEMENT_TOKEN, this.config.REGISTRY_TOKEN]))); else resolve(Buffer.concat(output)); });
    });
  }
  private auth() { return this.config.REGISTRY_AUTH_FILE ? ['--authfile', this.config.REGISTRY_AUTH_FILE] : ['--no-creds']; }
  shutdown() { for (const child of this.children) child.kill('SIGKILL'); }
  async inspect(reference: string, architecture: 'amd64' | 'arm64'): Promise<ImageValidation> {
    const parsed = imageReference(reference);
    const global = ['--override-os', 'linux', '--override-arch', architecture];
    const raw = await this.run([...global, 'inspect', '--raw', '--tls-verify=true', ...this.auth(), `docker://${parsed.reference}`], this.config.IMAGE_INSPECT_TIMEOUT_MS);
    const digest = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
    if (parsed.digest && parsed.digest !== digest) throw new AppError(422, 'image_digest_mismatch', '仓库返回的镜像清单与请求摘要不一致。');
    let manifest: { manifests?: { digest: string; platform?: { os?: string; architecture?: string } }[] };
    try { manifest = JSON.parse(raw.toString()); } catch { throw new AppError(502, 'invalid_image_manifest', '仓库没有返回可解析的 OCI/Docker 镜像清单。'); }
    let platformDigest = digest;
    if (Array.isArray(manifest.manifests)) {
      const platform = manifest.manifests.find(m => m.platform?.os === 'linux' && m.platform.architecture === architecture);
      if (!platform || !/^sha256:[a-f0-9]{64}$/.test(platform.digest)) throw new AppError(422, 'image_architecture_mismatch', `镜像清单不包含 linux/${architecture}。`);
      platformDigest = platform.digest;
    }
    const configRaw = await this.run([...global, 'inspect', '--config', '--tls-verify=true', ...this.auth(), `docker://${parsed.repository}@${platformDigest}`], this.config.IMAGE_INSPECT_TIMEOUT_MS);
    let config: { os?: string; architecture?: string; config?: { Entrypoint?: unknown; Cmd?: unknown } };
    try { config = JSON.parse(configRaw.toString()); } catch { throw new AppError(502, 'invalid_image_config', '无法读取镜像配置。'); }
    if (config.os !== 'linux' || config.architecture !== architecture) throw new AppError(422, 'image_architecture_mismatch', `镜像实际架构为 ${config.os ?? '?'}/${config.architecture ?? '?'}，与 linux/${architecture} 不符。`);
    const strings = (value: unknown) => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').slice(0, 128) : [];
    return { digest, platformDigest, architecture, os: 'linux', checkedAt: new Date().toISOString(), entrypoint: strings(config.config?.Entrypoint), cmd: strings(config.config?.Cmd) };
  }
  async copy(source: string, destination: string, architecture: 'amd64' | 'arm64') {
    const auth = this.config.REGISTRY_AUTH_FILE ? ['--authfile', this.config.REGISTRY_AUTH_FILE] : ['--src-no-creds', '--dest-no-creds'];
    await this.run(['--override-os', 'linux', '--override-arch', architecture, 'copy', '--preserve-digests', '--src-tls-verify=true', '--dest-tls-verify=true', ...auth, `docker://${imageReference(source).reference}`, `docker://${imageReference(destination).reference}`], this.config.IMAGE_COPY_TIMEOUT_MS);
  }
}
