/**
 * agent-step.ts —— 公共「Python agent 步骤执行器」（阶段 2 复用）
 *
 * 模式: cli_entry 整 agent 子进程跑 + 卡挂起 + resume 断点续跑（--resume）
 * 粒度: agent 内部状态机留在 Python（零改动收编），TS 只做编排+卡拍板。
 */
import { runPythonAgent, writeDecision, type BridgeOutcome } from "./python-bridge.js";

export const V2_HOME = "/Users/haiyi/Desktop/洞察/肯特合金/Jobber Drill Bits/V2视图预览";
export const VENV_PY = `${V2_HOME}/.venv/bin/python`;

export async function runAgentStep(
  agent: "tag" | "collect" | "insight" | "monitor",
  workDir: string,
  threadId: string,
  task: Record<string, unknown>,
  resumeData: { decision?: unknown } | undefined,
  suspend: (payload: unknown) => Promise<unknown>,
  debug = false,
  onProgress?: (line: string) => void,
): Promise<BridgeOutcome> {
  if (resumeData?.decision !== undefined) {
    writeDecision(workDir, resumeData.decision);
  }
  const outcome = await runPythonAgent({
    v2Home: V2_HOME,
    venvPython: VENV_PY,
    workDir,
    agent,
    threadId,
    task,
    resume: resumeData !== undefined, // 有拍板 = 断点续跑
    timeoutMs: 3600000,
  });
  if (outcome.kind === "card") {
    if (debug) {
      console.log(`[debug] ${agent} 卡: ${outcome.card.title} | stdout 尾:`,
        outcome.stdout.slice(-300).replace(/\n/g, " ⏎ "));
    }
    await suspend({
      title: outcome.card.title,
      detail: outcome.card.detail ?? "",
      return_to: outcome.card.return_to ?? "",
      agent,
    });
  } else if (outcome.kind === "error" && debug) {
    console.log(`[debug] ${agent} error: ${outcome.error} | stdout 尾:`,
      outcome.stdout.slice(-400).replace(/\n/g, " ⏎ "));
  }
  return outcome;
}
