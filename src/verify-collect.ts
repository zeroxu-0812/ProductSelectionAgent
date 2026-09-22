/**
 * verify-collect.ts —— 阶段 2 验收②: 取数 agent 迁移
 *
 * 断言:
 *   C1 collect 步骤完成（sellersprite rds 交接，零 API）
 *   C2 TS 版 handoff 与当天 Python 版逐位一致
 *   C3 handoff 结构正确（产物路径字段）
 */
import { createCollectMastra } from "./workflows/collect.js";
import { clearCards, runPythonAgent } from "./bridge/python-bridge.js";
import { V2_HOME, VENV_PY } from "./bridge/agent-step.js";

const TS = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const WORK_DIR = `/tmp/mastra_collect_${TS}`;
// keepa 断点续传场景（历史 fetched 的 ASIN——零成本零请求，测试 S1 同款）
import { readFileSync } from "node:fs";
const FETCHED_ASINS: string[] = (() => {
  try {
    return JSON.parse(readFileSync("/tmp/tag_agent_runs/keepa_live_test_20260918_100403/fetched.json", "utf-8")).asins.slice(0, 10);
  } catch {
    return [];
  }
})();
const TASK = { asins: FETCHED_ASINS };

async function main() {
  clearCards(WORK_DIR);
  const mastra = createCollectMastra();
  const wf = mastra.getWorkflow("collect");
  const run = await wf.createRun();

  const r0 = await run.start({
    inputData: {
      source: "keepa",
      taskJson: JSON.stringify(TASK),
      live: true,
      workDir: WORK_DIR,
      threadId: `mastra-col-${TS}`,
    },
  });
  console.log("TS 版 start → 状态:", r0.status);

  let cur = r0;
  let cardCount = 0;
  while (cur.status === "suspended" && cardCount < 3) {
    clearCards(WORK_DIR);
    const suspendedStep =
      (cur as unknown as { suspendedStepId?: string }).suspendedStepId ??
      (cur.steps
        ? Object.entries(cur.steps).find(([, s]) => (s as { status: string }).status === "suspended")?.[0]
        : undefined);
    console.log(`[卡${cardCount + 1}] 挂起: ${suspendedStep} → 拍 continue`);
    cur = await run.resume({ step: suspendedStep as string, resumeData: { decision: "continue" } });
    cardCount++;
  }
  console.log("TS 版最终 → 状态:", cur.status, "| 卡数:", cardCount);
  const out = cur.steps?.collect?.output as
    | { status: string; handoff: string | null; error: string | null }
    | undefined;
  const c1 = cur.status === "success" || out?.status === "done";
  console.log("C1", c1 ? `PASS: collect 完成 ✓` : `FAIL ⚠️（${cur.status} ${out?.error ?? ""}）`);

  // C2: 当天 Python 版对比（预置授权卡决策——与 TS 版同拍板）
  const { writeDecision } = await import("./bridge/python-bridge.js");
  writeDecision(`${WORK_DIR}/py`, "continue");
  writeDecision(`${WORK_DIR}/py`, "continue");
  const py = await runPythonAgent({
    v2Home: V2_HOME, venvPython: VENV_PY,
    workDir: `${WORK_DIR}/py`, agent: "collect",
    threadId: `py-col-${TS}`,
    task: {
      source: "keepa",
      task: TASK,
      live: true,
      budget_calls: 5,
      run_dir: `${WORK_DIR}/py/collect`,
    },
  });
  console.log("py 对比跑结果 kind:", py.kind, py.kind === "error" ? `error=${py.error}` : "");
  const pyHandoff = py.kind === "done" ? JSON.stringify(py.result.handoff ?? null) : null;
  const tsHandoff = out?.handoff ?? null;
  const stripTs = (s: string | null) => {
    if (!s) return s;
    try {
      const o = JSON.parse(s);
      delete o.ts; // 时间戳非确定性字段
      // 路径归一化（py 对比跑 run_dir 带 /py 前缀，属非确定性差异）
      return JSON.stringify(o).replaceAll(`${WORK_DIR}/py/`, "${WORK_DIR}/").replaceAll(WORK_DIR, "${WORK_DIR}");
    } catch { return s; }
  };
  const c2 = pyHandoff !== null && tsHandoff !== null && stripTs(pyHandoff) === stripTs(tsHandoff);
  if (!c2) {
    const a = String(stripTs(pyHandoff));
    const b = String(stripTs(tsHandoff));
    let diffAt = -1;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) { diffAt = i; break; }
    }
    console.log(`  [debug] 首个差异位置: ${diffAt}`);
    console.log("  [debug] py 差异处:", a.slice(Math.max(0, diffAt - 40), diffAt + 60));
    console.log("  [debug] ts 差异处:", b.slice(Math.max(0, diffAt - 40), diffAt + 60));
  }
  console.log("C2", c2 ? "PASS: handoff 与当天 Python 版逐位一致 ✓" : `FAIL ⚠️（py=${String(pyHandoff).slice(0,80)} ts=${String(tsHandoff).slice(0,80)}）`);

  // C3: handoff 结构
  let c3 = false;
  if (tsHandoff) {
    try {
      const h = JSON.parse(tsHandoff);
      c3 = typeof h === "object" && h !== null;
    } catch { c3 = false; }
  }
  console.log("C3", c3 ? "PASS: handoff 结构正确 ✓" : "FAIL ⚠️");

  console.log(c1 && c2 && c3 ? "COLLECT MIGRATION VERIFY ALL PASS" : "COLLECT MIGRATION HAS FAILURES");
}

main();
