import type { CatalogModel } from './catalog.js';
import type { RuntimeProfile } from '../shared/types.js';
import { Store } from './store.js';
import { AppError } from './errors.js';

export class Models {
  constructor(private store: Store, private catalog: () => CatalogModel[]) {}
  removal(id: string) {
    const model = this.catalog().find(m => m.id === id);
    if (!model) throw new AppError(404, 'not_found', '模型不存在或已删除。');
    const services = this.store.list().filter(s => s.modelId === id);
    const weights = this.store.weights().filter(w => w.modelId === id);
    const profiles = this.store.assets<RuntimeProfile>('runtime').filter(p => p.modelId === id);
    const blockers = [...services.map(s => `服务 ${s.name} 尚未删除`), ...weights.filter(w => ['importing', 'unknown'].includes(w.status)).map(w => `权重 ${w.revision} 仍在准备或结果未知`), ...profiles.filter(p => ['publishing', 'unknown'].includes(p.status)).map(p => `运行配置 ${p.name} 正在发布或结果未知`)];
    return { modelId: id, name: model.name, canDelete: !blockers.length, blockers, weightCount: weights.length, profileCount: profiles.length };
  }
  delete(id: string, confirmation: string, actor: string) {
    return this.store.transaction(() => {
      const check = this.removal(id);
      if (confirmation !== id) throw new AppError(400, 'confirmation_mismatch', '请输入模型标识确认删除。');
      if (!check.canDelete) throw new AppError(409, 'model_in_use', check.blockers.join('；'));
      const profiles = this.store.assets<RuntimeProfile>('runtime').filter(p => p.modelId === id);
      const weights = this.store.weights().filter(w => w.modelId === id);
      this.store.saveAsset('deleted-model', id, { model: this.catalog().find(m => m.id === id), profiles, weights, actor, deletedAt: new Date().toISOString() });
      this.store.deleteAsset('model', id);
      for (const p of profiles) this.store.deleteAsset('runtime', p.id);
      for (const w of weights) this.store.db.prepare('DELETE FROM weight_versions WHERE id=?').run(w.id);
      this.store.db.prepare("DELETE FROM previews WHERE json_extract(data,'$.service.modelId')=?").run(id);
      return { deleted: true, ...check };
    });
  }
}
