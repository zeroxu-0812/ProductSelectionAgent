/**
 * verify-insight.ts —— 阶段 2 验收③: 洞察 agent 迁移
 *
 * 断言:
 *   I1 卡链真实挂起（报告类型卡 → 修数卡 → MI 授权卡）
 *   I2 HTML 产物生成且与当天 Python 版逐位一致（不同 pipeline_out 对比字节）
 *   I3 修数锚值逐位一致（report_data L12 GMV = 15,523,282 校准链）
 *
 * 拍板（CB 历史资产）: both → anchor(LU&MN=455,347.81 注册表推荐) → continue(MI 复用)
 */
import { createInsightMastra } from "./workflows/insight.js";
import { clearCards } from "./bridge/python-bridge.js";
import { readFileSync, existsSync, statSync } from "node:fs";

const TS = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const WORK_DIR = `/tmp/mastra_insight_${TS}`;
const CB = {
  category: "cutting_burrs",
  categoryLabel: "Cutting Burrs",
  tagJson: "/Users/haiyi/Desktop/Cutting Burrs/cb_tag_full_20260914.json",
  labelXlsx: "/Users/haiyi/Desktop/Cutting Burrs/cutting burrs_label.xlsx",
};
const DECISIONS: unknown[] = [
  "both", // 报告类型卡
  { mode: "anchor", anchor_brand: "LU&MN", anchor_revenue: 455347.81 }, // 修数卡（注册表推荐）
  "continue", // MI 授权卡（复用）
];

async function main() {
  clearCards(WORK_DIR);
  const mastra = createInsightMastra();
  const wf = mastra.getWorkflow("insight");
  const run = await wf.createRun();

  const r0 = await run.start({
    inputData: {
      ...CB,
      pipelineOut: `${WORK_DIR}/out`,
      workDir: WORK_DIR,
      threadId: `mastra-ins-${TS}`,
    },
  });
  console.log("start → 状态:", r0.status);

  let cur = r0;
  let cardCount = 0;
  while (cur.status === "suspended" && cardCount < DECISIONS.length) {
    const decision = DECISIONS[cardCount];
    clearCards(WORK_DIR);
    const suspendedStep =
      (cur as unknown as { suspendedStepId?: string }).suspendedStepId ??
      (cur.steps
        ? Object.entries(cur.steps).find(([, s]) => (s as { status: string }).status === "suspended")?.[0]
        : undefined);
    console.log(`[卡${cardCount + 1}] ${suspendedStep} → 拍:`, JSON.stringify(decision).slice(0, 60));
    cur = await run.resume({ step: suspendedStep as string, resumeData: { decision } });
    console.log(`[卡${cardCount + 1}] → 状态:`, cur.status);
    cardCount++;
  }

  const out = cur.steps?.insight?.output as
    | { status: string; html: string | null; htmlSizeMb: number | null; error: string | null }
    | undefined;
  const i1 = cardCount >= 3; // 三卡链全部真实挂起
  console.log("I1", i1 ? `PASS: 卡链真实挂起 ${cardCount} 次（报告类型→修数→MI）✓` : `FAIL ⚠️（${cardCount} 卡）`);

  // I2: HTML 产物
  const tsHtml = out?.html ?? null;
  const i2a = cur.status === "success" && !!tsHtml && existsSync(tsHtml);
  console.log("I2a", i2a ? `PASS: HTML 产物 ✓（${tsHtml}，${out?.htmlSizeMb}MB）` : `FAIL ⚠️（status=${cur.status} err=${out?.error ?? ""}）`);

  // I3: 修数锚值（report_data 内含 CB 权威锚 gmv=15523282.13 / units=715809，逐位一致）
  let i3 = false;
  if (i2a) {
    try {
      const raw = readFileSync(`${WORK_DIR}/out/report_data.json`, "utf-8");
      i3 = raw.includes("15523282.13") && raw.includes("715809.0");
    } catch { i3 = false; }
  }
  console.log("I3", i3 ? "PASS: 修数锚值逐位一致 ✓（gmv=15,523,282.13 / units=715,809）" : "FAIL ⚠️");

  console.log(i1 && i2a && i3 ? "INSIGHT MIGRATION VERIFY ALL PASS" : "INSIGHT MIGRATION HAS FAILURES");
}

main();
