---
slug: env-inspect
status: complete
completed: 2026-11-16
---

# 结果

## 做了什么

- 新增 `electron/tools.js`：工具版本探测（Node / npm / pnpm / yarn / bun / Python / uv / Poetry / pipenv / Docker 等），
  最低版本判断与获取 / 升级建议；Windows 的 `.cmd` shim 通过 `cmd /c` 执行。
- 新增 `electron/dbstart.js`：PostgreSQL / MySQL / Redis / MongoDB 识别、`sc query` 本机服务探测、
  `net start` 启动、连接串与 `DATABASE_URL` / `PGPASSWORD` 注入。
- 新增 `electron/envcheck.js`：README 与清单联合体检，输出绿 / 黄 / 红三态、安装计划、环境残留枚举与白名单删除。
- `environment.js`：安装计划执行、数据库启动钩子、密钥注入、删除项目可连带清理环境。
- `main.js` / `preload.js`：新增 `env:inspect`、`env:install`、`env:residue`、`db:prepare`，口令仅存内存。
- 渲染层：新增「环境体检」页、彩色状态、安装计划确认弹窗、数据库口令弹窗、删除确认弹窗。
- 文档：README 功能表 / 使用步骤 / 新章节 / FAQ / 目录结构，CHANGELOG 0.4.0，版本号 0.4.0。

## 验证

- `npm test`：170+ 用例全绿（新增 18 条 envcheck / tools / dbstart / environment 用例）。
- Electron 冒烟：CDP 打开环境体检页，确认绿色 / 黄色状态、安装计划弹窗、数据库弹窗、删除弹窗渲染正常，无运行时异常。

## 已知取舍

- 数据库口令只在内存，应用重启后首次启动项目会再次询问（不落 `profiles.json`）。
- 容器数据库不强制收口令，交给 `docker compose`；需要连接串时仍可在数据库卡片里填写。
- `net start` 需要管理员权限时会提示手动命令，不会自动提权。
