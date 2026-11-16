---
slug: start-diagnosis
created: 2026-11-16
status: complete
---

# 启动失败诊断与一键修复

## 背景

把 DevDock 自己的目录当项目启动时，日志只有：

```
[DevDock] 进程退出 (code=0)
```

外加 Chromium 的 `0x5 拒绝访问` 缓存报错。根因是第二个实例被单实例锁结束，但界面把它当正常退出，没有解释。

## 目标

- 启动前拦截「从 DevDock 启动 DevDock 自己」。
- 启动进程退出后自动归类问题（权限 / 端口 / 缺命令 / 缺依赖 / 缺脚本 / 数据库 / 秒退）。
- 能自动修的给一键修复；权限类问题弹窗让用户允许后提权重启。
- 把主要问题写进弹窗，日志摘录附在后面，而不是让用户自己翻。

## 拆分

1. `electron/diagnose.js`：纯函数诊断 + 自启动识别。
2. `electron/issuefix.js`：`netstat` 解析、结束占用端口的进程。
3. `electron/runner.js`：记录退出耗时、启动命令与最近 12KB 输出。
4. `electron/main.js`：退出后诊断并广播 `start-failed`；`issue:fix` 修复入口；提权重启。
5. `electron/environment.js`：启动前调用自启动检查，命中时广播 `start-blocked`。
6. `renderer/`：问题弹窗、自动修复并重试、以管理员身份重启。
7. 测试、README、CHANGELOG 0.4.1，提交推送。

## 验收

- 启动 DevDock 自身目录：不再真的起第二个实例，直接弹窗说明。
- 命令秒退（code=0）：弹「进程启动后立刻退出」并附日志。
- 端口占用：弹窗可一键结束占用进程后自动重试。
- `0x5` / `EACCES`：弹窗提供提权重启。
- `npm test` 全绿。
