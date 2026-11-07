# Chat Editing Video

对话式视频剪辑桌面应用。pnpm + Turborepo monorepo。

| 包                                | 说明                                                                                               |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| `apps/chat-editing-video-desktop` | Electron 外壳（Windows）。开发时加载 web 的 dev server，打包后通过 `app://local` 加载 web 构建产物 |
| `apps/chat-editing-video-web`     | React 界面，同时是桌面端界面，也可单独部署为浏览器版                                               |
| `apps/chat-editing-video-server`  | NestJS API：Drizzle + PostgreSQL、Redis、BullMQ 任务队列、SSE 推送、本地 LLM（Ollama）             |
| `packages/shared`                 | 三端共用契约：zod schema、API 路由、IPC 通道、`EditExecutor` 接口、SSE 工具                        |
| `e2e`                             | Playwright：Web（mock API）+ Electron（真实桌面应用）                                              |

## 环境要求

- Node 24（见 `.nvmrc`）：`nvm install 24.22.2 && nvm use 24.22.2`
- pnpm 9：`corepack enable && corepack prepare pnpm@9.15.9 --activate`
- Docker Desktop（运行 PostgreSQL / Redis）
- FFmpeg / FFprobe（需含 libx264、AAC、zscale、tonemap；通过 PATH 或 `.env` 配置可执行文件路径）
- Ollama，已拉取 `qwen3:8b`（对话剪辑使用；登录、上传、素材处理和已保存结果播放不依赖 Ollama）

## 快速开始

```bash
pnpm install
cp .env.example apps/chat-editing-video-server/.env
pnpm db:up          # 启动 PostgreSQL + Redis（docker compose）
pnpm db:migrate     # 执行数据库迁移
pnpm db:seed        # 可选：示例数据
pnpm dev            # 同时启动 server(:3000) + web(:5173) + desktop
```

只跑浏览器版：分别在两个终端运行 `pnpm dev:server` 和 `pnpm dev:web`，打开 http://localhost:5173 。

## 常用命令

| 命令                                         | 作用                                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| `pnpm build` / `typecheck` / `lint` / `test` | 全仓构建 / 类型检查 / Lint / 单元测试（Turborepo 缓存）                             |
| `pnpm e2e`                                   | 构建 web + desktop 后跑 Playwright。首次先执行 `pnpm --filter @cev/e2e e2e:install` |
| `pnpm --filter @cev/server test:integration` | 服务端集成测试，需要 `db:up` + `db:migrate`                                         |
| `pnpm db:generate`                           | 修改 `src/database/schema.ts` 后生成迁移                                            |
| `pnpm --filter @cev/desktop package`         | 打 Windows 安装包（未签名，输出到 `release/`）                                      |

## 架构要点

**剪辑执行位置**：首版素材处理和成品生成由服务端负责，关闭桌面应用不会停止已开始的服务端任务。底层保留 `EditExecutor` 的两种适配：

- 桌面端本地：`apps/chat-editing-video-desktop/src/main/local-executor.ts`（IPC 推送进度）
- 服务端：`apps/chat-editing-video-server/src/jobs/executors/ffmpeg-server.executor.ts`（BullMQ worker，Redis pub/sub → SSE 推送进度）

服务端执行器已接入真实 FFmpeg 导出，使用当前已确认时间轴的不可变版本快照。桌面本地执行适配仍为架构占位，产品界面统一使用服务端生成。进度与状态保存在数据库；生成期间可继续编辑，退出客户端不影响后台作业。

**登录与账号隔离**：手机号 + 固定测试验证码 `123456`，不发送短信。先获取验证码再登录；验证码默认 5 分钟有效，60 秒获取间隔，会话默认 7 天有效（见 `.env.example`）。新登录替换旧会话；任务、素材及生成进度均按账号校验访问权限。历史无归属任务保留在数据库中，不展示给新账号。

**页面**：`/login`、`/tasks`、`/tasks/new`、`/tasks/:id/edit`、`/tasks/:id/player`。新建空页不会创建数据库任务；第一个视频完整上传并通过服务端校验后才创建任务，同批后续视频归入同一任务。支持真实上传、逐秒缩略图、逐帧查看、重命名和删除；对话剪辑、确认卡、时间轴持久化、即时预览、独立播放及成品下载已接入。

