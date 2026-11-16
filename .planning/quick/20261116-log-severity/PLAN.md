---
slug: log-severity
created: 2026-11-16
status: complete
---

# stderr 日志被整片标红

## 问题

Django `runserver` 把启动信息写到 stderr：

```
Watching for file changes with StatReloader
```

DevDock 之前按流着色，所有 stderr 都标红，看起来像报错。

## 修复

1. 新增 `renderer/log-severity.js`：按内容分级，而不是按流。
   - 红：`error` / `Exception` / `EADDRINUSE` / `拒绝访问` / Python `Traceback` 整段
   - 黄：`warning` / `DeprecationWarning`
   - 正常：stderr 里的启动进度、访问日志
2. `app.js` 实时输出与重建日志都走同一分类器；`Traceback` 连续行保持红色，空行后恢复。
3. 清空日志、删除项目时重置分类器状态。
4. 顺带修掉没有数据库口令时仍提示「正在准备数据库环境…」的噪音。

## 验证

- 新增 6 条 `log-severity` 用例。
- Electron 冒烟：构造 stderr 输出 `Watching...` / `Starting development server...`，DOM 里 class 为空（正常色），页面无异常。
