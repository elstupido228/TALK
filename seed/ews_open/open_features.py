"""Признаки по годовой отчётности (RFSD / ГИР БО) для модели риска банкротства.
Расчёт повторён один в один в score_open.js (проверка — check_open_parity.js).
Суммы — в тысячах рублей (как в формах отчётности)."""
import math

LINES = ["1100", "1150", "1200", "1210", "1230", "1240", "1250", "1300", "1370", "1400", "1410", "1500", "1510",
         "1520", "1530", "1540", "1550", "1600", "1700", "2110", "2120", "2200", "2300", "2330", "2400"]

# отрасли, близкие к клиентам лизинга: по первым двум цифрам ОКВЭД
SECTORS = [("Сельское хозяйство", range(1, 4)), ("Добыча полезных ископаемых", range(5, 10)),
           ("Обрабатывающее производство", range(10, 34)), ("Строительство", range(41, 44)),
           ("Оптовая торговля", range(46, 47)), ("Транспорт и хранение", range(49, 54))]


def sector_of(okved):
    if okved is None: return None
    d = "".join(ch for ch in str(okved) if ch.isdigit())
    if len(d) < 2: return None
    k = int(d[:2])
    for name, rng in SECTORS:
        if k in rng: return name
    return None


def _v(r, code):
    x = r.get("line_" + code) if r else None
    return None if x is None or (isinstance(x, float) and math.isnan(x)) else float(x)


def _z(r, code):
    x = _v(r, code)
    return 0.0 if x is None else x


def _ratio(a, b):
    if a is None or b is None or b == 0: return None
    return a / b


# --- класс кредитоспособности по формулам калькулятора (Приложение 5 к Регламенту 285, файл «Пробивка») ---
# Строки шаблона: 10=2110, 11=2200, 12=2400, 18=1230, 19=1240, 20=1250, 21=1200, 25=1300, 27=1530, 28=1550, 29=1500, 30=1600.
# Ручные расшифровки = 0, отрасль не указана (пороги К4 для торговли и лизинга), как в калькуляторе по умолчанию.
def _x15(x): return x if x == "" else float(f"{x:.15g}")
def _div(a, b):
    if b == 0: return ""
    q = a / b
    return "" if not math.isfinite(q) else _x15(q)
def _lt(a, b): return False if a == "" else a < b
def _ge(a, b): return True if a == "" else a >= b


def class285(r):
    g = lambda code: _z(r, code)
    K1 = _div(g("1250"), g("1500") - (g("1550") + g("1530")))
    K2 = _div(g("1250") + g("1240") + g("1230"), g("1500") - (g("1550") + g("1530")))
    K3 = _div(g("1200"), g("1500") - g("1550") - g("1530"))
    K4 = _div(g("1300") + g("1530") + g("1550"), g("1600"))
    K5 = _div(g("2200"), g("2110")); K6 = _div(g("2400"), g("2110"))
    c1 = 3 if _lt(K1, 0.05) else 2 if _lt(K1, 0.1) else 1
    c2 = 3 if _lt(K2, 0.5) else 2 if _lt(K2, 0.8) else 1
    c3 = 3 if _lt(K3, 1) else 2 if _lt(K3, 1.5) else 1
    c4 = 3 if _lt(K4, 0.15) else 2 if _lt(K4, 0.25) else 1
    c5 = 3 if g("2110") == 0 else 3 if _lt(K5, 0) else 2 if _lt(K5, 0.1) else 1
    c6 = 3 if g("2110") == 0 else 3 if _lt(K6, 0) else 2 if _lt(K6, 0.06) else 1
    S = _x15(c1 * 0.05 + c2 * 0.10 + c3 * 0.40 + c4 * 0.20 + c5 * 0.15 + c6 * 0.10)
    chk1 = _ge(K5, 0.1) and S <= 1.25
    chk2 = S <= 2.35 and _ge(K5, 0) and not chk1
    return S, (1 if chk1 else 2 if chk2 else 3)


def features(r, prev, year, creation_year, sector, filed_prev):
    """r, prev — словари строк отчётности за год year и year-1 (prev может быть None)."""
    rev, assets = _v(r, "2110"), _v(r, "1600")
    debt = _z(r, "1410") + _z(r, "1510")
    i = _v(r, "2330"); i = abs(i) if i is not None else None
    ebt = _v(r, "2300")
    S, cls = class285(r)
    f = {
        "eq_ratio": _ratio(_v(r, "1300"), assets),
        "re_assets": _ratio(_v(r, "1370"), assets),
        "net_margin": _ratio(_v(r, "2400"), rev),
        "sales_margin": _ratio(_v(r, "2200"), rev),
        "roa": _ratio(_v(r, "2400"), assets),
        "debt_rev": _ratio(debt, rev),
        "debt_assets": _ratio(debt, assets),
        "current_ratio": _ratio(_v(r, "1200"), _v(r, "1500")),
        "cash_ratio": _ratio(_v(r, "1250"), _v(r, "1500")),
        "payables_rev": _ratio(_v(r, "1520"), rev),
        "interest_cover": None if not i or ebt is None else (ebt + i) / i,
        "rev_growth": None if prev is None or not _v(prev, "2110") or _v(prev, "2110") <= 0 or rev is None else rev / _v(prev, "2110") - 1,
        "assets_growth": None if prev is None or not _v(prev, "1600") or _v(prev, "1600") <= 0 or assets is None else assets / _v(prev, "1600") - 1,
        "log_revenue": None if rev is None or rev <= 0 else math.log(rev),
        "age_years": None if creation_year is None else year - creation_year,
        "gap_prev": 0 if filed_prev else 1,
        "class285_S": S,
        "class285": cls,
        "sector": sector or "Не указана",
    }
    return f


FEATURES = [  # имя, подпись, группа
    ("eq_ratio", "Доля собственного капитала в активах", "Устойчивость"),
    ("re_assets", "Нераспределённая прибыль к активам", "Устойчивость"),
    ("debt_assets", "Долг к активам", "Долговая нагрузка"),
    ("debt_rev", "Долг к выручке", "Долговая нагрузка"),
    ("interest_cover", "Покрытие процентов прибылью до налога и процентов", "Долговая нагрузка"),
    ("payables_rev", "Кредиторская задолженность к выручке", "Долговая нагрузка"),
    ("current_ratio", "Текущая ликвидность", "Ликвидность"),
    ("cash_ratio", "Денежные средства к краткосрочным обязательствам", "Ликвидность"),
    ("net_margin", "Рентабельность по чистой прибыли", "Рентабельность"),
    ("sales_margin", "Рентабельность продаж", "Рентабельность"),
    ("roa", "Рентабельность активов", "Рентабельность"),
    ("rev_growth", "Изменение выручки за год", "Динамика"),
    ("assets_growth", "Изменение активов за год", "Динамика"),
    ("log_revenue", "Размер (логарифм выручки)", "Профиль"),
    ("age_years", "Возраст компании, лет", "Профиль"),
    ("gap_prev", "Не сдана отчётность за предыдущий год", "Профиль"),
    ("class285_S", "Показатель S по методике класса кредитоспособности", "Класс кредитоспособности"),
    ("class285", "Класс кредитоспособности (1–3)", "Класс кредитоспособности"),
    ("sector", "Отрасль", "Профиль"),
]
