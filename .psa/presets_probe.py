# -*- coding: utf-8 -*-
import sys, json
sys.path.insert(0, "/Users/haiyi/Desktop/洞察/肯特合金/Jobber Drill Bits/V2视图预览")
from core.insight.category_registry import CATEGORY_REGISTRY as CATEGORIES
out = []
for k, v in CATEGORIES.items():
    out.append({
        'key': k,
        'label': v.get('category_label', k),
        'label_xlsx': v.get('label_xlsx', ''),
        'tag_json': v.get('tag_json', ''),
        'anchor': v.get('anchor'),
    })
print(json.dumps(out, ensure_ascii=False))