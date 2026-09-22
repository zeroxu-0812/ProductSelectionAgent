/**
 * monitor.ts —— 监控 workflow（阶段 2 第一个迁移）
 *
 * 对应 Python 侧监控 agent: init→fetch→verify→detect→alert→done
 * TS 侧: 调度 + 卡拍板（授权卡/告警卡）；取数与检测逻辑在 Python 子进程（零改动）。
 */
import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { runAgentStep } from "../bridge/agent-step.js";

const monitorStep = createStep({
  id: "monitor",
  description: "监控 agent（Python 子进程: Sif keywords 趋势巡检）",
  inputSchema: z.object({
    source: z.string(),
    keywords: z.array(z.string()),
    live: z.boolean(),
    workDir: z.string(),
    threadId: z.string(),
  }),
  resumeSchema: z.object({ decision: z.unknown() }),
  outputSchema: z.object({
    status: z.string(),
    detect: z.string().nullable(), // detect 结果 JSON（供验收比对）
    fetch: z.string().nullable(), // fetch 结果 JSON（趋势数据）
    error: z.string().nullable(),
  }),
  execute: async ({ inputData, resumeData, suspend }) => {
    const outcome = await runAgentStep(
      "monitor",
      inputData.workDir,
      inputData.threadId,
      {
        source: inputData.source,
        task: {
          mode: "keywords",
          keywords: inputData.keywords,
          granularity: "week",
          with_funnel: true,
        },
        live: inputData.live,
        run_dir: `${inputData.workDir}/monitor`,
      },
      resumeData,
      suspend,
      true,
    );
    if (outcome.kind === "done") {
      return {
        status: "done",
        detect: outcome.result.detect ? JSON.stringify(outcome.result.detect) : null,
        fetch: outcome.result.fetch ? JSON.stringify(outcome.result.fetch) : null,
        error: null,
      };
    }
    return {
      status: outcome.kind,
      detect: null,
      fetch: null,
      error: outcome.kind === "error" ? outcome.error : null,
    };
  },
});

const monitorWorkflow = createWorkflow({
  id: "monitor-keywords",
  inputSchema: z.object({
    source: z.string(),
    keywords: z.array(z.string()),
    live: z.boolean(),
    workDir: z.string(),
    threadId: z.string(),
  }),
  outputSchema: z.object({
    status: z.string(),
    detect: z.string().nullable(),
    fetch: z.string().nullable(),
    error: z.string().nullable(),
  }),
})
  .then(monitorStep)
  .commit();

export function createMonitorMastra() {
  return new Mastra({
    storage: new LibSQLStore({
      id: "psa-monitor",
      url: "file:" + process.cwd() + "/.mastra/monitor.db",
    }),
    workflows: { monitorKeywords: monitorWorkflow },
  });
}

export { monitorWorkflow };
