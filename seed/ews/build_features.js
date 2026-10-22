// node build_features.js data/demo.json data/snapshots.json
const fs = require("fs");
const F = require("./features.js");
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const t0 = Date.now();
const idx = F.prepare(data);
const rows = F.snapshots(idx, { withTarget: true, from: "2020-01-31" });
fs.writeFileSync(process.argv[3], JSON.stringify(rows));
const defs = {};
for (const cl of idx.clients.values()) { const e = F.firstDefault(idx, cl); if (e !== null) defs[cl.client] = F.diso(e); }
fs.writeFileSync(process.argv[3].replace(/snapshots\.json$/, "defaults.json"), JSON.stringify(defs));
const ev = rows.filter((r) => r.status === "оценивается" && r.y !== null);
const pos = ev.filter((r) => r.y === 1);
const byYear = {};
for (const r of ev) { const y = r.date.slice(0, 4); byYear[y] = byYear[y] || [0, 0]; byYear[y][0]++; byYear[y][1] += r.y; }
console.log(`срезов ${rows.length}, оцениваемых с исходом ${ev.length}, с событием ${pos.length} (${(100 * pos.length / ev.length).toFixed(1)}%), клиентов с событием ${new Set(pos.map((r) => r.client)).size}, ${((Date.now() - t0) / 1000).toFixed(1)} с`);
console.log(Object.entries(byYear).map(([y, [n, p]]) => `${y}: ${(100 * p / n).toFixed(1)}%`).join("  "));
