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
  const assetOf = new Map();
  for (const c of data.contracts) assetOf.set(c.client, c.asset); // последний договор клиента
  const zones = { red: 0, yellow: 0, green: 0, grey: 0 };
  const clients = [];
  for (const r of F.snapshots(idx, { from: today })) {
    if (r.date !== today) continue;
    // как zoneOf на странице: вне оценки (дефолт ранее) — серая зона
    const s = F.score(model, r);
    const zone = r.status === "оценивается" ? s.zone : "grey";
    zones[zone]++;
    clients.push({ client: r.client, sector: r.sector || idx.clients.get(r.client)?.sector || "", zone, score: s.score, dpd: r.dpd_now, status: r.status, exposure: r.exposure, asset: assetOf.get(r.client) || null });
  }
  clients.sort((a, b) => a.score - b.score);
  const worst = clients.filter((c) => c.zone === "red").slice(0, 3);
  const exposure = Object.fromEntries(Object.keys(zones).map((z) => [z, clients.filter((c) => c.zone === z).reduce((s, c) => s + c.exposure, 0)]));
  return { today, total: clients.length, zones, exposure, worst, clients };
}

let cached = null;
module.exports = { portfolioSummary: () => (cached ??= compute()) };
