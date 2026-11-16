---
slug: start-diagnosis
status: complete
completed: 2026-11-16
---

# 结果

## 做了什么

- 新增 `electron/diagnose.js`：按最近日志识别权限拒绝、端口占用、找不到命令、缺模块、缺脚本、数据库连不上、毫秒级退出，
  输出标题 / 主要问题 / 建议 / 日志摘录 / 可自动修复的动作。
- 新增 `electron/issuefix.js`：解析 `netstat -ano -p tcp` 找到端口占用者，用户确认后 `taskkill /T /F`。
- `runner.js` 记录进程退出耗时、启动命令与最近 12KB 输出，交给诊断使用。
- `main.js` 在启动进程退出后广播 `start-failed`；新增 `issue:fix`（结束端口占用、提权重启）。
- `environment.js` 启动前拦截 DevDock 自身目录，广播 `start-blocked`，不再真的起第二个实例。
- 渲染层新增问题弹窗：红色主要问题、建议列表、日志摘录，「自动修复并重试」/「以管理员身份重启」。
- README / CHANGELOG / 版本号升到 0.4.1。

## 验证

- `npm test`：183 条全绿，新增 12 条诊断 / netstat 用例。
- Electron 冒烟：把仓库目录当项目启动 → 弹「不能从 DevDock 里启动 DevDock 自己」，且没有真的生成第二个实例；
  `node -e "process.exit(0)"` → 弹「进程启动后立刻退出（code=0）」并带日志按钮。

## 已知取舍

- 端口占用的一键修复会结束占用进程（含子进程），默认需要用户点「自动修复并重试」。
- 提权重启会先退出当前 DevDock，用管理员身份重新拉起；未打包模式下参数是应用目录。
