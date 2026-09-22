/**
 * hitl-demo.ts —— 阶段 0 关键语义验证: HITL suspend/resume（@mastra/core 1.67）
 *
 * 对应 Python 侧真实卡: 「类目修数方式确认（每次必问）」
 * 验证三件事:
 *   V1 suspend 后 run 状态 = suspended，快照保留（libsql 持久化）
 *   V2 resume(resumeData=JSON拍板) → execute 重执行拿到拍板值
 *   V3 非法拍板拒绝 → 再次 suspend（宁问不猜语义）
 */
import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";

const REPAIR_MODES = ["anchor", "coef", "none"] as const;

/** 修数方式卡步骤: 首次执行 suspend；resume 后从 resumeData 读拍板并校验 */
const repairCardStep = createStep({
  id: "repair-card",
  description: "修数方式卡（每次必问）: suspend 等拍板，非法重挂起",
  inputSchema: z.object({ category: z.string() }),
  resumeSchema: z.object({ mode: z.string() }),
  outputSchema: z.object({
    mode: z.string().nullable(),
    rejected: z.boolean(),
    category: z.string(),
  }),
  execute: async ({ inputData, resumeData, suspend }) => {
    const { mode } = resumeData ?? {};
    if (mode === undefined) {
      await suspend({ title: `类目「${inputData.category}」修数方式确认（每次必问）` });
      return { mode: null, rejected: false, category: inputData.category };
    }
    if (!REPAIR_MODES.includes(mode as (typeof REPAIR_MODES)[number])) {
      await suspend({ title: `非法修数方式「${mode}」，请重新拍板（anchor/coef/none）` });
      return { mode: null, rejected: true, category: inputData.category };
    }
    return { mode: mode as string, rejected: false, category: inputData.category };
  },
});

const repairWorkflow = createWorkflow({
  id: "repair-hitl",
  inputSchema: z.object({ category: z.string() }),
  outputSchema: z.object({
    mode: z.string().nullable(),
    rejected: z.boolean(),
    category: z.string(),
  }),
})
  .then(repairCardStep)
  .commit();

const mastra = new Mastra({
  storage: new LibSQLStore({
    id: "psa-local",
    url: "file:" + process.cwd() + "/.mastra/mastra.db",
  }),
  workflows: { repairHitl: repairWorkflow },
});

async function main() {
  // V1: 启动 → 挂起在修数卡
  const wf = mastra.getWorkflow("repairHitl");
  const run = await wf.createRun();
  const r1 = await run.start({ inputData: { category: "paint_scrapers" } });
  console.log("V1 suspend 后状态:", r1.status, "| 结果:", JSON.stringify(r1.results));

  // V2: 拍板 anchor → resume 后 execute 重执行
  const r2 = await run.resume({ step: repairCardStep, resumeData: { mode: "anchor" } });
  console.log("V2 拍板 anchor → 状态:", r2.status, "| 步骤输出:", JSON.stringify(r2.steps?.["repair-card"]?.output));
  const v2ok = r2.status === "success" && r2.steps["repair-card"].output.mode === "anchor";

  // V3: 非法拍板 → 再次挂起
  const run2 = await wf.createRun();
  await run2.start({ inputData: { category: "cutting_burrs" } });
  const r3 = await run2.resume({ step: repairCardStep, resumeData: { mode: "invalid_mode" } });
  console.log("V3 非法拍板 → 状态:", r3.status, "| 步骤输出:", JSON.stringify(r3.steps?.["repair-card"]?.output));
  const v3ok = r3.status === "suspended"; // 非法拍板 → 重新挂起（宁问不猜语义）

  console.log("---");
  console.log(v2ok ? "V2 PASS: JSON 拍板 anchor 语义等价 ✓" : "V2 FAIL ⚠️");
  console.log(v3ok ? "V3 PASS: 非法拍板重挂起（宁问不猜）等价 ✓" : "V3 FAIL ⚠️");
  console.log(v2ok && v3ok ? "HITL-DEMO ALL PASS" : "HITL-DEMO HAS FAILURES");
}

main();
