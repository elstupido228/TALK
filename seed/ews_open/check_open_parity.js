// Сверка: признаки и баллы score_open.js против Python (open_features.py + optbinning) на периоде проверки.
// node check_open_parity.js [data/rfsd_panel] [data/model_open.json] [data/open_py_scores_test.csv] [data/open_obs_features.json]
const fs = require("fs");
const O = require("./score_open.js");
const model = JSON.parse(fs.readFileSync(process.argv[3] || "data/model_open.json", "utf8"));
const py = fs.readFileSync(process.argv[4] || "data/open_py_scores_test.csv", "utf8").trim().split("\n").slice(1).map((l) => l.split(","));
const feats = JSON.parse(fs.readFileSync(process.argv[5] || "data/open_test_inputs.json", "utf8")); // {inn|year: {r, prev, cy, okved, filed_prev, f_py}}
let n = 0, maxd = 0, fdiff = 0, skipped = 0, bad = [];
for (const [inn, year, s] of py) {
  const k = inn + "|" + year, x = feats[k]; if (!x) { skipped++; continue; }  // компания не попала в выборку для сверки
  const f = O.features(x.r, x.prev, +year, x.cy, O.sectorOf(x.okved), x.filed_prev);
  for (const [name, val] of Object.entries(x.f_py)) {
    const a = f[name], b = val;
    const same = (a === null && b === null) || a === b || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b)));
    if (!same) { fdiff++; if (bad.length < 5) bad.push([k, name, a, b]); }
  }
  const js = O.score(model, f).score; const d = Math.abs(js - +s); n++; if (d > maxd) maxd = d;
  if (d > 0.01 && bad.length < 8) bad.push([k, "балл", js, +s]);
}
console.log(`сравнено ${n} наблюдений (вне выборки для сверки ${skipped}): расхождений признаков ${fdiff}, максимальное расхождение балла ${maxd.toFixed(4)}`, bad.length ? bad : "");
