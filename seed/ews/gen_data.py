"""Условный портфель лизинговой компании в структуре запроса к ТАЛК.
Данные выдуманы: клиенты обозначены кодами, отрасли и регионы — для правдоподобия.
Выход: data/<out> (по умолчанию data/demo.json).
Запуск: python gen_data.py                                   # демо-портфель для страницы (420 клиентов)
        python gen_data.py --clients 2500 --out pool.json     # обучающий пул
"""
import json, math, random, argparse, datetime as dt
from pathlib import Path
import numpy as np

ap = argparse.ArgumentParser(description="Условный портфель лизинговой компании")
ap.add_argument("--clients", type=int, default=420, help="число клиентов (демо для страницы — 420, обучающий пул — 2500)")
ap.add_argument("--out", default="demo.json", help="имя файла в data/")
args = ap.parse_args()
SEED = 20261014
rng = np.random.default_rng(SEED); random.seed(SEED)
TODAY = dt.date(2026, 9, 30)
OUT = Path(__file__).parent / "data"; OUT.mkdir(exist_ok=True)

def add_months(d, k):
    y, m = divmod(d.month - 1 + k, 12)
    return dt.date(d.year + y, m + 1, min(d.day, 28))

def month_index(d):  # месяцы от 2019-01
    return (d.year - 2019) * 12 + d.month - 1

def sig(x): return 1 / (1 + math.exp(-x))

SECTORS = [  # отрасль, доля, типы предметов
    ("Грузоперевозки", 0.30, ["Грузовой транспорт"]),
    ("Строительство", 0.22, ["Спецтехника", "Грузовой транспорт"]),
    ("Оптовая торговля", 0.16, ["Легковой транспорт", "Грузовой транспорт"]),
    ("Сельское хозяйство", 0.12, ["Спецтехника", "Оборудование"]),
    ("Обрабатывающее производство", 0.12, ["Оборудование", "Грузовой транспорт"]),
    ("Добыча полезных ископаемых", 0.08, ["Спецтехника"]),
]
REGIONS = ["Москва", "Московская обл.", "Санкт-Петербург", "Свердловская обл.", "Тюменская обл.",
           "Краснодарский край", "Новосибирская обл.", "Республика Татарстан", "Нижегородская обл.", "Красноярский край"]
ASSET_VALUE = {"Грузовой транспорт": (16.0, 0.45), "Спецтехника": (16.4, 0.55),
               "Легковой транспорт": (15.0, 0.4), "Оборудование": (16.2, 0.7)}  # lognormal в рублях

