/**
 * decision-parser.ts —— 对话式拍板解析（自然语言 → JSON decision）
 *
 * 分层: 规则解析（零成本零延迟，覆盖常见拍板语）→ LLM 兜底（DeepSeek）。
 * decision schema 与各卡对齐:
 *   - 修数卡: {mode: "anchor"|"coef"|"none", anchor_brand?, anchor_revenue?, coef?}
 *   - 报告类型卡: {mode: "singularity"|"mi"|"both"} 或裸词 "singularity"/"mi"/"both"
 *   - 授权/告警卡: "continue"/"cancel"/"skip"/"log"/"ignore"
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ParsedDecision {
  ok: boolean;
  decision?: unknown;
  reason: string;
}

/** 规则解析（无 LLM） */
export function parseDecisionRule(cardTitle: string, text: string): ParsedDecision {
  const t = text.trim();
  const lower = t.toLowerCase();

  // 1. 直接 JSON（用户贴了 JSON）
  if (t.startsWith("{") || t.startsWith("[")) {
    try { return { ok: true, decision: JSON.parse(t), reason: "JSON 直读" }; }
    catch { return { ok: false, reason: "JSON 解析失败，请检查格式" }; }
  }

  // 2. 授权/确认类卡的裸词
  const SIMPLE = ["continue", "cancel", "skip", "log", "ignore", "singularity", "mi", "both"];
  for (const w of SIMPLE) {
    if (lower === w || lower === w + "（continue）") {
      return { ok: true, decision: w, reason: `裸词 ${w}` };
    }
  }
  // 中文裸词
  if (/(不修|不修数|跳过修数|如实|原样)/.test(t)) return { ok: true, decision: { mode: "none" }, reason: "不修数" };
  if (/(双报告|两个都|都要|both)/.test(t)) return { ok: true, decision: "both", reason: "双报告" };
  if (/(仅奇点|奇点)/.test(t)) return { ok: true, decision: "singularity", reason: "仅奇点" };
  if (/(仅市场|市场洞察|^mi$|市场报告)/.test(t)) return { ok: true, decision: "mi", reason: "仅市场洞察" };
  if (/(继续|授权|确定|同意|可以|ok)/i.test(t) && /(卡|取数|报告|生成|分析)/.test(cardTitle + t))
    return { ok: true, decision: "continue", reason: "确认继续" };
  if (/(取消|不取|算了|跳过)/.test(t)) return { ok: true, decision: "cancel", reason: "取消" };

  // 3. 修数卡结构解析
  const mAnchor = t.match(/(?:锚|anchor|锚点)\s*(?:品牌)?\s*[:：]?\s*([A-Za-z0-9&.\- ]+?)\s*(?:营收|gmv|revenue|金额)?\s*[:：]?\s*([\d,]+(?:\.\d+)?)/i);
  if (mAnchor) {
    const brand = mAnchor[1].trim().replace(/[\s,，]+$/, "");
    const rev = parseFloat(mAnchor[2].replace(/,/g, ""));
    if (brand && !isNaN(rev)) {
      return { ok: true, decision: { mode: "anchor", anchor_brand: brand, anchor_revenue: rev }, reason: `锚点 ${brand}=${rev}` };
    }
  }
  const mCoef = t.match(/(?:系数|coef|折算)\s*[:：]?\s*([\d.]+)/i);
  if (mCoef) {
    const c = parseFloat(mCoef[1]);
    if (!isNaN(c)) return { ok: true, decision: { mode: "coef", coef: c }, reason: `系数 ${c}` };
  }

  return { ok: false, reason: "规则未匹配（将尝试 AI 解析）" };
}

/** LLM 兜底解析（DeepSeek——key 从 ~/.hermes/.env 读，不回显） */
export async function parseDecisionLLM(cardTitle: string, text: string): Promise<ParsedDecision> {
  let key = process.env.DEEPSEEK_API_KEY;
  if (!key) {
    try {
      const env = readFileSync(join(process.env.HOME ?? "", ".hermes", ".env"), "utf-8");
      const m = env.match(/^DEEPSEEK_API_KEY\s*=\s*(.+)$/m);
      if (m) key = m[1].trim();
    } catch { /* ignore */ }
  }
  if (!key) return { ok: false, reason: "无 DeepSeek 凭证，无法 AI 解析（可改用 JSON 输入）" };

  const prompt = `你是拍板解析器。用户面对一张决策卡，回复了自然语言。转成 JSON 决策。
卡标题: ${cardTitle}
用户输入: ${text}
决策 schema（按卡类型）:
- 修数卡: {"mode":"anchor","anchor_brand":"品牌","anchor_revenue":数字} | {"mode":"coef","coef":数字} | {"mode":"none"}
- 报告类型卡: "singularity" | "mi" | "both"
- 授权卡: "continue" | "cancel" | "skip"
只输出 JSON，不要解释。`;

  const r = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200,
      temperature: 0,
    }),
  });
  if (!r.ok) return { ok: false, reason: `DeepSeek API ${r.status}` };
  const data = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = (data.choices?.[0]?.message?.content ?? "").trim();
  try {
    const json = JSON.parse(content.replace(/^```json|```$/g, "").trim());
    return { ok: true, decision: json, reason: "AI 解析" };
  } catch {
    return { ok: false, reason: "AI 输出非 JSON（请直接贴 JSON）" };
  }
}

/** 主入口: 规则优先 → LLM 兜底 */
export async function parseDecision(cardTitle: string, text: string): Promise<ParsedDecision> {
  const rule = parseDecisionRule(cardTitle, text);
  if (rule.ok) return rule;
  return parseDecisionLLM(cardTitle, text);
}
