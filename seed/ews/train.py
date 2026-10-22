"""Обучение балльной карты на срезах из build_features.js.
Выход: data/model.json — интервалы, баллы, зоны и результаты проверки (для страницы и для скоринга в JS)."""
import json, sys, warnings, datetime as dt
from pathlib import Path
import numpy as np, pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from optbinning import BinningProcess, Scorecard
warnings.filterwarnings("ignore")

D = Path(__file__).parent / "data"
SPLIT = sys.argv[1] if len(sys.argv) > 1 else "2024-03-31"   # обучение: срезы по эту дату включительно
rows = pd.DataFrame(json.loads((D / "snapshots.json").read_text()))
FEATS = [f for f in ["dpd_now", "max_dpd_6m", "late_cnt_6m", "delay_trend", "share_paid", "ltv", "guarantee", "restruct_12m",
                     "tenure_m", "tax_12m", "suits_12m", "fssp_12m", "ceo_12m", "eq_ratio", "net_margin", "rev_growth",
                     "debt_rev", "not_filed", "sector"]]
LABELS = {"dpd_now": "Просрочка на дату оценки, дней", "max_dpd_6m": "Максимальная просрочка за 6 месяцев, дней",
          "late_cnt_6m": "Платежей с опозданием более 5 дней за 6 месяцев", "delay_trend": "Изменение среднего опоздания, дней",
          "share_paid": "Доля выплаченных лизинговых платежей", "ltv": "Остаток платежей к стоимости предмета",
          "guarantee": "Поручительство по договорам", "restruct_12m": "Реструктуризаций за 12 месяцев",
          "tenure_m": "Срок отношений с компанией, месяцев", "tax_12m": "Налоговая недоимка за 12 месяцев",
          "suits_12m": "Исков к клиенту за 12 месяцев", "fssp_12m": "Исполнительных производств за 12 месяцев",
          "ceo_12m": "Смена руководителя за 12 месяцев", "eq_ratio": "Доля собственного капитала в активах",
          "net_margin": "Рентабельность по чистой прибыли", "rev_growth": "Изменение выручки за год",
          "debt_rev": "Долг к выручке", "not_filed": "Отчётность за последний год не сдана", "sector": "Отрасль клиента"}
GROUPS = {"dpd_now": "Платёжная дисциплина", "max_dpd_6m": "Платёжная дисциплина", "late_cnt_6m": "Платёжная дисциплина",
          "delay_trend": "Платёжная дисциплина", "share_paid": "Сделка и предмет", "ltv": "Сделка и предмет",
          "guarantee": "Сделка и предмет", "restruct_12m": "Сделка и предмет", "tenure_m": "Сделка и предмет",
          "tax_12m": "Внешние события", "suits_12m": "Внешние события", "fssp_12m": "Внешние события", "ceo_12m": "Внешние события",
          "eq_ratio": "Отчётность", "net_margin": "Отчётность", "rev_growth": "Отчётность", "debt_rev": "Отчётность",
          "not_filed": "Отчётность", "sector": "Отрасль"}

ev = rows[(rows.status == "оценивается") & rows.y.notna()].copy(); ev["y"] = ev.y.astype(int)
tr = ev[ev.date <= SPLIT]; te = ev[ev.date > SPLIT]
X = lambda d: d[FEATS].astype({c: float for c in FEATS if c != "sector"})

# 1. Интервалы и сила факторов на обучающей выборке
MONO = {v: {"monotonic_trend": "auto_asc_desc"} for v in FEATS if v != "sector"}
bp0 = BinningProcess(FEATS, categorical_variables=["sector"], max_n_bins=5, min_bin_size=0.05, binning_fit_params=MONO)
bp0.fit(X(tr), tr.y.values)
summ = bp0.summary().set_index("name")
iv = summ["iv"].astype(float).sort_values(ascending=False)
cand = [v for v in iv.index if iv[v] >= 0.02]
W = bp0.transform(X(tr), metric="woe")
# допустимое число факторов: критерии Riley и соавт. (2019), наблюдение = клиент, R2 Нагелькерке 0,3
import math
def riley_n(p, phi, r2n=0.3, S=0.9, delta=0.05):
    mx = 1 - math.exp(2 * (phi * math.log(phi) + (1 - phi) * math.log(1 - phi))); r2 = r2n * mx
    n1 = p / ((S - 1) * math.log(1 - r2 / S)); S2 = r2 / (r2 + delta * mx)
    n2 = p / ((S2 - 1) * math.log(1 - r2 / S2)) if S2 > 0.9 else 0
    return max(n1, n2, (1.96 / 0.05) ** 2 * phi * (1 - phi))
