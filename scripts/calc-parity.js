// Сверка ядра калькулятора (seed/calc/core.js) с эталоном Excel: 124 тестовых случая.
// Вход — 04_тестовые_случаи_вход.csv, эталон — 05_эталон_результаты_Excel.csv (значения формул листа после пересчёта в Excel).
//   node scripts/calc-parity.js
const fs = require("node:fs");
const path = require("node:path");
const C = require("../seed/calc/core.js");

const DIR = path.join(__dirname, "..", "seed", "calc");
const findCsv = (prefix) => path.join(DIR, fs.readdirSync(DIR).find((f) => f.startsWith(prefix) && f.endsWith(".csv")));

function readCsv(file) {
  const [head, ...rows] = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).map((l) => l.split(";"));
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

// Ошибка деления в Excel выгружена пустой ячейкой; в ядре это "".
const num = (s) => (s === "" ? "" : Number(s));
const sameK = (a, b) => (a === "" || b === "" ? a === b : Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b)));

function run() {
  const input = readCsv(findCsv("04_"));
  const expected = new Map(readCsv(findCsv("05_")).map((r) => [r.case_id, r]));
  const fails = [];
  for (const row of input) {
    const V = {}, M = {};
    for (const [k, v] of Object.entries(row)) {
      const m = k.match(/^row(\d+)_/);
      if (m) (+m[1] >= 35 ? M : V)[m[1]] = Number(v);
    }
    const got = C.calcColumn(V, M, row.industry === "trade_or_lease");
    const e = expected.get(row.case_id);
    const want = {
      K: [1, 2, 3, 4, 5, 6].map((i) => num(e["K" + i])),
      cat: [1, 2, 3, 4, 5, 6].map((i) => Number(e["cat" + i])),
      S: Number(e.S),
      cls: Number(e.class),
    };
    const diff = [];
    want.K.forEach((w, i) => !sameK(got.K[i], w) && diff.push(`K${i + 1}: ${got.K[i]} ≠ ${w}`));
    want.cat.forEach((w, i) => got.cat[i] !== w && diff.push(`cat${i + 1}: ${got.cat[i]} ≠ ${w}`));
    if (got.S !== want.S) diff.push(`S: ${got.S} ≠ ${want.S}`);
    if (got.cls !== want.cls) diff.push(`класс: ${got.cls} ≠ ${want.cls}`);
    if (diff.length) fails.push({ case: row.case_id, diff });
  }
  return { total: input.length, ok: input.length - fails.length, fails };
}

if (require.main === module) {
  const r = run();
  console.log(`совпало ${r.ok} из ${r.total} случаев с эталоном Excel`);
  for (const f of r.fails.slice(0, 20)) console.log(`  случай ${f.case}: ${f.diff.join("; ")}`);
  process.exit(r.fails.length || r.total !== 124 ? 1 : 0);
}

module.exports = { run };
