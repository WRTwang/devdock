# PLAN — v0.1

## 任务分解

1. 脚手架
   - [x] `package.json`（electron 45 / electron-builder 26）
   - [x] `.gitignore` / `.editorconfig`
   - [x] 目录：`electron/` `renderer/` `test/` `assets/`
2. 主进程内核（无 UI 依赖，可单测）
   - [x] `store.js`：读写 `profiles.json`，损坏自愈
   - [x] `detector.js`：特征文件 → 命令建议
   - [x] `dotenv.js`：`.env` 备份 / 合并写入 / 还原
   - [x] `runner.js`：spawn 封装、进程树 kill、日志广播
   - [x] `environment.js`：活跃环境编排（切换 / 启动 / 清理）
   - [x] `main.js`：窗口、IPC、生命周期清理
   - [x] `preload.js`：最小 API 暴露
3. 渲染层
   - [x] `index.html` 结构
   - [x] `styles.css` 设计系统（深色、终端）
   - [x] `app.js` 状态机、表单、日志渲染、事件订阅
4. 验证
   - [x] `node --test`：store / detector / dotenv / runner / environment（38 项）
   - [ ] 冷启动 `electron .` 无报错
   - [ ] 真实项目端到端冒烟（选一个本地 Node 仓库）
5. 发布
   - [x] README / LICENSE / CHANGELOG
   - [x] electron-builder 配置（nsis + portable）
   - [x] `.github/workflows/ci.yml`、`release.yml`
   - [x] 打 tag 说明与发布步骤

## 验收清单

- [x] 新建项目 → 自动检测填充命令
- [x] 搭环境日志实时滚动，退出码为 0 时提示成功
- [x] 启动后状态点变绿，进程出现在任务管理器
- [x] 切换项目后旧进程消失、旧 `.env` 还原
- [x] 重启应用后活跃项目保留
- [ ] `npm run dist` 产出安装包
