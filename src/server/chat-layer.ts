/**
 * chat-layer.ts —— 自然语言对话层（DeepSeek 多轮）
 *
 * 把工作台从「关键词触发任务」升级为「自然语言持续对话」:
 *   1. 带历史上下文判断意图（多轮指代:「分析这个类目」→ 记住前面说的类目）
 *   2. 任务意图 → 结构化参数（复用现有任务路由）
 *   3. 提问/闲聊 → 直接回答（系统能力/进行中状态/数据解释）
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ChatReply {
  kind: "task" | "answer";
  text?: string;          // answer 内容
  type?: string;          // task: 任务类型
  params?: Record<string, unknown>;
  reason?: string;
  error?: string;
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

const SYSTEM = `你是「选品 Agent 工作台」的对话层助手。用户在和你聊选品分析工作。

你可以做的任务（用户意图是任务时输出 JSON，category 必须从用户话中提取，指代词结合历史解析）:
- 全流程分析类目（打标+洞察+双报告）: {"kind":"task","type":"refresh","category":"类目名"}
- 洞察报告: {"kind":"task","type":"insight","category":"类目名"}
- 监控关键词: {"kind":"task","type":"monitorKeywords","keywords":["词1","词2"]}
- 取数: {"kind":"task","type":"collect","category":"类目名"}
- 打标: {"kind":"task","type":"tag","category":"类目名"}

意图是提问/闲聊时直接回答: {"kind":"answer","text":"回答内容"}。
你能回答: 系统能力说明、流程解释（提维/四层打标/修数锚点/报告类型）、进行中任务说明、选品方法论问题。
多轮指代: 结合历史消息理解「这个类目」「继续」「它」等指代。

输出严格 JSON，不要其他内容。`;

export async function chatLayer(
  messages: Array<{ role: string; content: string }>,
  registryLabels: string[],
): Promise<ChatReply> {
  const key = deepSeekKey();
  if (!key) return { kind: "answer", text: "对话层未配置 DeepSeek 凭证", error: "no-key" };

  const sys = SYSTEM + `\n已注册类目: ${registryLabels.join(", ") || "无"}`;
  const r = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "system", content: sys }, ...messages],
      max_tokens: 500,
      temperature: 0,
    }),
  });
  if (!r.ok) return { kind: "answer", text: `对话服务异常 (${r.status})`, error: "http" };
  const data = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = (data.choices?.[0]?.message?.content ?? "").trim();
  try {
    const json = JSON.parse(content.replace(/^```json|```$/g, "").trim());
    return json as ChatReply;
  } catch {
    // LLM 输出非 JSON → 当纯文本回答
    return { kind: "answer", text: content || "（无回复）" };
  }
}
