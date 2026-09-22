# ProductSelectionAgent

电商选品多 agent 智能体 —— Mastra(TS) 编排层 + Python 生产链零改动收编（混合架构）。

**架构与面试叙事**: 见 [ARCHITECTURE.md](./ARCHITECTURE.md)

## 迁移状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| 0 | 环境 + 骨架 + suspend/resume 语义验证 | ✅ |
| 1 | 编排器 refresh 全链（4 卡挂起 + 锚值逐位一致） | ✅ |
| 2 | 4 个 agent 逐个迁（监控/取数/洞察/打标） | ✅ |
| 3 | PS 类目全链复验（29,913,902.72 逐位一致） | ✅ |

## 目录结构

```
python-bridge/cli_entry.py    # Python agent 统一入口（V2 零改动）
src/bridge/                   # 子进程桥（CARD/RESULT/ERROR 协议）+ 公共步骤执行器
src/workflows/                # 5 个 workflow: orchestrator/insight/monitor/collect/tag
src/verify-*.ts               # 6 套迁移验收（全部 ALL PASS）
```

## 验收（全部可复跑）

```bash
npm run smoke             # hello workflow 冒烟
npm run hitl-demo         # suspend/resume 语义验证
npm run verify-refresh    # 编排器 CB 全链
npm run verify-monitor    # 监控（同天双跑逐位一致）
npm run verify-collect    # 取数（handoff 逐位一致）
npm run verify-insight    # 洞察（锚值逐位一致）
npm run verify-tag        # 打标（增量铁律）
npm run verify-ps         # PS 类目全链（非 CB 通用性）
```

## 关键约定

- **零改动收编**: Python 生产链（V2 项目）一行不改，子进程 + env 注入调用
- **HITL 每次必问**: 修数方式/报告类型/授权卡必须人拍板
- **逐位一致验收**: 与 Python 版同天双跑对比，非确定性字段剔除后逐位一致
- **Python 侧路径**: `V2_HOME = /Users/haiyi/Desktop/洞察/肯特合金/Jobber Drill Bits/V2视图预览`
