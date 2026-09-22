/**
 * verify-tag.ts —— 阶段 2 验收④: 打标 agent 迁移
 *
 * 断言:
 *   T1 tag 步骤 done（CB 历史成品 → plan_diff 零增量 → live_noop）
 *   T2 旧打标键值零改动（增量铁律: 零增量不重写输入 tag_json，md5 前后一致）
 *   T3 汇报落盘（report_path 存在）
 */
import { createTagMastra } from "./workflows/tag.js";
import { clearCards } from "./bridge/python-bridge.js";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const TS = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const WORK_DIR = `/tmp/mastra_tag_${TS}`;
const HISTORICAL = "/Users/haiyi/Desktop/Cutting Burrs/cb_tag_full_20260914.json";
const md5 = (p: string) => createHash("md5").update(readFileSync(p)).digest("hex");
const HIST_MD5_BEFORE = md5(HISTORICAL);

async function main() {
  clearCards(WORK_DIR);
  const mastra = createTagMastra();
  const wf = mastra.getWorkflow("tag");
  const run = await wf.createRun();

  const r0 = await run.start({
    inputData: {
      category: "cutting_burrs",
      labelXlsx: "/Users/haiyi/Desktop/Cutting Burrs/cutting burrs_label.xlsx",
      tagJson: HISTORICAL,
      workDir: WORK_DIR,
      threadId: `mastra-tag-${TS}`,
    },
  });
  console.log("start → 状态:", r0.status);

  let cur = r0;
  let cardCount = 0;
  while (cur.status === "suspended" && cardCount < 4) {
    clearCards(WORK_DIR);
    const suspendedStep =
      (cur as unknown as { suspendedStepId?: string }).suspendedStepId ??
      (cur.steps
        ? Object.entries(cur.steps).find(([, s]) => (s as { status: string }).status === "suspended")?.[0]
        : undefined);
    console.log(`[卡${cardCount + 1}] ${suspendedStep} → 拍 cancel（零成本验收）`);
    cur = await run.resume({ step: suspendedStep as string, resumeData: { decision: "cancel" } });
    cardCount++;
  }

  const out = cur.steps?.tag?.output as
    | { status: string; reportPath: string | null; tagJsonOut: string | null; error: string | null }
    | undefined;
  const t1 = cur.status === "success" || out?.status === "done";
  console.log("T1", t1 ? `PASS: tag 完成 ✓（卡数 ${cardCount}）` : `FAIL ⚠️（${cur.status} ${out?.error ?? ""}）`);

  // T2: 输入 tag_json 未被重写（零增量 = 旧键值零改动）
  const histAfter = md5(HISTORICAL);
  const t2 = histAfter === HIST_MD5_BEFORE;
  console.log("T2", t2 ? "PASS: 旧打标键值零改动 ✓（输入 tag_json md5 前后一致）" : "FAIL ⚠️（历史文件被改写）");

  // T3: 汇报落盘
  const t3 = !!out?.reportPath && existsSync(out.reportPath);
  console.log("T3", t3 ? `PASS: 汇报落盘 ✓（${out?.reportPath}）` : "FAIL ⚠️");

  console.log(t1 && t2 && t3 ? "TAG MIGRATION VERIFY ALL PASS" : "TAG MIGRATION HAS FAILURES");
}

main();
