/**
 * python-bridge.ts —— Python agent 子进程桥（阶段 1 核心）
 *
 * 协议（与 cli_entry.py 对应）:
 *   CARD: {json}   → agent 弹卡（interrupt），进程 exit(3)
 *   RESULT: {json} → agent 完成
 *   ERROR: {json}  → 执行异常
 *
 * 卡处理模式（Mastra suspend 语义下的设计）:
 *   子进程在卡时退出（Python LangGraph checkpoint 保状态），
 *   TS 层 workflow suspend → 人拍板 → resume 重新 spawn（--resume 断点续跑）。
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface PythonAgentConfig {
  v2Home: string; // V2 项目根（Python 生产链）
  venvPython: string; // <V2>/.venv/bin/python
  workDir: string; // 本次运行的 run_dir（卡文件/决策文件放这）
  agent: "tag" | "collect" | "insight" | "monitor";
  task: Record<string, unknown>;
  threadId: string;
  resume?: boolean; // 断点续跑（Python LangGraph checkpoint 恢复）
  timeoutMs?: number;
}

export interface CardPayload {
  title: string;
  detail?: string;
  return_to?: string;
  options?: string[];
}

export type BridgeOutcome =
  | { kind: "done"; result: Record<string, unknown>; stdout: string }
  | { kind: "card"; card: CardPayload; stdout: string }
  | { kind: "error"; error: string; exitCode: number; stdout: string; stderr: string };

/** 拍板写入决策文件（resume 时 cli_entry 读取并消费） */
export function writeDecision(workDir: string, decision: unknown): void {
  const decisions = [];
  if (existsSync(join(workDir, "decisions.json"))) {
    decisions.push(...JSON.parse(readFileSync(join(workDir, "decisions.json"), "utf-8")));
  }
  decisions.push(decision);
  writeFileSync(join(workDir, "decisions.json"), JSON.stringify(decisions), "utf-8");
}

export function clearCards(workDir: string): void {
  rmSync(join(workDir, "pending_cards.json"), { force: true });
}

/** spawn cli_entry.py 并解析协议输出 */
export function runPythonAgent(cfg: PythonAgentConfig): Promise<BridgeOutcome> {
  return new Promise((resolve) => {
    mkdirSync(cfg.workDir, { recursive: true });
    const taskFile = join(cfg.workDir, "task.json");
    writeFileSync(taskFile, JSON.stringify(cfg.task), "utf-8");

    const args = [
      join(process.cwd(), "python-bridge", "cli_entry.py"),
      "--agent", cfg.agent,
      "--task-json", taskFile,
      "--decision-file", join(cfg.workDir, "decisions.json"),
      "--thread-id", cfg.threadId,
    ];
    if (cfg.resume) args.push("--resume"); // 断点续跑（关键：否则 Python 从头重跑）
    const child = spawn(cfg.venvPython, args, {
      cwd: cfg.workDir,
      env: { ...process.env, V2_HOME: cfg.v2Home, PYTHONIOENCODING: "utf-8" },
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ kind: "error", error: `超时（${cfg.timeoutMs ?? 3600000}ms）`, exitCode: -1, stdout, stderr });
    }, cfg.timeoutMs ?? 3600000);

    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf-8"); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf-8"); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      const cardLine = lines.find((l) => l.startsWith("CARD: "));
      const resultLine = lines.find((l) => l.startsWith("RESULT: "));
      const errLine = lines.find((l) => l.startsWith("ERROR: "));
      if (cardLine) {
        resolve({ kind: "card", card: JSON.parse(cardLine.slice(6)), stdout });
      } else if (resultLine) {
        const result = JSON.parse(resultLine.slice(8)) as Record<string, unknown>;
        // interrupted_cancelled 等非完成态 → 不是 done（防误判为成功）
        if (result.status && !["done", "success", "completed"].includes(String(result.status))) {
          resolve({ kind: "error", error: `agent 非完成态: ${result.status}`, exitCode: code ?? -1, stdout, stderr });
        } else {
          resolve({ kind: "done", result, stdout });
        }
      } else if (errLine) {
        resolve({ kind: "error", error: JSON.parse(errLine.slice(7)).error ?? errLine, exitCode: code ?? -1, stdout, stderr });
      } else {
        resolve({ kind: "error", error: `异常退出 code=${code}（无协议输出）`, exitCode: code ?? -1, stdout, stderr });
      }
    });
  });
}
