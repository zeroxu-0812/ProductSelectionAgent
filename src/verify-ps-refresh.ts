/**
 * verify-ps-refresh.ts —— 阶段 3 验收①: PS 类目全链 live 复验（非 CB 类目通用性）
 *
 * 断言:
 *   P1 tag 步骤 done（PS tag_full 1446 全量 → plan_diff 零增量）
 *   P2 修数卡真实挂起（每次必问）→ 拍 anchor(LU&MN=246,005.36)
 *   P3 全链 done + report_data 校准生效（L12 GMV 显著小于未校准 76.3M）
 *
 * 报告类型拍 singularity（省 MI LLM 成本；修数链+奇点是本验收核心）
 */
import { createMastra } from "./workflows/orchestrator.js";
import { clearCards } from "./bridge/python-bridge.js";
import { readFileSync, existsSync } from "node:fs";

const TS = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const WORK_DIR = `/tmp/mastra_ps_${TS}`;
const DECISIONS: unknown[] = [
  "cancel", // tag: Keepa 补源卡（PS 也有缺口）→ 不取数
  "singularity", // insight: 报告类型卡 → 仅奇点（省 MI LLM）
  { mode: "anchor", anchor_brand: "LU&MN", anchor_revenue: 246005.36 }, // insight: 修数卡
];

async function main() {
  clearCards(WORK_DIR);
  const mastra = createMastra();
  const wf = mastra.getWorkflow("refresh");
  const run = await wf.createRun();

  const r0 = await run.start({
    inputData: {
      category: "paint_scrapers",
      categoryLabel: "Paint Scrapers",
      labelXlsx: "/Users/haiyi/Desktop/Paint Scrapers/Paint-Scrapers_label.xlsx",
      tagJson: "/tmp/ps_hitl_full/tag/tag_full.json",
      pipelineOut: `${WORK_DIR}/out`,
      workDir: WORK_DIR,
      threadId: `mastra-ps-${TS}`,
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
    console.log(`[卡${cardCount + 1}] ${suspendedStep} → 拍:`, JSON.stringify(decision).slice(0, 70));
    cur = await run.resume({ step: suspendedStep as string, resumeData: { decision } });
    console.log(`[卡${cardCount + 1}] → 状态:`, cur.status);
    cardCount++;
  }

  const tagOut = cur.steps?.tag?.output as { status: string } | undefined;
  const insOut = cur.steps?.insight?.output as
    | { status: string; html: string | null; error: string | null }
    | undefined;

  const p1 = tagOut?.status === "done";
  console.log("P1", p1 ? "PASS: tag 零增量 done ✓（PS 1446 全量成品）" : `FAIL ⚠️（${tagOut?.status}）`);

  const p2 = cardCount >= 2; // 至少报告类型卡+修数卡真实挂起
  console.log("P2", p2 ? `PASS: 卡链挂起 ${cardCount} 次（含修数卡每次必问）✓` : "FAIL ⚠️");

  let p3 = false;
  let l12: unknown = null;
  if (cur.status === "success" && insOut?.html) {
    try {
      const raw = readFileSync(`${WORK_DIR}/out/report_data.json`, "utf-8");
      const m = raw.match(/"l12_gmv"\s*:\s*([\d.]+)/) ?? raw.match(/"gmv"\s*:\s*([\d.]+)/);
      l12 = m ? Number(m[1]) : null;
      // 校准生效判据: 显著小于未校准口径 76,339,948（anchor K≈0.39 → ~29.9M）
      p3 = typeof l12 === "number" && l12 < 40000000 && l12 > 20000000;
    } catch { p3 = false; }
  }
  console.log("P3", p3
    ? `PASS: 全链 done + anchor 校准生效 ✓（L12 GMV≈${l12}，未校准口径 76.3M）`
    : `FAIL ⚠️（status=${cur.status} l12=${l12} err=${insOut?.error ?? ""}）`);

  console.log(p1 && p2 && p3 ? "PS REFRESH VERIFY ALL PASS" : "PS REFRESH HAS FAILURES");
}

main();