**素材处理**：Mediabunny 在浏览器检查 MP4 / MOV 元信息，XHR 提供进度和取消，服务端流式落盘后再次校验。默认每批最多 3 个，每个任务最多 10 个（含上传中），每文件最大 1 GB（1024 MB），时长不限；限制见 `.env.example`。文件完整上传后保存原件并分配稳定的 V 编号，删除后不复用。BullMQ 串行处理，数据库记录可在重启后恢复入队。退出登录或关闭客户端不会中止已保存素材的处理。

FFmpeg 生成 H.264 / yuv420p、30 fps、最长边不超过 1920 的 MP4，AAC 48 kHz 双声道，无音轨时补静音，处理旋转、非方形像素、VFR 和 HDR → SDR。每秒一个缩略图，按 30 秒分页加载雪碧图；点击某秒按需提取该秒实际存在的帧（末秒不补虚假帧）。所有位置按处理后视频的整数帧计算。帧图缓存默认 2 GB，按最近访问清理；临时上传 24 小时过期。

**媒体访问**：缩略图、完整帧和规范化视频都校验账号归属。凭证只放 Authorization 请求头；视频支持 HTTP Range / HEAD。生成中或失败的素材不能查看帧图，失败保留原件并可重试或删除。上传中离开会提示，未完成传输取消，已保存素材保留。

**交互预览**：运行 `pnpm dev:web` 后访问 http://localhost:5173/dev/ui-states ，可单独验证关键弹窗、帧图放大、复制时间、失败重试与上传离开保护。此入口只在开发环境提供，使用演示数据。

**进度推送**：聊天、任务、素材进度和会话失效通知通过携带 Bearer 凭证的 fetch SSE 读取。素材事件断线时通过轮询兜底；上传响应丢失先查询保存结果。断开客户端连接不取消服务端队列任务。

**桌面会话**：主进程使用 Electron `safeStorage` 加密保存；加密不可用时仅存内存。浏览器验证入口使用 sessionStorage。开发与 E2E 可通过 `CEV_USER_DATA_DIR` 隔离应用配置目录。

**存储**：本地文件系统（`STORAGE_DIR`），通过 `StorageService` 抽象，后续可替换为 S3/MinIO。

**桌面端安全**：`contextIsolation` + `sandbox`、无 Node 集成、自定义 `app://` 协议带 CSP、IPC 只接受自家页面调用且参数经 zod 校验。

## 持续集成（CI）

工作流位于 `.github/workflows/ci.yml`。PR 创建或更新、推送到 `dev` / `main` / `master` 时自动运行，也可在 GitHub 的 Actions → CI 页面手动运行；同一 PR 或分支的新运行会取消旧运行。

| 检查名称               | 环境                    | 内容                                                         |
| ---------------------- | ----------------------- | ------------------------------------------------------------ |
| `Quality and build`    | Ubuntu 24.04            | Prettier、类型检查、ESLint、单元/组件测试、全仓构建          |
| `Server integration`   | Ubuntu 24.04            | 空库迁移、PostgreSQL 17、Redis 7、真实 FFmpeg 素材处理与导出 |
| `Web E2E`              | Ubuntu 24.04 + Chromium | mock API 的 Web、素材界面和开发状态预览                      |
| `Windows Electron E2E` | Windows Server 2022     | 构建后的 Electron 应用、登录和桌面交互                       |

Node 版本读取 `.nvmrc`，pnpm 版本读取 `package.json` 的 `packageManager`，依赖通过 `pnpm install --frozen-lockfile` 安装。仅缓存 pnpm 下载目录，Turbo 命令使用 `--force` 确保实际执行检查。Ubuntu 从发行版软件源安装 FFmpeg 6.1 系列及字体，并检查 libx264 / AAC、drawtext / zscale / tonemap 和旋转参数；具体补丁版本打印在日志中，随 Ubuntu 安全更新变化。

CI 使用 runner 自己的临时数据库、Redis 和文件目录，不需要配置 GitHub Secrets 或复制本地 `.env`，不会连接开发数据库。常规检查不启动 API 常驻服务或 Ollama；剪辑集成测试使用固定模型响应，视频处理与导出仍运行真实 FFmpeg。真实模型、真实 API 的浏览器与 Electron 全链路验收继续按下文在本地执行；仅 `CEV_E2E_REAL_API=1` 会启用这部分测试，`0` 不会启用。

端到端测试失败时上传 HTML 报告、trace、截图和测试输出，服务端集成测试上传 JUnit 结果，保留 7 天。可从失败运行的 Artifacts 下载，在本地通过 `pnpm --filter @cev/e2e exec playwright show-report <报告目录>` 或 `pnpm --filter @cev/e2e exec playwright show-trace <trace.zip>` 查看。安装依赖或构建阶段失败时可能尚未生成报告，需查看对应步骤日志。

