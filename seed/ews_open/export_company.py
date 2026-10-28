"""Карточка компании для портала: отчётность по годам из панели RFSD + статус из кэша DaData -> JSON, который читает score_open.js.
  python export_company.py 7700000123 [--out company.json]
В портале тот же объект собирается из коннекторов (отчётность — ГИР БО / parser-api или RFSD, статус — DaData)."""
import argparse, json, math, sqlite3
from panel_io import read_bucket
from open_features import LINES

ap = argparse.ArgumentParser(); ap.add_argument("inn"); ap.add_argument("--panel", default="data/rfsd_panel")
ap.add_argument("--db", default="data/dadata.sqlite"); ap.add_argument("--out")
a = ap.parse_args()
t = read_bucket(a.panel, ["inn", "year", "okved", "creation_date", "filed"] + ["line_" + c for c in LINES], inns=[a.inn])
rows = sorted(t.to_pylist(), key=lambda r: r["year"])
if not rows: raise SystemExit("компании нет в панели")
st = None
try:
    r = sqlite3.connect(a.db).execute("select raw from dadata where inn=?", (a.inn,)).fetchone()
    if r:
        import datetime as _dt
        raw = json.loads(r[0]); conv = lambda x: None if x is None else _dt.datetime.fromtimestamp(int(x) / 1000, _dt.timezone.utc).date().isoformat() if str(x).isdigit() else str(x)[:10]
        st = {"status": raw.get("status"), "code": None if raw.get("code") is None else str(raw.get("code")),
              "actuality_date": conv(raw.get("actuality_date")), "liquidation_date": conv(raw.get("liquidation_date"))}
except sqlite3.Error: pass
clean = lambda r: {k: (None if isinstance(v, float) and math.isnan(v) else v) for k, v in r.items() if k.startswith("line_") or k in ("year", "filed")}
company = {"inn": a.inn, "okved": rows[-1]["okved"], "creation_date": next((r["creation_date"] for r in rows if r["creation_date"]), None),
           "reports": [clean(r) for r in rows if r["filed"] == 1], "state": st}
s = json.dumps(company, ensure_ascii=False)
if a.out: open(a.out, "w").write(s)
else: print(s)
