// Сведение ответов модели по частям одного PDF в один документ (как ждёт калькулятор):
// графы с одинаковым видом и датой объединяются, первая по дате графа каждого вида — основная.
// Логика перенесена со страницы калькулятора (mergeCols и выбор основной графы), чтобы ею пользовались и шлюз, и замер.
const { parseDate } = require("../../seed/calc/core.js");

const CODES_ALL = ["1200", "1230", "1240", "1250", "1300", "1370", "1500", "1530", "1540", "1550", "1600", "1700", "2110", "2200", "2400"];
const CONF_RANK = ["fns_receipt", "edo_signature", "paper_signature", "none"];

function toNumber(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s/g, "").replace(",", ".").replace(/^\((.*)\)$/, "-$1");
  if (s === "-" || s === "—") return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function mergeCols(all) {
  const m = new Map();
  for (const c of all) {
    const date = parseDate(c.date);
    if (!date || (c.kind !== "balance" && c.kind !== "pnl")) continue;
    const k = c.kind + date;
    const cur = m.get(k) || { kind: c.kind, date, months: c.months ? +c.months : null, header: c.header ?? null, values: {}, page: {} };
    for (const [code, v] of Object.entries(c.values || {})) {
      if (!CODES_ALL.includes(code)) continue;
      if (cur.values[code] === undefined || cur.values[code] === null) {
        cur.values[code] = toNumber(v);
        if (c.page?.[code]) cur.page[code] = +c.page[code];
      }
    }
    m.set(k, cur);
  }
  const merged = [...m.values()].sort((a, b) => b.date.localeCompare(a.date));
  const seen = new Set();
  for (const c of merged) {
    c.primary = !seen.has(c.kind);
    seen.add(c.kind);
  }
  return merged;
}

// parts: ответы модели по частям страниц одного файла
function assemble(parts, pages) {
  let company = null, inn = null, variant = null;
  const conf = [], cols = [];
  for (const j of parts) {
    for (const c of j.columns || []) cols.push(c);
    company ||= j.company || null;
    if (j.inn && !inn) inn = String(j.inn).replace(/\D/g, "") || null;
    variant ||= j.form_variant || null;
    if (CONF_RANK.includes(j.confirmation)) conf.push(j.confirmation);
  }
  conf.sort((a, b) => CONF_RANK.indexOf(a) - CONF_RANK.indexOf(b));
  return { company, inn, form_variant: variant, confirmation: conf[0] || "none", pages, columns: mergeCols(cols) };
}

module.exports = { assemble, mergeCols, toNumber, CODES_ALL };
