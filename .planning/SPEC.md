# SPEC — DevDock v0.1

## 领域模型

```ts
ProjectProfile {
  id: string            // uuid
  name: string          // 显示名，默认取目录名
  dir: string           // 绝对路径，必须存在
  shell: 'powershell' | 'cmd'
  setupCommand: string  // 搭环境命令，可空
  startCommand: string  // 启动命令，可空
  stopCommand: string   // 自定义停止命令，可空（默认 taskkill 进程树）
  envVars: { key, value }[]
  syncDotEnv: boolean   // 是否把 envVars 写入项目 .env
  autoSetup: boolean    // 启动前若未搭过环境则自动搭
  createdAt: number
  lastUsedAt: number | null
}
```

全局状态 `AppState`：

```ts
{
  profiles: ProjectProfile[]
  activeId: string | null        // 同一时间只有一个活跃项目
  lastLogPath: Record<id, string>
}
```

## 环境隔离规则

1. **进程级**：每项目的子进程 `env = process.env + profile.envVars`，互不污染主进程。
2. **文件级（可选）**：`syncDotEnv` 开启时，启动前把项目 `.env` 备份到 `.env.devddock.bak`（已存在则不覆盖备份），写入合并后的变量；停止/切换/退出应用时还原。
3. **切换即清理**：`activate(next)` 若 `activeId !== next`：
   - `taskkill /PID <pid> /T /F` 杀掉旧项目全部进程；
   - 还原旧项目 `.env`；
   - `activeId = next` 落盘；
   - 写一条 `[DevDock] 环境已切换 A → B` 到新项目日志。
4. **退出清理**：`before-quit` 同步杀掉全部进程并还原全部 `.env`。

## 命令执行

- `cmd`：`cmd.exe /d /s /c "<command>"`
- `powershell`：`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "<command>"`
- `spawn` 选项：`windowsHide: true`、`cwd: profile.dir`、注入 env。
- stdout/stderr 按 chunk 推送到渲染进程，同时追加写日志文件（`logs/<projectId>/<yyyyMMdd-HHmmss>.log`）。

## 自动检测

按优先级读目录特征文件，返回 `{ setupCommand, startCommand, envVars, runtime }`：

| 特征 | setup | start |
| --- | --- | --- |
| `pnpm-lock.yaml` | `pnpm install` | `pnpm dev`（有 dev script） |
| `yarn.lock` | `yarn install` | `yarn dev` |
| `bun.lockb` | `bun install` | `bun run dev` |
| `package.json` | `npm install` | `npm run dev` / `npm start`（按 scripts） |
| `pyproject.toml` + poetry | `poetry install` | `poetry run python -m <pkg>` |
| `requirements.txt` | `pip install -r requirements.txt` | — |
| `Cargo.toml` | `cargo build` | `cargo run` |
| `go.mod` | `go mod download` | `go run .` |
| `*.sln` / `*.csproj` | `dotnet restore` | `dotnet run` |
| `docker-compose.yml` | — | `docker compose up` |
| `Gemfile` | `bundle install` | `bundle exec rails server`（检测 rails） |
| `composer.json` | `composer install` | — |

无匹配时返回空命令并提示「未识别项目类型，请手动填写」。

## IPC 契约（preload 白名单）

| 通道 | 方向 | 说明 |
| --- | --- | --- |
| `profiles:list` | invoke | 返回 AppState |
| `profiles:save` | invoke | 新增/更新档案 |
| `profiles:delete` | invoke | 删除档案并清理 |
| `profiles:detect` | invoke | 入参 dir，返回检测结果 |
| `dialog:pickDir` | invoke | 系统选目录 |
| `env:setup` | invoke | 执行 setupCommand |
| `env:start` | invoke | 执行 startCommand |
| `env:stop` | invoke | 停止项目进程 |
| `env:activate` | invoke | 切换活跃项目（含清理） |
| `env:status` | invoke | 运行中进程快照 |
| `log:event` | main→renderer | `{ projectId, stream, chunk, ts }` |
| `state:event` | main→renderer | 状态变更（activeId / running / setup 进度） |
| `shell:openDir` | invoke | 资源管理器打开目录 |

## UI

- 顶栏：品牌、活跃项目徽章、新建按钮。
- 左栏：项目列表（状态点 + 名称 + 路径尾段），空态引导。
- 右栏：项目头（名称/路径/开关按钮组）→ Tab（配置 / 日志）。
- 配置页：只读摘要 + 编辑入口；日志页：终端风格，支持自动滚动、清空、打开日志目录。
- 编辑弹窗：字段校验（路径必填且存在）、「自动检测」按钮、环境变量键值行增删。
- 交互反馈：启动/停止按钮 loading 态，错误以 toast + 日志双通道呈现。

## 错误处理

- 路径不存在 → 表单内联报错，禁止保存。
- 命令为空点启动 → toast 提示去配置。
- 启动失败（ENOENT / 非零退出）→ 日志红色输出 + 状态回到 idle。
- 档案 JSON 损坏 → 备份为 `profiles.corrupt-<ts>.json` 并以空状态启动，不静默丢数据。
