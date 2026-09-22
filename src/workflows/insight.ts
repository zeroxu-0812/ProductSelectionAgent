/**
 * insight.ts —— 洞察 workflow（阶段 2 第三个迁移）
 *
 * 对应 Python 侧洞察 agent: 修数链 + 双报告 + 自检五件套。
 * 卡链: 报告类型卡（生成前必问）→ 修数方式卡（每次必问）→ MI 授权卡。
 */
import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { runAgentStep } from "../bridge/agent-step.js";

const insightStep = createStep({
  id: "insight",
  description: "洞察 agent（Python 子进程: 修数链+双报告+自检）",
  inputSchema: z.object({
    category: z.string(),
    categoryLabel: z.string(),
    tagJson: z.string(),
    labelXlsx: z.string(),
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
      inputData.threadId,
      {
        category: inputData.category,
        category_label: inputData.categoryLabel,
        tag_json: inputData.tagJson,
        label_xlsx: inputData.labelXlsx,
        mode: "rds",
        pipeline_out: inputData.pipelineOut,
        task: {}, // 修数方式不预置 → 修数卡真实弹
        run_dir: `${inputData.workDir}/insight`,
      },
      resumeData,
      suspend,
      true,
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
    return {
      status: outcome.kind,
      html: null,
      htmlSizeMb: null,
      error: outcome.kind === "error" ? outcome.error : null,
    };
  },
});

const insightWorkflow = createWorkflow({
  id: "insight",
  inputSchema: z.object({
    category: z.string(),
    categoryLabel: z.string(),
    tagJson: z.string(),
    labelXlsx: z.string(),
    pipelineOut: z.string(),
    workDir: z.string(),
    threadId: z.string(),
  }),
  outputSchema: z.object({
    status: z.string(),
    html: z.string().nullable(),
    htmlSizeMb: z.number().nullable(),
    error: z.string().nullable(),
  }),
})
  .then(insightStep)
  .commit();

export function createInsightMastra() {
  return new Mastra({
    storage: new LibSQLStore({
      id: "psa-insight",
      url: "file:" + process.cwd() + "/.mastra/insight.db",
    }),
    workflows: { insight: insightWorkflow },
  });
}

export { insightWorkflow };
