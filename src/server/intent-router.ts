/**
 * intent-router.ts —— 对话意图路由（自然语言 → 任务类型 + 参数）
 *
 * 分层: 规则解析（零成本，覆盖常见意图）→ DeepSeek 兜底。
 * 支持的任务类型与参数提取:
 *   refresh     全流程（类目名 → 注册表推导资产路径）
 *   monitorKeywords  监控巡检（关键词列表）
 *   collect    取数（类目名/ASIN）
 *   insight    洞察报告（类目名）
 *   tag        打标（类目名）
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface IntentResult {
  ok: boolean;
  type?: string;
  params?: Record<string, unknown>;
  reply?: string; // 解析失败时的提示
  reason?: string;
}

function deepSeekKey(): string | undefined {
  let key = process.env.DEEPSEEK_API_KEY;
  if (!key) {
    try {
      const env = readFileSync(join(process.env.HOME ?? "", ".hermes", ".env"), "utf-8");
      const m = env.match(/^DEEPSEEK_API_KEY\s*=\s*(.+)$/m);
      if (m) key = m[1].trim();
    } catch { /* ignore */ }
  }
  return key;
}

/** 规则解析 */
export function routeIntentRule(text: string, registryLabels: string[]): IntentResult {
  const t = text.trim();
  const lower = t.toLowerCase();
  if (!t) return { ok: false, reply: "请告诉我你想做什么，例如「分析 square_nose 类目」或「监控 carbide burr 这个词」" };

  // 关键词监控
  if (/(监控|巡检|跟踪|趋势|关键词)/.test(t) && /(词|keyword|监控|巡检|跟踪)/i.test(t)) {
    const kws = t.split(/[，,、\n]+/).map(s => s.trim()).filter(s => s && !/监控|巡检|跟踪|趋势|关键词|一下|这些|帮我/.test(s));
    if (kws.length) {
      return {
        ok: true, type: "monitorKeywords", reason: "关键词监控意图",
        params: { keywords: kws, withFunnel: true },
      };
    }
  }
  // 取数
  if (/(取数|采集|抓取|数据源|月采|补采)/.test(t)) {
    return { ok: true, type: "collect", reason: "取数意图", params: { collectCategory: t } };
  }
  // 打标
  if (/(打标|标注|标签)/.test(t)) {
    return { ok: true, type: "tag", reason: "打标意图", params: { categoryText: t } };
  }
  // 洞察/报告
  if (/(洞察|报告|奇点|市场洞察)/.test(t)) {
    return { ok: true, type: "insight", reason: "洞察意图", params: { categoryText: t } };
  }
  // 全流程/分析（类目名匹配优先）
  if (/(分析|全流程|跑一下|跑一遍|研究|选品|看下|看看)/.test(t) || registryLabels.some(l => t.includes(l))) {
    return { ok: true, type: "refresh", reason: "全流程分析意图", params: { categoryText: t } };
  }
  // 兜底: 提到类目名 → 全流程
  for (const l of registryLabels) {
    if (t.toLowerCase().includes(l.toLowerCase())) {
      return { ok: true, type: "refresh", reason: `类目「${l}」匹配 → 全流程`, params: { categoryText: t } };
    }
  }
  return { ok: false, reply: "没理解你的意图。试试：「分析 square_nose 类目」「监控 carbide burr、die grinder bits」「取数 Creatine」「打标 cutting_burrs」" };
}

/** LLM 兜底 */
export async function routeIntentLLM(text: string, registryLabels: string[]): Promise<IntentResult> {
  const key = deepSeekKey();
  if (!key) return { ok: false, reply: "无 DeepSeek 凭证，无法理解意图（请用明确的任务词）" };
  const prompt = `你是电商选品 agent 的意图路由器。用户自然语言 → JSON。
任务类型: refresh(类目全流程分析) | monitorKeywords(关键词监控) | collect(取数) | insight(洞察报告) | tag(打标)
已注册类目: ${registryLabels.join(", ") || "无"}
输出 JSON:
- 全流程/洞察/打标: {"type":"refresh|insight|tag","category":"类目名或注册类目键","categoryLabel":"展示名(可选)","labelXlsx":"label路径(可选)"}
- 监控: {"type":"monitorKeywords","keywords":["词1","词2"]}
- 取数: {"type":"collect","category":"类目名","months":"last24"}
只输出 JSON。
用户输入: ${text}`;
  const r = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: prompt }], max_tokens: 300, temperature: 0 }),
  });
  if (!r.ok) return { ok: false, reply: `DeepSeek API ${r.status}` };
  const data = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
  try {
    const json = JSON.parse((data.choices?.[0]?.message?.content ?? "").replace(/^```json|```$/g, "").trim());
    return { ok: true, type: json.type, params: json, reason: "AI 意图路由" };
  } catch {
    return { ok: false, reply: "AI 输出异常（请用明确的任务词）" };
  }
}

export async function routeIntent(text: string, registryLabels: string[]): Promise<IntentResult> {
  const rule = routeIntentRule(text, registryLabels);
  if (rule.ok) return rule;
  return routeIntentLLM(text, registryLabels);
}
