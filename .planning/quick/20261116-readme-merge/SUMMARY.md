---
slug: readme-merge
status: complete
completed: 2026-11-16
---

# 结果

- `electron/readme-detect.js`：新增 `setupEcosystem()`，把 README 安装命令映射到语言生态。
- `electron/envcheck.js`：新增 `mergeReadmeInstall()` / `venvNameFromCommand()` / `venvAt()` / `rewriteToVenv()`；
  README 命令并回同语言体检项，README 优先；裸 pip 改写到项目 venv；未创建的 venv 先建；无法归类才单独成条。
- 已有 venv 时安装命令不再重复 `python -m venv`。
- 测试新增 5 条，`npm test` 全绿；README / CHANGELOG 更新到 0.4.2。
