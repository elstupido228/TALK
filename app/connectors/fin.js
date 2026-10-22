// Годовая бухгалтерская отчётность по ИНН -> значения по кодам строк калькулятора.
// Источники по порядку: ГИР БО (bo.nalog.gov.ru, JSON сайта, без ключа) -> parser-api.com (PARSERAPI_KEY, 200 запросов/мес).
// В открытых источниках только годовая отчётность: баланс на 31.12 (с графами на 31.12 двух прошлых лет) и ОПиУ за год.
// Ответы и условия источников — docs/sources/girbo.md, docs/sources/parser-api.md.
const fs = require("node:fs");
const path = require("node:path");
const { fail } = require("./core");

const CODES = ["1200", "1230", "1240", "1250", "1300", "1370", "1500", "1530", "1540", "1550", "1600", "1700", "2110", "2200", "2400"];
const BAL = CODES.filter((c) => c < "2000"), PNL = CODES.filter((c) => c >= "2000");
const validInn = (s) => /^(\d{10}|\d{12})$/.test(String(s || ""));
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
// КНД 0710099 — полная форма, 0710096 — упрощённая (строки укрупнены)
const variantOf = (knd) => (String(knd) === "0710096" ? "simplified" : "standard");

// ---------- ГИР БО ----------
const GIRBO = "https://bo.nalog.gov.ru";
async function girboJson(p) {
  const r = await fetch(GIRBO + p, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (talk-proto)" }, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(`ГИР БО ответил ${r.status}`);
  return r.json();
}
async function fromGirbo(inn) {
  const s = await girboJson(`/advanced-search/organizations/search?query=${inn}&page=0`);
  const org = (s.content || []).find((o) => String(o.inn).replace(/<[^>]+>/g, "") === inn);
  if (!org) return { provider: "girbo", found: false, reports: [] };
  const list = await girboJson(`/nbo/organizations/${org.id}/bfo/`);
  const reports = [];
  for (const b of list) {
    const corr = (b.typeCorrections || []).map((t) => t.correction).find((c) => c && c.balance);
    if (!corr) continue;
    const take = (sec, codes, col) => Object.fromEntries(codes.map((c) => [c, num(sec?.[`${col}${c}`])]));
    reports.push({
      year: Number(b.period), knd: b.knd, variant: variantOf(b.knd), published: b.actualBfoDate || null,
      balance: { current: take(corr.balance, BAL, "current"), previous: take(corr.balance, BAL, "previous"), beforePrevious: take(corr.balance, BAL, "beforePrevious") },
      pnl: { current: take(corr.financialResult, PNL, "current"), previous: take(corr.financialResult, PNL, "previous") },
    });
  }
  return {
    provider: "girbo", found: true,
    org: { name: org.shortName, inn, ogrn: org.ogrn || null, okved: org.okved2 || null, status: org.statusCode || null },
    reports: reports.sort((a, b) => b.year - a.year),
  };
}

// ---------- parser-api.com ----------
async function fromParserApi(inn, key) {
  const B = "https://parser-api.com/parser/nalog_bo_api/";
  const get = async (q) => {
    const r = await fetch(`${B}${q}&key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(60000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`parser-api ${r.status}${j.error_code ? ` (${j.error_code}: ${j.error})` : ""}`);
    if (j.success === 0) throw new Error("parser-api: сбой источника, повторите позже");
    return j;
  };
  const s = await get(`search?inn=${inn}`);
  const item = (s.items || []).find((o) => String(o.inn) === inn);
  if (!item) return { provider: "parser-api", found: false, reports: [] };
  const d = await get(`details?id=${item.id}`);
  const pick = (rows, codes, col) => Object.fromEntries(codes.map((c) => [c, num((rows || []).find((x) => String(x.code) === c)?.[col])]));
  return {
    provider: "parser-api", found: true,
    org: { name: item.short_name, inn, ogrn: item.ogrn || null, okved: item.okved2 || null, status: item.status || null },
    reports: (d.reports || []).map((r) => ({
      year: Number(r.period), knd: r.knd || null, variant: variantOf(r.knd), published: r.published_date || null,
      balance: { current: pick(r.balance, BAL, "current"), previous: pick(r.balance, BAL, "previous"), beforePrevious: pick(r.balance, BAL, "before_previous") },
      pnl: { current: pick(r.financial_result, PNL, "current"), previous: pick(r.financial_result, PNL, "previous") },
    })).sort((a, b) => b.year - a.year),
  };
}

// ---------- песочница: годовые значения по условному пакету калькулятора ----------
function sandboxReports(inn) {
  const demo = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "seed", "calc", "demo_synthetic.json"), "utf8"));
  const pkg = demo.packages.find((p) => p.inn === inn) || demo.packages[0];
  const col = (kind, date) => pkg.docs.flatMap((d) => d.columns).find((c) => c.kind === kind && c.date === date).values;
  const bal = col("balance", "2025-12-31"), pnl = col("pnl", "2025-12-31");
  const scale = (v, k) => Object.fromEntries(Object.entries(v).map(([c, x]) => [c, x === null ? null : Math.round(x * k)]));
  const pick = (v, codes) => Object.fromEntries(codes.map((c) => [c, v[c] ?? null]));
  return {
    provider: "sandbox", found: true, sandbox_note: "условные значения песочницы (по демо-пакету калькулятора)",
    org: { name: pkg.name, inn, ogrn: null, okved: "77.39.1", status: "ACTIVE" },
    reports: [2025, 2024].map((y, i) => ({
      year: y, knd: "0710099", variant: "standard", published: `${y + 1}-03-31`,
      balance: { current: pick(scale(bal, [1, 0.9][i]), BAL), previous: pick(scale(bal, [0.9, 0.8][i]), BAL), beforePrevious: pick(scale(bal, [0.8, 0.7][i]), BAL) },
      pnl: { current: pick(scale(pnl, [1, 0.9][i]), PNL), previous: pick(scale(pnl, [0.9, 0.8][i]), PNL) },
    })),
  };
}

module.exports = {
  id: "fin",
  title: "Бухгалтерская отчётность (ГИР БО)",
  what: "Годовые баланс и ОПиУ по ИНН → коды строк 1200…2400; источник ГИР БО, запасной — parser-api.com",
  mode: "live",
  CODES,
  ops: {
    reports: {
      ttlMs: 7 * 24 * 3600 * 1000, // годовая отчётность меняется редко; без сети используется кэш
      async live({ inn }, { env }) {
        if (!validInn(inn)) throw fail("bad_request", "ИНН — 10 или 12 цифр", 400);
        if (/^0{9}[1-3]$/.test(String(inn))) return sandboxReports(String(inn)); // условные ИНН демо-пакетов
        const errors = [];
        try {
          return await fromGirbo(String(inn));
        } catch (e) {
          errors.push(`ГИР БО: ${e.message}`);
        }
        if (env.PARSERAPI_KEY) {
          try {
            return await fromParserApi(String(inn), env.PARSERAPI_KEY);
          } catch (e) {
            errors.push(e.message);
          }
        }
        throw new Error(errors.join("; "));
      },
      async sandbox({ inn }) {
        if (!validInn(inn)) throw fail("bad_request", "ИНН — 10 или 12 цифр", 400);
        return sandboxReports(String(inn));
      },
    },
  },
};
