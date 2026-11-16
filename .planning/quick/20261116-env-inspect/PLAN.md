---
slug: env-inspect
created: 2026-11-16
status: in-progress
---

# 环境体检与数据库自启

## 目标

在 DevDock 里加一层「项目环境体检」：同时读 `README.md` 与 `requirements.txt` / `package.json` 等清单，
判断项目需要的运行环境是已有、缺失还是报错；缺失项经用户确认后安装；数据库环境弹窗收密码并自启本机数据库；
删除项目时可选连同环境残留一起删除。

## 已确认的决策

- 流程：gsd-quick（原子提交 + 计划留档）
- 环境位置：项目目录内（`.venv` / `node_modules` 等）
- 第一版：检测 + 逐项确认后安装
- 数据库：本机服务 + docker compose 都支持；密码写入项目 `.env` 供服务连接
- 发布：普通 commit + push 到 `main`

## 拆分

1. `electron/tools.js`：探测本机工具与版本，判断是否达到最低版本，给出获取/升级建议（需用户同意）。
2. `electron/dbstart.js`：数据库引擎识别、本机 Windows 服务探测与启动、连接串拼装。
3. `electron/envcheck.js`：README + 清单联合体检，输出绿/黄/红三态条目与安装计划；环境残留枚举与删除。
4. `electron/environment.js` / `main.js` / `preload.js`：体检、安装、数据库密码、连带删除的 IPC。
5. `renderer/`：环境体检面板、彩色状态、数据库密码弹窗、工具获取同意弹窗、删除确认弹窗。
6. 测试、README、CHANGELOG、版本号，提交并推送。

## 验收

- `npm test` 全绿（含新增 envcheck / tools / dbstart 用例）。
- 对一个 Node / Python 项目，环境面板能分别显示绿色（已就绪）、黄色（缺失）、红色（命令失败）。
- 缺工具时先弹同意框，同意后才执行安装。
- 识别到数据库时弹密码框，密码不落 `profiles.json`，启动时注入 `DATABASE_URL`。
- 删除项目时询问是否删除环境残留，确认后删除 `.venv` / `node_modules` / `.devdock` 等。
