/**
 * server.ts —— 选品 agent 产品化服务层（P1: REST API）
 *
 * 产品形态 C（混合）后端: Web 前端 + 飞书通知共用本服务。
 *
 * 端点:
 *   GET  /api/health             健康检查
 *   GET  /api/tasks              任务列表
 *   POST /api/tasks              创建任务 {type, params} → 后台跑 workflow
 *   GET  /api/tasks/:id          任务详情（状态/节点/挂起卡）
 *   POST /api/tasks/:id/resume   拍板 {decision} → resume 挂起步骤
 *   GET  /api/tasks/:id/report   报告 HTML 产物（静态）
 *
 * 任务注册表: libsql 表 tasks（runId 映射 + 参数快照 + 产物路径），
 * 服务器重启后任务状态仍可查（workflow 快照在 .mastra/*.db）。
 */
import express from "express";
import { createServer } from "node:http";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { refreshWorkflow } from "../workflows/orchestrator.js";
import { monitorWorkflow } from "../workflows/monitor.js";
import { collectWorkflow } from "../workflows/collect.js";
import { insightWorkflow } from "../workflows/insight.js";
import { tagWorkflow } from "../workflows/tag.js";
import { LibSQLStore } from "@mastra/libsql";
import { Mastra } from "@mastra/core";
import { loadCategoryPresets, buildRefreshParams } from "./presets.js";
import { parseDecision } from "./decision-parser.js";
import { VENV_PY } from "../bridge/agent-step.js";
import { routeIntent } from "./intent-router.js";

const PORT = Number(process.env.PSA_PORT ?? 8123);
const DATA_DIR = join(process.cwd(), ".psa");
const TASK_STORE = join(DATA_DIR, "tasks.json");
mkdirSync(DATA_DIR, { recursive: true });

// ---- Mastra 实例（5 workflow 全注册）----
const mastra = new Mastra({
  storage: new LibSQLStore({
    id: "psa-server",
    url: "file:" + join(process.cwd(), ".mastra", "server.db"),
  }),
  workflows: {
    refresh: refreshWorkflow,
    monitorKeywords: monitorWorkflow,
    collect: collectWorkflow,
    insight: insightWorkflow,
    tag: tagWorkflow,
  },
});

// ---- 任务注册表（JSON 持久化，MVP 够用；量大换 libsql 表）----
interface TaskRec {
  id: string;
  type: string;
  params: Record<string, unknown>;
  runId?: string;
  status: string;
  createdAt: string;
  decisions: unknown[];
  lastStep?: string; // P3 重启恢复: 挂起步骤名
}
function loadTasks(): TaskRec[] {
  try { return JSON.parse(readFileSync(TASK_STORE, "utf-8")); } catch { return []; }
}
function saveTasks(tasks: TaskRec[]) {
  writeFileSync(TASK_STORE, JSON.stringify(tasks, null, 2));
}

// ---- workflow 输入映射（refresh 的 7 字段从 params 来）----
const WORKFLOW_INPUTS: Record<string, string[]> = {
  refresh: ["category", "categoryLabel", "labelXlsx", "tagJson", "pipelineOut", "workDir", "threadId", "reportType"],
  monitorKeywords: ["source", "keywords", "live", "workDir", "threadId", "withFunnel"],
  collect: ["source", "taskJson", "live", "workDir", "threadId"],
  insight: ["category", "categoryLabel", "tagJson", "labelXlsx", "pipelineOut", "workDir", "threadId"],
  tag: ["category", "labelXlsx", "tagJson", "workDir", "threadId"],
};

function pickInput(type: string, params: Record<string, unknown>): Record<string, unknown> {
  const keys = WORKFLOW_INPUTS[type] ?? [];
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = params[k];
  return out;
}

