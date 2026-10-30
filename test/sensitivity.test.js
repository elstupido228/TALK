// Запас до смены класса: пороги совпадают с core.js, найденный сдвиг минимален и действительно меняет категорию.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const C = require("../seed/calc/core.js");
const { margins, THRESHOLDS, COEF } = require("../seed/calc/sensitivity.js");

// 124 случая сверки с Excel — как вход для проверки на разнообразных данных
function cases() {
  const dir = path.join(__dirname, "..", "seed", "calc");
  const f = fs.readdirSync(dir).find((n) => n.startsWith("04_") && n.endsWith(".csv"));
  const [head, ...rows] = fs.readFileSync(path.join(dir, f), "utf8").trim().split(/\r?\n/).map((l) => l.split(";"));
  return rows.map((r) => {
    const o = Object.fromEntries(head.map((h, i) => [h, r[i]]));
    const V = {}, M = {};
    for (const [k, v] of Object.entries(o)) { const m = k.match(/^row(\d+)_/); if (m) (+m[1] >= 35 ? M : V)[m[1]] = Number(v); }
    return { V, M, lease: o.industry === "trade_or_lease" };
  });
}

test("пороги модуля совпадают с calcColumn из core.js (по обе стороны каждого порога)", () => {
  for (const lease of [true, false]) {
    THRESHOLDS(lease).forEach(([t1, t2], k) => {
      for (const [t, catBelow, catAt] of [[t1, 3, 2], [t2, 2, 1]]) {
        // знаменатель 1000, числитель — порог ± 1 тыс.: категория должна смениться ровно на пороге
        const V = { 10: 1000, 11: 500, 12: 500, 18: 0, 19: 0, 20: 0, 21: 0, 25: 0, 27: 0, 28: 0, 29: 1000, 30: 1000 };
        const at = Object.assign({}, V, { [COEF[k].row]: t * 1000 }), below = Object.assign({}, V, { [COEF[k].row]: t * 1000 - 1 });
        assert.strictEqual(C.calcColumn(at, {}, lease).cat[k], catAt, `К${k + 1} на пороге ${t} (lease=${lease})`);
        assert.strictEqual(C.calcColumn(below, {}, lease).cat[k], catBelow, `К${k + 1} ниже порога ${t} (lease=${lease})`);
      }
    });
  }
});

test("на 124 случаях: сдвиг меняет категорию, на 1 тыс. меньше — ещё не меняет; класс — из calcColumn", () => {
  let checked = 0;
  for (const { V, M, lease } of cases()) {
    const m = margins(V, M, lease);
    assert.strictEqual(m.cls, C.calcColumn(V, M, lease).cls);
    m.coefs.forEach((c, k) => {
      for (const [mv, dir] of [[c.worse, 1], [c.better, -1]]) {
        if (!mv) continue;
        const row = COEF[k].row, base = C.calcColumn(V, M, lease);
        const moved = C.calcColumn(Object.assign({}, V, { [row]: +(V[row] ?? 0) + mv.delta }), M, lease);
        assert.strictEqual(moved.cat[k], mv.cat);
        assert.strictEqual(moved.cls, mv.cls);
        assert.ok(dir > 0 ? moved.cat[k] > base.cat[k] : moved.cat[k] < base.cat[k]);
        // минимальность: на 1 тыс. руб. ближе к исходному значению категория ещё прежняя
        const short = C.calcColumn(Object.assign({}, V, { [row]: +(V[row] ?? 0) + mv.delta + (mv.delta > 0 ? -1 : 1) }), M, lease);
        assert.strictEqual(short.cat[k], base.cat[k], `К${k + 1}: сдвиг не минимален`);
        checked++;
      }
    });
  }
  assert.ok(checked > 300, `проверено сдвигов: ${checked}`);
});

test("пограничный пример: угроза — К5, сочетания ухудшений, запас по сумме баллов", () => {
  // условный пограничный пример (тыс. руб.): мало денег, крупная дебиторка, высокая рентабельность
  const V = { 10: 100000, 11: 23000, 12: 21000, 18: 150000, 19: 0, 20: 7500, 21: 280000, 25: 250000, 27: 0, 28: 0, 29: 76000, 30: 330000 };
  const m = margins(V, {}, true);
  assert.deepStrictEqual([m.cls, m.S, m.toS1], [1, 1.05, 0.2]);
  assert.strictEqual(m.threat.k, 5);
  assert.strictEqual(m.threat.worse.cls, 2);
  assert.strictEqual(m.coefs[2].worse.delta, -166001);
  assert.strictEqual(m.coefs[0].better.delta, 100);
  assert.ok(m.pairs.some((p) => [p.a, p.b].sort().join() === "1,4" && p.cls === 2), "К1 и К4 вместе дают класс 2");
});

test("делитель 0 или отрицательный — сдвиг не предлагается", () => {
  const V = { 10: 0, 11: 0, 12: 0, 18: 10, 19: 0, 20: 10, 21: 100, 25: 50, 27: 0, 28: 0, 29: 0, 30: 0 };
  const m = margins(V, {}, true);
  for (const c of m.coefs) { assert.strictEqual(c.noDen, true); assert.strictEqual(c.worse, null); assert.strictEqual(c.better, null); }
});

test("путь наверх: сочетание улучшений действительно улучшает класс, и одной строкой этого не добиться", () => {
  let found = 0;
  for (const { V, M, lease } of cases()) {
    const m = margins(V, M, lease);
    if (!m.up) continue;
    const V2 = Object.assign({}, V);
    for (const k of m.up.ks) { const row = COEF[k - 1].row; V2[row] = +(V2[row] ?? 0) + m.coefs[k - 1].better.delta; }
    const r = C.calcColumn(V2, M, lease);
    assert.ok(r.cls < m.cls);
    assert.strictEqual(r.cls, m.up.cls);
    if (m.up.ks.length > 1) assert.strictEqual(m.chance, null, "есть шаг одной строкой — сочетание не нужно");
    found++;
  }
  assert.ok(found > 10, `путей наверх: ${found}`);
  // условный пример класса 2: оборотные активы и прибыль от продаж вместе дают класс 1 (S = 1,25, К5 = 0,10)
  const V = { 10: 840000, 11: 50400, 12: 25200, 18: 150000, 19: 0, 20: 23000, 21: 375000, 25: 300000, 27: 0, 28: 0, 29: 306000, 30: 857000 };
  const m = margins(V, {}, true);
  assert.deepStrictEqual([m.cls, m.S, m.chance], [2, 1.8, null]);
  assert.deepStrictEqual(m.up, { ks: [3, 5], cls: 1, S: 1.25 });
});
