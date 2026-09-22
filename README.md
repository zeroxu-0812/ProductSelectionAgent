# ProductSelectionAgent

电商选品多 agent 智能体 —— Mastra(TS) 编排层 + Python 生产链零改动收编（混合架构）。

## 定位

- **Mastra 层（本仓库）**: 多 agent 编排（4 管道 workflow）、5 个 agent 状态机、HITL（suspend/resume 人在环拍板）、记忆管理
- **Python 层（外部，子进程调用）**: 生产数据链（db_to_long 修数 / tag_* 打标 / build_report+html 报告），零改动收编

## 迁移路线

| 阶段 | 内容 | 状态 |
|---|---|---|
| 0 | 环境 + 骨架 + suspend/resume 语义验证 | ✅ 2026-09-21 |
| 1 | 编排器迁移（4 管道 workflow + Python 子进程桥 + HITL） | 进行中 |
| 2 | 5 个 agent 逐个迁（监控→取数→洞察→打标） | 未开始 |
| 3 | 回归套件 + live 复验 | 未开始 |

详细路线图与痛点清单见 `docs/MIGRATION_PLAN.md`（Python 侧 V2 项目同款文档）。

## 运行

```bash
npm install
npx tsx src/index.ts           # hello workflow 冒烟
npx tsx src/hitl-demo.ts       # suspend/resume 语义验证（HITL 前置验证）
```
