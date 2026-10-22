// Сборка страницы «Мониторинг» (раннее предупреждение) из seed/ews — то же, что build_page.py, но на сервере:
// шаблон page_src.html + модуль признаков features.js + балльная карта model.json + сжатый условный портфель demo.json.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { wrap, withBar, fill, jsonForScript: js } = require("../standalone");

const SEED = path.join(__dirname, "..", "..", "seed", "ews");

// Как в build_page.py: график и платежи — по столбцам, gzip, base64.
function demoPayload(d) {
  const cols = (rows, keys) => Object.fromEntries(keys.map((k) => [k, rows.map((r) => r[k] ?? null)]));
  const c = {
    today: d.today, clients: d.clients, contracts: d.contracts,
    schedule: cols(d.schedule, ["contract", "due", "amount"]), payments: cols(d.payments, ["contract", "date", "amount"]),
    events: d.events, reports: d.reports,
  };
  return zlib.gzipSync(Buffer.from(JSON.stringify(c)), { level: 9 }).toString("base64");
}

function build() {
  const demo = JSON.parse(fs.readFileSync(path.join(SEED, "data", "demo.json"), "utf8"));
  const model = JSON.parse(fs.readFileSync(path.join(SEED, "data", "model.json"), "utf8"));
  return wrap(
    fill(fs.readFileSync(path.join(SEED, "page_src.html"), "utf8"), {
      "/*FEATURES_JS*/": fs.readFileSync(path.join(SEED, "features.js"), "utf8"),
      __MODEL_JSON__: js(model),
      __DATA_GZ__: demoPayload(demo),
    })
  );
}

let cached = null;
const monitoringPage = (user) => withBar((cached ??= build()), user, "Мониторинг");

module.exports = { build, monitoringPage, demoPayload };
