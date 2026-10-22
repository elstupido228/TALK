// Замер распознавания на условных PDF (bench/pdf, генерируются scripts/gen-synthetic-pdf.js из demo_synthetic.json).
// Для каждой модели и каждого пакета: все PDF пакета -> шлюз (тот же код, что /api/extract) -> сведение core.consolidate
// -> 60 ячеек расчёта (12 строк шаблона × 5 дат) против значений пакета. Порог приёмки — не ниже 57 из 60 по каждому пакету.
//
// Запуск на сервере (ключ берётся из .env контейнера; вызовы пишутся в openai_usage с source='bench'):
//   docker compose exec app node scripts/bench-extract.js --models gpt-5.4-mini,gpt-5.5,gpt-5.6-luna
// Параметры: --packages A,B,C  --max-calls 120 (предохранитель расхода)  --out каталог (по умолчанию $DATA_DIR/bench-results)
const fs = require("node:fs");
const path = require("node:path");
const C = require("../seed/calc/core.js");

const ROOT = path.join(__dirname, "..");
const ROWS = Object.keys(C.TPL_ROWS); // 12 строк шаблона
const THRESHOLD = 57;

// 60 ячеек: {col:{row:value}} из документов пакета
function cells(docs) {
  const cons = C.consolidate(docs.filter((d) => d.columns && d.columns.length));
  const V = {};
  for (const c of C.TPL_COLS) {
    V[c] = {};
    for (const r of ROWS) V[c][r] = cons.cells[c]?.[C.TPL_ROWS[r]]?.value ?? null;
  }
  return { dates: cons.dates, V };
}

function score(pkg, extractedDocs) {
  const want = cells(pkg.docs), got = cells(extractedDocs);
  const diffs = [];
  let ok = 0;
  C.TPL_COLS.forEach((c, i) =>
    ROWS.forEach((r) => {
      const a = want.V[c][r], b = got.V[c]?.[r] ?? null;
      if (b !== null && +a === +b) ok++;
      else diffs.push({ date: want.dates[i], code: C.TPL_ROWS[r], want: a, got: b });
    })
  );
  const datesOk = JSON.stringify(want.dates) === JSON.stringify(got.dates);
  return { ok, total: C.TPL_COLS.length * ROWS.length, datesOk, diffs };
}

function args(argv) {
  const o = { models: null, packages: null, maxCalls: 120, out: process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "bench-results") : path.join(ROOT, "bench", "results") };
  for (let i = 0; i < argv.length; i++) {
    const [k, v] = [argv[i], argv[i + 1]];
    if (k === "--models") (o.models = v.split(",")), i++;
    else if (k === "--packages") (o.packages = v.split(",")), i++;
    else if (k === "--max-calls") (o.maxCalls = +v), i++;
    else if (k === "--out") (o.out = path.resolve(v)), i++;
  }
  return o;
}

async function main() {
  const { open } = require("../app/db");
  const { createGateway } = require("../app/extract/gateway");
  const o = args(process.argv.slice(2));
  const demo = JSON.parse(fs.readFileSync(path.join(ROOT, "seed", "calc", "demo_synthetic.json"), "utf8"));
  const db = open();
  const gw = createGateway({ db });
  if (!gw.config.key) throw new Error("не задан OPENAI_API_KEY");

  // Доступность моделей: GET /v1/models/{id} по каждой (общий список /v1/models у OpenAI бывает недоступен — 500/504)
  const models = o.models || [gw.config.model];
  const avail = new Map();
  for (const m of models) {
    const r = await fetch(`${gw.config.base}/models/${encodeURIComponent(m)}`, { headers: { authorization: `Bearer ${gw.config.key}` } });
    avail.set(m, r.status);
    console.log(`GET /v1/models/${m}: ${r.status} — ${r.ok ? "доступна" : r.status === 404 ? "НЕТ" : "не проверено, замер выполняется"}`);
  }

  const pkgs = demo.packages.filter((p) => !o.packages || o.packages.includes(p.id));
  const usedBefore = db.prepare("SELECT count(*) n FROM openai_usage").get().n;
  const summary = [];
  fs.mkdirSync(o.out, { recursive: true });

  for (const model of models) {
    if (avail.get(model) === 404) { summary.push({ model, skipped: "модель не найдена (404)" }); continue; }
    const res = { model, at: new Date().toISOString(), packages: [] };
    for (const pkg of pkgs) {
      const dir = path.join(ROOT, "bench", "pdf", pkg.id);
      const docs = [];
      const t0 = Date.now();
      for (const d of pkg.docs) {
        const calls = db.prepare("SELECT count(*) n FROM openai_usage").get().n - usedBefore;
        if (calls >= o.maxCalls) throw new Error(`достигнут предохранитель --max-calls ${o.maxCalls}`);
        try {
          const x = await gw.extractPdf(fs.readFileSync(path.join(dir, d.name)), d.name, { source: "bench", model });
          docs.push({ name: d.name, ...x });
        } catch (e) {
          docs.push({ name: d.name, columns: [], error: `${e.code || "error"}: ${e.message}` });
        }
      }
      const s = score(pkg, docs);
      const errors = docs.filter((d) => d.error).map((d) => `${d.name}: ${d.error}`);
      res.packages.push({ id: pkg.id, ...s, seconds: Math.round((Date.now() - t0) / 1000), errors });
      console.log(`${model} · пакет ${pkg.id}: ${s.ok} из ${s.total}${s.datesOk ? "" : " (даты не совпали)"} · ${Math.round((Date.now() - t0) / 1000)} с${errors.length ? ` · ошибок: ${errors.length}` : ""}`);
      for (const df of s.diffs.slice(0, 10)) console.log(`    ${df.date} код ${df.code}: ожидалось ${df.want}, получено ${df.got}`);
      for (const e of errors.slice(0, 5)) console.log(`    ошибка ${e}`);
    }
    const tok = db.prepare("SELECT count(*) calls, sum(input_tokens) inp, sum(output_tokens) outp, sum(ms) ms FROM openai_usage WHERE source='bench' AND model=? AND at >= ?").get(model, Date.parse(res.at));
    res.usage = tok;
    res.pass = res.packages.every((p) => p.ok >= THRESHOLD);
    fs.writeFileSync(path.join(o.out, `${res.at.slice(0, 10)}_${model}.json`), JSON.stringify(res, null, 2));
    summary.push(res);
  }

  console.log(`\nИтог (порог: не ниже ${THRESHOLD} из 60 по каждому пакету)`);
  console.log("модель\t" + pkgs.map((p) => `пакет ${p.id}`).join("\t") + "\tвызовов\tвход. токены\tвыход. токены\tрезультат");
  for (const s of summary) {
    if (s.skipped) { console.log(`${s.model}\tпропущена: ${s.skipped}`); continue; }
    console.log(`${s.model}\t${s.packages.map((p) => `${p.ok}/60`).join("\t")}\t${s.usage.calls}\t${s.usage.inp ?? "—"}\t${s.usage.outp ?? "—"}\t${s.pass ? "порог пройден" : "НИЖЕ ПОРОГА"}`);
  }
  db.close();
}

if (require.main === module) main().catch((e) => { console.error("Ошибка:", e.message); process.exit(1); });

module.exports = { score, cells, main, THRESHOLD };
