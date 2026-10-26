# 本机恢复部署 · 2026-10-26

平台已从 2026-10-22 的开发记录恢复至 1.5.0，本机地址为 http://localhost:3201。

已开启 Cloudflare 临时 HTTPS 公网入口，管理员登录保持启用。当前公网地址在 `data/review-url.txt`；桌面“推理部署平台-公网.webloc”及本目录“公网访问.webloc”会在隧道启动时更新。公网模式由同一个 LaunchAgent 管理，电脑开机联网且 OrbStack 运行时可用；重启后域名可能变化。`启动平台.command` / `停止平台.command` 同时启停平台和隧道。公网验证结果见 `artifacts/public-verification.json`。

- 打开：桌面的“推理部署平台.webloc”，或本目录的“打开平台.webloc”。
- 登录：admin；新密码保存在 `data/orbstack-login.txt`。
- 启停：双击 `启动平台.command` / `停止平台.command`。
- 后台服务：macOS LaunchAgent `cn.local.launchpad`，登录电脑时自动启动，进程退出自动重启。需要 OrbStack 运行才能管理模型。
- 后端：本机 OrbStack / `launchpad-test`，已恢复原有 SmolLM2 服务的模型、镜像、PVC 权重、运行配置及服务登记，2 个副本就绪。
- 当前验证：55 项自动测试通过，前后端构建通过，HTTP 登录/鉴权、集群连接、状态、日志及真实 CPU 模型调用通过。证据：`artifacts/recovery-verification.json`。
- 此次未恢复旧的操作历史或旧登录会话；数据库为重建登记。没有接入生产 GPU 集群或生产 Registry/IO 凭据。
- 私有配置：`.env.orbstack`；日志：`data/server.log` / `data/server-error.log`。
- 源码备份和数据库快照位于 `backups/`。源码备份不包含凭据、依赖及运行数据库。

以下为原项目开发说明，其中公网评审地址和历史验收描述为当时记录；当前使用上面的本机地址。

---

# Launchpad · 模型部署平台

一个适合自有服务器部署的模型控制台。登记自有模型、管理 OSS 权重、查询引擎镜像版本，配置启动命令与健康检查，通过 Registry / IO 或原生 Kubernetes 预检和部署。

采用 React 19、TypeScript、Ant Design 6、Vite、Fastify 5、SQLite WAL。无需妙搭、Sites、托管数据库或其他 SaaS 运行时。平台服务器不需要 GPU；模型实例运行在目标 Kubernetes 集群。

## 本地启动

环境：Node.js 22.12+、npm。首次安装原生 SQLite 依赖时，如果没有适配的预编译文件，需要 Python 3 与 C/C++ 编译工具。

```bash
cd /Users/chenshoulong/Desktop/model-deploy-platform
npm ci
npm run dev
```

打开 **http://localhost:5173**。请通过该地址使用，不要双击 `index.html`。macOS 也可双击 `start.command` 启动。

没有 `.env` 时默认为本地配置模式（`APP_MODE=setup`），只绑定回环地址。可以登记模型、镜像和配置草稿，不生成演示数据、不模拟部署成功；导入、发布、预检和部署需要先配置真实连接。默认数据库为 `data/launchpad-live.sqlite`，接入真实环境后保留这些草稿。不能将生产数据库反向切回无登录的配置模式。

只有显式设置 `APP_MODE=demo` 才进入演示模式，使用独立的 `data/launchpad.sqlite`，含三个演示模型与初始服务。演示不访问 OSS 或 GPU。以前版本的演示数据仍保留在原文件中，不自动迁移为真实资产。

开发前端端口为 5173，API 为 3200。写入来源默认只接受 `http://localhost:5173`，如果更换访问域名或端口，同时修改 `PUBLIC_ORIGIN`。不要使用 Vite 开发服务器对外提供生产服务。

本机构建后体验单端口版本：

```bash
npm run build
PUBLIC_ORIGIN=http://localhost:3200 npm start
```

无连接配置时仍为本地配置模式。访问 http://localhost:3200。

## 当前包含的产品能力

