import type { EngineDefinition, RuntimeProfileInput } from './types.js';
export const ENGINES: EngineDefinition[] = [
  { id: 'vllm', name: 'vLLM', repository: 'vllm/vllm-openai', docs: 'https://docs.vllm.ai/en/stable/deployment/docker/', command: ['vllm', 'serve'], args: ['{{MODEL_PATH}}', '--host', '0.0.0.0', '--port', '{{PORT}}', '--served-model-name', '{{SERVED_MODEL_NAME}}'], note: '适用于该镜像版本支持的模型。张量并行、量化和上下文参数需按模型与 GPU 调整。' },
  { id: 'sglang', name: 'SGLang', repository: 'lmsysorg/sglang', docs: 'https://docs.sglang.ai/basic_usage/send_request.html', command: ['python3', '-m', 'sglang.launch_server'], args: ['--model-path', '{{MODEL_PATH}}', '--host', '0.0.0.0', '--port', '{{PORT}}', '--served-model-name', '{{SERVED_MODEL_NAME}}'], note: '启动参数随版本变化。请以所选镜像内的 --help 和支持模型列表为准。' },
  { id: 'vllm-omni', name: 'vLLM-Omni', repository: 'vllm/vllm-omni', docs: 'https://docs.vllm.ai/projects/vllm-omni/en/stable/getting_started/installation/gpu/', command: ['vllm', 'serve'], args: ['{{MODEL_PATH}}', '--omni', '--host', '0.0.0.0', '--port', '{{PORT}}', '--served-model-name', '{{SERVED_MODEL_NAME}}'], note: '独立于 vLLM 的镜像与版本。多阶段模型可能还需要 --deploy-config、额外权重和多 GPU。' },
  { id: 'sglang-omni', name: 'SGLang Omni', repository: 'hongccc/sglang-omni', docs: 'https://sgl-project.github.io/sglang-omni/get_started/apiserver_quickstart.html', command: ['sgl-omni', 'serve'], args: ['--model-path', '{{MODEL_PATH}}', '--host', '0.0.0.0', '--port', '{{PORT}}', '--model-name', '{{SERVED_MODEL_NAME}}'], note: '参考镜像可能只有开发 tag，并且需要额外安装包。请使用预装 sgl-omni 及模型依赖的内部镜像，按模型配置 pipeline。' },
  { id: 'custom', name: '自定义引擎', repository: '', docs: '', command: [], args: [], note: '填写镜像内真实存在的 entrypoint 与参数，或提供启动脚本。平台不在自身服务器执行这些命令。' },
];
export function defaultRuntime(modelId = '', engineId = 'vllm'): RuntimeProfileInput {
  const engine = ENGINES.find(e => e.id === engineId) ?? ENGINES[0];
  return { name: '', version: 'v1', modelId, engineId: engine.id, imageId: '', mode: 'argv', command: [...engine.command], args: [...engine.args], script: '', port: 8000, healthPath: '/health', livenessPath: '/health', startupTimeoutSeconds: 1800, cpuCores: 4, memoryGB: 16, gpuResourceName: 'nvidia.com/gpu', gpuCount: 1, gpuMemoryGB: 0, sharedMemoryGB: 4, maxConcurrency: 4, mounts: [{ role: 'main', mountPath: '/models/main', envName: 'MODEL_PATH' }], env: {} };
}
export const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
