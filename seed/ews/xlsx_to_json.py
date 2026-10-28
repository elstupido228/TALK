"""Выгрузка по шаблону (xlsx, 6 листов) -> JSON в формате data/demo.json для build_features.js.
Запуск: python xlsx_to_json.py выгрузка.xlsx data/talk.json --date 2026-09-30
--date — дата оценки (конец месяца); по умолчанию последний полный месяц по датам платежей и событий.
Без --reverse. С --reverse: обратная операция JSON -> xlsx по шаблону (для проверки и для примера):
      python xlsx_to_json.py data/demo.json пример.xlsx --reverse
"""
import sys, json, argparse, datetime as dt, calendar
from pathlib import Path
import pandas as pd

# лист, ключ в JSON, столбцы: (заголовок в шаблоне, поле, тип: s строка, d дата, n число, b да/нет)
SHEETS = [
    ("Клиенты", "clients", [("Код клиента", "client", "s"), ("Отрасль", "sector", "s"), ("Регион", "region", "s"),
                            ("Дата начала отношений", "since", "d")]),
    ("Договоры", "contracts", [("Номер договора", "contract", "s"), ("Код клиента", "client", "s"), ("Дата договора", "date", "d"),
                               ("Тип предмета лизинга", "asset", "s"), ("Стоимость предмета, руб.", "asset_value", "n"),
                               ("Аванс, руб.", "advance", "n"), ("Срок, мес.", "term", "n"), ("Поручительство (да/нет)", "guarantee", "b")]),
    ("График", "schedule", [("Номер договора", "contract", "s"), ("Дата платежа", "due", "d"), ("Сумма платежа, руб.", "amount", "n")]),
    ("Платежи", "payments", [("Номер договора", "contract", "s"), ("Дата оплаты", "date", "d"), ("Сумма оплаты, руб.", "amount", "n")]),
    ("События", "events", [("Код клиента", "client", "s"), ("Дата", "date", "d"), ("Тип события", "type", "s"), ("Сумма, руб.", "amount", "n")]),
    ("Отчётность", "reports", [("Код клиента", "client", "s"), ("Год", "year", "n"), ("Дата представления", "filed", "d"),
                               ("Выручка, тыс. руб.", "revenue", "n"), ("Чистая прибыль, тыс. руб.", "net_profit", "n"),
                               ("Капитал, тыс. руб.", "equity", "n"), ("Активы, тыс. руб.", "assets", "n"), ("Долг, тыс. руб.", "debt", "n")]),
]
EVENT_TYPES = {"Налоговая недоимка", "Иск к клиенту", "Исполнительное производство", "Смена руководителя",
               "Намерение кредитора о банкротстве", "Реструктуризация", "Расторжение договора", "Изъятие предмета лизинга"}
REQUIRED = {"client", "contract", "date", "due", "amount", "year", "filed", "type"}


def to_date(v):
    if v is None or (isinstance(v, float) and pd.isna(v)) or v == "": return None
    if isinstance(v, (dt.datetime, pd.Timestamp)): return v.strftime("%Y-%m-%d")
    if isinstance(v, dt.date): return v.isoformat()
    if isinstance(v, (int, float)): return (dt.date(1899, 12, 30) + dt.timedelta(days=int(v))).isoformat()  # дата Excel числом
    s = str(v).strip()
    for f in ("%d.%m.%Y", "%Y-%m-%d", "%d.%m.%y"):
        try: return dt.datetime.strptime(s[:10], f).date().isoformat()
        except ValueError: pass
    return None


def to_num(v):
    if v is None or (isinstance(v, float) and pd.isna(v)) or v == "": return None
    if isinstance(v, (int, float)): return int(v) if float(v).is_integer() else float(v)
    try:
        x = float(str(v).replace(" ", "").replace(" ", "").replace(",", "."))
        return int(x) if x.is_integer() else x
    except ValueError: return None


def to_bool(v): return str(v).strip().lower() in ("да", "1", "true", "yes", "истина")