- 模型服务：状态筛选、搜索、排序、分页、CSV 导出、实例与资源汇总、自动刷新。
- 模型资产：登记模型、删除目录；保护服务及未完成任务的引用，归档本地配置，保留远端文件。支持 OSS 导入或原生 Kubernetes PVC 权重登记。
- 推理引擎：vLLM、SGLang、vLLM-Omni、SGLang Omni 与自定义引擎；参考命令可修改，附官方文档链接。
- 镜像版本库：支持源码构建、仓库导入和直接使用；按引擎查询版本与真实上游 tag，保存来源、任务记录、不可变摘要和校验证据。
- 运行配置：查询、搜索、编辑草稿与复制新版本；配置 entrypoint/args 或 Shell 脚本、权重角色/挂载/环境变量、端口、就绪/存活探针、启动宽限时间、CPU/内存/GPU/共享内存与容量。
- 部署流程：选择模型、已发布运行配置和已就绪权重，查看实际镜像、命令、资源与解析后的 Spec，预检通过后显式确认部署。原有文件模板保留为快捷兼容入口。
- 真实部署：可直接管理指定 Kubernetes 上下文和允许的命名空间，生成原生 Deployment / Service、探针、共享内存与只读 PVC 挂载；也可检查现有平台授权目标，解析 Registry `deployment-options` 或管理员提供的完整 IO Spec，调用创建 preview，再提交 create。
- 服务详情：控制面就绪阶段、服务入口、cURL/Python 示例、配置、权重来源、诊断和上游观测链接。
- 配置变更：调整副本、CPU、内存、并发或同仓库镜像摘要，预检后确认差异；保留原 GPU、挂载、环境变量与其他配置。
- 操作记录：跨服务搜索、按状态筛选、CSV 导出、请求标识与配置差异；删除服务后保留历史。
- 生命周期：多副本扩缩容、停止、恢复原副本数量启动、重启、删除；服务端保留操作状态与请求标识。
- 安全与可靠性：管理员登录、Scrypt 密码哈希、HttpOnly/SameSite Cookie、CSRF、请求限流、来源校验、参数白名单、UID/resourceVersion 并发保护、模糊结果保护、凭据脱敏。
- 独立交付：Dockerfile、Compose、Caddy HTTPS、持久化、在线一致性备份、人工核对工具和 CI。

列表只展示**通过本平台登记创建的服务**，不是集群全量管理视图。

## OrbStack 实测与本地运行

OrbStack 通过 `orb start k8s` 启动。所有测试和原生操作显式指定 `orbstack` 上下文，不使用当前默认上下文，不修改已有生产集群。测试资源位于 `launchpad-test`。

```bash
npm run test:orbstack
```

该脚本使用真实 Kubernetes、真实 Skopeo 清单验证、官方 llama.cpp ARM64 CPU 镜像与 SmolLM2-135M-Instruct Q4_K_M GGUF 权重。镜像固定 digest，权重固定仓库 commit 并核对发布的 SHA256；约下载 105 MB 权重。首次运行还需拉取镜像。CPU 验收不会模拟 vLLM/SGLang 的 GPU 推理。

脚本通过平台的登录和 API 完成模型/镜像/PVC 权重/运行配置登记、发布、服务端预检、部署、实际 chat completion、扩容双副本、Pod UID 重启验证、停止/启动、故障命令诊断、读取容器日志、服务删除和模型删除。最后核对 Deployment、Service、Pod 消失，PVC 仍保留。结果写入 `artifacts/orbstack-acceptance.json`，真实数据位于 `data/orbstack.sqlite`；未完成的失败运行保留记录，便于排查，不会自动重放未知写入。

本机控制台：

```bash
cp config/orbstack.env.example .env.orbstack
# npm run password，填入 .env.orbstack 的密码哈希
npm run build
npm run start:orbstack
```

打开 http://localhost:3201 登录。开发时可使用同一 API 的构建后页面；Vite 默认代理本地 API 3200，避免与其他本地服务的 3100 端口冲突。此配置使用真实集群，保留登录；本地 HTTP 仅绑定回环地址。生产仍使用 HTTPS。

