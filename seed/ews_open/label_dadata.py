"""Разметка исхода через DaData «Организация по ИНН»: статус и подробный код (ЕГРЮЛ).
Банкротство: коды 113–117 (процедура идёт) и 203 (ликвидировано после конкурсного производства).

Кого спрашиваем (по порядку): 1) прекращённые по данным RFSD; 2) переставшие сдавать отчётность;
3) случайные 3% остальных — чтобы оценить, сколько банкротов среди продолжающих отчитываться.
Кэш — SQLite (data/dadata.sqlite): повторный запуск продолжает с места остановки, ИНН не запрашиваются дважды.

  DADATA_TOKEN=... python label_dadata.py --limit 8000
  python label_dadata.py --mock data/mock_dadata.json        # проверка без сети
"""
import argparse, json, os, random, sqlite3, sys, time, datetime as dt
from pathlib import Path
from panel_io import population

URL = "https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party"
BANKRUPT_CODES = {"113", "114", "115", "116", "117", "203"}


def plan(pop, max_year, sample_share, seed):
    """Сначала компании с недавним окончанием отчётности: на них раньше можно начать обучение."""
    p = pop.sort_values("last_filed", ascending=False)
    a = [k for k in p.index[p.dis.notna()]]
    b = [k for k in p.index[p.dis.isna() & (p.last_filed < max_year)]]
    rest = sorted(p.index[p.dis.isna() & (p.last_filed >= max_year)])
    random.Random(seed).shuffle(rest)
    c = rest[: int(len(rest) * sample_share)]
    order = [(k, "прекращена") for k in a] + [(k, "перестала сдавать") for k in b]
    order.sort(key=lambda x: -int(p.at[x[0], "last_filed"]))
    return order + [(k, "выборка продолжающих") for k in c]


def db(path):
    con = sqlite3.connect(path)
    con.execute("create table if not exists dadata(inn text primary key, grp text, found int, status text, code text,"
                " liquidation_date text, actuality_date text, registration_date text, raw text, fetched_at text)")
    return con


def ms_to_date(x):
    if x is None: return None
    try: return dt.datetime.fromtimestamp(int(x) / 1000, dt.timezone.utc).date().isoformat()
    except (TypeError, ValueError): return str(x)[:10]


def fetch(inn, token, session):
    for attempt in range(5):
        r = session.post(URL, json={"query": inn, "branch_type": "MAIN"},
                         headers={"Authorization": f"Token {token}", "Content-Type": "application/json", "Accept": "application/json"}, timeout=20)
        if r.status_code == 429: time.sleep(2 ** attempt); continue
        if r.status_code == 403: raise SystemExit("DaData вернула 403: исчерпан суточный лимит или неверный токен. Запустите снова завтра.")
        r.raise_for_status()
        s = r.json().get("suggestions") or []
        return s[0]["data"] if s else None
    raise RuntimeError("DaData: слишком много запросов подряд (429)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--panel", default="data/rfsd_panel")
    ap.add_argument("--db", default="data/dadata.sqlite")
    ap.add_argument("--min-revenue", type=float, default=50_000, help="порог максимальной выручки, тыс. руб. (50 млн руб.)")
    ap.add_argument("--unit", choices=["thousand", "rub"], default="thousand", help="в чём суммы в RFSD")
    ap.add_argument("--limit", type=int, default=8000, help="не больше запросов за последние 24 часа")
    ap.add_argument("--rps", type=float, default=10)
    ap.add_argument("--sample-share", type=float, default=0.03)
    ap.add_argument("--mock", help="JSON {инн: data} вместо обращения к DaData (для проверки)")
    ap.add_argument("--since-year", type=int, default=2015, help="брать компании, сдававшие отчётность не раньше этого года")
    ap.add_argument("--plan-only", action="store_true", help="только посчитать, сколько запросов нужно")
    ap.add_argument("--save-plan", help="записать план (порядок ИНН и группы) в JSON — для разметки на другой машине без панели")
    ap.add_argument("--plan-file", help="взять план из JSON (--save-plan) вместо расчёта по панели")
    a = ap.parse_args()
    mult = 1.0 if a.unit == "thousand" else 0.001
    if a.plan_file:
        meta = json.loads(Path(a.plan_file).read_text(encoding="utf-8"))
        todo, n_pop, max_year = [tuple(x) for x in meta["todo"]], meta["population"], meta["max_year"]
    else:
        pop, max_year = population(a.panel, a.min_revenue, mult, a.since_year)
        todo, n_pop = plan(pop, max_year, a.sample_share, 20261028), len(pop)
    if a.save_plan:
        Path(a.save_plan).write_text(json.dumps({"population": n_pop, "max_year": max_year, "min_revenue": a.min_revenue,
                                                 "sample_share": a.sample_share, "since_year": a.since_year, "todo": todo}, ensure_ascii=False), encoding="utf-8")
    con = db(a.db)
    done = {r[0] for r in con.execute("select inn from dadata")}
    left = [(k, g) for k, g in todo if k not in done]
    groups = {}
    for _, g in todo: groups[g] = groups.get(g, 0) + 1
    print(f"компаний в выборке {n_pop}, последний год отчётности {max_year}; к запросу {len(todo)}: {groups}; уже в кэше {len(done)}, осталось {len(left)}")
    print(f"при лимите {a.limit} в сутки потребуется около {-(-len(left) // max(a.limit, 1))} суток")
    if a.plan_only: sys.exit(0)
    since = (dt.datetime.now() - dt.timedelta(days=1)).isoformat()
    used = con.execute("select count(*) from dadata where fetched_at > ?", (since,)).fetchone()[0]
    budget = max(0, a.limit - used)
    print(f"за последние 24 часа уже запрошено {used}, доступно {budget}")
    mock = json.loads(Path(a.mock).read_text()) if a.mock else None
    token = os.environ.get("DADATA_TOKEN")
    if not mock and not token: raise SystemExit("нет DADATA_TOKEN в окружении")
    import requests
    session = requests.Session(); n = 0; t0 = time.time()
    for inn, grp in left[:budget]:
        data = mock.get(inn) if mock else fetch(inn, token, session)
        st = (data or {}).get("state") or {}
        con.execute("insert or replace into dadata values (?,?,?,?,?,?,?,?,?,?)",
                    (inn, grp, 1 if data else 0, st.get("status"), None if st.get("code") is None else str(st.get("code")),
                     ms_to_date(st.get("liquidation_date")), ms_to_date(st.get("actuality_date")), ms_to_date(st.get("registration_date")),
                     json.dumps(st, ensure_ascii=False), dt.datetime.now().isoformat()))
        n += 1
        if n % 200 == 0: con.commit(); print(f"  {n} из {min(budget, len(left))}", flush=True)
        if not mock: time.sleep(max(0, 1 / a.rps - 0.0))
    con.commit()
    rows = con.execute("select grp, count(*), sum(code in ('113','114','115','116','117','203')), sum(found=0) from dadata group by grp").fetchall()
    print(f"запрошено сейчас {n} за {time.time() - t0:.0f} с; осталось {len(left) - n}")
    for g, c, b, nf in rows: print(f"  {g}: размечено {c}, банкротств {b or 0}, не найдено в DaData {nf or 0}")
