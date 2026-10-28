// Сверка: баллы, посчитанные модулем страницы (features.js), против баллов optbinning в Python
const fs = require("fs");
const F = require("./features.js");
const data = JSON.parse(fs.readFileSync(process.argv[2] || "data/demo.json", "utf8"));  // тот же файл, на котором обучали
const model = JSON.parse(fs.readFileSync("data/model.json", "utf8"));
const py = fs.readFileSync("data/py_scores_test.csv", "utf8").trim().split("\n").slice(1).map((l) => l.split(","));
const idx = F.prepare(data);
const rows = F.snapshots(idx, { withTarget: true, from: "2020-01-31" });
const key = (r) => r.client + "|" + r.date;
const m = new Map(rows.map((r) => [key(r), r]));
let n = 0, maxd = 0, bad = [];
for (const [c, d, s] of py) {
  const r = m.get(c + "|" + d); if (!r) { bad.push(["нет среза", c, d]); continue; }
  const js = F.score(model, r).score; const diff = Math.abs(js - +s); n++;
  if (diff > maxd) maxd = diff; if (diff > 0.01 && bad.length < 5) bad.push([c, d, s, js]);
}
console.log(`сравнено ${n} срезов, максимальное расхождение ${maxd.toFixed(4)} балла`, bad.length ? bad : "");
