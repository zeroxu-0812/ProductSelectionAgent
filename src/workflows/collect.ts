/**
 * collect.ts —— 取数 workflow（阶段 2 第二个迁移）
 *
 * 对应 Python 侧取数 agent: 三源（sellersprite RDS / keepa / sif）+ handoff。
 * TS 侧: 调度 + 授权卡拍板；取数逻辑在 Python 子进程（零改动）。
 */
import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { runAgentStep } from "../bridge/agent-step.js";

const collectStep = createStep({
  id: "collect",
  description: "取数 agent（Python 子进程: sellersprite/keepa/sif）",
  inputSchema: z.object({
    source: z.string(),
    taskJson: z.string(), // 源任务参数 JSON（透传 task 字段）
    live: z.boolean(),
    workDir: z.string(),
    threadId: z.string(),
  }),
  resumeSchema: z.object({ decision: z.unknown() }),
  outputSchema: z.object({
    status: z.string(),
    handoff: z.string().nullable(), // handoff JSON（供验收比对）
    error: z.string().nullable(),
  }),
  execute: async ({ inputData, resumeData, suspend }) => {
    const task = JSON.parse(inputData.taskJson) as Record<string, unknown>;
    const outcome = await runAgentStep(
      "collect",
      inputData.workDir,
      inputData.threadId,
      {
        source: inputData.source,
        task,
        live: inputData.live,
        budget_calls: 500,   // 预算阈值 500 次调用（方案 A: 正常取数不弹卡，异常大单才弹）
        authorized: true,    // 对话指令「取数 xx」即授权（2026-10-08 用户拍板）
        run_dir: `${inputData.workDir}/collect`,
      },
      resumeData,
      suspend,
      true,
    );
    if (outcome.kind === "done") {
      return {
        status: "done",
        handoff: outcome.result.handoff ? JSON.stringify(outcome.result.handoff) : null,
        error: null,
      };
    }
    return {
      status: outcome.kind,
      handoff: null,
      error: outcome.kind === "error" ? outcome.error : null,
    };
  },
});

const collectWorkflow = createWorkflow({
  id: "collect",
  inputSchema: z.object({
    source: z.string(),
    taskJson: z.string(),
    live: z.boolean(),
    workDir: z.string(),
    threadId: z.string(),
  }),
  outputSchema: z.object({
    status: z.string(),
    handoff: z.string().nullable(),
    error: z.string().nullable(),
  }),
})
  .then(collectStep)
  .commit();

export function createCollectMastra() {
  return new Mastra({
    storage: new LibSQLStore({
      id: "psa-collect",
      url: "file:" + process.cwd() + "/.mastra/collect.db",
    }),
    workflows: { collect: collectWorkflow },
  });
}

export { collectWorkflow };
