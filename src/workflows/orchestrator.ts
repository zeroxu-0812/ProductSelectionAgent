/**
 * orchestrator.ts —— 编排器 workflow（阶段 1）: refresh 管道
 *
 * 对应 Python 侧编排器 refresh 管道: tag → insight（卡挂起 → 人拍板 → resume）
 *
 * ⚠️ 幂等设计（Mastra suspend 后 execute 重执行）:
 *   每步 execute: 首跑 spawn → 若 CARD 则 suspend（快照存 runId）
 *                resume 重执行 → resumeData 拍板 → writeDecision → 重新 spawn（--resume）
 *                Python 侧 LangGraph checkpoint 从断点继续 → RESULT 或下一张卡
 */
import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { runPythonAgent, writeDecision, clearCards, type BridgeOutcome } from "../bridge/python-bridge.js";

const V2_HOME = "/Users/haiyi/Desktop/洞察/肯特合金/Jobber Drill Bits/V2视图预览";
const VENV_PY = `${V2_HOME}/.venv/bin/python`;

/** 单步通用执行器: 跑 Python agent，卡则挂起 */
async function runAgentStep(
  agent: "tag" | "collect" | "insight" | "monitor",
  workDir: string,
  threadId: string,
  task: Record<string, unknown>,
  resumeData: { decision?: unknown } | undefined,
  suspend: (payload: unknown) => Promise<unknown>,
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
    console.log(`[debug] ${agent} 卡: ${outcome.card.title} | stdout 尾:`,
      outcome.stdout.slice(-300).replace(/\n/g, " ⏎ "));
    await suspend({
      title: outcome.card.title,
      detail: outcome.card.detail ?? "",
      return_to: outcome.card.return_to ?? "",
      agent,
    });
  } else if (outcome.kind === "error") {
    console.log(`[debug] ${agent} error: ${outcome.error} | stdout 尾:`,
      outcome.stdout.slice(-400).replace(/\n/g, " ⏎ "));
  }
  return outcome;
}

/** tag 步骤（输出透传 insight 所需字段——1.67 上步输出=下步输入） */
const tagStep = createStep({
  id: "tag",
  description: "打标 agent（Python 子进程）",
  inputSchema: z.object({
    category: z.string(),
    categoryLabel: z.string(),
    labelXlsx: z.string(),
    tagJson: z.string(),
    pipelineOut: z.string(),
    workDir: z.string(),
    threadId: z.string(),
  }),
  resumeSchema: z.object({ decision: z.unknown() }),
  outputSchema: z.object({
    status: z.string(),
    reportPath: z.string().nullable(),
    category: z.string(),
    categoryLabel: z.string(),
    labelXlsx: z.string(),
    tagJson: z.string(),
    pipelineOut: z.string(),
    workDir: z.string(),
    threadId: z.string(),
  }),
  execute: async ({ inputData, resumeData, suspend }) => {
    const outcome = await runAgentStep(
      "tag",
      inputData.workDir,
      `${inputData.threadId}-tag`,
      {
        category: inputData.category,
        label_xlsx: inputData.labelXlsx,
        tag_json: inputData.tagJson,
        budget_cny: 50,
        dry_run: false,
        run_dir: `${inputData.workDir}/tag`,
      },
      resumeData,
      suspend,
    );
    const status = outcome.kind === "done" ? "done" : outcome.kind;
    return {
      status,
      reportPath: outcome.kind === "done" ? ((outcome.result.report_path as string) ?? null) : null,
      category: inputData.category,
      categoryLabel: inputData.categoryLabel,
      labelXlsx: inputData.labelXlsx,
      tagJson: inputData.tagJson,
      pipelineOut: inputData.pipelineOut,
      workDir: inputData.workDir,
      threadId: inputData.threadId,
    };
  },
});

/** insight 步骤（输入 = tag 输出透传；修数卡/报告类型卡/MI 授权卡都会真实挂起） */
const insightStep = createStep({
  id: "insight",
  description: "洞察 agent（Python 子进程，修数卡每次必问）",
  inputSchema: z.object({
    status: z.string(),
    reportPath: z.string().nullable(),
    category: z.string(),
    categoryLabel: z.string(),
    labelXlsx: z.string(),
    tagJson: z.string(),
    pipelineOut: z.string(),
    workDir: z.string(),
    threadId: z.string(),
  }),
  resumeSchema: z.object({ decision: z.unknown() }),
  outputSchema: z.object({
    status: z.string(),
    html: z.string().nullable(),
    htmlSizeMb: z.number().nullable(),
    error: z.string().nullable(),
  }),
  execute: async ({ inputData, resumeData, suspend }) => {
    const outcome = await runAgentStep(
      "insight",
      inputData.workDir,
      `${inputData.threadId}-insight`,
      {
        category: inputData.category,
        category_label: inputData.categoryLabel,
        tag_json: inputData.tagJson,
        label_xlsx: inputData.labelXlsx,
        mode: "rds",
        pipeline_out: inputData.pipelineOut,
        task: {}, // 修数方式不预置 → 修数卡真实弹（每次必问）
        run_dir: `${inputData.workDir}/insight`,
      },
      resumeData,
      suspend,
    );
    if (outcome.kind === "done") {
      const h = (outcome.result.handoff as Record<string, unknown>) ?? {};
      return {
        status: "done",
        html: (h.html as string) ?? null,
        htmlSizeMb: (h.html_size_mb as number) ?? null,
        error: null,
      };
    }
    return { status: outcome.kind, html: null, htmlSizeMb: null,
             error: outcome.kind === "error" ? outcome.error : null };
  },
});

/** refresh 管道: tag → insight */
const refreshWorkflow = createWorkflow({
  id: "refresh",
  inputSchema: z.object({
    category: z.string(),
    categoryLabel: z.string(),
    labelXlsx: z.string(),
    tagJson: z.string(),
    pipelineOut: z.string(),
    workDir: z.string(),
    threadId: z.string(),
  }),
  outputSchema: z.object({
    html: z.string().nullable(),
    htmlSizeMb: z.number().nullable(),
  }),
})
  .then(tagStep)
  .then(insightStep)
  .commit();

export function createMastra() {
  return new Mastra({
    storage: new LibSQLStore({
      id: "psa-orchestrator",
      url: "file:" + process.cwd() + "/.mastra/orchestrator.db",
    }),
    workflows: { refresh: refreshWorkflow },
  });
}

export { refreshWorkflow };