def sector_shock(sector, m):
    d = dt.date(2019 + m // 12, m % 12 + 1, 1)
    s = 0.0
    if sector == "Грузоперевозки" and dt.date(2024, 5, 1) <= d <= dt.date(2025, 8, 1): s -= 0.10
    if sector == "Строительство" and dt.date(2025, 1, 1) <= d <= dt.date(2025, 12, 1): s -= 0.07
    if sector == "Оптовая торговля" and dt.date(2025, 2, 1) <= d <= dt.date(2025, 10, 1): s -= 0.03
    if dt.date(2020, 4, 1) <= d <= dt.date(2020, 9, 1): s -= 0.03  # общий спад
    return s

N_CLI = args.clients  # первые 420 клиентов одинаковы при любом N: генератор идёт по клиентам последовательно
M_END = month_index(TODAY)
clients, contracts, schedule, payments, events, reports = [], [], [], [], [], []
n_contract = 0
for i in range(N_CLI):
    cid = f"КЛ-{i+1:04d}"
    sec = rng.choice(len(SECTORS), p=[s[1] for s in SECTORS]); sector, _, assets = SECTORS[sec]
    rel_start = dt.date(2019, 1, 1) + dt.timedelta(days=int(rng.integers(0, (dt.date(2025, 12, 1) - dt.date(2019, 1, 1)).days)))
    region = REGIONS[int(rng.integers(0, len(REGIONS)))]
    clients.append({"client": cid, "sector": sector, "region": region, "since": rel_start.isoformat()})
    # латентное состояние клиента по месяцам
    h = np.zeros(M_END + 1); h[0] = rng.normal(0.1, 0.9)
    for m in range(1, M_END + 1):
        h[m] = 0.97 * h[m - 1] + rng.normal(0, 0.22) + sector_shock(sector, m)
    # договоры
    k = 1 + int(rng.random() < 0.35) + int(rng.random() < 0.12)
    starts = sorted([rel_start] + [rel_start + dt.timedelta(days=int(rng.integers(60, 900))) for _ in range(k - 1)])
    cl_contracts = []
    for st in starts:
        if st > dt.date(2026, 6, 30): continue
        n_contract += 1
        a = assets[int(rng.integers(0, len(assets)))]
        mu, sd = ASSET_VALUE[a]; value = round(float(rng.lognormal(mu, sd)), -3)
        adv = float(rng.choice([0.1, 0.15, 0.2, 0.25, 0.3])); term = int(rng.choice([24, 36, 36, 48, 60]))
        total = value * (1 - adv) * (1 + 0.11 * term / 12)
        inst = round(total / term, 2)
        guar = bool(rng.random() < 0.45)
        con = {"contract": f"ДЛ-{n_contract:05d}", "client": cid, "date": st.isoformat(), "asset": a,
               "asset_value": value, "advance": round(value * adv, 2), "term": term, "guarantee": guar}
        dues = [add_months(st, j + 1) for j in range(term)]
        cl_contracts.append((con, dues, inst))
    if not cl_contracts: clients.pop(); continue
    # события и платежи по месяцам
    default_m = None; cured = False; terminated = None
    for m in range(month_index(rel_start), M_END + 1):
        hm = h[m]
        md = dt.date(2019 + m // 12, m % 12 + 1, 1)
        if default_m is None and hm < -2.15 and md >= dt.date(2019, 6, 1):
            default_m = m
        def ev(t, amount=None):
            day = md + dt.timedelta(days=int(rng.integers(0, 27)))
            if day <= TODAY: events.append({"client": cid, "date": day.isoformat(), "type": t, "amount": amount})
        if terminated is None:
            if rng.random() < 0.004 + 0.10 * sig((-hm - 1.2) * 2.5): ev("Налоговая недоимка", round(float(rng.lognormal(13, 1)), -3))
            if rng.random() < 0.010 + 0.10 * sig((-hm - 1.0) * 2.0): ev("Иск к клиенту", round(float(rng.lognormal(14.5, 1.2)), -3))
            if rng.random() < 0.003 + 0.08 * sig((-hm - 1.5) * 2.5): ev("Исполнительное производство", round(float(rng.lognormal(13.5, 1)), -3))
            if rng.random() < 0.006 + 0.03 * sig((-hm - 1.5) * 2.0): ev("Смена руководителя")
            if rng.random() < 0.25 * sig((-hm - 3.0) * 3): ev("Намерение кредитора о банкротстве")
        if default_m is not None and m == default_m + 3 and terminated is None and not cured:
            if rng.random() < 0.35:
                cured = True; ev("Реструктуризация")
                h[m:] = h[m:] + 2.2
            else:
                terminated = m; ev("Расторжение договора");
                if rng.random() < 0.7:
                    md2 = add_months(md, 1)
                    if md2 <= TODAY: events.append({"client": cid, "date": md2.isoformat(), "type": "Изъятие предмета лизинга", "amount": None})
    # платежи по графику
    for con, dues, inst in cl_contracts:
        contracts.append(con)
        arrears = []  # неоплаченные платежи, которые погасятся при реструктуризации
        for j, d in enumerate(dues):
            schedule.append({"contract": con["contract"], "due": d.isoformat(), "amount": inst})
            m = month_index(d)
            if m > M_END: continue
            if terminated is not None and m >= terminated: continue
            in_default = default_m is not None and default_m <= m and not (cured and m >= default_m + 3)
            if in_default:
                arrears.append(d); continue
            hm = h[m]
            r = rng.random()
            delay = int(rng.integers(-3, 1))
            if r < 0.10: delay = int(rng.integers(1, 6))
            elif r < 0.14: delay = int(rng.integers(6, 21))
            if hm < -1.0:
                s = min(1.0, (-1.0 - hm) / 1.6)
                if rng.random() < 0.3 + 0.6 * s: delay = int(5 + rng.exponential(10 + 40 * s))
            pd_ = d + dt.timedelta(days=delay)
            if cured and arrears and m >= default_m + 3:
                pay_day = d + dt.timedelta(days=int(rng.integers(0, 10)))
                for a in arrears:
                    if pay_day <= TODAY: payments.append({"contract": con["contract"], "date": pay_day.isoformat(), "amount": inst})
                arrears = []
            if pd_ <= TODAY: payments.append({"contract": con["contract"], "date": pd_.isoformat(), "amount": inst})
    # годовая отчётность (тыс. руб.)
    rev = float(rng.lognormal(math.log(250_000), 0.8))
    for Y in range(max(2018, rel_start.year - 2), 2026):
        ms = [month_index(dt.date(Y, mm, 1)) for mm in range(1, 13) if 0 <= month_index(dt.date(Y, mm, 1)) <= M_END]
        ah = float(np.mean(h[ms])) if ms else float(h[0])
        prev = rev; rev = max(5_000.0, rev * (1 + 0.08 + 0.06 * ah + rng.normal(0, 0.10)))
        if terminated is not None and Y * 12 > (2019 * 12 + terminated): break
        p_file = 0.93 if ah > -1.5 else 0.6
        if rng.random() > p_file: continue
        filed = dt.date(Y + 1, 3, int(rng.integers(10, 31)))
        if filed > TODAY: continue
        eq_ratio = float(np.clip(0.35 + 0.07 * ah + rng.normal(0, 0.06), -0.3, 0.9))
        assets_v = rev * float(rng.uniform(0.6, 1.4))
        reports.append({"client": cid, "year": Y, "filed": filed.isoformat(), "revenue": round(rev),
                        "net_profit": round(rev * (0.04 + 0.025 * ah + rng.normal(0, 0.02))),
                        "equity": round(assets_v * eq_ratio), "assets": round(assets_v),
                        "debt": round(assets_v * (1 - max(eq_ratio, 0)) * float(rng.uniform(0.5, 0.9)))})

data = {"today": TODAY.isoformat(), "clients": clients, "contracts": contracts, "schedule": schedule,
        "payments": payments, "events": events, "reports": reports}
(OUT / args.out).write_text(json.dumps(data, ensure_ascii=False))
print({k: len(v) for k, v in data.items() if isinstance(v, list)})
from collections import Counter
print(Counter(e["type"] for e in events))
