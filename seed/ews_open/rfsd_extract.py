"""Выгрузка RFSD по годам в компактную панель: только отрасли лизинга и нужные столбцы.
Год скачивается, читается кусками (pyarrow), отфильтровывается и удаляется — на диске одновременно ~1 ГБ, в памяти < 500 МБ.

  python rfsd_extract.py --years 2014-2025                        # с Hugging Face (irlspbru/RFSD)
  python rfsd_extract.py --years 2014-2025 --source /path/RFSD    # из локальной копии (каталоги year=YYYY)

Выход: data/rfsd_panel/year=YYYY.parquet. Повторный запуск пропускает готовые годы.
"""
import argparse, os, sys, shutil, time, json
from pathlib import Path
import pyarrow as pa, pyarrow.parquet as pq, pyarrow.compute as pc
from open_features import LINES, sector_of

ID_COLS = ["inn", "ogrn", "year", "okved", "okved_section", "region", "creation_date", "dissolution_date",
           "eligible", "filed", "imputed", "simplified", "outlier", "financial"]
LINE_COLS = ["line_" + c for c in LINES]
REPO = "irlspbru/RFSD"


def year_files_hf(year, tmp):
    from huggingface_hub import HfApi, hf_hub_download
    files = [f for f in HfApi().list_repo_files(REPO, repo_type="dataset") if f.startswith(f"RFSD/year={year}/") and f.endswith(".parquet")]
    if not files: raise SystemExit(f"на Hugging Face нет файлов для {year}")
    for f in files:
        t = time.time()
        p = hf_hub_download(REPO, f, repo_type="dataset", local_dir=tmp)
        print(f"  скачан {f}: {os.path.getsize(p) / 2**20:.0f} МБ за {time.time() - t:.0f} с", flush=True)
        yield Path(p), True


def year_files_local(year, src):
    d = Path(src) / f"year={year}"
    for p in sorted(d.glob("*.parquet")): yield p, False


def process_year(year, files, out, unit_check):
    writer, kept, seen, revs = None, 0, 0, []
    for path, remove in files:
        pf = pq.ParquetFile(path, pre_buffer=False)  # без предзагрузки и пакетами по 50 тыс.: в 900 МБ контейнера (200 тыс. — убит по памяти)
        names = set(pf.schema_arrow.names)
        cols = [c for c in ID_COLS + LINE_COLS if c in names]
        missing = [c for c in LINE_COLS if c not in names]
        if missing: print(f"  нет столбцов: {', '.join(missing)}")
        for b in pf.iter_batches(columns=cols, batch_size=50_000):
            t = pa.Table.from_batches([b]); seen += t.num_rows
            ok = pc.is_valid(t["okved"]) if "okved" in t.column_names else None
            sect = [sector_of(x) for x in t["okved"].to_pylist()]
            mask = pa.array([s is not None for s in sect])
            for flag, bad in (("eligible", 0), ("outlier", 1), ("financial", 1)):
                if flag in t.column_names:
                    col = pc.fill_null(pc.cast(t[flag], pa.float64()), 0 if flag != "eligible" else 1)
                    mask = pc.and_(mask, pc.not_equal(col, bad))
            t = t.filter(mask)
            if "year" not in t.column_names: t = t.append_column("year", pa.array([year] * t.num_rows, pa.int32()))
            for c in cols:  # единые типы
                if c.startswith("line_") or c in ("eligible", "filed", "imputed", "simplified", "outlier", "financial"):
                    t = t.set_column(t.column_names.index(c), c, pc.cast(t[c], pa.float64()))
                elif c in ("inn", "ogrn", "okved", "okved_section", "region"):
                    t = t.set_column(t.column_names.index(c), c, pc.cast(t[c], pa.string()))
                elif c in ("creation_date", "dissolution_date"):
                    t = t.set_column(t.column_names.index(c), c, pc.cast(pc.cast(t[c], pa.string()), pa.string()))
            for c in [x for x in ID_COLS + LINE_COLS if x not in t.column_names]:
                t = t.append_column(c, pa.nulls(t.num_rows, pa.float64() if c.startswith("line_") else pa.string()))
            t = t.select(ID_COLS + LINE_COLS)
            if unit_check and "line_2110" in t.column_names:
                r = [x for x in t["line_2110"].to_pylist()[:50_000] if x and x > 0]; revs += r
            if writer is None: writer = pq.ParquetWriter(out.with_suffix(".tmp"), t.schema, compression="zstd")
            writer.write_table(t); kept += t.num_rows
        if remove:
            os.remove(path)
    if writer: writer.close(); os.replace(out.with_suffix(".tmp"), out)
    med = sorted(revs)[len(revs) // 2] if revs else None
    return seen, kept, med


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", default="2014-2025")
    ap.add_argument("--source", help="локальный каталог RFSD (year=YYYY/*.parquet); по умолчанию Hugging Face")
    ap.add_argument("--out", default="data/rfsd_panel")
    ap.add_argument("--tmp", default="data/_tmp_download")
    a = ap.parse_args()
    y0, y1 = map(int, a.years.split("-")); out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    log = {}
    for y in range(y0, y1 + 1):
        f = out / f"year={y}.parquet"
        if f.exists(): print(f"{y}: уже выгружен, пропуск"); continue
        t = time.time(); print(f"{y}: обработка", flush=True)
        files = year_files_local(y, a.source) if a.source else year_files_hf(y, a.tmp)
        seen, kept, med = process_year(y, files, f, unit_check=True)
        print(f"{y}: строк {seen}, оставлено {kept}, медиана выручки {med}, {time.time() - t:.0f} с", flush=True)
        log[y] = {"rows": seen, "kept": kept, "median_revenue": med}
        if not a.source: shutil.rmtree(a.tmp, ignore_errors=True)
    meds = [v["median_revenue"] for v in log.values() if v["median_revenue"]]
    if meds:
        m = sorted(meds)[len(meds) // 2]
        print(f"Проверка единиц: медиана выручки {m:,.0f}. Если больше 1 000 000 — суммы, вероятно, в рублях, а не в тысячах: "
              f"тогда в label_dadata.py и build_open.py указать --unit rub.")
    (out / "_extract_log.json").write_text(json.dumps(log, ensure_ascii=False, indent=1))