/** 异步执行任务（后台跑，卡点挂起等待拍板） */
const runRefs = new Map<string, { run: unknown; last: Record<string, unknown> }>();
async function runTask(t: TaskRec) {
  const wf = mastra.getWorkflow(t.type);
  const run = await wf.createRun();
  const r0 = (await run.start({ inputData: pickInput(t.type, t.params) })) as Record<string, unknown>;
  runRefs.set(t.id, { run, last: r0 });
  t.runId = run.runId;
  t.status = (r0.status as string) ?? "unknown";
  // P3 重启恢复: 挂起步骤名持久化（重启后 resume 用）
  if (t.status === "suspended") {
    const steps = (r0.steps ?? {}) as Record<string, unknown>;
    t.lastStep = Object.entries(steps).find(
      ([, s]) => (s as { status: string }).status === "suspended",
    )?.[0];
  }
  saveTasks(loadTasks().map((x) => (x.id === t.id ? t : x)));
}

/** P3 重启恢复: 服务器启动时重建挂起任务的 run 引用 */
async function restoreSuspended() {
  for (const t of loadTasks().filter((x) => x.status === "suspended" && x.runId)) {
    try {
      const wf = mastra.getWorkflow(t.type);
      const run = await wf.createRun({ runId: t.runId });
      runRefs.set(t.id, { run, last: {} as Record<string, unknown> });
      console.log(`[restore] 任务 ${t.id}（${t.type}）run 引用已恢复，挂起步骤 ${t.lastStep ?? "未知"}`);
    } catch (e) {
      console.log(`[restore] 任务 ${t.id} 恢复失败: ${String(e).slice(0, 120)}`);
    }
  }
}

/** 从最近一次 start/resume 返回值读状态（含挂起卡 payload） */
function readRunState(t: TaskRec): Record<string, unknown> {
  const ref = runRefs.get(t.id);
  if (!ref) return { error: "run 引用不在进程内（服务器重启后请重新创建任务）" };
  const r = ref.last;
  const status = (r.status as string) ?? "unknown";
  const steps = (r.steps ?? {}) as Record<string, unknown>;
  const step = Object.entries(steps).find(
    ([, s]) => (s as { status: string }).status === "suspended",
  )?.[0];
  let payload: unknown;
  if (step) {
    try {
      payload = (steps[step] as Record<string, unknown>).suspendPayload;
    } catch { payload = undefined; }
  }
  return { status, suspendedStep: step, suspendPayload: payload, result: r.result };
}

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(join(process.cwd(), "public"))); // Web 前端（P2）

app.get("/api/health", (_req, res) => res.json({ ok: true, workflows: Object.keys(mastra.getWorkflows?.() ?? {}) }));

/** 类目预设（新建任务表单: 类目下拉 + 资产路径推导 + 锚点提示） */
app.get("/api/presets", (_req, res) => {
  try {
    res.json({ categories: loadCategoryPresets() });
  } catch (e) {
    res.status(500).json({ error: "类目注册表读取失败: " + String(e).slice(0, 150) });
  }
});

/** 类目数据检查（任意类目: 注册表匹配 + RDS 数据量——无数据引导取数） */
app.post("/api/check-category", (req, res) => {
  const { name } = req.body ?? {};
  if (!name) return res.status(400).json({ error: "缺类目名" });
  try {
    const raw = execSync(`"${VENV_PY}" "${join(process.cwd(), "src", "server", "check_category.py")}" "${String(name).replace(/"/g, '\\"')}"`, {
      encoding: "utf-8", timeout: 60000,
    });
    res.json(JSON.parse(raw));
  } catch (e) {
    res.status(500).json({ error: "类目检查失败: " + String(e).slice(0, 150) });
  }
});
app.post("/api/parse-decision", async (req, res) => {
  const { cardTitle, text } = req.body ?? {};
  if (!cardTitle || !text) return res.status(400).json({ error: "缺 cardTitle 或 text" });
  const r = await parseDecision(String(cardTitle), String(text));
  res.json(r);
});

/** 对话意图路由（Codex 风格工作台: 自然语言 → 任务类型+参数） */
app.post("/api/chat-intent", async (req, res) => {
  const { text } = req.body ?? {};
  if (!text) return res.status(400).json({ error: "缺 text" });
  const labels = loadCategoryPresets().map((c) => c.label);
  const r = await routeIntent(String(text), labels);
  res.json(r);
});

app.get("/api/tasks", (_req, res) => res.json(loadTasks()));

