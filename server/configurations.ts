import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import type { RuntimeImage, RuntimeProfile } from '../shared/types.js';
import { AppError } from './errors.js';
export type ConfigurationKind = 'image' | 'runtime' | 'weight';
/** Archive platform metadata only. External jobs and data have independent lifecycles. */
export class Configurations {
  constructor(private store: Store) {}
  removal(kind: ConfigurationKind, id: string) {
    const entry = kind === 'weight' ? this.store.weight(id) : this.store.asset<RuntimeImage | RuntimeProfile>(kind, id);
    if (!entry || this.store.asset(`archived:${kind}`, id)) throw new AppError(404, 'not_found', '配置不存在或已删除。');
    const blockers: string[] = [];
    const services = this.store.list();
    if (kind === 'runtime') for (const s of services.filter(s => s.deployment?.profileId === id || s.variantId === id)) blockers.push(`服务 ${s.name} 正在引用此运行配置`);
    if (kind === 'weight') for (const s of services.filter(s => s.weightSource?.versionId === id)) blockers.push(`服务 ${s.name} 正在引用此权重版本`);
    if (kind === 'image') {
      for (const p of this.store.assets<RuntimeProfile>('runtime').filter(p => p.imageId === id)) blockers.push(`运行配置 ${p.name} / ${p.version} 正在引用此镜像`);
    }
    const name = kind === 'runtime' ? `${(entry as RuntimeProfile).name} / ${(entry as RuntimeProfile).version}` : kind === 'image' ? `${(entry as RuntimeImage).engineId} / ${(entry as RuntimeImage).version}` : 'revision' in entry ? String(entry.revision) : id;
    return { id, kind, name, canDelete: !blockers.length, blockers, backgroundWork: ['importing', 'verifying', 'submitting', 'building', 'copying', 'publishing', 'unknown'].includes(String(entry.status)) };
  }
  delete(kind: ConfigurationKind, id: string, confirmation: string, actor: string) {
    return this.store.transaction(() => {
      const check = this.removal(kind, id);
      if (confirmation !== id) throw new AppError(400, 'confirmation_mismatch', '删除确认已失效，请重新确认。');
      if (!check.canDelete) throw new AppError(409, 'configuration_in_use', check.blockers.join('；'));
      this.store.saveAsset(`archived:${kind}`, id, { id, actor, deletedAt: new Date().toISOString(), eventId: randomUUID() });
      // Keep the original records available to in-flight reconcilers and historical audit.
      const field = kind === 'runtime' ? '$.service.deployment.profileId' : kind === 'weight' ? '$.service.weightSource.versionId' : undefined;
      if (kind === 'image') { const image = this.store.asset<RuntimeImage>('image', id)!; if (image.imageRef) { this.store.db.prepare("DELETE FROM previews WHERE json_extract(data,'$.service.spec.runtime.image')=?").run(image.imageRef); this.store.db.prepare("DELETE FROM config_previews WHERE json_extract(data,'$.spec.runtime.image')=?").run(image.imageRef); } }
      if (field) this.store.db.prepare('DELETE FROM previews WHERE json_extract(data,?)=?').run(field, id);
      return { deleted: true, ...check };
    });
  }
}
