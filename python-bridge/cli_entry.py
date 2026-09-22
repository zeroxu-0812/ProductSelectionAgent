#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""cli_entry.py —— Python agent 统一入口（Mastra 桥，放 TS 仓库内，V2 零改动）

用法（由 python-bridge.ts spawn）:
  <V2>/.venv/bin/python cli_entry.py --agent <name> --task-json <file>
      [--decision-file <file>] [--resume] [--thread-id <id>]

协议（stdout 逐行，TS 侧解析）:
  CARD: {json}          —— agent 弹卡（interrupt），决策文件空 → 本进程 exit(3)，
                           等 TS 层人拍板后重新 spawn（--resume 断点续跑 + 决策预置）
  RESULT: {json}        —— agent 完成（status/route/handoff/report 等）
  ERROR: {json}         —— 执行异常

设计（对应旧系统 ps_hitl_full.py decisions 队列模式的 TS 版）:
  interrupt 不可跨进程存活 → 卡时退出（LangGraph checkpoint 保状态），
  resume 重新 spawn 从 checkpoint 恢复。
"""
from __future__ import annotations

import argparse
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.environ["V2_HOME"])  # TS 桥注入：V2 项目根

AGENTS = {}  # 延迟导入（避免未用到时 import 失败）


def _load_agents():
    from core.tagging.agent.api import run_tagging_agent
    from core.collect.agent.api import run_collection_agent
    from core.insight.agent.api import run_insight_agent
    from core.monitor.agent.api import run_monitor_agent
    AGENTS.update({"tag": run_tagging_agent, "collect": run_collection_agent,
                   "insight": run_insight_agent, "monitor": run_monitor_agent})


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--agent", required=True)
    ap.add_argument("--task-json", required=True)
    ap.add_argument("--decision-file", default="")
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--thread-id", default="")
    args = ap.parse_args()

    _load_agents()
    if args.agent not in AGENTS:
        print(f"ERROR: {json.dumps({'error': f'未知 agent: {args.agent}'}, ensure_ascii=False)}")
        return 2

    task = json.load(open(args.task_json, encoding="utf-8"))
    if args.resume:
        task["resume"] = True
        task["thread_id"] = args.thread_id or task.get("thread_id")
    elif args.thread_id:
        task["thread_id"] = args.thread_id

    decisions: list = []
    if args.decision_file and os.path.exists(args.decision_file):
        decisions = json.load(open(args.decision_file, encoding="utf-8"))

    def provider(payload):
        if decisions:
            d = decisions.pop(0)
            # 消费持久化: 写回文件（防残留决策被后续步骤误食）
            if args.decision_file:
                json.dump(decisions, open(args.decision_file, "w", encoding="utf-8"))
            return d
        # 卡 → 写卡文件 + 退出（checkpoint 保留），TS 层读卡文件挂起
        card = {"title": payload.get("title"), "detail": payload.get("detail"),
                "return_to": payload.get("return_to"), "options": payload.get("options")}
        card_path = os.path.join(os.path.dirname(args.task_json) or ".", "pending_cards.json")
        cards = json.load(open(card_path, encoding="utf-8")) if os.path.exists(card_path) else []
        cards.append(card)
        json.dump(cards, open(card_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        print(f"CARD: {json.dumps(card, ensure_ascii=False)}", flush=True)
        sys.exit(3)  # 挂起信号：TS 层 suspend，人拍板后 --resume 重入

    try:
        result = AGENTS[args.agent](task, decision_provider=provider)
        print(f"RESULT: {json.dumps(result, ensure_ascii=False, default=str)}", flush=True)
        return 0
    except SystemExit as e:
        return int(e.code or 0)
    except Exception as e:
        print(f"ERROR: {json.dumps({'error': str(e)[:500]}, ensure_ascii=False)}", flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