工作流进入远端并成功运行后，在 GitHub Settings → Rules → Rulesets（或 Branches → Branch protection）为需要保护的分支启用 PR 合并和必需状态检查，选择上表四个检查名称。此设置需要仓库管理权限，仓库与账号计划也需支持对应规则；仅添加 YAML 不会自动阻止检查失败的合并。

工作流只验证代码，不打安装包、不签名、不创建 Release、不推送或部署。以后更新 Actions 时需重新核对完整提交 SHA；Node / pnpm / Playwright / FFmpeg 升级后需检查 runner 兼容性。

## 已知限制

- 登录使用固定测试验证码，尚未接入真实短信服务。
- CI 使用 GitHub Actions；尚未配置自动部署和安装包发布。
- 桌面端未签名、无自动更新，仅 Windows x64。

## 上传与素材查看验收

1. 启动 PostgreSQL / Redis，运行 `pnpm db:migrate`，确认 FFmpeg 和 FFprobe 可执行，再运行 `pnpm dev:web` 或 `pnpm dev`。
2. 访问 `/login`，获取测试验证码并以 `123456` 登录。进入“新建”，选择或拖入 MP4 / MOV；首个文件保存后自动进入已保存任务。
3. 等待素材“处理完成”，点击某秒查看帧图，点击帧图放大并复制时间。最后一秒只显示实际帧数。
4. 上传中返回列表，可选择继续上传或取消并离开。已保存素材在后台继续处理；任务与素材删除均需确认，失败可重试。

服务端集成测试会生成本地编号视频，覆盖 CFR / VFR、MOV 旋转、HDR、上传幂等、并发首次保存、限额、账号隔离、Range、处理与删除重试。运行前需数据库迁移及 FFmpeg 可用。测试素材和输出存放在忽略的 `storage/` 或 `test-results/`，不会作为源码资源使用。

真实浏览器联调：保持 API 运行，设置 `CEV_E2E_REAL_API=1` 后运行 `pnpm e2e`，会额外验证真实登录 → MOV 上传 → 处理 → 查看帧图 → 刷新恢复 → 删除。测试使用独立随机账号；服务端集成测试使用独立的队列前缀和存储目录，可与本地服务同时运行。测试环境也需要在 PATH 中提供 FFmpeg，或设置 `FFMPEG_PATH`。

## 对话剪辑与成品验收

1. 等待素材处理完成，输入“把 V1 的第 5 秒到第 8 秒追加到主视频末尾”。确认卡应显示 00:05:00 → 00:08:00，共 91 帧；预览选段后点击“确认并保存”。
2. 确认前不改时间轴；可取消。刷新或重新进入保留待确认卡，保存失败时保留上次已保存结果，重试不会重复添加。
3. 支持截取追加、插入 Clip 前后、移动、复制；每条消息一个操作。Clip 显示编号按当前顺序变化，内部 ID 稳定。修改截取范围需删除后重加，首版不支持撤销。
4. Remotion Player 直接编排已确认片段，不等待完整编码。时间轴支持横向滚动、片段播放和删除；主视频按钮连续播放全部。画布比例由首个确认片段确定并保留，其他素材补黑边。
5. 点击“下载成品”开始后台生成，完成后点击“保存 vN 到本地”。相同版本复用成品，新剪辑使用新快照。Web 使用浏览器下载，Electron 使用原生保存对话框；服务器必须保持运行。
6. 导出为 30 fps H.264 MP4，AAC 原声。16:9 为 1920×1080，9:16 为 1080×1920，其他比例最长边 1920。主视频最多 100 个 Clip、54000 帧（30 分钟）。
7. 当前时间轴引用的素材禁止删除；解除引用后可从素材库删除。旧生成仍需要的处理文件保留，失败可重试，成功或删除整个任务后清理。

本地 Ollama 的 GPU 推理无法初始化时，可在服务端环境文件设置 `LLM_OLLAMA_CPU=true` 并重启服务端，以同一模型通过本地 Ollama CPU 模式推理。默认关闭，模型调用超时由 `LLM_TIMEOUT_MS` 配置（默认 180000）。此配置不会修改 Ollama 的系统设置。

真实联调设置 `CEV_E2E_REAL_API=1` 后，除素材流程外还会验证真实模型理解、待确认恢复、鉴权视频预览、MP4 下载和 Electron 原生保存。服务端集成测试使用固定模型响应验证保存/并发/错误规则，视频处理与导出运行真实 FFmpeg。
