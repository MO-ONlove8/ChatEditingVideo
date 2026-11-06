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
- Ollama，已拉取 `qwen3:8b`（聊天功能需要）

## 快速开始

```bash
pnpm install
cp .env.example apps/chat-editing-video-server/.env
pnpm db:up          # 启动 PostgreSQL + Redis（docker compose）
pnpm db:migrate     # 执行数据库迁移
pnpm db:seed        # 可选：示例数据
pnpm dev            # 同时启动 server(:3000) + web(:5173) + desktop
```

只跑浏览器版：`pnpm dev:web`（同时启动 server），打开 http://localhost:5173 。

## 常用命令

| 命令                                         | 作用                                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| `pnpm build` / `typecheck` / `lint` / `test` | 全仓构建 / 类型检查 / Lint / 单元测试（Turborepo 缓存）                             |
| `pnpm e2e`                                   | 构建 web + desktop 后跑 Playwright。首次先执行 `pnpm --filter @cev/e2e e2e:install` |
| `pnpm --filter @cev/server test:integration` | 服务端集成测试，需要 `db:up` + `db:migrate`                                         |
| `pnpm db:generate`                           | 修改 `src/database/schema.ts` 后生成迁移                                            |
| `pnpm --filter @cev/desktop package`         | 打 Windows 安装包（未签名，输出到 `release/`）                                      |

## 架构要点

**剪辑执行位置（待需求文档确定）**：对话产出的是声明式的 `EditPlan`（`packages/shared/src/schemas/edit-plan.ts`），由 `EditExecutor` 接口的两个实现执行：

- 桌面端本地：`apps/chat-editing-video-desktop/src/main/local-executor.ts`（IPC 推送进度）
- 服务端：`apps/chat-editing-video-server/src/jobs/executors/ffmpeg-server.executor.ts`（BullMQ worker，Redis pub/sub → SSE 推送进度）

两者目前都是**桩实现**：模拟进度并输出一个 JSON manifest，尚未调用 FFmpeg。Web 端 `src/lib/executor.ts` 按设置选择其一，浏览器版只能用服务端。

**进度推送**：聊天用 `POST /api/chat/stream`（fetch 读取 SSE），任务进度用 `GET /api/jobs/:id/events`（EventSource）。

**存储**：本地文件系统（`STORAGE_DIR`），通过 `StorageService` 抽象，后续可替换为 S3/MinIO。

**桌面端安全**：`contextIsolation` + `sandbox`、无 Node 集成、自定义 `app://` 协议带 CSP、IPC 只接受自家页面调用且参数经 zod 校验。

## 已知限制

- 未实现鉴权：API 目前没有任何身份认证，**不要暴露到公网**。
- CI/CD（GitHub Actions）尚未搭建。
- 桌面端未签名、无自动更新，仅 Windows x64。
