"""Имитация RFSD (каталоги year=YYYY с parquet) и ответов DaData — только для проверки конвейера без сети.
Значения выдуманы; связи финансов с банкротством заданы здесь, поэтому метрики на имитации ничего не говорят о реальности.
  python mock_rfsd.py --firms 40000 --out data_mock"""
import argparse, json, math, datetime as dt
from pathlib import Path
import numpy as np, pyarrow as pa, pyarrow.parquet as pq

ap = argparse.ArgumentParser(); ap.add_argument("--firms", type=int, default=40000); ap.add_argument("--out", default="data_mock")
a = ap.parse_args()
rng = np.random.default_rng(1); out = Path(a.out); (out / "RFSD").mkdir(parents=True, exist_ok=True)
OKVED = ["01.11", "08.12", "25.11", "41.20", "43.99", "46.71", "49.41", "52.29", "47.11", "62.01", "68.20"]  # последние 3 — вне отраслей
P = [0.07, 0.03, 0.12, 0.10, 0.08, 0.16, 0.14, 0.05, 0.10, 0.08, 0.07]
Y0, Y1 = 2014, 2025
n = a.firms
okv = rng.choice(OKVED, n, p=P); born = rng.integers(1995, 2022, n)
inn = np.array([f"{7700000000 + i:010d}" for i in range(n)])
size = rng.lognormal(math.log(60_000), 1.3, n)        # выручка, тыс. руб.
h = rng.normal(0.3, 0.8, n)
state = {}; rows = {y: [] for y in range(Y0, Y1 + 1)}; by_firm = {}
end = {}  # год последней отчётности и причина
for i in range(n):
    hi, rev = h[i], size[i]; dead = None
    for y in range(max(Y0, born[i]), Y1 + 1):
        shock = -0.25 if (okv[i] in ("49.41", "41.20", "43.99") and y in (2024, 2025)) else (-0.15 if y in (2015, 2020) else 0)
        hi = 0.85 * hi + rng.normal(0, 0.35) + shock
        rev = max(500.0, rev * math.exp(0.05 + 0.08 * hi + rng.normal(0, 0.12)))
        assets = rev * rng.uniform(0.5, 1.5); eq = assets * float(np.clip(0.30 + 0.12 * hi + rng.normal(0, 0.08), -0.4, 0.9))
        cur = assets * rng.uniform(0.4, 0.8); stl = assets * rng.uniform(0.2, 0.6) * (1.2 - 0.2 * hi)
        np_ = rev * (0.03 + 0.03 * hi + rng.normal(0, 0.02))
        r = {"inn": inn[i], "ogrn": None, "year": y, "okved": okv[i], "region": "77", "creation_date": f"{born[i]}-03-15",
             "dissolution_date": None, "eligible": 1.0, "filed": 1.0, "imputed": 0.0, "simplified": float(rev < 120_000), "outlier": 0.0, "financial": 0.0,
             "line_1100": assets - cur, "line_1150": (assets - cur) * 0.8, "line_1200": cur, "line_1210": cur * 0.3, "line_1230": cur * 0.4,
             "line_1240": cur * 0.05, "line_1250": max(0.0, cur * (0.08 + 0.04 * hi)), "line_1300": eq, "line_1370": eq * 0.9,
             "line_1400": assets - eq - stl if assets - eq - stl > 0 else 0.0, "line_1410": max(0.0, (assets - eq - stl) * 0.7), "line_1500": stl,
             "line_1510": stl * 0.4, "line_1520": stl * 0.5, "line_1530": 0.0, "line_1540": stl * 0.02, "line_1550": stl * 0.03,
             "line_1600": assets, "line_1700": assets, "line_2110": rev, "line_2120": -rev * 0.85, "line_2200": rev * (0.06 + 0.04 * hi),
             "line_2300": np_ * 1.25, "line_2330": -stl * 0.04, "line_2400": np_}
        if rng.random() < 0.03: r["filed"] = 0.0; [r.__setitem__(k, None) for k in list(r) if k.startswith("line_")]
        rows[y].append(r); by_firm.setdefault(inn[i], []).append(r)
        p_bank = 1 / (1 + math.exp(-(-5.2 - 1.6 * hi)))
        if y >= 2016 and rng.random() < p_bank: dead = ("bankrupt", y); break
        if y >= 2016 and rng.random() < 0.012: dead = ("voluntary", y); break
    if dead:
        kind, y = dead
        if kind == "bankrupt":
            start = dt.date(y + 1, int(rng.integers(1, 12)), 15)
            if start.year <= 2023 and rng.random() < 0.7:
                liq = dt.date(start.year + 2, start.month, 1)
                state[inn[i]] = {"state": {"status": "LIQUIDATED", "code": "203", "actuality_date": None,
                                           "liquidation_date": int(dt.datetime(liq.year, liq.month, 1).timestamp() * 1000)}}
                for rr in by_firm.get(inn[i], []): rr["dissolution_date"] = liq.isoformat()
            else:
                state[inn[i]] = {"state": {"status": "BANKRUPT", "code": "114", "actuality_date": int(dt.datetime(start.year, start.month, 15).timestamp() * 1000), "liquidation_date": None}}
        else:
            liq = dt.date(y + 1, 6, 1); code = rng.choice(["201", "407"])
            state[inn[i]] = {"state": {"status": "LIQUIDATED", "code": str(code), "actuality_date": None, "liquidation_date": int(dt.datetime(liq.year, liq.month, 1).timestamp() * 1000)}}
for y, rr in rows.items():
    d = out / "RFSD" / f"year={y}"; d.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.Table.from_pylist(rr), d / "part-0.parquet")
for i in range(n):
    state.setdefault(inn[i], {"state": {"status": "ACTIVE", "code": None, "actuality_date": None, "liquidation_date": None}})
(out / "mock_dadata.json").write_text(json.dumps(state))
print("компаний", n, "строк", sum(len(v) for v in rows.values()), "банкротств", sum(1 for v in state.values() if v["state"]["code"] in ("114", "203")))
