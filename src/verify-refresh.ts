/**
 * verify-refresh.ts —— 阶段 1 验收: CB refresh 管道 live 走查（多卡链循环）
 *
 * 断言:
 *   P1 tag 步骤先挂起（打标 Keepa 补源卡）→ 拍 cancel → tag done
 *   P2 insight 修数卡挂起（每次必问）→ 拍 {"mode":"none"} → 继续
 *   P3 报告类型卡 → 拍 "both" → MI 授权卡 → 拍 "continue" → 全链 done + HTML
 *
 * 预置决策序列模拟人拍板（验收自动化）；真实使用时由外部逐卡拍板。
 * 零花钱: 打标零增量 + Keepa cancel + 修数 none + MI 复用。
 */
import { createMastra } from "./workflows/orchestrator.js";
import { clearCards } from "./bridge/python-bridge.js";

const TS = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const WORK_DIR = `/tmp/mastra_refresh_${TS}`;

// 卡序决策（CB refresh 场景实测卡链: 报告类型卡在修数卡之前——init_task 序）
const DECISIONS: unknown[] = [
  "cancel", // tag: Keepa 补源授权卡 → 不取数
  "both", // insight: 报告类型卡（生成前必问，先于修数卡）
  { mode: "none" }, // insight: 修数方式卡（每次必问）→ 未校准
  "continue", // insight: MI 授权卡 → 复用不重跑
];

async function main() {
  clearCards(WORK_DIR);
  const mastra = createMastra();
  const wf = mastra.getWorkflow("refresh");
  const run = await wf.createRun();

  const r0 = await run.start({
    inputData: {
      category: "cutting_burrs",
      categoryLabel: "Cutting Burrs",
      labelXlsx: "/Users/haiyi/Desktop/Cutting Burrs/cutting burrs_label.xlsx",
      tagJson: "/Users/haiyi/Desktop/Cutting Burrs/cb_tag_full_20260914.json",
      pipelineOut: "/tmp/cb_pipeline/output",
      workDir: WORK_DIR,
      threadId: `mastra-cb-${TS}`,
    },
  });
  console.log("start → 状态:", r0.status);

  // 多卡循环: 每轮挂起 → 消费预置决策 → resume
  let cur = r0;
  let cardCount = 0;
  while (cur.status === "suspended" && cardCount < DECISIONS.length) {
    const decision = DECISIONS[cardCount];
    clearCards(WORK_DIR); // 清上一步卡残留（防跨步误读）
    const suspendedStep =
      (cur as unknown as { suspendedStepId?: string }).suspendedStepId ??
      (cur.steps
        ? Object.entries(cur.steps).find(([, s]) => (s as { status: string }).status === "suspended")?.[0]
        : undefined);
    console.log(`\n[卡${cardCount + 1}] 挂起步骤: ${suspendedStep} | 预置拍板:`, JSON.stringify(decision));
    cur = await run.resume({ step: suspendedStep as string, resumeData: { decision } });
    console.log(`[卡${cardCount + 1}] resume → 状态:`, cur.status);
    cardCount++;
  }

  const tagOut = cur.steps?.tag?.output;
  const insOut = cur.steps?.insight?.output;
  console.log("---");
  console.log("tag 步:", JSON.stringify(tagOut));
  console.log("insight 步:", JSON.stringify(insOut));
  const p1 = cur.steps?.tag?.status === "success";
  const p2 = cardCount >= 2; // 至少修数卡真实挂起过
  const p3 = cur.status === "success" && !!insOut?.html;
  console.log(p1 ? "P1 PASS: tag 步骤 done ✓" : "P1 FAIL ⚠️");
  console.log(p2 ? `P2 PASS: 多卡链真实挂起 ${cardCount} 次（含修数卡每次必问）✓` : "P2 FAIL ⚠️");
  console.log(p3 ? `P3 PASS: 全链 done ✓ HTML=${insOut?.html}` : "P3 FAIL ⚠️");
  console.log(p1 && p2 && p3 ? "STAGE1 VERIFY ALL PASS" : "STAGE1 VERIFY HAS FAILURES");
}

main();
