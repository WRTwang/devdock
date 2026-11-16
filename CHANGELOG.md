# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.5.0] - 2026-11-16

### 新增

- **装完自动复检**：安装结束重新体检，仍有缺失项会列出具体项目，不再直接标记「已就绪」
- **venv 命令切换**：检测到项目 venv 后，启动与安装中的 `python` / `pip` / `uvicorn` 等命令自动切到 venv 解释器
- **多布局 venv**：兼容 `.venv\Scripts`（Windows 原生）与 `.venv\bin`（MSYS2 / Cygwin），并优先用 `py -3` 创建原生 venv
- **`.env` 准备**：只有 `.env.example` / `.env.sample` 时提示复制，安装计划里可直接生成
- **子项目识别**：根目录没有清单时识别一层 `backend/` + `web/` 子项目，分别体检、安装与启动
- **清单兜底**：支持 `setup.py`、`requirements/base.txt`、`.python-version`、`Procfile` / `Procfile.windows`（`%PORT%` 自动替换）
- **删除更彻底**：递归清理任意层级的 venv / node_modules / 缓存 / 构建产物，可选是否删缓存与构建；Docker compose 项目会先 `down --remove-orphans`
- **原样 `.env` 副本**：从示例复制且没被改过的 `.env` 会随环境一起删除，改过的保留

### 修复

- **Windows 引号命令失败**：`cmd` 会收到被转义的 `\"`，导致带引号路径（如 venv 中的 python）无法执行
- **Python 启动找不到包**：依赖装在 venv，启动却用系统 Python
- **README 提一句 PostgreSQL 就误报数据库**：现在只认 compose 镜像、数据库服务或真实连接串
- **安装过程中可点启动**：安装期间禁用启动按钮并给出提示

### 实测

- 以 Heroku 的 Node / Python 示例项目为蓝本做端到端：体检 → 安装 → 启动返回 HTTP 200 → 删除；删除后无 `.venv` / `node_modules` / `.devdock` / `.env` 残留，源码保留。

## [0.4.3] - 2026-11-16

### 修复

- **stderr 被整片标红**：Django 的 `Watching for file changes with StatReloader`、访问日志这类正常进度写到 stderr 时不再显示为错误
- **日志按内容分级**：真正的错误与 Python `Traceback` 整段标红，`warning` / `DeprecationWarning` 标黄，其余 stderr 按普通信息显示
- **`Traceback` 连续行**保持红色，空行后自动恢复正常
- **无意义的数据库提示**：没有输入口令、也没有本机服务需要启动时，不再弹「正在准备数据库环境…」

## [0.4.2] - 2026-11-16

### 修复

- **README 安装步骤重复成「缺失」项**：README 的安装命令现在按语言并回 Python / Node 等体检项，只有完全对不上生态的命令才单独成条
- **README 命令优先级**：并回时使用 README 的写法（例如带 `-i` 镜像源），不会被执行两遍
- **裸 `pip install` 不再装到系统 Python**：自动改写成项目 venv 里的解释器；README 指向尚未创建的 venv 时先建环境
- **已有 venv 不再重复执行 `python -m venv`**：依赖缺失时只跑安装命令

## [0.4.1] - 2026-11-16

### 新增

- **启动失败诊断**：进程退出后按日志归类为权限拒绝、端口占用、找不到命令、缺依赖、缺脚本、数据库连不上、启动后秒退，并用弹窗给出主要问题和处理建议
- **一键修复**：端口占用可结束占用进程后自动重试；权限问题（`0x5` / `EACCES`）可直接「以管理员身份重启 DevDock」
- **拦截自启动**：把 DevDock 自己的目录当项目启动时直接拦下，说明 `code=0` 与 `0x5` 缓存报错的来源

### 改进

- 启动进程的退出信息会带上耗时、命令与最近日志，诊断不再依赖用户翻日志
- 单实例程序被二次启动、启动命令写成一次性脚本这类「正常退出但没服务」的情况也会提示

## [0.4.0] - 2026-11-16

### 新增

- **环境体检**：同时读 README 与 `package.json` / `requirements.txt` / `pyproject.toml` / `Pipfile`，逐项判断已就绪（绿）、缺失（黄）、异常（红）
- **按需安装**：每条缺失项可单独安装，也可一次装完；需要下载或升级工具时先弹确认框，同意后才执行
- **工具版本协商**：探测 Node / npm / pnpm / yarn / bun / Python / uv / Poetry / pipenv / Docker 等版本，优先复用已达标工具
- **数据库口令与自启**：识别 PostgreSQL / MySQL / Redis / MongoDB，弹窗输入口令后启动本机 Windows 服务，连接串只在内存与 `.env` 中流转
- **删除即清理**：删除档案时列出 `.venv` / `node_modules` / `.devdock` / `devdock.cmd` 等残留，确认后一并删除

### 说明

- 数据库口令不写入 `profiles.json`；重启应用后首次启动项目会再次询问
- 需要管理员权限的 `net start` 失败时会给出可手动执行的提示

## [0.3.0] - 2026-11-16

### 新增

- **README 优先识别**：从 README 代码块提取安装 / 启动命令与端口，识别不到再退回目录结构
- **识别来源标注**：告知命令来自 README 还是目录结构，便于判断是否需要手改
- **项目内启动器**：保存时生成 `devdock.cmd` 与 `.devdock/project.json`，双击即自动启动整套服务
- **`--project` 启动参数**：支持从项目目录直接打开并自动编排；单实例下会切换项目

### 说明

- 项目内启动器记录生成时的应用路径，重装后需重新保存项目
- 多服务项目不会被 README 的整体命令覆盖，仅作提示

## [0.2.0] - 2026-11-16

### 新增

- **多服务编排**：一个项目可包含前端 / 后端 / 数据库 / 后台任务多个服务
- **服务模型**：目录、安装命令、启动命令、角色、端口、依赖，旧档案自动迁移为单服务
- **依赖排序**：稳定拓扑排序，成环时拒绝启动并列出环上的服务
- **数据库就绪门控**：TCP 轮询端口，就绪后再启动下游服务，超时回滚已启动的进程
- **项目结构识别**：解析 `docker-compose.yml` 多服务与 `pnpm-workspace.yaml` / `workspaces` 子包
- **服务级日志**：日志按 `项目/服务` 分目录，界面支持按服务筛选
- **服务编辑界面**：增删服务、选择角色、填写端口、勾选依赖

### 改进

- 启动按钮状态、回滚提示与错误信息更明确
- 配置页用服务卡片替代单一命令卡片

## [0.1.0] - 2026-11-15

### 新增

- 项目档案：路径、Shell、安装/启动/停止命令、环境变量，本地持久化
- 项目类型自动检测：Node（npm/pnpm/yarn/bun）、Python（pip/poetry/uv/pipenv）、Rust、Go、.NET、Docker Compose、Ruby、Java、PHP
- 一键搭环境、一键启动、一键停止（Windows 进程树）
- 实时日志面板与按项目落盘日志
- 单一活跃环境：切换项目时停止旧进程并还原 `.env`
- 可选的 `.env` 同步与自动备份/还原
- 深色 GUI、项目侧栏、配置卡片、终端面板
- 单元测试（`node --test`）与 electron-builder 打包配置
