// Прогрев кэша коннекторов для демо-сценария: ИНН -> DaData -> отчётность ГИР БО -> класс.
// Кэш хранится в SQLite (том app_data); если во время показа внешние источники недоступны, ответы берутся из него.
// ИНН демо-компаний не хранятся в репозитории — они в .env сервера (DEMO_INNS) или передаются аргументами:
//   docker compose exec app node scripts/warm-demo-cache.js            # ИНН из DEMO_INNS
//   docker compose exec app node scripts/warm-demo-cache.js 1234567890
const { open } = require("../app/db");
const { createConnectors } = require("../app/connectors/core");
const { annualClasses } = require("../app/check");

const inns = (process.argv.slice(2).length ? process.argv.slice(2) : (process.env.DEMO_INNS || "").split(",")).map((s) => s.trim()).filter(Boolean);
if (!inns.length) {
  console.error("Нет ИНН: передайте аргументами или задайте DEMO_INNS в .env");
  process.exit(1);
}

(async () => {
  const db = open();
  const c = createConnectors(db, [require("../app/connectors/dadata"), require("../app/connectors/fin")]);
  let bad = 0;
  for (const inn of inns) {
    try {
      const p = await c.call("dadata", "party", { inn });
      const f = await c.call("fin", "reports", { inn });
      const cls = annualClasses(f.data).map((y) => `${y.year}: класс ${y.cls} (S ${y.S.toFixed(2)})${y.missing.length ? `, нет строк ${y.missing.join(",")}` : ""}`);
      const ok = p.source !== "sandbox" && f.source !== "sandbox" && p.data.found !== false && f.data.found !== false;
      if (!ok) bad++;
      console.log(`${inn} · ${p.data.name || "не найдена"} · ${p.data.status_label || ""} · DaData: ${p.source} · отчётность: ${f.source}/${f.data.provider}, лет ${f.data.reports?.length ?? 0}${ok ? "" : " · ВНИМАНИЕ: нет живого ответа"}`);
      for (const line of cls) console.log(`    ${line}`);
    } catch (e) {
      bad++;
      console.log(`${inn} · ошибка: ${e.message}`);
    }
  }
  db.close();
  process.exit(bad ? 1 : 0);
})();
