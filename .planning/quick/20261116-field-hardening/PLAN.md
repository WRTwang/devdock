---
slug: field-hardening
created: 2026-11-16
status: complete
---

# 实战加固：从 GitHub 下载项目 → 装环境 → 启动 → 删除

## 目标

任意下载一个 GitHub 项目，DevDock 能识别、装好虚拟环境、正常启动；删除项目时环境残留清干净。

## 实测暴露的问题

1. 真实 Node 仓库：`npm install` 期间点启动会找不到依赖（安装未完成就放行）。
2. 真实 Python 仓库：机器上的 `python` 是 MSYS2 版本，`venv` 生成 `.venv\bin\python.exe`，旧逻辑只认 `Scripts`。
3. venv 装好后启动命令仍是系统 `python app.py`，依赖找不到。
4. Windows `cmd` 收到被转义的 `\"`，带引号路径无法执行。
5. README 里提一句 PostgreSQL 就被误判成数据库项目。
6. 删除只清根目录的环境，子目录 / 缓存 / 构建产物会残留。
7. 安装失败后仍可能被标记为「已就绪」。

## 修复

- runner 增加 `windowsVerbatimArguments`，修 Windows 引号。
- 安装结束自动复检，仍有缺失则广播 `setup-incomplete`；安装期间禁用启动。
- venv 兼容 `Scripts` / `bin`；MSYS2 Python 优先用 `py -3` 创建原生 venv；创建命令对两种布局自动回退。
- 执行前把 `python` / `pip` / `uvicorn` 等切换为 venv 解释器。
- 数据库只认 compose / 数据库服务 / 真实连接串。
- 新增 `.env.example` 复制、`Procfile(.windows)`、`.python-version`、`requirements/`、`setup.py`、一层子项目识别。
- 删除递归扫描环境 / 缓存 / 构建产物，可选是否删缓存与构建；Docker compose 先 `down --remove-orphans`；原样未改的 `.env` 副本一起删。

## 验证

- `npm test` 207 条全绿。
- Electron 端到端（两份由真实仓库提取的等价项目）：
  - Node：安装 2s，`HTTP 200` on 5006，删除后无 `node_modules` / `.devdock` / `devdock.cmd` / `.env`。
  - Python：`.venv\Scripts`，安装 14s，`HTTP 200` on 5000，删除后无 `.venv` 等；源码保留。
- Git 网络受限期间改用本地等价项目；GitHub 恢复后可复跑同一脚本。
