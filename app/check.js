// «Проверка по ИНН»: DaData -> годовая отчётность (ГИР БО) -> класс на каждую годовую дату по формулам core.js.
// В открытых источниках только годовая отчётность, поэтому это предварительная проверка: для заключения по п. 14.1.6
// калькулятору нужны четыре квартальные даты, их запрашивают у клиента.
const C = require("../seed/calc/core.js");
const { margins } = require("../seed/calc/sensitivity.js");

// В ГИР БО пустая строка формы приходит как null (в документе — прочерк, то есть 0). Отсутствием данных считаются
// только пропуски итоговых строк; прочие пустые строки — нули, иначе калькулятор пометит их «не найдено».
const TOTALS = new Set(["1200", "1300", "1500", "1600", "1700", "2110"]);
const zeroFill = (values) => {
  if (!values || [...TOTALS].every((c) => values[c] === null || values[c] === undefined)) return values; // графы нет вовсе
  return Object.fromEntries(Object.entries(values).map(([c, v]) => [c, v === null && !TOTALS.has(c) ? 0 : v]));
};

// Годовая отчётность -> документы в формате калькулятора (последние два года: баланс с тремя графами, ОПиУ с двумя).
function toDocs(fin) {
  const docs = [];
  for (const r of (fin.reports || []).slice(0, 2)) {
    const Y = r.year, conf = fin.provider === "sandbox" ? "none" : "fns_receipt";
    const base = { inn: fin.org?.inn || null, variant: r.variant, confirmation: conf, pages: null };
    docs.push({ ...base, name: `ГИР БО: бухгалтерский баланс за ${Y} год`, type: "balance",
      columns: [[Y, r.balance.current, true], [Y - 1, r.balance.previous, false], [Y - 2, r.balance.beforePrevious, false]].map(([y, values, primary]) =>
        ({ kind: "balance", date: `${y}-12-31`, months: null, header: `На 31 декабря ${y} г.`, primary, values: zeroFill(values), page: {} })) });
    docs.push({ ...base, name: `ГИР БО: отчёт о финансовых результатах за ${Y} год`, type: "pnl",
      columns: [[Y, r.pnl.current, true], [Y - 1, r.pnl.previous, false]].map(([y, values, primary]) =>
        ({ kind: "pnl", date: `${y}-12-31`, months: 12, header: `За ${y} год`, primary, values: zeroFill(values), page: {} })) });
  }
  return docs;
}

// Класс на 31.12 каждого года, где есть баланс и ОПиУ. Отрасль не указана — пороги К4 торговли и лизинга, как в калькуляторе.
function annualClasses(fin, { lease = true } = {}) {
  return (fin.reports || []).slice(0, 3).map((r) => {
    const V = {}, missing = [];
    const bal = zeroFill(r.balance.current), pnl = zeroFill(r.pnl.current);
    for (const [row, code] of Object.entries(C.TPL_ROWS)) {
      const v = (code < "2000" ? bal : pnl)[code];
      if (v === null || v === undefined) missing.push(code);
      V[row] = v ?? 0;
    }
    const res = C.calcColumn(V, {}, lease);
    // без итоговых строк (например, у НКО нет выручки и раздела «Капитал») расчёт по нулям дал бы класс из пустоты
    const ok = missing.length === 0;
    return { year: r.year, variant: r.variant, cls: ok ? res.cls : null, S: ok ? res.S : null, K: ok ? res.K : null, missing,
      revenue: r.pnl.current["2110"], net: r.pnl.current["2400"], assets: r.balance.current["1600"], equity: r.balance.current["1300"] };
  });
}

// Запас до смены класса — по последнему году с полной отчётностью (seed/calc/sensitivity.js)
function annualMargins(fin, { lease = true } = {}) {
  for (const r of (fin.reports || []).slice(0, 3)) {
    const bal = zeroFill(r.balance.current), pnl = zeroFill(r.pnl.current), V = {};
    let full = true;
    for (const [row, code] of Object.entries(C.TPL_ROWS)) {
      const v = (code < "2000" ? bal : pnl)[code];
      if (v === null || v === undefined) { full = false; break; }
      V[row] = v;
    }
    if (full) return { year: r.year, ...margins(V, {}, lease) };
  }
  return null;
}

module.exports = { toDocs, annualClasses, annualMargins };
