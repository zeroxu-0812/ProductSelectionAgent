/**
 * tag.ts —— 打标 workflow（阶段 2 第四个迁移，最复杂 agent 但零增量路径最简单）
 *
 * 对应 Python 侧打标 agent: plan→execute→qa→enrich→vision_review→release 回环。
 * CB 历史成品在 → plan_diff 零增量 → live_noop 直达 done（无卡路径）。
 */
import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { runAgentStep } from "../bridge/agent-step.js";

const tagStep = createStep({
  id: "tag",
  description: "打标 agent（Python 子进程: 回环状态机，零增量时直达 done）",
  inputSchema: z.object({
    category: z.string(),
    labelXlsx: z.string(),
    tagJson: z.string(),
    workDir: z.string(),
    threadId: z.string(),
  }),
  resumeSchema: z.object({ decision: z.unknown() }),
  outputSchema: z.object({
    status: z.string(),
    reportPath: z.string().nullable(),
    tagJsonOut: z.string().nullable(),
    error: z.string().nullable(),
  }),
  execute: async ({ inputData, resumeData, suspend }) => {
    const outcome = await runAgentStep(
      "tag",
      inputData.workDir,
      inputData.threadId,
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
      true,
    );
    if (outcome.kind === "done") {
      return {
        status: "done",
        reportPath: (outcome.result.report_path as string) ?? null,
        tagJsonOut: (outcome.result.tag_json as string) ?? null,
        error: null,
      };
    }
    return {
      status: outcome.kind,
      reportPath: null,
      tagJsonOut: null,
      error: outcome.kind === "error" ? outcome.error : null,
    };
  },
});

const tagWorkflow = createWorkflow({
  id: "tag",
  inputSchema: z.object({
    category: z.string(),
    labelXlsx: z.string(),
    tagJson: z.string(),
    workDir: z.string(),
    threadId: z.string(),
  }),
  outputSchema: z.object({
    status: z.string(),
    reportPath: z.string().nullable(),
    tagJsonOut: z.string().nullable(),
    error: z.string().nullable(),
  }),
})
  .then(tagStep)
  .commit();

export function createTagMastra() {
  return new Mastra({
    storage: new LibSQLStore({
      id: "psa-tag",
      url: "file:" + process.cwd() + "/.mastra/tag.db",
    }),
    workflows: { tag: tagWorkflow },
  });
}

export { tagWorkflow };