n_cl = tr.client.nunique(); e_cl = tr[tr.y == 1].client.nunique(); phi = e_cl / n_cl
P_MAX = max(3, max([p for p in range(1, 20) if riley_n(p, phi) <= n_cl] or [3]))

def fit(sel):
    bp = BinningProcess(sel, categorical_variables=[c for c in sel if c == "sector"], max_n_bins=5, min_bin_size=0.05,
                        binning_fit_params={v: MONO[v] for v in sel if v in MONO})
    sc = Scorecard(binning_process=bp, estimator=LogisticRegression(C=0.5, max_iter=2000),
                   scaling_method="pdo_odds", scaling_method_params={"pdo": 20, "odds": 50, "scorecard_points": 600},
                   rounding=True)
    sc.fit(X(tr)[sel], tr.y.values)
    return sc

banned = set()
while True:
    sel, why = [], {}
    for v in cand:  # по убыванию IV; отбрасываем дублирующие (|r| > 0,7) и сверх лимита
        if v in banned: continue
        dup = [s for s in sel if abs(np.corrcoef(W[v], W[s])[0, 1]) > 0.7]
        if dup: why[v] = "дублирует фактор «" + LABELS[dup[0]] + "»"
        elif len(sel) >= P_MAX: why[v] = f"сверх допустимого числа факторов ({P_MAX})"
        else: sel.append(v)
    sc = fit(sel); coef = dict(zip(sel, sc.estimator_.coef_[0]))
    med = np.sign(np.median(list(coef.values())))
    bad = {v for v, c in coef.items() if np.sign(c) != med}
    if not bad: break
    banned |= bad

# 2. Экспорт карты для страницы
tab = sc.table(style="detailed")
vars_ = []
for v in sel:
    ob = sc.binning_process_.get_binned_variable(v)
    t = tab[tab.Variable == v].reset_index(drop=True)
    nb = len(ob.splits) + 1 if ob.dtype == "numerical" else len(ob.splits)
    pts = [float(p) for p in t.Points[:nb]]
    special, missing = float(t.Points.iloc[nb]), float(t.Points.iloc[nb + 1])
    bt = ob.binning_table.build(); bt = bt[bt.index != "Totals"].reset_index(drop=True)
    bins = [{"label": str(bt.Bin[i]), "count": int(bt.Count[i]), "event_rate": float(bt["Event rate"][i]),
             "woe": float(bt.WoE[i]), "points": pts[i]} for i in range(nb)]
    miss_row = bt.iloc[nb + 1]
    bins_missing = {"count": int(miss_row.Count), "event_rate": float(miss_row["Event rate"]) if miss_row.Count else None, "points": missing}
    entry = {"name": v, "label": LABELS[v], "group": GROUPS[v], "iv": round(float(iv[v]), 3),
             "coef": round(float(coef[v]), 3), "points": pts, "missing": missing, "bins": bins, "bins_missing": bins_missing}
    if ob.dtype == "numerical": entry["splits"] = [float(s) for s in ob.splits]
    else: entry["cat"] = True; entry["groups"] = [[str(x) for x in g] for g in ob.splits]
    vars_.append(entry)

s_tr = sc.score(X(tr)[sel]); s_te = sc.score(X(te)[sel])
red, yellow = float(np.percentile(s_tr, 10)), float(np.percentile(s_tr, 30))

# 3. Проверка на другом периоде
def gini(y, s): return 2 * roc_auc_score(y, -s) - 1   # меньше балл — выше риск
rng = np.random.default_rng(7)
def boot(df, s, n=1000):
    cl = df.client.values; uc = np.unique(cl); pos = {u: np.where(cl == u)[0] for u in uc}; y = df.y.values; out = []
    for _ in range(n):
        ii = np.concatenate([pos[u] for u in rng.choice(uc, len(uc))])
        if 0 < y[ii].sum() < len(ii): out.append(gini(y[ii], s[ii]))
    return [round(float(np.percentile(out, 2.5)), 3), round(float(np.percentile(out, 97.5)), 3)]
rule_te = -(te.max_dpd_6m.values > 5).astype(float)       # простое правило: опоздание более 5 дней за полгода
zone = lambda s: np.where(s <= red, "red", np.where(s <= yellow, "yellow", "green"))
zt = pd.DataFrame({"zone": zone(s_te), "y": te.y.values})
zones_te = {z: {"share": round(float((zt.zone == z).mean()), 3), "event_rate": round(float(zt[zt.zone == z].y.mean()), 3),
                "events_share": round(float(zt[zt.zone == z].y.sum() / zt.y.sum()), 3)} for z in ["red", "yellow", "green"]}
