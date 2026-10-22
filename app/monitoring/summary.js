// Сводка портфеля для главной: зоны на дату оценки — тем же кодом (features.js, model.json), что считает страница «Мониторинг».
const fs = require("node:fs");
const path = require("node:path");
const F = require("../../seed/ews/features.js");

const SEED = path.join(__dirname, "..", "..", "seed", "ews", "data");

function compute() {
  const data = JSON.parse(fs.readFileSync(path.join(SEED, "demo.json"), "utf8"));
  const model = JSON.parse(fs.readFileSync(path.join(SEED, "model.json"), "utf8"));
  const idx = F.prepare(data);
  const today = F.diso(idx.today);
  const zones = { red: 0, yellow: 0, green: 0, grey: 0 };
  const red = [];
  for (const r of F.snapshots(idx, { from: today })) {
    if (r.date !== today) continue;
    // как zoneOf на странице: вне оценки (просрочка 30+, дефолт) — серая зона
    const s = F.score(model, r);
    const zone = r.status === "оценивается" ? s.zone : "grey";
    zones[zone]++;
    if (zone === "red") red.push({ client: r.client, score: s.score, sector: idx.clients.get(r.client)?.sector || "" });
  }
  red.sort((a, b) => a.score - b.score);
  return { today, total: Object.values(zones).reduce((a, b) => a + b, 0), zones, worst: red.slice(0, 3) };
}

let cached = null;
module.exports = { portfolioSummary: () => (cached ??= compute()) };
