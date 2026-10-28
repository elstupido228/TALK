"""Обучение балльной карты риска банкротства на открытых данных (тот же метод, что train.py в seed/ews).

Разделение по времени: обучение — отчёты за годы ≤ --train-to, проверка — (--train-to, --test-to].
Единица для лимита факторов (Riley и соавт., 2019) — компания. Для экономии памяти из обучения берутся все банкротства
и случайная часть небанкротов (--max-goods); на ранжирование это не влияет, зоны и доли банкротств считаются по полной проверке.
Устойчивость: сила (IV) и направление факторов отдельно на периодах --periods.

  python train_open.py --train-to 2021 --test-to 2023      -> data/model_open.json, data/open_py_scores_test.csv
"""
import argparse, json, math, warnings, datetime as dt
from pathlib import Path
import numpy as np, pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from optbinning import BinningProcess, Scorecard
from open_features import FEATURES
warnings.filterwarnings("ignore")

ap = argparse.ArgumentParser()
ap.add_argument("--obs", default="data/open_obs.parquet")
ap.add_argument("--train-from", type=int, default=2015)
ap.add_argument("--train-to", type=int, default=2021)
ap.add_argument("--test-to", type=int, default=2023)
ap.add_argument("--max-goods", type=int, default=300_000)
ap.add_argument("--periods", default="2015-2018,2019-2021,2022-2023")
ap.add_argument("--out", default="data/model_open.json")
a = ap.parse_args()

LABEL = {n: l for n, l, g in FEATURES}; GROUP = {n: g for n, l, g in FEATURES}
NUM = [n for n, l, g in FEATURES if n != "sector"]
FEATS = NUM + ["sector"]
df = pd.read_parquet(a.obs)
df = df[(df.year >= a.train_from) & (df.year <= a.test_to)].copy()
X = lambda d: d[FEATS].astype({c: float for c in NUM})
tr_all = df[df.year <= a.train_to]; te = df[df.year > a.train_to]
rng = np.random.default_rng(20261028)
goods = tr_all[tr_all.y == 0]
if len(goods) > a.max_goods: goods = goods.iloc[rng.choice(len(goods), a.max_goods, replace=False)]
tr = pd.concat([tr_all[tr_all.y == 1], goods]).sort_values(["year", "inn"])
print(f"обучение: {len(tr_all)} наблюдений ({tr_all.inn.nunique()} компаний, банкротств {int(tr_all.y.sum())}); "
      f"в расчёт взято {len(tr)}; проверка: {len(te)} наблюдений, банкротств {int(te.y.sum())}", flush=True)

MONO = {v: {"monotonic_trend": "auto_asc_desc"} for v in NUM}
bp0 = BinningProcess(FEATS, categorical_variables=["sector"], max_n_bins=6, min_bin_size=0.03, binning_fit_params=MONO)
bp0.fit(X(tr), tr.y.values)
iv = bp0.summary().set_index("name")["iv"].astype(float).sort_values(ascending=False)
cand = [v for v in iv.index if iv[v] >= 0.02]
W = bp0.transform(X(tr), metric="woe")

def riley_n(p, phi, r2n=0.3, S=0.9, delta=0.05):
    mx = 1 - math.exp(2 * (phi * math.log(phi) + (1 - phi) * math.log(1 - phi))); r2 = r2n * mx
    n1 = p / ((S - 1) * math.log(1 - r2 / S)); S2 = r2 / (r2 + delta * mx)
    n2 = p / ((S2 - 1) * math.log(1 - r2 / S2)) if S2 > 0.9 else 0
    return max(n1, n2, (1.96 / 0.05) ** 2 * phi * (1 - phi))
n_cl = tr_all.inn.nunique(); e_cl = tr_all[tr_all.y == 1].inn.nunique(); phi = max(e_cl / n_cl, 1e-4)
P_MAX = max(3, max([p for p in range(1, len(FEATS) + 1) if riley_n(p, phi) <= n_cl] or [3]))

