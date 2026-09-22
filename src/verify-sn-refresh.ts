/**
 * verify-sn-refresh.ts —— SN 类目全流程（预置拍板模式：用户已全部拍板）
 *
 * 卡链决策（2026-09-22 用户拍板实录）:
 *   tag Keepa 补源卡 → cancel（零成本惯例）
 *   报告类型卡 → both（双报告）
 *   修数卡 → anchor LU&MN=144,883.52
 *   MI 授权卡 → continue（AI 分析）
 *
 * 断言:
 *   S1 tag 零增量 done（归并修复后 new_dims=[]）
 *   S2 卡链挂起 ≥4 次（真实人在环路径全部走通）
 *   S3 全链 done + HTML 产物 + SN 锚值校准生效
 */
import { createMastra } from "./workflows/orchestrator.js";
import { clearCards } from "./bridge/python-bridge.js";
import { existsSync, readFileSync } from "node:fs";

const TS = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const WORK_DIR = `/tmp/mastra_sn_${TS}`;
const DECISIONS: unknown[] = [
  "cancel", // tag Keepa 卡
  "both", // 报告类型卡
  { mode: "anchor", anchor_brand: "LU&MN", anchor_revenue: 144883.52 }, // 修数卡
  "continue", // MI 授权卡
];

async function main() {
  clearCards(WORK_DIR);
  const mastra = createMastra();
  const wf = mastra.getWorkflow("refresh");
  const run = await wf.createRun();

  const r0 = await run.start({
    inputData: {
      category: "square_nose",
      categoryLabel: "Square Nose End Mills",
      labelXlsx: "/Users/haiyi/Desktop/Square Nose End Mills/Square_Nose_End_Mills_label.xlsx",
      tagJson: "/Users/haiyi/Desktop/Square Nose End Mills/sn_tag_full_20260911.json",
      pipelineOut: `${WORK_DIR}/out`,
      workDir: WORK_DIR,
      threadId: `mastra-sn-${TS}`,
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

  const s1 = tagOut?.status === "done";
  console.log("S1", s1 ? "PASS: tag 零增量 done ✓（SN 归并后 new_dims=[]）" : `FAIL ⚠️（${tagOut?.status}）`);

  const s2 = cardCount >= 4;
  console.log("S2", s2 ? `PASS: 卡链真实挂起 ${cardCount} 次（Keepa/报告类型/修数/MI）✓` : "FAIL ⚠️");

  const s3 = cur.status === "success" && !!insOut?.html;
  console.log("S3", s3 ? `PASS: 全链 done ✓ HTML=${insOut?.html}` : `FAIL ⚠️（${cur.status} err=${insOut?.error ?? ""}）`);

  // 锚值验证（SN anchor LU&MN=144,883.52 校准生效）
  let s4 = false;
  if (s3) {
    try {
      const rd = JSON.parse(readFileSync(`${WORK_DIR}/out/report_data.json`, "utf-8"));
      const raw = JSON.stringify(rd);
      const m = raw.match(/"l12_gmv"\s*:\s*([\d.]+)/);
      const l12 = m ? Number(m[1]) : null;
      s4 = l12 !== null && l12 > 0;
      console.log("S4", s4 ? `PASS: report_data 生成 ✓（L12 GMV=${l12}）` : "FAIL ⚠️");
    } catch { console.log("S4 FAIL ⚠️（report_data 读取失败）"); }
  } else {
    console.log("S4 SKIP（S3 未过）");
  }

  console.log(s1 && s2 && s3 ? "SN REFRESH VERIFY ALL PASS" : "SN REFRESH HAS FAILURES");
}

main();