def read_xlsx(path, date_arg):
    xl = pd.ExcelFile(path)
    data, report, fatal = {}, [], False
    for sheet, key, cols in SHEETS:
        if sheet not in xl.sheet_names:
            report.append(f"ОШИБКА: нет листа «{sheet}»"); fatal = True; data[key] = []; continue
        df = xl.parse(sheet, dtype=object)
        miss = [h for h, f, _ in cols if h not in df.columns]
        miss_req = [h for h, f, _ in cols if h in miss and f in REQUIRED]
        if miss_req: report.append(f"ОШИБКА: лист «{sheet}», нет обязательных столбцов: {', '.join(miss_req)}"); fatal = True
        rows, skipped = [], 0
        for rec in df.to_dict("records"):
            o = {}
            for h, f, t in cols:
                v = rec.get(h)
                o[f] = to_date(v) if t == "d" else to_num(v) if t == "n" else to_bool(v) if t == "b" else \
                    (None if v is None or (isinstance(v, float) and pd.isna(v)) else str(v).strip())
            if any(o.get(f) in (None, "") for _, f, t in cols if f in REQUIRED and t in ("d", "s") and f in o):
                skipped += 1; continue
            if key == "reports" and o.get("year") is not None: o["year"] = int(o["year"])
            if key == "contracts" and o.get("term") is not None: o["term"] = int(o["term"])
            rows.append(o)
        data[key] = rows
        report.append(f"лист «{sheet}»: {len(rows)} строк" + (f", пропущено без обязательных полей: {skipped}" if skipped else "")
                      + (f"; нет столбцов: {', '.join(miss)}" if miss and not miss_req else ""))
    if fatal: return None, report
    # связи и справочники
    cons = {c["contract"] for c in data["contracts"]}; cls = {c["client"] for c in data["clients"]}
    sch = {s["contract"] for s in data["schedule"]}
    report.append(f"договоров без клиента: {sum(c['client'] not in cls for c in data['contracts'])}; "
                  f"платежей без договора: {sum(p['contract'] not in cons for p in data['payments'])}; "
                  f"договоров без графика: {sum(c['contract'] not in sch for c in data['contracts'])}")
    unk = sorted({e["type"] for e in data["events"]} - EVENT_TYPES)
    if unk: report.append("ВНИМАНИЕ: нераспознанные типы событий (не участвуют в расчёте): " + "; ".join(unk[:10]))
    for c in data["clients"]:  # дата начала отношений по первому договору, если не заполнена
        if not c.get("since"):
            ds = sorted(o["date"] for o in data["contracts"] if o["client"] == c["client"] and o.get("date"))
            c["since"] = ds[0] if ds else None
    data["clients"] = [c for c in data["clients"] if c.get("since")]
    if date_arg: today = date_arg
    else:
        last = max([p["date"] for p in data["payments"]] + [e["date"] for e in data["events"]])
        y, m, d = map(int, last.split("-"))
        if d < calendar.monthrange(y, m)[1]: y, m = (y, m - 1) if m > 1 else (y - 1, 12)
        today = f"{y}-{m:02d}-{calendar.monthrange(y, m)[1]:02d}"
    report.append(f"дата оценки: {today}")
    return {"today": today, **data}, report


def write_xlsx(data, path):
    with pd.ExcelWriter(path) as w:
        desc = [{"Лист": s, "Столбец": h} for s, _, cols in SHEETS for h, _, _ in cols]
        pd.DataFrame(desc).to_excel(w, sheet_name="Описание", index=False)
        for sheet, key, cols in SHEETS:
            rows = data.get(key, [])
            if isinstance(rows, dict): rows = [dict(zip(rows, t)) for t in zip(*rows.values())]
            out = [{h: (("да" if r.get(f) else "нет") if t == "b" else
                        (dt.date.fromisoformat(r[f]).strftime("%d.%m.%Y") if t == "d" and r.get(f) else r.get(f))) for h, f, t in cols} for r in rows]
            pd.DataFrame(out, columns=[h for h, _, _ in cols]).to_excel(w, sheet_name=sheet, index=False)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("src"); ap.add_argument("dst")
    ap.add_argument("--date", help="дата оценки ГГГГ-ММ-ДД (конец месяца)")
    ap.add_argument("--reverse", action="store_true", help="JSON -> xlsx")
    a = ap.parse_args()
    if a.reverse:
        write_xlsx(json.loads(Path(a.src).read_text()), a.dst); print("записано:", a.dst); sys.exit(0)
    data, rep = read_xlsx(a.src, a.date)
    print("\n".join(rep))
    if data is None: print("Файл не соответствует шаблону, JSON не записан."); sys.exit(1)
    Path(a.dst).write_text(json.dumps(data, ensure_ascii=False)); print("записано:", a.dst)