app.post("/api/tasks", async (req, res) => {
  const { type, params } = req.body ?? {};
  if (!type || !WORKFLOW_INPUTS[type]) {
    return res.status(400).json({ error: `未知任务类型 ${type}（可选: ${Object.keys(WORKFLOW_INPUTS)}）` });
  }
  // P3 类目任务锁: 同类目有活跃任务 → 拒绝（防 pipeline 目录互踩）
  const category = (params?.category as string) ?? (params?.taskJson ? "collect-" + type : "");
  const active = loadTasks().find((x) =>
    (x.params?.category === category || (category.startsWith("collect-") && x.type === type))
    && ["starting", "pending", "suspended", "running"].includes(x.status));
  if (active && category) {
    return res.status(409).json({ error: `类目 ${category} 已有活跃任务 ${active.id}（状态 ${active.status}）——请先完成或拍板`, activeTask: active.id });
  }
  const id = "t-" + createHash("md5").update(`${type}-${Date.now()}-${Math.random()}`).digest("hex").slice(0, 10);
  const t: TaskRec = {
    id, type, params: params ?? {}, status: "starting", createdAt: new Date().toISOString(), decisions: [],
  };
  const tasks = loadTasks();
  tasks.unshift(t);
  saveTasks(tasks);
  runTask(t).catch((e) => {
    t.status = "error:" + String(e.message ?? e).slice(0, 120);
    saveTasks(loadTasks().map((x) => (x.id === t.id ? t : x)));
  });
  res.json({ id, status: "starting" });
});

app.get("/api/tasks/:id", async (req, res) => {
  const t = loadTasks().find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "任务不存在" });
  const state = readRunState(t);
  // P3 耗时统计
  const elapsed = Math.round((Date.now() - new Date(t.createdAt).getTime()) / 1000);
  // P3 进度日志尾部（workDir/progress.log，跨进程天然）
  let progress: string[] = [];
  try {
    const log = readFileSync(join(String(t.params.workDir ?? ""), "progress.log"), "utf-8");
    progress = log.split("\n").filter(Boolean).slice(-6);
  } catch { progress = []; }
  res.json({ ...t, ...state, elapsed, progress });
});

app.post("/api/tasks/:id/resume", async (req, res) => {
  const t = loadTasks().find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "任务不存在" });
  const { decision } = req.body ?? {};
  const ref = runRefs.get(t.id);
  if (!ref) return res.status(400).json({ error: "run 引用不在进程内（服务器重启后请重新创建任务）" });
  const state = readRunState(t);
  const step = (state.suspendedStep as string | undefined)
    ?? ((t as TaskRec & { lastStep?: string }).lastStep ?? undefined); // 重启恢复场景
  if (!step) return res.status(400).json({ error: `无挂起步骤可拍板（当前状态 ${state.status}）` });
  const run = ref.run as {
    resume: (o: { step: string; resumeData: { decision: unknown } }) => Promise<Record<string, unknown>>;
  };
  const r = await run.resume({ step, resumeData: { decision } });
  ref.last = r;
  const tasks = loadTasks().map((x) =>
    x.id === t.id ? { ...x, status: (r.status as string) ?? "unknown", decisions: [...x.decisions, decision] } : x);
  saveTasks(tasks);
  res.json({ id: t.id, ...readRunState(t) });
});

app.get("/api/tasks/:id/report", (req, res) => {
  const t = loadTasks().find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "任务不存在" });
  const outDir = String(t.params.pipelineOut ?? "");
  const html = (existsSync(outDir) ? readdirSafe(outDir) : []).find((f) => f.endsWith(".html"));
  if (!html) return res.status(404).json({ error: `产物目录无 HTML（${outDir}）` });
  res.sendFile(join(outDir, html));
});

function readdirSafe(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

const server = createServer(app);
restoreSuspended().then(() => {
  server.listen(PORT, () => {
    console.log(`[psa-server] 选品 agent 服务已启动: http://localhost:${PORT}`);
    console.log(`  GET /api/tasks · POST /api/tasks · POST /api/tasks/:id/resume · GET /api/tasks/:id/report`);
  });
});
