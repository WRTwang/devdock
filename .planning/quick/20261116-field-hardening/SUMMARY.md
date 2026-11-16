---
slug: field-hardening
status: complete
completed: 2026-11-16
---

# 结果

- 识别：`.python-version` / `runtime.txt` 作为版本提示（不阻塞）、`Procfile(.windows)` 启动命令与 `%PORT%` 替换、`requirements/` 子目录、`setup.py`、一层子项目。
- 安装：`.env.example` → `.env`、venv 两种布局、`py -3` 优先、安装后复检、失败带日志尾部。
- 启动：`python` / `pip` / `uvicorn` 等自动切换到 venv；安装期间禁止启动。
- 删除：递归清环境 / 缓存 / 构建；原样 `.env` 副本；Docker compose down。
- 其他：数据库误报修复、Windows 引号命令修复。

## 验证

- `npm test`：207 条全绿。
- Electron E2E：Node 5006 / Python 5000 均 HTTP 200；删除后目录无 `.venv`、`node_modules`、`.devdock`、`devdock.cmd`、`.env`，源码保留。
