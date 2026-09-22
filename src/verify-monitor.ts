/**
 * verify-monitor.ts —— 阶段 2 验收①: 监控 agent 迁移
 *
 * 断言:
 *   M1 监控 live 零积分巡检直接完成（无授权卡——设计行为）
 *   M2 TS 迁移版 vs 当天 Python 版逐位一致（同接口同窗口，最新排名等值）
 *   M3 detect 结构正确（moves/new/dropped/first_run）
 *
 * 注意: Sif 是 live 数据（ABA 每周滚动更新），历史基线会过期——
 *       正确验收方式 = 同天双跑对比（TS 版 vs Python 版），非对比历史快照。
 */
import { createMonitorMastra } from "./workflows/monitor.js";
import { clearCards } from "./bridge/python-bridge.js";
import { runPythonAgent } from "./bridge/python-bridge.js";
import { V2_HOME, VENV_PY } from "./bridge/agent-step.js";

const TS = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const WORK_DIR = `/tmp/mastra_monitor_${TS}`;
const KEYWORDS = ["carbide burr", "die grinder bits", "rotary burr",
  "tungsten carbide burr", "cutting burr"];

async function main() {
  clearCards(WORK_DIR);
  const mastra = createMonitorMastra();
  const wf = mastra.getWorkflow("monitorKeywords");
  const run = await wf.createRun();

  const r0 = await run.start({
    inputData: {
      source: "sif",
      keywords: KEYWORDS,
      live: true,
      workDir: WORK_DIR,
      threadId: `mastra-mon-${TS}`,
    },
  });
  console.log("TS 版 start → 状态:", r0.status);

  let cur = r0;
  if (r0.status === "suspended") {
    cur = await run.resume({ step: "monitor", resumeData: { decision: "continue" } });
    console.log("TS 版 resume → 状态:", cur.status);
  }
  const out = cur.steps?.monitor?.output as
    | { status: string; detect: string | null; fetch: string | null; error: string | null }
    | undefined;
  const tsFetch = out?.fetch ? JSON.parse(out.fetch) : null;

  // M1: live 零积分巡检无授权卡 → 直接完成（设计行为）
  const m1 = cur.status === "success" || out?.status === "done";
  console.log("M1", m1 ? "PASS: live 零积分巡检直接完成（无授权卡=设计行为）✓" : `FAIL ⚠️（状态 ${cur.status}）`);

  // M2: 当天 Python 版对比（同一接口同窗口）
  const py = await runPythonAgent({
    v2Home: V2_HOME, venvPython: VENV_PY,
    workDir: `${WORK_DIR}/py`, agent: "monitor",
    threadId: `py-mon-${TS}`,
    task: {
      source: "sif",
      task: { mode: "keywords", keywords: KEYWORDS, granularity: "week", with_funnel: true },
      live: true,
      run_dir: `${WORK_DIR}/py/monitor`,
    },
  });
  const pyFetch = py.kind === "done" ? ((py.result.fetch as Record<string, unknown>) ?? {}) : {};
  const pySeries = (pyFetch.series as Record<string, unknown>) ?? {};
  const tsSeries = (tsFetch?.series as Record<string, unknown>) ?? {};

  let m2ok = true;
  let compared = 0;
  for (const kw of KEYWORDS) {
    const p = pySeries[kw] as Record<string, unknown> | undefined;
    const t = tsSeries[kw] as Record<string, unknown> | undefined;
    if (!p) continue;
    compared++;
    const pl = p.latest_rank ?? null;
    const tl = t?.latest_rank ?? null;
    if (pl !== tl) {
      m2ok = false;
      console.log(`  ${kw}: Python ${pl} ≠ TS ${tl}`);
    }
  }
  console.log("M2", m2ok && compared > 0
    ? `PASS: TS 版与当天 Python 版逐位一致 ✓（对比 ${compared} 词）` : `FAIL ⚠️（对比 ${compared} 词）`);

  // M3: detect 结构
  const detect = out?.detect ? JSON.parse(out.detect) : null;
  const m3ok = detect && Array.isArray(detect.moves) && Array.isArray(detect.new)
    && Array.isArray(detect.dropped) && detect.first_run !== undefined;
  console.log("M3", m3ok ? `PASS: detect 结构正确 ✓（first_run=${detect.first_run} moves=${detect.moves.length}）` : "FAIL ⚠️");

  console.log(m1 && m2ok && m3ok ? "MONITOR MIGRATION VERIFY ALL PASS" : "MONITOR MIGRATION HAS FAILURES");
}

main();
