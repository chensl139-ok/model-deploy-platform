import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { JsonObject, Model, Variant } from '../shared/types.js';
import type { Config } from './config.js';

const variantSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/), label: z.string().min(1), memoryGB: z.number().positive(),
  description: z.string(), recommended: z.boolean().optional(),
  clusterId: z.number().int().positive(), namespace: z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/).max(63),
  targetId: z.string().optional(), runtimePackageId: z.string().optional(),
  spec: z.record(z.string(), z.unknown()).optional(),
}).refine(v => Boolean(v.runtimePackageId) !== Boolean(v.spec), '每种规格必须且只能配置 runtimePackageId 或 spec')
  .refine(v => !v.runtimePackageId || Boolean(v.targetId), 'Registry 模板必须配置 targetId');
const modelSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/), name: z.string().min(1), version: z.string().min(1),
  family: z.string(), description: z.string(), initials: z.string().min(1).max(3),
  color: z.enum(['violet', 'blue', 'amber', 'teal']), framework: z.string().min(1),
  modelKey: z.string().optional(), modelRevision: z.string().optional(),
  servedModelName: z.string().optional(),
  variants: z.array(variantSchema).min(1),
});
const catalogSchema = z.array(modelSchema).superRefine((models, ctx) => {
  if (new Set(models.map(m => m.id)).size !== models.length) ctx.addIssue({ code: 'custom', message: '模型 id 不可重复' });
  for (const model of models) {
    if (new Set(model.variants.map(v => v.id)).size !== model.variants.length) ctx.addIssue({ code: 'custom', message: `${model.id} 的规格 id 不可重复` });
    if (model.variants.filter(v => v.recommended).length > 1) ctx.addIssue({ code: 'custom', message: `${model.id} 仅允许一个推荐规格` });
  }
});
export type CatalogModel = z.infer<typeof modelSchema>;
export type CatalogVariant = z.infer<typeof variantSchema>;

export function demoCatalog(): CatalogModel[] {
  return [
    { id: 'qwen3-8b', name: 'Qwen3-8B', version: 'v1', family: 'Qwen', description: '轻量通用模型，适合快速验证与日常对话。', initials: 'Q', color: 'violet', framework: 'vLLM',
      variants: [{ id: '24gb', label: '四分之一卡 · 24GB', memoryGB: 24, description: '单实例 · RTX PRO 6000', recommended: true, clusterId: 70001, namespace: 'inference-tob', spec: {} },
        { id: '48gb', label: '半卡 · 48GB', memoryGB: 48, description: '更充裕的上下文空间', clusterId: 70001, namespace: 'inference-tob', spec: {} }] },
    { id: 'deepseek-r1-14b', name: 'DeepSeek-R1-Distill-14B', version: 'v1', family: 'DeepSeek', description: '专注推理与代码，适合复杂问题探索。', initials: 'D', color: 'blue', framework: 'vLLM',
      variants: [{ id: '48gb', label: '半卡 · 48GB', memoryGB: 48, description: '单实例 · RTX PRO 6000', recommended: true, clusterId: 70001, namespace: 'inference-tob', spec: {} }] },
    { id: 'qwen3-32b', name: 'Qwen3-32B', version: 'v1', family: 'Qwen', description: '更强的综合能力，适合深度任务与应用验证。', initials: 'Q', color: 'amber', framework: 'SGLang',
      variants: [{ id: '96gb', label: '整卡 · 96GB', memoryGB: 96, description: '单实例 · RTX PRO 6000', recommended: true, clusterId: 70001, namespace: 'inference-tob', spec: {} }] },
  ];
}

export function loadCatalog(config: Config): CatalogModel[] {
  if (config.APP_MODE === 'demo') return demoCatalog();
  if (!existsSync(config.CATALOG_PATH)) return [];
  return catalogSchema.parse(JSON.parse(readFileSync(config.CATALOG_PATH, 'utf8')));
}
export function publicModels(catalog: CatalogModel[]): Model[] {
  return catalog.map(({ modelKey, modelRevision, servedModelName, variants, ...model }) => ({
    ...model,
    modelKey: modelKey ?? model.id, servedModelName: servedModelName ?? modelKey ?? model.id,
    variants: variants.map(({ id, label, memoryGB, description, recommended, runtimePackageId, spec }): Variant => ({ id, label, memoryGB, description, recommended, supportsWeightVersions: Boolean(runtimePackageId) || (spec && !Object.keys(spec).length) })),
  }));
}
export function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}
