"""Чтение панели RFSD частями, чтобы память не зависела от размера выборки."""
import pyarrow as pa, pyarrow.dataset as ds, pyarrow.compute as pc
import pandas as pd


def population(panel, min_rev, unit_mult, since_year=2015):
    """Компании выборки: выручка хотя бы в одном году ≥ min_rev (тыс. руб.), последняя сданная отчётность не раньше since_year.
    Два прохода потоком: сначала ИНН, у которых в каком-то сданном отчёте выручка ≥ min_rev (их немного), затем агрегаты
    только по ним. Результат тот же, что у агрегата по всем компаниям, а память не растёт с числом компаний панели
    (полная панель RFSD — 21,8 млн строк, агрегат по всем ИНН не помещался в 900 МБ)."""
    cols = ["inn", "year", "filed", "line_2110", "dissolution_date"]
    keep = set()
    for b in ds.dataset(panel, format="parquet").to_batches(columns=["inn", "filed", "line_2110"], batch_size=500_000):
        rev = pc.multiply(pc.fill_null(pc.cast(b.column("line_2110"), pa.float64()), 0.0), unit_mult)
        m = pc.and_(pc.equal(pc.fill_null(pc.cast(b.column("filed"), pa.float64()), 0.0), 1.0), pc.greater_equal(rev, min_rev))
        keep.update(pc.unique(b.column("inn").filter(m)).to_pylist())
    inn_set = pa.array(sorted(x for x in keep if x is not None), pa.string())
    g, max_year = None, None
    for b in ds.dataset(panel, format="parquet").to_batches(columns=cols, batch_size=500_000):
        y = pc.max(b.column("year")).as_py()
        if y is not None: max_year = y if max_year is None else max(max_year, y)
        b = b.filter(pc.is_in(b.column("inn"), value_set=inn_set))
        if not b.num_rows: continue
        df = b.to_pandas(types_mapper=pd.ArrowDtype)
        df["rev"] = df["line_2110"].astype("float64").fillna(0) * unit_mult
        df["fy"] = df["year"].where(df["filed"] == 1)
        df["frev"] = df["rev"].where(df["filed"] == 1, 0.0)
        part = df.groupby("inn", observed=True).agg(max_rev=("frev", "max"), last_filed=("fy", "max"), dis=("dissolution_date", "max"))
        del df
        g = part if g is None else pd.concat([g, part]).groupby(level=0).agg(max_rev=("max_rev", "max"), last_filed=("last_filed", "max"), dis=("dis", "max"))
    max_year = int(max_year)
    g = g[(g.max_rev >= min_rev) & g.last_filed.notna() & (g.last_filed >= since_year)]
    g["last_filed"] = g["last_filed"].astype(int)
    return g, max_year


def buckets(n):
    """Разбиение компаний по двум последним цифрам ИНН на n групп (ИНН распределены равномерно)."""
    return [pa.array([f"{i:02d}" for i in range(100) if i % n == b]) for b in range(n)]


def read_bucket(panel, columns, suffixes=None, inns=None, years=None):
    """Потоковое чтение: в память попадают только строки нужной группы компаний."""
    keep = []
    inn_set = pa.array(sorted(inns), pa.string()) if inns is not None else None
    for b in ds.dataset(panel, format="parquet").to_batches(columns=columns, batch_size=500_000):
        m = None
        if suffixes is not None: m = pc.is_in(pc.utf8_slice_codeunits(b.column("inn"), -2), value_set=suffixes)
        if years is not None:
            my = pc.is_in(b.column("year"), value_set=pa.array(years, b.column("year").type)); m = my if m is None else pc.and_(m, my)
        if inn_set is not None:
            mi = pc.is_in(b.column("inn"), value_set=inn_set); m = mi if m is None else pc.and_(m, mi)
        bb = b.filter(m) if m is not None else b
        if bb.num_rows: keep.append(bb)
    return pa.Table.from_batches(keep) if keep else pa.table({c: [] for c in columns})