def fit(sel):
    bp = BinningProcess(sel, categorical_variables=[c for c in sel if c == "sector"], max_n_bins=6, min_bin_size=0.03,
                        binning_fit_params={v: MONO[v] for v in sel if v in MONO})
    sc = Scorecard(binning_process=bp, estimator=LogisticRegression(C=0.5, max_iter=3000),
                   scaling_method="pdo_odds", scaling_method_params={"pdo": 20, "odds": 50, "scorecard_points": 600}, rounding=True)
    sc.fit(X(tr)[sel], tr.y.values); return sc

banned = set()
while True:
    sel, why = [], {}
    for v in cand:
        if v in banned: continue
        dup = [s for s in sel if abs(np.corrcoef(W[v], W[s])[0, 1]) > 0.7]
        if dup: why[v] = "дублирует фактор «" + LABEL[dup[0]] + "»"
        elif len(sel) >= P_MAX: why[v] = f"сверх допустимого числа факторов ({P_MAX})"
        else: sel.append(v)
    sc = fit(sel); coef = dict(zip(sel, sc.estimator_.coef_[0]))
    med = np.sign(np.median(list(coef.values())))
    bad = {v for v, c in coef.items() if np.sign(c) != med}
    if not bad: break
    banned |= bad

tab = sc.table(style="detailed"); vars_ = []
for v in sel:
    ob = sc.binning_process_.get_binned_variable(v); t = tab[tab.Variable == v].reset_index(drop=True)
    nb = len(ob.splits) + 1 if ob.dtype == "numerical" else len(ob.splits)
    pts = [float(p) for p in t.Points[:nb]]; missing = float(t.Points.iloc[nb + 1])
    bt = ob.binning_table.build(); bt = bt[bt.index != "Totals"].reset_index(drop=True)
    bins = [{"label": str(bt.Bin[i]), "count": int(bt.Count[i]), "event_rate": float(bt["Event rate"][i]), "woe": float(bt.WoE[i]), "points": pts[i]} for i in range(nb)]
    mr = bt.iloc[nb + 1]
    e = {"name": v, "label": LABEL[v], "group": GROUP[v], "iv": round(float(iv[v]), 3), "coef": round(float(coef[v]), 3), "points": pts,
         "missing": missing, "bins": bins, "bins_missing": {"count": int(mr.Count), "event_rate": float(mr["Event rate"]) if mr.Count else None, "points": missing}}
    if ob.dtype == "numerical": e["splits"] = [float(s) for s in ob.splits]
    else: e["cat"] = True; e["groups"] = [[str(x) for x in g] for g in ob.splits]
    vars_.append(e)

s_tr = sc.score(X(tr_all)[sel]); s_te = sc.score(X(te)[sel])
red, yellow = float(np.percentile(s_tr, 10)), float(np.percentile(s_tr, 30))
def gini(y, s): return 2 * roc_auc_score(y, -s) - 1
def boot(d, s, n=500):
    cl = d.inn.values; uc = np.unique(cl); idx = pd.Series(np.arange(len(cl))).groupby(cl).apply(np.array).to_dict(); y = d.y.values; out = []
    r = np.random.default_rng(7)
    for _ in range(n):
        ii = np.concatenate([idx[u] for u in r.choice(uc, len(uc))])
        if 0 < y[ii].sum() < len(ii): out.append(gini(y[ii], s[ii]))
    return [round(float(np.percentile(out, 2.5)), 3), round(float(np.percentile(out, 97.5)), 3)]
zone = lambda s: np.where(s <= red, "red", np.where(s <= yellow, "yellow", "green"))
zt = pd.DataFrame({"zone": zone(s_te), "y": te.y.values})
zones_te = {z: {"share": round(float((zt.zone == z).mean()), 4), "event_rate": round(float(zt[zt.zone == z].y.mean()), 4),
                "events_share": round(float(zt[zt.zone == z].y.sum() / max(zt.y.sum(), 1)), 3)} for z in ["red", "yellow", "green"]}