rule_flag = te.max_dpd_6m.values > 5
rule_stats = {"share": round(float(rule_flag.mean()), 3), "events_share": round(float(te.y.values[rule_flag].sum() / te.y.sum()), 3)}
# модель при том же числе тревог, что и правило: худшие по баллу срезы в той же доле
k = int(round(rule_flag.mean() * len(te))); top = np.argsort(s_te, kind="stable")[:k]
rule_stats["model_events_share_same_volume"] = round(float(te.y.values[top].sum() / te.y.sum()), 3)

valid = {"split": SPLIT, "train": {"rows": int(len(tr)), "clients": int(tr.client.nunique()), "events": int(tr.y.sum()),
                                   "event_clients": int(tr[tr.y == 1].client.nunique()), "from": tr.date.min(), "to": tr.date.max()},
         "test": {"rows": int(len(te)), "clients": int(te.client.nunique()), "events": int(te.y.sum()),
                  "event_clients": int(te[te.y == 1].client.nunique()), "from": te.date.min(), "to": te.date.max()},
         "gini_train": round(gini(tr.y.values, s_tr), 3), "gini_test": round(gini(te.y.values, s_te), 3),
         "gini_test_ci": boot(te, s_te), "gini_rule": round(gini(te.y.values, rule_te), 3), "gini_rule_ci": boot(te, rule_te),
         "zones_test": zones_te, "rule_test": rule_stats}

# заблаговременность: за сколько месяцев до первого дефолта клиент впервые попал в красную зону
allr = rows[rows.status == "оценивается"].copy()
allr["score"] = sc.score(X(allr)[sel]); allr["zone"] = zone(allr.score.values)
allr.loc[allr.stop_bankr == 1, "zone"] = "red"
first_def = json.loads((D / "defaults.json").read_text())  # общее правило из features.js
lead = []
mdiff = lambda a, b: (int(b[:4]) - int(a[:4])) * 12 + int(b[5:7]) - int(a[5:7])
for c, d in first_def.items():
    if d <= SPLIT: continue
    g = allr[(allr.client == c) & (allr.date < d)]
    g = g[g.date.map(lambda x: mdiff(x, d) <= 12)]
    if not len(g): continue
    r = g[g.zone == "red"]
    a = rows[(rows.client == c) & (rows.date < d) & (rows.dpd_now >= 30)]
    a = a[a.date.map(lambda x: mdiff(x, d) <= 12)]
    lead.append({"client": c, "default": d, "red": mdiff(r.date.iloc[0], d) if len(r) else 0,
                 "dpd30": mdiff(a.date.iloc[0], d) if len(a) else 0})
L = pd.DataFrame(lead)
valid["lead"] = {"clients": int(len(L)), "red_median": float(L.red.median()), "dpd30_median": float(L.dpd30.median()),
                 "red_ge3": round(float((L.red >= 3).mean()), 3), "dpd30_ge3": round(float((L.dpd30 >= 3).mean()), 3),
                 "red_never": round(float((L.red == 0).mean()), 3),
                 "hist_red": [int((L.red == k).sum()) for k in range(13)], "hist_dpd30": [int((L.dpd30 == k).sum()) for k in range(13)],
                 "cases": L.to_dict("records")}

cands = [{"name": v, "label": LABELS[v], "group": GROUPS[v], "iv": round(float(iv[v]), 3), "selected": v in sel,
          "reason": "в модели" if v in sel else ("слабый фактор (IV < 0,02)" if iv[v] < 0.02 else
                    ("вес получил противоположный знак при совместной оценке" if v in banned else why.get(v, "")))} for v in iv.index]
valid["p_max"] = {"value": int(P_MAX), "clients": int(n_cl), "event_clients": int(e_cl)}
model = {"version": dt.date.today().isoformat(), "data": "Демонстрационные данные (условный портфель)",
         "target": "Просрочка 60+ дней или расторжение договора в течение 12 месяцев после даты оценки",
         "scaling": {"pdo": 20, "odds": 50, "points": 600}, "zones": {"red": red, "yellow": yellow},
         "vars": vars_, "candidates": cands, "validation": valid}
(D / "model.json").write_text(json.dumps(model, ensure_ascii=False, indent=1, default=float))
# для проверки совпадения с расчётом на странице
pd.DataFrame({"client": te.client.values, "date": te.date.values, "py_score": s_te}).to_csv(D / "py_scores_test.csv", index=False)
print("факторы:", [(v["name"], v["iv"]) for v in vars_])
print("зоны:", round(red, 1), round(yellow, 1))
print(json.dumps({k: valid[k] for k in ["gini_train", "gini_test", "gini_test_ci", "gini_rule", "gini_rule_ci", "zones_test", "rule_test", "lead"]}, ensure_ascii=False))
