// ===== Запас до смены класса: на сколько должна измениться строка отчётности, чтобы коэффициент перешёл порог =====
// Формулы и пороги расчёта класса — в core.js (calcColumn), здесь не меняются. Модуль только ищет ближайшие пороги:
// для каждого коэффициента берётся «определяющая» строка числителя, вычисляется сумма, при которой коэффициент
// пересекает порог категории, и итоговый класс считается самой calcColumn. Пороги ниже сверяются с core.js тестом.
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory(require("./core.js").calcColumn);
  else root.classMargins = factory(root.calcColumn);
})(typeof window !== "undefined" ? window : globalThis, function (calcColumn) {
  // Пороги категорий (нижняя граница категории 2 и категории 1): К < t1 — категория 3, К < t2 — категория 2
  const THRESHOLDS = (lease) => [[0.05, 0.1], [0.5, 0.8], [1, 1.5], lease ? [0.15, 0.25] : [0.25, 0.4], [0, 0.1], [0, 0.06]];
  // Определяющая строка числителя и знаменатель каждого коэффициента (строки шаблона «Пробивки» / ручные строки)
  const g = (V, r) => +(V[r] ?? 0), h = (M, r) => +(M[r] ?? 0);
  const COEF = [
    { name: "К1 абсолютная ликвидность", row: 20, code: "1250", label: "денежные средства", num: (V, M) => g(V, 20) + h(M, 37), den: (V) => g(V, 29) - (g(V, 28) + g(V, 27)) },
    { name: "К2 промежуточная ликвидность", row: 18, code: "1230", label: "дебиторская задолженность", alt: "или безнадёжная дебиторская задолженность (стр. 35) на ту же сумму",
      num: (V, M) => g(V, 20) + g(V, 19) - h(M, 38) + g(V, 18) - h(M, 35), den: (V) => g(V, 29) - (g(V, 28) + g(V, 27)) },
    { name: "К3 текущая ликвидность", row: 21, code: "1200", label: "оборотные активы", alt: "или вычеты (безнадёжная дебиторка, неликвидные запасы — стр. 35–39) на ту же сумму",
      num: (V, M) => g(V, 21) - h(M, 35) - h(M, 36) - h(M, 38) - h(M, 39), den: (V) => g(V, 29) - g(V, 28) - g(V, 27) },
    { name: "К4 соотношение собственных и заёмных средств", row: 25, code: "1300", label: "капитал и резервы", num: (V) => g(V, 25) + g(V, 27) + g(V, 28), den: (V) => g(V, 30) },
    { name: "К5 рентабельность продукции", row: 11, code: "2200", label: "прибыль от продаж", num: (V) => g(V, 11), den: (V) => g(V, 10) },
    { name: "К6 рентабельность деятельности", row: 12, code: "2400", label: "чистая прибыль", num: (V) => g(V, 12), den: (V) => g(V, 10) },
  ];

  // Сдвиг строки так, чтобы К оказался по нужную сторону порога t; результат проверяется calcColumn
  function move(V, M, lease, k, t, toward, base) {
    const c = COEF[k], den = c.den(V), num = c.num(V, M);
    if (!(den > 0)) return null; // делитель 0 или отрицательный: шаблон даёт ошибку деления — сдвигом строки не управляется
    // целевой числитель: чуть ниже порога (ухудшение) или ровно на пороге (улучшение), шаг — 1 тыс. руб.
    const target = toward === "worse" ? Math.ceil(t * den) - 1 : Math.ceil(t * den);
    const delta = target - num;
    const V2 = Object.assign({}, V, { [c.row]: g(V, c.row) + delta });
    const r = calcColumn(V2, M, lease);
    const catOk = toward === "worse" ? r.cat[k] > base.cat[k] : r.cat[k] < base.cat[k];
    if (!catOk) return null;
    const cur = g(V, c.row);
    return { threshold: t, delta, pct: cur ? delta / Math.abs(cur) : null, value: r.K[k], cat: r.cat[k], cls: r.cls, S: r.S };
  }

  // V, M — значения одной даты (как для calcColumn), lease — пороги К4 для торговли и лизинга
  function margins(V, M = {}, lease = true) {
    const base = calcColumn(V, M, lease);
    const T = THRESHOLDS(lease);
    const coefs = COEF.map((c, k) => {
      const cat = base.cat[k], [t1, t2] = T[k];
      const worse = cat === 1 ? move(V, M, lease, k, t2, "worse", base) : cat === 2 ? move(V, M, lease, k, t1, "worse", base) : null;
      const better = cat === 3 ? move(V, M, lease, k, t1, "better", base) : cat === 2 ? move(V, M, lease, k, t2, "better", base) : null;
      const noDen = !(c.den(V) > 0);
      return { k: k + 1, name: c.name, code: c.code, label: c.label, alt: c.alt || null, value: base.K[k], cat, weight: [0.05, 0.1, 0.4, 0.2, 0.15, 0.1][k], worse, better, noDen };
    });
    // ближайшая угроза классу — ухудшение, которое меняет класс, с наименьшим относительным изменением строки
    const threats = coefs.filter((c) => c.worse && c.worse.cls > base.cls).sort((a, b) => Math.abs(a.worse.pct ?? Infinity) - Math.abs(b.worse.pct ?? Infinity));
    const chances = coefs.filter((c) => c.better && c.better.cls < base.cls).sort((a, b) => Math.abs(a.better.pct ?? Infinity) - Math.abs(b.better.pct ?? Infinity));
    // пары ухудшений, которые по отдельности класс не меняют, а вместе меняют (строки разные — сдвиги складываются)
    const quiet = coefs.filter((c) => c.worse && c.worse.cls === base.cls);
    const pairs = [];
    for (let i = 0; i < quiet.length; i++) for (let j = i + 1; j < quiet.length; j++) {
      const a = quiet[i], b = quiet[j], ra = COEF[a.k - 1].row, rb = COEF[b.k - 1].row;
      if (ra === rb) continue;
      const V2 = Object.assign({}, V, { [ra]: g(V, ra) + a.worse.delta, [rb]: g(V, rb) + b.worse.delta });
      const r = calcColumn(V2, M, lease);
      if (r.cls > base.cls) pairs.push({ a: a.k, b: b.k, cls: r.cls, S: r.S, size: Math.max(Math.abs(a.worse.pct ?? 1), Math.abs(b.worse.pct ?? 1)) });
    }
    pairs.sort((x, y) => x.size - y.size);
    // путь наверх: если одной строкой класс не улучшить — наименьшее сочетание улучшений (2–3 строки одновременно),
    // при равном числе шагов — с наименьшим наибольшим относительным изменением
    let up = chances[0] ? { ks: [chances[0].k], cls: chances[0].better.cls, S: chances[0].better.S } : null;
    if (!up && base.cls > 1) {
      const cand = coefs.filter((c) => c.better);
      const combos = (n, from = 0, acc = []) => (acc.length === n ? [acc] : cand.slice(from).flatMap((c, i) => combos(n, from + i + 1, [...acc, c])));
      for (let n = 2; n <= 3 && !up; n++) {
        let best = null;
        for (const set of combos(n)) {
          const V2 = Object.assign({}, V);
          for (const c of set) { const row = COEF[c.k - 1].row; V2[row] = g(V2, row) + c.better.delta; }
          const r = calcColumn(V2, M, lease);
          const size = Math.max(...set.map((c) => Math.abs(c.better.pct ?? 1)));
          if (r.cls < base.cls && (!best || size < best.size)) best = { ks: set.map((c) => c.k), cls: r.cls, S: r.S, size };
        }
        if (best) up = { ks: best.ks, cls: best.cls, S: best.S };
      }
    }
    return { cls: base.cls, S: base.S, K5: base.K[4], coefs, threat: threats[0] || null, threats: threats.map((c) => c.k), chance: chances[0] || null, up, pairs: pairs.slice(0, 3),
      toS1: +(1.25 - base.S).toFixed(2), toS2: +(2.35 - base.S).toFixed(2) };
  }

  return { margins, THRESHOLDS, COEF };
});