S_te = te.class285_S.values.astype(float)  # класс по методике банка: больше S — хуже
valid = {"train": {"years": [a.train_from, a.train_to], "obs": int(len(tr_all)), "firms": int(n_cl), "events": int(tr_all.y.sum()), "used_rows": int(len(tr))},
         "test": {"years": [a.train_to + 1, a.test_to], "obs": int(len(te)), "firms": int(te.inn.nunique()), "events": int(te.y.sum())},
         "gini_train": round(gini(tr_all.y.values, s_tr), 3), "gini_test": round(gini(te.y.values, s_te), 3), "gini_test_ci": boot(te, s_te),
         "gini_class285_S": round(2 * roc_auc_score(te.y.values, S_te) - 1, 3), "gini_class285_S_ci": boot(te, -S_te),
         "zones_test": zones_te, "p_max": {"value": int(P_MAX), "firms": int(n_cl), "event_firms": int(e_cl)},
         "base_rate_test": round(float(te.y.mean()), 5)}
# устойчивость факторов по периодам
stab = {}
for per in a.periods.split(","):
    p0, p1 = map(int, per.split("-")); d = df[(df.year >= p0) & (df.year <= p1)]
    dg = d[d.y == 0]
    if len(dg) > a.max_goods: d = pd.concat([d[d.y == 1], dg.iloc[np.random.default_rng(p0).choice(len(dg), a.max_goods, replace=False)]])
    if d.y.sum() < 20: stab[per] = {"note": f"мало банкротств ({int(d.y.sum())})"}; continue
    b = BinningProcess(FEATS, categorical_variables=["sector"], max_n_bins=6, min_bin_size=0.03, binning_fit_params=MONO).fit(X(d), d.y.values)
    s = b.summary().set_index("name")
    dirs = {}
    for v in NUM:
        t = b.get_binned_variable(v).binning_table.build(); t = t[t.index != "Totals"]
        er = [x for x, c in zip(t["Event rate"][:-2], t.Count[:-2]) if c > 0]
        dirs[v] = "растёт" if len(er) > 1 and er[-1] > er[0] else "падает" if len(er) > 1 and er[-1] < er[0] else "—"
    stab[per] = {"events": int(d.y.sum()), "obs": int(len(d)), "iv": {v: round(float(s.loc[v, "iv"]), 3) for v in FEATS}, "risk_direction": dirs}
cands = [{"name": v, "label": LABEL[v], "group": GROUP[v], "iv": round(float(iv[v]), 3), "selected": v in sel,
          "reason": "в модели" if v in sel else ("слабый фактор (IV < 0,02)" if iv[v] < 0.02 else
                    ("вес получил противоположный знак при совместной оценке" if v in banned else why.get(v, "")))} for v in iv.index]
model = {"kind": "open", "version": dt.date.today().isoformat(),
         "data": "Открытые данные: RFSD (отчётность ГИР БО / Росстат) + статус ЕГРЮЛ через DaData",
         "target": "Последний сданный отчёт перед банкротством (процедура банкротства или ликвидация после конкурсного производства)",
         "population": "Отрасли: сельское хозяйство, добыча, обрабатывающее производство, строительство, оптовая торговля, транспорт; выручка хотя бы в одном году от 50 млн руб.",
         "availability": "Отчёт за год Y учитывается с 1 апреля Y+1",
         "scaling": {"pdo": 20, "odds": 50, "points": 600}, "zones": {"red": red, "yellow": yellow},
         "vars": vars_, "candidates": cands, "validation": valid, "stability": stab}
Path(a.out).write_text(json.dumps(model, ensure_ascii=False, indent=1, default=float))
pd.DataFrame({"inn": te.inn.values, "year": te.year.values, "py_score": s_te}).to_csv(Path(a.out).parent / "open_py_scores_test.csv", index=False)
print("факторы:", [(v["name"], v["iv"]) for v in vars_])
print(json.dumps({k: valid[k] for k in ["gini_train", "gini_test", "gini_test_ci", "gini_class285_S", "gini_class285_S_ci", "zones_test", "p_max", "base_rate_test"]}, ensure_ascii=False))
for per, s in stab.items():
    if "iv" in s: print(per, "банкротств", s["events"], "топ-5 IV:", sorted(s["iv"].items(), key=lambda x: -x[1])[:5])