原生后端是单集群、指定命名空间的普通 Deployment 管理。`KUBE_CONTEXT`、`KUBE_NAMESPACES`、`KUBE_INSTANCE_ID` 与数据库绑定，禁止将同一数据库静默切换到其他集群或后端。`KUBE_IMAGE_PULL_SECRETS` 可指定已存在于目标命名空间的私有仓库 Secret 名称，平台不保存仓库密码。平台服务器需能连接 Kubernetes API；原生 Service 返回集群内部地址，实际推理客户端需具备集群网络访问能力。OrbStack 可从 Mac 访问 ClusterIP。[OrbStack 官方文档](https://docs.orbstack.dev/kubernetes/)

原生权重登记检查 PVC 的 Bound 状态与 UID，支持多角色、只读挂载和 subPath；部署前复查 PVC 身份。PVC 内容 SHA256 是管理员提供的版本标识，平台不将“绑定成功”表述为已核验文件哈希。验收脚本另行在 PVC 内核对文件 SHA256，真实模型加载与推理验证内容可用。原生后端不自动从 OSS 下载权重；生产 OSS 自动准备和源码 CI 构建继续使用真实 Registry 服务。`deploy/kubernetes-rbac.example.yaml` 提供专用账号最小权限参考；容器镜像包含 kubectl 与 skopeo。不要把宿主机管理员 kubeconfig 或可执行认证插件直接当作生产平台身份；使用专用受限 kubeconfig，容器内证书引用需为实际可读路径。

## 模型删除

模型目录、权重版本、镜像版本、运行配置均有删除入口。模型删除要求输入模型标识确认。仍被服务（包括已停止服务）引用，或权重导入/运行包发布处于执行中、结果未知时，删除被阻止。删除成功后移除本地权重登记、运行配置和未使用的部署预检，并归档这些元数据；历史操作记录保留。OSS 对象、PVC、Registry 运行包和镜像均不删除。文件目录配置也通过持久化归档标记隐藏，重启不会重新出现。删除后的平台模型标识可重新登记，旧配置与删除历史继续归档。

## 配置删除与公网评审

镜像版本、权重版本和运行配置可单独删除。运行配置仍被服务引用、权重仍被服务引用、镜像仍被运行配置引用时，弹窗列出具体名称，解除引用后可删除。删除是本地元数据归档，远端镜像层、运行包、OSS 和 PVC 文件不回收。未关联服务的进行中/结果未知任务也可移除登记，弹窗说明外部任务可能继续运行；迟到的回调与同步结果不会使已删除配置重新出现在列表中。删除会使依赖该配置的未提交预检失效。操作历史继续保留。

公网评审保留管理员登录，账号可完整新增、修改、删除和扩缩容，只能操作 `.env.orbstack` 允许的 OrbStack 测试命名空间。当前本机私有登录信息保存在 `data/orbstack-login.txt`，不会打包进 Docker 镜像或 Git。已验证临时公网地址的 HTTPS、登录、Secure Cookie、来源/CSRF 检查、真实集群状态/日志，以及模型、镜像、已发布运行配置、权重版本的新增和独立删除。

重新启动临时评审入口：先停止正在占用 3201 的本机进程，再执行：

```bash
npm run build
npm run review
```

需要 `cloudflared`（macOS 可用 `brew install cloudflared`）。脚本取得临时 HTTPS 地址后启动生产模式应用，显式配置公网和本机来源；地址写入 `data/review-url.txt`，按 Ctrl+C 一起停止应用和隧道。临时域名每次启动会变化，电脑与隧道进程需要保持运行；正式长期部署使用自有服务器、固定域名与 HTTPS。[Cloudflare Quick Tunnels 文档](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

## 自有服务器部署

建议部署到可以访问 IO/Registry 的 Linux 服务器，安装 Docker Engine 和 Docker Compose v2。使用 amd64 或 arm64 与服务器一致的镜像；不强制跨架构模拟。平台为单实例服务，SQLite 数据卷必须在本地可靠磁盘上，不能多副本共享 SQLite 文件。

域名 DNS 指向服务器，允许 HTTPS 所需的 80/443 入站。Caddy 自动申请证书需要域名可被 ACME 验证；纯内网域名或已有公司证书时，改用公司现有 HTTPS 反向代理。应用容器不直接映射公网端口。

1. 将项目源代码和 lockfile 放到服务器，执行：

   ```bash
   cp .env.example .env
   cp config/catalog.example.json config/catalog.json
   ```

2. 在本地或服务器的 Node 环境执行 `npm run password`，输入至少 12 个字符的管理员密码。将生成的**整行** `ADMIN_PASSWORD_HASH='scrypt$…$…'` 放进 `.env`。保留单引号，防止 Docker Compose 对 `$` 插值。不要把密码明文放进配置。

3. 编辑 `.env`：填写 `DOMAIN`、与之对应的 `PUBLIC_ORIGIN=https://…`、IO 管理地址和 Token；使用 Registry 模板或 OSS 权重导入时填写 Registry 地址和 Token，并配置 `OSS_ALLOWED_PREFIXES`。`IO_BASE_URL` 不包含 `/management/v1`。选择的域名应与浏览器访问来源完全一致。

4. `config/catalog.json` 可设置为空数组 `[]`，或不提供此文件，在页面登记自有模型、镜像和运行配置即可。文件模板只用于兼容已有管理员配置；示例中的占位值不能直接部署。

5. 启动：

   ```bash
   docker compose config --quiet
   docker compose up -d --build
   docker compose ps
   docker compose logs --tail=100 app
   ```

6. 打开真实域名登录，检查「环境连接」。先部署一个小模型，分别核对实例就绪、入口可用及实际推理。预检通过、HTTP 200 和演示测试不能替代真实 GPU 验收。

若先在本机连接文档中的 QA，可使用 `config/qa.env.example` 替代生产示例。它预填了文档中的 Registry / IO 地址、OSS 前缀与目标说明，但不含任何凭据；执行 `npm run password` 并填写两个专用管理 Token 后再启动。2026-10-22 只读探测时，两个 QA 授权目标接口均返回 401（未携带 Token），说明 HTTP 接口可达，不能据此认定账号有权限或能部署模型。

`NODE_ENV=production` 强制密码和 HTTPS。Compose 使用非 root 应用用户、只读根文件系统、独立数据卷、健康检查、日志轮换与优雅退出。管理 Token 从不下发浏览器；Token 应只授权必要的 cluster/namespace。`.env`、运行数据、备份和私有模板均在 `.gitignore` 内。

现有 HTTPS 代理可以替换 Caddy：只启动 app，再通过你们内部网络代理到 3100；保持 `PUBLIC_ORIGIN`、受信代理与 HTTPS Cookie 配置一致，不开放无登录的演示模式。

## 通用模型部署流程（推荐）

1. 「模型资产 → 登记模型」：填写平台标识、Registry `model_key`、展示名和实际调用名称。模型身份无需预先写进代码。
2. 「模型资产 → 从 OSS 导入」：选择登记的模型、版本和目标，填写真实目录与内容指纹。等目标权重 `available` 后才可部署。
3. 「推理运行配置 → 镜像版本库 → 登记镜像版本」：选择源码构建、从仓库导入或直接使用。已有镜像默认执行真实清单验证；只有验证/构建/导入成功的版本可发布运行配置。可以显式保存草稿，但草稿不等于可部署镜像。
4. 「新建运行配置」：选择模型、引擎和镜像版本，填入参考命令后按实际镜像/模型修改参数。配置每个权重角色的只读挂载与环境变量、服务端口、探针和资源。TP/PP、量化、上下文长度、Omni pipeline 文件路径属于引擎参数，必须显式填写，不根据 GPU 数量自动猜测。
5. 保存草稿、检查完整请求，然后「发布运行配置」。后端调用 `POST /internal/v1/runtime-packages`，已有或导入镜像使用 `image_ref`，源码构建产物使用 `image_artifact_id`，二者互斥；确认返回 `package_id` 后才标为已发布。
6. 「选择权重部署」：平台按 `runtime_package_id/model_key/model_revision` 解析 `deployment-options`，精确匹配已准备权重所在 target/cluster/namespace。核对解析镜像与选定摘要一致，保留完整 Spec 的存储、调度、探针等字段，设置副本与容量后执行 IO preview。
7. 查看镜像、实际命令、目标、角色匹配与预检结果，确认部署。服务详情保留创建时的配置版本、运行包 ID、命令与探针，另行展示当前实时资源与镜像。

已发布配置不可覆盖，修改命令、探针或镜像时复制为新版本。草稿编辑使用版本条件防止互相覆盖。运行包发布的网络中断/5xx/缺少 package_id 会进入「结果待核对」，不会自动重发；可复制详情中的唯一 `package_name` 交由 Registry 管理员核对。

任意模型可登记，并不表示任意引擎天然支持它。镜像必须包含所需模型实现、插件、量化依赖及正确 CUDA / 驱动组合。尤其 SGLang Omni 的上游开发镜像可能还需安装对应包；平台不会将其直接当作已验证的生产镜像，也不会在模型启动时自动联网装依赖。

当前通用流程面向 **NativeDeployment，单 Pod 内单/多 GPU 与多进程 pipeline**。跨节点 LWS、PD 分离及多组件 Engine/Glue 拓扑尚未提供专用配置器。运行包中的探针路径与启动宽限可配置，具体探针间隔/阈值由目标 Registry 版本生成；不伪造其 schema。纯 CPU 部署可设 GPU 数量为 0。

### 镜像的三种来源

| 来源 | 平台实际执行的操作 | 就绪条件 |
| --- | --- | --- |
| 直接使用 | 登记已有 `仓库@sha256`，通过 Skopeo 只读检查真实 manifest 与 image config，不复制或启动镜像 | digest 一致，包含且实际符合选定 Linux 架构 |
| 从仓库导入 | 来源可填 tag；先锁定选定架构的 digest，再复制至目标仓库的新唯一 tag，并重新读取目标清单 | 复制完成，目标 digest 与来源平台 digest 一致 |
| 从源码构建 | 固定 HTTPS Git 仓库、40 位 commit、context、Dockerfile 和可选构建 stage，提交 Registry `component-builds` | CI `succeeded` 且返回有效 `image_artifact_id` |

源码构建由现有 Registry CI 执行，不在控制台服务器上运行不受隔离的 Dockerfile。请求使用 `component_build.role=engine`，私有 Git 凭据由 CI 提供。可选择已授权 GPU 目标以传递 `target_ids`；Dockerfile 自行使用 `BUILD_CUDA_ARCH_LIST`。CPU 架构字段是目标声明，CI/Dockerfile 必须实现对应产物，不能据此声称已独立检查其架构。平台轮询 `GET /internal/v1/image-builds/{record_id}`，构建成功才把镜像产物提供给运行配置；失败、未知状态或缺少产物 ID 均阻止使用。

构建、复制请求在网络操作前持久化请求标识。相同请求重放返回原记录，修改输入后复用相同标识会冲突。同一引擎版本与架构不允许换摘要或换来源。构建响应丢失且没有 `record_id` 时暂停并人工核对；已有记录 ID 可继续同步，不重复发起构建。复制失败/中断结果不明时进入「待核对」，同步按钮只读检查原目标 tag 与已锁定来源，绝不自动再复制一次。

直接使用记录的状态为「待验证 → 验证中 → 已验证 / 失败」。历史登记不会自动被视为已验证。校验读取真实 manifest，复算 sha256，选择目标平台并检查 image config 的 OS/architecture；详情展示两个 digest、校验时间和镜像默认 entrypoint/CMD。普通 `CUDA` 字段仍是人工备注，不能证明驱动、引擎、量化依赖或真实推理可用。构建产物显示「产物就绪」，与独立清单校验的「已验证」区分。

仓库复制默认关闭。管理员需在服务器设置：

```dotenv
# 允许读取的来源/直接引用仓库前缀；边界匹配，不含 docker:// 或 https://。
IMAGE_ALLOWED_PREFIXES=docker.io/vllm/,docker.io/lmsysorg/,registry.company.com/inference/
# 允许推送的导入目标。留空禁止复制；平台为每次导入生成新 tag。
IMAGE_IMPORT_PREFIXES=registry.company.com/inference/
IMAGE_SOURCE_HOSTS=github.com,git.company.com
REGISTRY_AUTH_FILE=/app/config/registry-auth.json
```

镜像仓库凭据与 Registry 管理 Token 是两套凭据。使用 [Skopeo 的认证文件](https://github.com/containers/skopeo/blob/main/docs/skopeo-login.1.md)配置私有仓库访问，给来源配置读取权限、目标配置推送权限。表单不收集仓库密码，服务端不把密码作为命令参数传入。Compose 已只读挂载 `./config`；认证文件须由容器 `node` 用户可读，并已在 `.gitignore` 中排除，勿提交到仓库。

生产 Dockerfile 已安装 Skopeo 和 CA 证书，不需要 Docker daemon。本地开发如缺少工具，安装 Skopeo（macOS：`brew install skopeo`），或通过 `SKOPEO_PATH` 指定可执行文件。镜像校验保持 TLS 证书验证；复制使用保留摘要模式。大镜像复制需要实际仓库写权限与足够网络/临时空间。默认清单操作超时 45 秒、复制超时 1 小时，最多 4 项重任务并行；可用 `IMAGE_INSPECT_TIMEOUT_MS`、`IMAGE_COPY_TIMEOUT_MS` 调整超时。参见 [Skopeo inspect](https://github.com/containers/skopeo/blob/main/docs/skopeo-inspect.1.md)、[Skopeo copy](https://github.com/containers/skopeo/blob/main/docs/skopeo-copy.1.md)。

已做真实只读验收：2026-10-22，本地平台成功登记并校验 `docker.io/vllm/vllm-openai` 的固定摘要，取得 `linux/amd64`、manifest/platform digest 和默认 `vllm serve` 入口。没有下载大体积层或启动 GPU。私有仓库推送与真实 CI 构建仍需你们的仓库认证文件及有效 Registry Token 验收。

### 引擎参考

- [vLLM Docker](https://docs.vllm.ai/en/stable/deployment/docker/)：参考 `vllm serve`；版本支持的参数以镜像内帮助为准。
- [SGLang 服务](https://docs.sglang.ai/basic_usage/send_request.html)：参考 `python3 -m sglang.launch_server`。
- [vLLM-Omni Docker](https://docs.vllm.ai/projects/vllm-omni/en/stable/getting_started/installation/gpu/)：独立镜像，参考 `vllm serve … --omni`。
- [SGLang Omni API Server](https://sgl-project.github.io/sglang-omni/get_started/apiserver_quickstart.html)：参考 `sgl-omni serve --model-path …`；其 `--model-name` 参数与其他引擎不同。

运行包字段依据[自定义新模型接入指南](https://acnc6zeentra.feishu.cn/docx/UdbYdGoJ5oLWfwxEUIMcGHtwnph)的自带镜像流程实现。实际环境需已发布相同契约，并具备镜像校验/拉取权限。管理凭据只保存在服务端 `.env`，不写入运行配置的普通环境变量。普通变量及用户编写的脚本在配置详情中可见。

## 兼容：文件模型模板

`config/catalog.json` 是可选的管理员模板清单，启动时校验并加载，修改后重启 app。此旧入口不提供底层 Spec 编辑；通用运行配置使用上面的页面流程。当前只有平台管理员角色，允许编写将于模型容器中执行的命令；不是对普通租户开放任意代码的平台。集群/namespace 仍受管理凭据的授权目标限制。

### 推荐：使用 Registry 已完成的运行包

参考 `config/catalog.example.json`。每个模型可提供多个 `variants`：

| 字段 | 作用 |
| --- | --- |
| `id`、`name`、`version` | 本平台模板标识和展示信息 |
| `servedModelName` | 实际推理请求中的 `model`；必须与模型服务启动参数一致 |
| `modelKey`、`modelRevision` | Registry 登记的模型与版本 |
| `variants[].runtimePackageId` | 构建成功后的运行包 ID，不能使用构建前基础包 ID |
| `variants[].targetId`、`clusterId`、`namespace` | 精确匹配的目标位置 |
| `memoryGB`、`label`、`description` | 模板展示信息，管理员需核对与实际运行包资源一致 |
| `recommended` | 此模型的默认规格，最多一个 |

后端从 `options` 精确匹配 target、cluster、namespace，整体复用该选项的 `resolved_spec`，按需带上该选项的 `glue_profile`。不会选择数组第一项，也不会仅修改 target_id。

此兼容入口复用已有运行包。新模型和新命令请使用通用流程。权重就绪不代表新版本一定兼容运行包，以部署预检与实际推理结果为准。

### 从 OSS 导入权重

1. 将完整模型目录上传至 OSS，按现有权重准备工具生成并上传 `manifest.json`，最后上传 `_READY`。保留工具输出的真实 `content_revision`（`sha256:` 加 64 位小写十六进制），不能用随意选择的文件哈希替代。
2. 管理员在 `.env` 设置允许引用的目录，例如 `OSS_ALLOWED_PREFIXES=oss://company-models/inference/`；多个前缀用逗号分隔，留空时真实环境禁止导入。OSS 读取权限由现有 Registry/存储准备服务管理，浏览器无需填写 AccessKey。
3. 打开「模型资产 → 从 OSS 导入」，选择已登记模型、权重版本与准备位置，填写目录、角色（例如 `main`）和内容指纹。多组件权重可添加多个角色，每个角色名称须唯一。
4. 平台调用 Registry `POST /internal/v1/weight-imports` 并查询导入状态，只有 `available` 才允许用于部署。部署时根据选定 revision、运行包和精确目标解析 `deployment-options`，整体复用 `resolved_spec`，不自行拼接 PVC 或挂载路径。
5. 点击该版本的「部署」，服务详情的「权重来源」会保留 OSS 目录、版本与指纹。权重准备失败时，可悬停状态查看原因并同步状态；复制导入请求标识可供管理员在 Registry 排查。

这里只引用已有 OSS 文件，不上传、覆盖或删除对象。同一模型版本与目标已有有效记录时不允许再次导入；更新内容请使用新版本。目标存储准备完成不代表 GPU 空闲。

Registry 写请求结果不明时记录为「待核对」，不会自动重发。已有 `import_id` 的记录可继续同步；未收到导入标识时，需要管理员按原请求标识在 Registry 核对。请勿通过改版本绕过未知结果反复提交。

### 可选：使用完整 IO Spec

参考 `config/catalog.direct-spec.example.json`，每种规格配置 `spec`，不能同时配置 `runtimePackageId`。示例只展示请求结构，未提供真实镜像、启动参数、权重挂载或 GPU 调度保证。需要管理员补齐目标环境支持的完整配置并实际验证。

当前只管理 `backend.type=NativeDeployment` 的普通服务，新建时可选 1–64 个副本，配置变更支持 0–64 个副本；停止后重新启动恢复停止前的副本数量。直接 Spec 模板的权重是固定的，不能选择另一个 OSS 版本；动态权重版本需要 `runtimePackageId` 模板。LWS、DisaggregatedSet、复杂分布式拓扑不在当前操作范围内。GPU 默认值来自适配模板，平台不会根据权重文件大小推算显存，也不会保证目标 GPU 当前空闲。

不同 Patrick 模式能力不同。原生 HelmRelease 兼容目标可能不支持 Glue、startupScripts 或 internalExposure。不要从 IO 透传能力推断下游支持；以目标已发布版本、schema、preview 和运行验证为准。

## 状态与实际调用

服务详情的「配置变更」先以当前实时配置生成完整目标 Spec，再向上游预检，页面展示差异并等待确认。发布携带原 UID 与 resourceVersion；其他人已改动配置时拒绝覆盖，需要刷新后重新预检。此入口调整当前副本和资源；启动脚本/探针在运行配置中创建新版本，经过发布和预检后创建新服务。

平台分开展示「请求接受」「实例运行」「入口可用」「推理验证」。运行状态按上游控制面报告解释，不把未知数量当 0，也不把目标副本当就绪副本。

- 详情 `live=true, stale=false` 才能作为实时观测；历史兜底保留最近状态并暂停修改。
- URL/Host 来自 `kubernetes.status.internalExposure` 的就绪观测，且不能为 stale route。当前入口解析针对前一份 QA 指南约定的 `gatewayAddresses: string[]`、`gatewayPort: number` 和 `hostname`。其他目标若只返回不同形状的 `routes`，页面保守显示入口待就绪，需要按真实契约扩展解析器。
- 页面不代理真实推理，以免把平台变成任意地址请求代理。复制代码后，从可访问目标网络的客户端调用；实际入口鉴权按你们的推理网关配置补充。
- 管理 Token 不得用于模型请求；页面不会将管理 Token 放进调用示例。
- 环境连接检查只验证 IO 授权目标接口连通，不代表 Registry、模型权重、GPU 和业务路由全部可用。

## 备份、恢复与更新

本地在线一致性备份：

```bash
npm run backup
```

备份使用 SQLite Backup API，运行中也可执行，不是只复制一个可能缺少 WAL 的文件。

容器中备份并取到服务器：

```bash
docker compose exec app node scripts/backup.mjs /app/backups/manual.sqlite
docker compose cp app:/app/backups/manual.sqlite ./manual.sqlite
```

已有同名备份不会覆盖。请使用新名称，并按你们的规则将备份同步到其他机器。备份包含配置、操作与会话数据，应作为受控资产保存。

恢复时先停止 app，保留原数据文件及其 `-wal`/`-shm` 文件备份，再把一致性备份作为新数据库恢复；不要把新主库与旧 WAL 文件混用。确保容器用户可写后启动。通过停止期间的独立维护容器或本地挂载完成文件恢复，避免对运行中的数据库直接覆盖。

更新时先备份，再执行 `docker compose up -d --build`。`docker compose down` 默认保留命名卷；不要在未确认前使用 `down -v`。

演示与真实模式不能共用数据库。首次切换必须使用新的 `DATABASE_PATH`；Compose 建议分别使用不同 project 名称，生成独立数据卷。

## 结果未知的操作如何处理

写请求超时、5xx、进程中断可能发生在上游已接受操作之后。平台持久化请求标识并暂停进一步修改，后台先读取实际状态；不自动重放创建/重启，不自动删建，不在 409 时偷偷更新版本再覆盖。

- 已知 UID 的上下线/重启可根据同一对象实时 rollout 状态确认结果。
- 删除接受后等待实时 GET 404，之后移出列表。附属资源是否回收仍由集群策略决定。
- 首次创建响应丢失时，不能仅凭同名对象认定创建成功，需要管理员核对来源与原始配置。

提供 `scripts/resolve-operation.mjs` 供人工核对。本地先 `npm run build`，使用真实环境 `.env`：

```bash
npm run resolve-operation -- --service <平台服务UUID>
```

该命令只读，输出当前实际 UID、版本和未知操作标识，不输出完整配置或凭据。服务 UUID 是详情页 URL 的最后一段。

如已确定未知创建实际成功，先停止应用进程，明确核对 UID 和原始配置后执行：

```bash
npm run resolve-operation -- --service <平台服务UUID> --uid <实际UID> --decision adopt --confirm
```

仅当实时配置包含原始创建要求才允许接管。对于上下线/重启，在管理员**确定该操作未生效且不会继续执行**后，可使用 `--decision failed` 解除保护；不能用这个选项跳过创建或删除的身份核对。

容器维护方式：`docker compose stop app`，然后通过 `docker compose run --rm --no-deps app node scripts/resolve-operation.mjs ...` 执行同样参数，再启动 app。工具只修改本地登记，不向 IO 发起写请求。

## 检查与代码结构

```bash
npm test
npm run build
docker compose --env-file .env.example config --no-env-resolution --quiet
```

`npm test` 使用隔离数据库、本地模拟 IO/Registry 和注入的镜像传输适配器，不操作真实集群或推送镜像。覆盖生命周期、幂等、并发、预检过期、登录、CSRF、资源替换、历史状态、未知结果、脱敏、目标精确匹配、配置变更、OSS 导入、三种镜像来源、校验失败、复制结果核对、构建产物与运行包衔接，以及真实 React 配置交互。另有 `npm run test:orbstack` 的真实集群与模型验收，以及 `npm run test:container` 的生产容器检查（先 `docker build -t launchpad-platform:1.5.0 .`）。验收证据在 `artifacts/`，不与契约模拟测试混称。

```text
client/      React 界面、API 客户端与自动刷新
server/      鉴权、SQLite、模板加载、IO/Registry 客户端和部署状态管理
shared/      前后端数据类型
config/      管理员维护的模型模板示例
deploy/      HTTPS 代理配置
scripts/     密码哈希、备份、人工核对、真实集群/容器验收与公网评审
tests/       业务契约、鉴权与界面交互测试
```

目前适合单平台实例、平台管理员维护模型资产与推理配置的自有部署场景。多人 SSO/RBAC、高可用、完整集群资产发现、浏览器权重上传、跨节点分布式拓扑、压测、灰度、自动回滚与定时下线尚未包含。源码构建采用自带 Dockerfile 的 Registry 组件构建流程，尚未提供内置框架源码依赖构建表单或完整 CI 日志查看器。真实接入需要实际地址、凭据、仓库认证和 GPU。契约模拟测试与公开镜像清单校验不替代真实 GPU 验收。
