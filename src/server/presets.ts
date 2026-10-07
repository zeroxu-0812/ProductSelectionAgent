/**
 * presets.ts —— 类目注册表驱动的任务预设（P4 前置: 新建任务表单化）
 *
 * GET /api/presets → 类目列表 + 资产路径（从 V2 category_registry 推导）
 */
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { V2_HOME, VENV_PY } from "../bridge/agent-step.js";

export interface CategoryPreset {
  key: string;
  label: string;
  labelXlsx: string;
  tagJson: string;
  hasAnchor: boolean;
  anchorBrand?: string;
  anchorRevenue?: number;
}

export function loadCategoryPresets(): CategoryPreset[] {
  // 脚本落临时文件执行（避免 -c 多行转义地狱）
  const script = [
    "# -*- coding: utf-8 -*-",
    "import sys, json",
    "sys.path.insert(0, " + JSON.stringify(V2_HOME) + ")",
    "from core.insight.category_registry import CATEGORY_REGISTRY as CATEGORIES",
    "out = []",
    "for k, v in CATEGORIES.items():",
    "    out.append({",
    "        'key': k,",
    "        'label': v.get('category_label', k),",
    "        'label_xlsx': v.get('label_xlsx', ''),",
    "        'tag_json': v.get('tag_json', ''),",
    "        'anchor': v.get('anchor'),",
    "    })",
    "print(json.dumps(out, ensure_ascii=False))",
  ].join("\n");
  const scriptPath = join(process.cwd(), ".psa", "presets_probe.py");
  mkdirSync(join(process.cwd(), ".psa"), { recursive: true });
  writeFileSync(scriptPath, script, "utf-8");
  const raw = execSync(`"${VENV_PY}" "${scriptPath}"`, {
    encoding: "utf-8", timeout: 60000,
  });
  const rows = JSON.parse(raw) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    key: String(r.key),
    label: String(r.label),
    labelXlsx: String(r.label_xlsx ?? ""),
    tagJson: String(r.tag_json ?? ""),
    hasAnchor: !!r.anchor && typeof r.anchor === "object",
    anchorBrand: (r.anchor as Record<string, unknown> | undefined)?.anchor_brand as string | undefined,
    anchorRevenue: (r.anchor as Record<string, unknown> | undefined)?.anchor_revenue as number | undefined,
  }));
}

/** 由类目 key 推导全流程任务参数（技术路径全部自动） */
export function buildRefreshParams(cat: CategoryPreset, threadTag: string): Record<string, unknown> {
  const slug = cat.key.replace(/_/g, "-");
  return {
    category: cat.key,
    categoryLabel: cat.label,
    labelXlsx: cat.labelXlsx,
    tagJson: cat.tagJson,
    pipelineOut: `/tmp/psa_${slug}/out`,
    workDir: `/tmp/psa_${slug}`,
    threadId: `${threadTag}-${Date.now()}`,
  };
}
