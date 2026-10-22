// DaData «Организация по ИНН» (findById/party). Токен — DADATA_TOKEN, заголовок Authorization: Token …
// Бесплатно до 10 000 запросов в сутки. Описание ответа — docs/sources/dadata.md.
const { fail } = require("./core");

const URL_ = "https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party";
const STATUS = { ACTIVE: "действует", LIQUIDATING: "ликвидируется", LIQUIDATED: "ликвидирована", BANKRUPT: "банкротство", REORGANIZING: "реорганизация" };
const validInn = (s) => /^(\d{10}|\d{12})$/.test(String(s || ""));
const iso = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : null);

function card(d) {
  return {
    inn: d.inn, kpp: d.kpp ?? null, ogrn: d.ogrn ?? null, type: d.type,
    name: d.name?.short_with_opf || d.name?.full_with_opf || null, full_name: d.name?.full_with_opf || null,
    status: d.state?.status || null, status_label: STATUS[d.state?.status] || d.state?.status || null,
    registered: iso(d.state?.registration_date), liquidated: iso(d.state?.liquidation_date),
    address: d.address?.value || null, okved: d.okved || null,
    management: d.management ? { name: d.management.name, post: d.management.post, since: iso(d.management.start_date) } : d.fio ? { name: [d.fio.surname, d.fio.name, d.fio.patronymic].filter(Boolean).join(" "), post: "Индивидуальный предприниматель", since: null } : null,
  };
}

// Условные карточки песочницы: ИНН вида 000000000N — демо-пакеты калькулятора
const SANDBOX = {
  "0000000001": "ООО «Альфа-Пример»", "0000000002": "ООО «Бета-Пример»", "0000000003": "ООО «Гамма-Пример»",
};

module.exports = {
  id: "dadata",
  title: "DaData — организация по ИНН",
  what: "Наименование, статус (действует / ликвидируется / банкротство), адрес, ОКВЭД, руководитель",
  mode: "live",
  card,
  ops: {
    party: {
      ttlMs: 24 * 3600 * 1000,
      async live({ inn }, { env }) {
        if (!validInn(inn)) throw fail("bad_request", "ИНН — 10 или 12 цифр", 400);
        if (SANDBOX[inn]) return this.sandbox({ inn }); // условные ИНН демо-пакетов в реестрах не существуют
        if (!env.DADATA_TOKEN) throw new Error("не задан DADATA_TOKEN");
        const r = await fetch(URL_, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json", authorization: `Token ${env.DADATA_TOKEN}` },
          body: JSON.stringify({ query: String(inn), branch_type: "MAIN" }),
          signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) throw new Error(`DaData ответила ${r.status}`);
        const s = (await r.json()).suggestions || [];
        if (!s.length) return { found: false, inn: String(inn) };
        return { found: true, ...card(s[0].data) };
      },
      async sandbox({ inn }) {
        if (!validInn(inn)) throw fail("bad_request", "ИНН — 10 или 12 цифр", 400);
        return { found: true, inn: String(inn), kpp: null, ogrn: null, type: "LEGAL", name: SANDBOX[inn] || "ООО «Условная организация»", full_name: null,
          status: "ACTIVE", status_label: "действует", registered: "2015-03-01", liquidated: null, address: "условный адрес, г. Москва", okved: "77.39.1",
          management: { name: "Петров Пётр Петрович (условно)", post: "Генеральный директор", since: "2020-01-01" }, sandbox_note: "условные значения песочницы" };
      },
    },
  },
};
