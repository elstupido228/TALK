"""Входы для сверки JS и Python: исходные строки отчётности и признаки Python по наблюдениям периода проверки.
  python export_test_inputs.py --test-from 2022 --test-to 2023 [--max 30000]  -> data/open_test_inputs.json"""
import argparse, json, math
import pandas as pd
from panel_io import read_bucket
from open_features import LINES, features, sector_of

ap = argparse.ArgumentParser()
ap.add_argument("--panel", default="data/rfsd_panel"); ap.add_argument("--obs", default="data/open_obs.parquet")
ap.add_argument("--test-from", type=int, default=2022); ap.add_argument("--test-to", type=int, default=2023)
ap.add_argument("--max", type=int, default=10000, help="сколько компаний сверять"); ap.add_argument("--out", default="data/open_test_inputs.json")
a = ap.parse_args()
obs = pd.read_parquet(a.obs, columns=["inn", "year"])
obs = obs[(obs.year >= a.test_from) & (obs.year <= a.test_to)]
keys = set(zip(obs.inn, obs.year))
inns = sorted({k[0] for k in keys})[: a.max]
t = read_bucket(a.panel, ["inn", "year", "okved", "creation_date", "filed"] + ["line_" + c for c in LINES], inns=inns)
rows, cy = {}, {}
for r in t.to_pylist():
    if r["filed"] == 1: rows[(r["inn"], r["year"])] = r
    if r.get("creation_date") and r["inn"] not in cy: cy[r["inn"]] = int(str(r["creation_date"])[:4])
del t
clean = lambda r: None if r is None else {k: (None if isinstance(v, float) and math.isnan(v) else v) for k, v in r.items() if k.startswith("line_")}
out = {}
inn_set = set(inns)
for (inn, y) in keys:
    if inn not in inn_set: continue
    r, prev = rows.get((inn, y)), rows.get((inn, y - 1))
    f = features(r, prev, y, cy.get(inn), sector_of(r["okved"]), (inn, y - 1) in rows)
    out[f"{inn}|{y}"] = {"r": clean(r), "prev": clean(prev), "cy": cy.get(inn), "okved": r["okved"], "filed_prev": (inn, y - 1) in rows, "f_py": f}
json.dump(out, open(a.out, "w"), ensure_ascii=False)
print("наблюдений для сверки:", len(out))
