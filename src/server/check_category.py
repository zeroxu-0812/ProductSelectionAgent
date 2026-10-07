"""
check_category.py —— 类目数据检查（POST /api/check-category 后端脚本）

输入: 类目名（category 键或展示名）
输出 JSON:
  {registered: bool, rds: {asin_count, months, latest_month}, tag_full: bool}
"""
import json
import sys
import os
import glob

V2_HOME = "/Users/haiyi/Desktop/洞察/肯特合金/Jobber Drill Bits/V2视图预览"
sys.path.insert(0, V2_HOME)

name = sys.argv[1] if len(sys.argv) > 1 else ""

# 1. 注册表匹配（类目名 → 注册条目）
from core.insight.category_registry import CATEGORY_REGISTRY  # noqa: E402

reg = None
for k, v in CATEGORY_REGISTRY.items():
    if name in (k, v.get("category_label", "")):
        reg = {"key": k, **v}
        break
if not reg and name:
    for k, v in CATEGORY_REGISTRY.items():
        if name.lower() in k.lower() or name.lower() in str(v.get("category_label", "")).lower():
            reg = {"key": k, **v}
            break

# 2. 打标文件自动定位（洞察任务免人工输入打标路径）：
#    注册表 tag_json → 存在性 → 失效则探测 Desktop/{类目}/ 目录 *tag_full*.json
tag_info = {"path": None, "exists": False, "source": None, "candidates": []}
def _find_tag_file(cat_label: str) -> list:
    hits = []
    for base in [os.path.expanduser(f"~/Desktop/{cat_label}"), os.path.expanduser(f"~/Desktop")]:
        if os.path.isdir(base):
            hits += sorted(glob.glob(os.path.join(base, "*tag_full*.json")))
    return sorted(set(hits))

if reg and reg.get("tag_json"):
    tag_info["path"] = reg["tag_json"]
    tag_info["source"] = "registry"
    tag_info["exists"] = os.path.exists(reg["tag_json"])
    if not tag_info["exists"]:
        cands = _find_tag_file(reg.get("category_label", ""))
        tag_info["candidates"] = cands
        if cands:
            tag_info["path"] = cands[-1]  # 最新
            tag_info["source"] = "auto-probe"
            tag_info["exists"] = True
else:
    cands = _find_tag_file(name)
    tag_info["candidates"] = cands
    if cands:
        tag_info["path"] = cands[-1]
        tag_info["source"] = "auto-probe"
        tag_info["exists"] = True

# 2. RDS 查库（类目数据量）
rds = {"asin_count": 0, "months": 0, "latest_month": None}
try:
    import psycopg2
    cfg = json.load(open(V2_HOME + "/api_keys.local.json"))
    conn = psycopg2.connect(
        host="postgre.cluster-ro-cavkqwqmyvuw.us-west-2.rds.amazonaws.com",
        port=5432, dbname="postgres", user="pgzero",
        password=cfg.get("SS_DB_PASSWORD") or "o$^@u820WAtW", connect_timeout=15)
    cur = conn.cursor()
    cat_key = (reg.get("category_label") if reg else name)
    # 精确类目键（快照表按 query_keyword=类目展示名 过滤）
    cur.execute(
        "SELECT COUNT(DISTINCT asin), COUNT(DISTINCT query_month), MAX(query_month) "
        "FROM sellersprite_product_snapshots WHERE query_keyword=%s", (cat_key,))
    row = cur.fetchone()
    if row and row[0]:
        rds = {"asin_count": int(row[0]), "months": int(row[1]), "latest_month": str(row[2])}
    else:
        # 模糊匹配（query_keyword 可能存变体）
        cur.execute(
            "SELECT DISTINCT query_keyword FROM sellersprite_product_snapshots "
            "WHERE query_keyword ILIKE %s LIMIT 10", (f"%{name}%",))
        hits = [r[0] for r in cur.fetchall()]
        if hits:
            rds = {"asin_count": -1, "months": 0, "latest_month": None, "similar_categories": hits}
    conn.close()
except Exception as e:
    rds["error"] = str(e)[:150]

print(json.dumps({"query": name, "registered": reg, "rds": rds, "tag_file": tag_info}, ensure_ascii=False))
