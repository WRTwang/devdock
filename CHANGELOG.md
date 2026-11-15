# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
