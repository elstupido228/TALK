// Банк России, веб-сервис DailyInfoWebServ (SOAP 1.2): ключевая ставка (KeyRate), курсы валют (GetCursOnDate).
// https://www.cbr.ru/DailyInfoWebServ/DailyInfo.asmx — без ключа, открытые данные.
const { fail } = require("./core");

const URL_ = "https://www.cbr.ru/DailyInfoWebServ/DailyInfo.asmx";
const DAY = 24 * 3600 * 1000;
const isoDate = (d) => d.toISOString().slice(0, 10);
const mskToday = () => isoDate(new Date(Date.now() + 3 * 3600 * 1000));

async function soap(method, inner, timeoutMs = 15000) {
  const body = `<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body><${method} xmlns="http://web.cbr.ru/">${inner}</${method}></soap12:Body></soap12:Envelope>`;
  const r = await fetch(URL_, { method: "POST", headers: { "content-type": "application/soap+xml; charset=utf-8" }, body, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`ЦБ ответил ${r.status}`);
  return r.text();
}

// Ставки по дням (новые сверху) -> текущая ставка, дата начала её действия, история изменений.
function keyRateSummary(rows) {
  rows.sort((a, b) => b.date.localeCompare(a.date));
  if (!rows.length) throw new Error("ЦБ вернул пустой ряд ключевой ставки");
  const changes = [];
  for (let i = rows.length - 1; i >= 0; i--) if (i === rows.length - 1 || rows[i].rate !== rows[i + 1].rate) changes.push({ since: rows[i].date, rate: rows[i].rate });
  changes.reverse();
  return { rate: rows[0].rate, date: rows[0].date, since: changes[0].since, changes };
}

const VALID = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

module.exports = {
  id: "cbr",
  title: "Банк России — DailyInfoWebServ",
  what: "Ключевая ставка (KeyRate), курсы валют (GetCursOnDate)",
  mode: "live",
  keyRateSummary,
  ops: {
    "key-rate": {
      ttlMs: 6 * 3600 * 1000,
      async live({ days = 400 } = {}) {
        const to = new Date(Date.now() + 3 * 3600 * 1000), from = new Date(to - Math.min(+days || 400, 2000) * DAY);
        const xml = await soap("KeyRate", `<fromDate>${isoDate(from)}</fromDate><ToDate>${isoDate(to)}</ToDate>`);
        const rows = [...xml.matchAll(/<DT>(\d{4}-\d{2}-\d{2})[^<]*<\/DT>\s*<Rate>([\d.]+)<\/Rate>/g)].map((m) => ({ date: m[1], rate: Number(m[2]) }));
        return keyRateSummary(rows);
      },
      // Песочница: условный ответ той же формы (значения — последние известные на 21.10.2026)
      async sandbox() {
        return { rate: 14, date: "2026-10-21", since: "2026-07-27", changes: [{ since: "2026-07-27", rate: 14 }, { since: "2026-06-22", rate: 14.25 }], sandbox_note: "условные значения песочницы" };
      },
    },
    "curs": {
      ttlMs: 6 * 3600 * 1000,
      async live({ date = mskToday(), codes = "USD,EUR,CNY" } = {}) {
        if (!VALID(date)) throw fail("bad_request", "дата в формате ГГГГ-ММ-ДД", 400);
        const xml = await soap("GetCursOnDate", `<On_date>${date}</On_date>`);
        const want = String(codes).toUpperCase().split(",");
        const out = [];
        for (const m of xml.matchAll(/<ValuteCursOnDate[^>]*>([\s\S]*?)<\/ValuteCursOnDate>/g)) {
          const g = (t) => (m[1].match(new RegExp(`<${t}>\\s*([^<]*?)\\s*</${t}>`)) || [])[1];
          const code = g("VchCode");
          if (want.includes(code)) out.push({ code, name: g("Vname"), nominal: Number(g("Vnom")), rate: Number(g("Vcurs")) });
        }
        if (!out.length) throw new Error("ЦБ не вернул курсы на эту дату");
        return { date, rates: out };
      },
      async sandbox({ date = mskToday() } = {}) {
        return { date, rates: [{ code: "USD", name: "Доллар США", nominal: 1, rate: 80 }, { code: "EUR", name: "Евро", nominal: 1, rate: 93 }, { code: "CNY", name: "Китайский юань", nominal: 1, rate: 11 }], sandbox_note: "условные значения песочницы" };
      },
    },
  },
};
