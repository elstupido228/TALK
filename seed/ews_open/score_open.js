/* Балл риска банкротства по годовой отчётности (модель на открытых данных) и помесячный ряд «балл + статус» для графика.
   Повторяет open_features.py один в один (проверка — check_open_parity.js). Суммы — тыс. руб.
   Работает в Node (module.exports) и в браузере (window.TalkOpen).

   Вход для компании:
   {
     inn, okved, creation_date: "ГГГГ-ММ-ДД",
     reports: [{year: 2023, filed_date?: "ГГГГ-ММ-ДД", line_2110: ..., line_1600: ..., ...}],   // filed_date нет — считается 1 апреля следующего года
     state: {status: "ACTIVE|BANKRUPT|LIQUIDATING|LIQUIDATED|REORGANIZING", code: "114", actuality_date, liquidation_date}  // из DaData
   }
*/
(function (root) {
  "use strict";
  const SECTORS = [["Сельское хозяйство", 1, 3], ["Добыча полезных ископаемых", 5, 9], ["Обрабатывающее производство", 10, 33],
    ["Строительство", 41, 43], ["Оптовая торговля", 46, 46], ["Транспорт и хранение", 49, 53]];
  function sectorOf(okved) {
    if (okved === null || okved === undefined) return null;
    const d = String(okved).replace(/\D/g, ""); if (d.length < 2) return null;
    const k = +d.slice(0, 2); const s = SECTORS.find(([, a, b]) => k >= a && k <= b); return s ? s[0] : null;
  }
  const v = (r, c) => { if (!r) return null; const x = r["line_" + c]; return x === null || x === undefined || (typeof x === "number" && isNaN(x)) ? null : +x; };
  const z = (r, c) => { const x = v(r, c); return x === null ? 0 : x; };
  const ratio = (a, b) => (a === null || b === null || b === 0 ? null : a / b);

  // класс кредитоспособности — формулы калькулятора (Приложение 5 к Регламенту 285), ручные поля 0, отрасль не указана
  const X15 = (x) => (x === "" ? x : Number(Number(x).toPrecision(15)));
  const div = (a, b) => (b === 0 || !isFinite(a / b) ? "" : X15(a / b));
  const LT = (a, b) => (a === "" ? false : a < b), GE = (a, b) => (a === "" ? true : a >= b);
  function class285(r) {
    const g = (c) => z(r, c);
    const K1 = div(g("1250"), g("1500") - (g("1550") + g("1530")));
    const K2 = div(g("1250") + g("1240") + g("1230"), g("1500") - (g("1550") + g("1530")));
    const K3 = div(g("1200"), g("1500") - g("1550") - g("1530"));
    const K4 = div(g("1300") + g("1530") + g("1550"), g("1600"));
    const K5 = div(g("2200"), g("2110")), K6 = div(g("2400"), g("2110"));
    const c1 = LT(K1, 0.05) ? 3 : LT(K1, 0.1) ? 2 : 1, c2 = LT(K2, 0.5) ? 3 : LT(K2, 0.8) ? 2 : 1;
    const c3 = LT(K3, 1) ? 3 : LT(K3, 1.5) ? 2 : 1, c4 = LT(K4, 0.15) ? 3 : LT(K4, 0.25) ? 2 : 1;
    const c5 = g("2110") === 0 ? 3 : LT(K5, 0) ? 3 : LT(K5, 0.1) ? 2 : 1, c6 = g("2110") === 0 ? 3 : LT(K6, 0) ? 3 : LT(K6, 0.06) ? 2 : 1;
    const S = X15(c1 * 0.05 + c2 * 0.10 + c3 * 0.40 + c4 * 0.20 + c5 * 0.15 + c6 * 0.10);
    const chk1 = GE(K5, 0.1) && S <= 1.25, chk2 = S <= 2.35 && GE(K5, 0) && !chk1;
    return { S, cls: chk1 ? 1 : chk2 ? 2 : 3 };
  }
  function features(r, prev, year, creationYear, sector, filedPrev) {
    const rev = v(r, "2110"), assets = v(r, "1600"), debt = z(r, "1410") + z(r, "1510");
    let i = v(r, "2330"); i = i !== null ? Math.abs(i) : null; const ebt = v(r, "2300");
    const c = class285(r), pr = v(prev, "2110"), pa = v(prev, "1600");
    return {
      eq_ratio: ratio(v(r, "1300"), assets), re_assets: ratio(v(r, "1370"), assets),
      net_margin: ratio(v(r, "2400"), rev), sales_margin: ratio(v(r, "2200"), rev), roa: ratio(v(r, "2400"), assets),
      debt_rev: ratio(debt, rev), debt_assets: ratio(debt, assets),
      current_ratio: ratio(v(r, "1200"), v(r, "1500")), cash_ratio: ratio(v(r, "1250"), v(r, "1500")),
      payables_rev: ratio(v(r, "1520"), rev),
      interest_cover: !i || ebt === null ? null : (ebt + i) / i,
      rev_growth: prev === null || prev === undefined || !pr || pr <= 0 || rev === null ? null : rev / pr - 1,
      assets_growth: prev === null || prev === undefined || !pa || pa <= 0 || assets === null ? null : assets / pa - 1,
      log_revenue: rev === null || rev <= 0 ? null : Math.log(rev),
      age_years: creationYear === null || creationYear === undefined ? null : year - creationYear,
      gap_prev: filedPrev ? 0 : 1, class285_S: c.S, class285: c.cls, sector: sector || "Не указана",
    };
  }
  // применение карты — тот же алгоритм, что в features.js
  function score(model, f) {
    let s = 0; const parts = {};
    for (const vv of model.vars) {
      const x = f[vv.name]; let p, bin;
      if (x === null || x === undefined || (typeof x === "number" && !isFinite(x))) { p = vv.missing; bin = -1; }
      else if (vv.cat) { bin = vv.groups.findIndex((g) => g.includes(x)); p = bin >= 0 ? vv.points[bin] : vv.missing; }
      else { bin = 0; while (bin < vv.splits.length && x >= vv.splits[bin]) bin++; p = vv.points[bin]; }
      parts[vv.name] = { points: p, bin }; s += p;
    }
    s = Math.round(s * 100) / 100;
    return { score: s, zone: s <= model.zones.red ? "red" : s <= model.zones.yellow ? "yellow" : "green", parts };
  }
  function reasons(model, parts, n = 3) {
    return model.vars.map((vv) => ({ name: vv.name, label: vv.label, lost: Math.max(...vv.points, vv.missing) - parts[vv.name].points }))
      .filter((r) => r.lost > 0.5).sort((a, b) => b.lost - a.lost).slice(0, n);
  }
  const avail = (r) => r.filed_date || `${r.year + 1}-04-01`;
  const STATUS_RU = { ACTIVE: "Действует", BANKRUPT: "Банкротство", LIQUIDATING: "Ликвидируется", LIQUIDATED: "Ликвидирована", REORGANIZING: "Реорганизация" };
  // статус на дату: история статусов DaData не отдаёт — известен текущий статус и дата его последнего изменения
  function statusAt(state, iso) {
    if (!state || !state.status || state.status === "ACTIVE") return { status: "ACTIVE", label: STATUS_RU.ACTIVE, known: !!state };
    if (state.liquidation_date && iso >= state.liquidation_date) return { status: "LIQUIDATED", label: STATUS_RU.LIQUIDATED, code: state.code, known: true };
    if (state.actuality_date && iso >= state.actuality_date) return { status: state.status, label: STATUS_RU[state.status] || state.status, code: state.code, known: true };
    return { status: "ACTIVE", label: STATUS_RU.ACTIVE, known: false };  // до изменения статуса — предполагается «действует»
  }
  function monthEnds(fromIso, toIso) {
    const out = []; let y = +fromIso.slice(0, 4), m = +fromIso.slice(5, 7) - 1;
    for (;;) { const d = new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10); if (d > toIso) break; out.push(d); m++; if (m === 12) { m = 0; y++; } }
    return out;
  }
  // помесячный ряд: на каждый конец месяца — последний доступный отчёт, балл, зона, причины, статус
  function monthlySeries(company, model, fromIso, toIso) {
    const reps = (company.reports || []).filter((r) => r.filed !== 0).slice().sort((a, b) => a.year - b.year);
    const byYear = Object.fromEntries(reps.map((r) => [r.year, r]));
    const cy = company.creation_date ? +String(company.creation_date).slice(0, 4) : null;
    const sector = sectorOf(company.okved);
    const cache = {};
    return monthEnds(fromIso, toIso).map((d) => {
      const st = statusAt(company.state, d);
      const r = [...reps].reverse().find((x) => avail(x) <= d);
      if (!r) return { date: d, score: null, zone: null, report_year: null, status: st };
      if (!cache[r.year]) {
        const f = features(r, byYear[r.year - 1] || null, r.year, cy, sector, !!byYear[r.year - 1]);
        const sc = score(model, f); cache[r.year] = { f, ...sc, reasons: reasons(model, sc.parts) };
      }
      const c = cache[r.year];
      return { date: d, score: c.score, zone: c.zone, report_year: r.year, reasons: c.reasons, class285: c.f.class285, status: st };
    });
  }
  const api = { sectorOf, class285, features, score, reasons, statusAt, monthlySeries, STATUS_RU };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.TalkOpen = api;
})(typeof window !== "undefined" ? window : globalThis);
