"""Наблюдения «компания — год отчётности» с признаками и исходом.

Наблюдение: отчёт за год Y, доступен с 1 апреля Y+1 (срок сдачи). Учитываются только сданные отчёты (filed = 1).
Исход y = 1 — «последний отчёт перед банкротством»:
  - коды 113–117 (процедура идёт): событие = дата последнего изменения статуса (actuality_date);
    y = 1 у последнего отчёта, доступного до события; отчёты, ставшие доступными после события, исключаются;
  - код 203 (ликвидировано после конкурсного производства): начало процедуры неизвестно;
    y = 1 у последнего сданного отчёта.
Остальные отчёты — y = 0. Добровольные ликвидации и исключения из ЕГРЮЛ — не банкротство (решение пользователя 28.10.2026).
Компании без разметки DaData (продолжают отчитываться и не попали в выборку) считаются небанкротами; доля ошибки оценивается по выборке.

  python build_open.py            -> data/open_obs.parquet
"""
import argparse, sqlite3, json, datetime as dt
from pathlib import Path
import pyarrow as pa, pyarrow.parquet as pq
from panel_io import population, buckets, read_bucket
from open_features import features, sector_of, LINES, FEATURES

BANKRUPT_RUNNING = {"113", "114", "115", "116", "117"}

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--panel", default="data/rfsd_panel")
    ap.add_argument("--db", default="data/dadata.sqlite")
    ap.add_argument("--min-revenue", type=float, default=50_000)
    ap.add_argument("--unit", choices=["thousand", "rub"], default="thousand")
    ap.add_argument("--out", default="data/open_obs.parquet")
    ap.add_argument("--since-year", type=int, default=2015)
    ap.add_argument("--buckets", type=int, default=25, help="на сколько частей делить компании (меньше памяти — больше частей)")
    a = ap.parse_args()
    mult = 1.0 if a.unit == "thousand" else 0.001
    cols = ["inn", "year", "okved", "creation_date", "dissolution_date", "filed", "simplified"] + ["line_" + c for c in LINES]
    pop, _ = population(a.panel, a.min_revenue, mult, a.since_year)
    pop_set = set(pop.index)
    lab = {r[0]: r[1:] for r in sqlite3.connect(a.db).execute("select inn, code, actuality_date, liquidation_date, grp from dadata")}
    stats = {"firms": 0, "bankrupt_firms": 0, "bankrupt_running": 0, "bankrupt_203": 0, "dropped_after_event": 0,
             "unlabeled_firms": 0, "sample_checked": 0, "sample_bankrupt": 0, "obs": 0, "events": 0}
    ys, writer = {}, None
    for bi, suf in enumerate(buckets(a.buckets)):
        t = read_bucket(a.panel, cols, suffixes=suf)
        firms = {}
        for row in t.to_pylist():
            if row["inn"] in pop_set: firms.setdefault(row["inn"], []).append(row)
        del t
        out = []
        for inn, rows in firms.items():
            rows.sort(key=lambda r: r["year"])
            filed = [r for r in rows if r["filed"] == 1]
            if not filed: continue
            stats["firms"] += 1
            code, act, liq, grp = lab.get(inn, (None, None, None, None))
            if inn not in lab: stats["unlabeled_firms"] += 1
            if grp == "выборка продолжающих":
                stats["sample_checked"] += 1; stats["sample_bankrupt"] += int(code in BANKRUPT_RUNNING or code == "203")
            cy = None
            for r in rows:
                if r.get("creation_date"): cy = int(str(r["creation_date"])[:4]); break
            by_year = {r["year"]: r for r in filed}
            event = act if code in BANKRUPT_RUNNING else None
            usable = [r for r in filed if not (event and f"{r['year'] + 1}-04-01" > event)]
            stats["dropped_after_event"] += len(filed) - len(usable)
            if not usable: continue
            last_y = usable[-1]["year"]
            bankrupt = code in BANKRUPT_RUNNING or code == "203"
            if bankrupt:
                stats["bankrupt_firms"] += 1; stats["bankrupt_running" if code in BANKRUPT_RUNNING else "bankrupt_203"] += 1
            for r in usable:
                y = r["year"]
                f = features(r, by_year.get(y - 1), y, cy, sector_of(r["okved"]), (y - 1) in by_year)
                out.append({"inn": inn, "year": y, "avail": f"{y + 1}-04-01", "y": int(bankrupt and y == last_y),
                            "status_code": code, "event_date": event, "simplified": r.get("simplified"), **f})
        if out:
            tb = pa.Table.from_pylist(out, schema=writer.schema if writer else None)
            if writer is None: writer = pq.ParquetWriter(a.out, tb.schema, compression="zstd")
            writer.write_table(tb)
            for o in out: ys.setdefault(o["year"], [0, 0]); ys[o["year"]][0] += 1; ys[o["year"]][1] += o["y"]
            stats["obs"] += len(out); stats["events"] += sum(o["y"] for o in out)
        print(f"  часть {bi + 1}/{a.buckets}: компаний {len(firms)}, наблюдений {len(out)}", flush=True)
    if writer: writer.close()
    if stats["sample_checked"]:
        stats["sample_bankrupt_share"] = round(stats["sample_bankrupt"] / stats["sample_checked"], 4)
    print(json.dumps(stats, ensure_ascii=False))
    print("по годам (наблюдений / банкротств):", " ".join(f"{k}: {v[0]}/{v[1]}" for k, v in sorted(ys.items())))
    Path(a.out).with_suffix(".stats.json").write_text(json.dumps({"stats": stats, "by_year": ys}, ensure_ascii=False, indent=1))
