# 票清单：多服务（前端 / 后端 / 数据库）支持

> 目标：一个项目可以包含多个服务，每个服务有自己的目录、安装命令、启动命令、端口和依赖关系。
> 启动时按依赖顺序编排（数据库就先绪再起后端，后端起来再起前端），停止时逆序清理。
> 约定：每票先写失败测试 → 实现 → 全量测试绿 → 提交，commit 以票号开头。

| 票号 | 内容 | 主要文件 | 状态 |
| --- | --- | --- | --- |
| 01 | 档案模型支持 `services[]`，旧档案自动迁移为单服务 | `electron/services.js`、`electron/store.js` | 进行中 |
| 02 | 服务依赖拓扑排序 + 环检测 | `electron/services.js` | 待办 |
| 03 | docker-compose 多服务检测（含数据库服务识别） | `electron/detector.js` | 待办 |
| 04 | monorepo / workspace 前后端检测 | `electron/detector.js` | 待办 |
| 05 | 端口就绪探测（TCP connect + 超时） | `electron/probe.js` | 待办 |
| 06 | 编排启动：按依赖顺序 + 数据库就绪门控 | `electron/environment.js` | 待办 |
| 07 | 逆序停止与部分失败回滚 | `electron/environment.js` | 待办 |
| 08 | 服务级日志归属（projectId + serviceId） | `electron/runner.js` | 待办 |
| 09 | UI：服务列表编辑（增删、角色、端口、依赖） | `renderer/*` | 待办 |
| 10 | UI：服务状态与分区日志 | `renderer/*` | 待办 |
| 11 | 文档、CHANGELOG、数据迁移说明 | `README.md`、`CHANGELOG.md` | 待办 |

## 本票范围（01）

- 新增 `electron/services.js`：`resolveServices(profile)`、`normalizeService(raw, index)`
- `store.normalizeProfile` 输出增加 `services` 字段
- 旧档案（只有 `startCommand`）自动迁移成一个 `role: 'app'` 的服务，命令保持不变
- 不做：排序、探测、编排、UI（后续票）

## 我假设了什么

- 服务 `id` 缺省时按顺序生成 `main` / `svc-2` / `svc-3`，保证同一档案内稳定
- `cwd` 是相对项目根目录的路径，默认 `.`
- `port` 只接受 1–65535 的整数，其余视为 `null`
- 顶层 `startCommand` / `setupCommand` 保留，供旧 UI 继续工作，不删除
