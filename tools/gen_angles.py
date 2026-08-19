# -*- coding: utf-8 -*-
"""由 data/angle_dict.csv 生成 web/angles.js（浏览器 + Node 双环境）。

改了 CSV 就重跑：python tools/gen_angles.py
"""
import csv
import io
import json
import collections
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSV = os.path.join(ROOT, "data", "angle_dict.csv")
OUT = os.path.join(ROOT, "web", "angles.js")

rows = [r for r in csv.DictReader(io.open(CSV, encoding="utf-8"))
        if r.get("discipline") and not r["discipline"].lstrip().startswith("#")]

by = collections.OrderedDict()
for r in rows:
    by.setdefault(r["discipline"], []).append(
        [r["angle_en"], r["angle_zh"], r["category"]])

LINES = [
    "// 自动生成于 data/angle_dict.csv —— 勿手改；改 CSV 后跑 tools/gen_angles.py",
    "const ANGLE_DICT = " + json.dumps(by, ensure_ascii=False,
                                       separators=(",", ":")) + ";",
    "if (typeof module !== 'undefined' && module.exports) "
    "module.exports = { ANGLE_DICT };",
    "",
]
io.open(OUT, "w", encoding="utf-8", newline="\n").write("\n".join(LINES))
print("学科 %d, 角度 %d -> %s"
      % (len(by), sum(len(v) for v in by.values()), os.path.relpath(OUT, ROOT)))
