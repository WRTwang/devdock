---
slug: readme-merge
created: 2026-11-16
status: complete
---

# README 安装步骤与 Python 体检项重复

## 问题

环境体检同时出现：

- Python 依赖（已就绪）
- README 安装步骤（缺失）：`.\venv\Scripts\python.exe -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple`

同一件事被拆成两条：README 命令因为多了 venv 路径和镜像参数，与生成的安装命令字面不同，被当成独立缺失项。

## 修复

1. `readme-detect.js` 新增 `setupEcosystem()`：把安装命令归到 python / node / rust / go / ruby / php / dotnet。
2. `envcheck.js` 新增 `mergeReadmeInstall()`：
   - 能对上语言就并回对应体检项，README 命令优先；
   - README 指向已存在的 venv → 直接用；
   - 指向未创建的 venv → 先 `python -m venv <name>`；
   - 裸 `pip install` → 改写成项目 venv 解释器，避免装到系统 Python；
   - 完全对不上生态才保留独立的「README 安装步骤」。
3. 已有 venv 时不再重复执行 `python -m venv`。

## 验证

- 新增 5 条用例覆盖：README venv+pip 并回、裸 pip 改写、venv 未创建、npm 优先级、无法归类才单独成条。
- `npm test` 全绿。
