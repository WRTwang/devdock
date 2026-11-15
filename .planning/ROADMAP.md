# ROADMAP

## M1 — 可用的启动器（v0.1）

- [x] 项目档案 CRUD + 本地持久化（profiles.json）
- [x] 项目类型自动检测（Node / Python / Rust / Go / .NET / Docker / Ruby / PHP）
- [x] 一键搭环境（安装命令，流式日志）
- [x] 一键启动 / 停止（Windows 进程树）
- [x] 活跃环境唯一：切换即停旧进程 + 还原 `.env`
- [x] 实时日志面板 + 日志落盘
- [x] 深色 GUI，新建/编辑表单

## M2 — 发布就绪（v1.0）

- [ ] `npm test` 覆盖 store / detector / env 合并
- [ ] electron-builder 打包 NSIS 安装包 + 免安装版
- [ ] GitHub Actions 三件套：CI、Release 上传、CHANGELOG
- [ ] README（截图、安装、快速上手、FAQ）+ LICENSE

## 后续（不进 v1）

- 端口占用检测 / 一键释放
- 项目分组与搜索
- 预设模板（React / FastAPI / Spring Boot）
- 系统托盘 + 开机自启
- macOS / Linux 支持
