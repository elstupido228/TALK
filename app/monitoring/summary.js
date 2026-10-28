// Сводка портфеля для главной: зоны на дату оценки — из того же расчёта, что API и страница «Мониторинг» (ews.js).
const { defaultEws } = require("./ews");

function compute(ews) {
  const p = ews.portfolio("demo");
  const assetOf = new Map();
  for (const c of ews.dataset("demo").data.contracts) assetOf.set(c.client, c.asset); // последний договор клиента
  const zones = Object.fromEntries(Object.entries(p.zones).map(([z, v]) => [z, v.clients]));
  const exposure = Object.fromEntries(Object.entries(p.zones).map(([z, v]) => [z, v.exposure]));
  const clients = p.clients.map((c) => ({ client: c.client, sector: c.sector, zone: c.zone, score: c.score, dpd: c.dpd, status: c.status, exposure: c.exposure, asset: assetOf.get(c.client) || null }));
  clients.sort((a, b) => a.score - b.score || (a.client < b.client ? -1 : 1)); // как прежде: при равном балле — порядок портфеля
  return { today: p.date, total: clients.length, zones, exposure, worst: clients.filter((c) => c.zone === "red").slice(0, 3), clients };
}

let cached = null;
module.exports = { portfolioSummary: (ews = defaultEws()) => (cached ??= compute(ews)) };
