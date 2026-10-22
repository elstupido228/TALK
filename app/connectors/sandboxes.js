// Контур.Фокус, СПАРК, 1С, CRM: только интерфейс и песочница (условные ответы, детерминированные по ИНН).
// Живой режим не реализован: договор и доступ к API — задача внедрения (см. docs/ТЗ.md). При CONNECTOR_<ID>_MODE=live
// вызов падает в песочницу с пометкой fallback.
const crypto = require("node:crypto");
const { fail } = require("./core");

const validInn = (s) => /^(\d{10}|\d{12})$/.test(String(s || ""));
const need = (inn) => { if (!validInn(inn)) throw fail("bad_request", "ИНН — 10 или 12 цифр", 400); return String(inn); };
// псевдослучайные, но постоянные для ИНН числа 0..1
const rnd = (inn, salt) => (k) => crypto.createHash("sha256").update(`${salt}:${inn}:${k}`).digest().readUInt32BE(0) / 2 ** 32;
const NOTE = "условные значения песочницы";
const notLive = async () => { throw new Error("живое подключение не реализовано в прототипе"); };
const sandboxOnly = (id, title, what, ops) => ({ id, title, what, mode: "sandbox", sandboxOnly: true,
  ops: Object.fromEntries(Object.entries(ops).map(([k, sandbox]) => [k, { ttlMs: 3600 * 1000, live: notLive, sandbox }])) });

module.exports = [
  sandboxOnly("kontur", "Контур.Фокус", "Проверка контрагента: арбитраж, исполнительные производства, факторы риска", {
    async check({ inn }) {
      const r = rnd(need(inn), "kontur");
      return { inn, arbitration: { as_defendant_12m: Math.floor(r(1) * 6), sum_mln: Math.round(r(2) * 300) / 10 },
        fssp: { open: Math.floor(r(3) * 3) }, flags: [r(4) > 0.8 && "смена руководителя за 12 месяцев", r(5) > 0.9 && "массовый адрес"].filter(Boolean), sandbox_note: NOTE };
    },
  }),
  sandboxOnly("spark", "СПАРК", "Индексы должной осмотрительности, платёжной дисциплины, финансового риска", {
    async risk({ inn }) {
      const r = rnd(need(inn), "spark");
      return { inn, due_diligence_index: 1 + Math.floor(r(1) * 99), payment_discipline_index: 1 + Math.floor(r(2) * 99), financial_risk_index: 1 + Math.floor(r(3) * 99), sandbox_note: NOTE };
    },
  }),
  sandboxOnly("onec", "1С", "Договоры лизинга, графики платежей, оплаты по клиенту", {
    async contracts({ inn }) {
      const r = rnd(need(inn), "onec"); const n = 1 + Math.floor(r(1) * 3);
      return { inn, contracts: Array.from({ length: n }, (_, i) => ({ number: `ДЛ-${100 + Math.floor(r(10 + i) * 900)}/2025`, asset: ["Грузовой транспорт", "Спецтехника", "Оборудование"][Math.floor(r(20 + i) * 3)],
        amount_mln: Math.round((5 + r(30 + i) * 45) * 10) / 10, overdue_days: r(40 + i) > 0.8 ? Math.floor(r(50 + i) * 40) : 0 })), sandbox_note: NOTE };
    },
  }),
  sandboxOnly("crm", "CRM", "Заявки и история взаимодействия с клиентом", {
    async applications({ inn }) {
      const r = rnd(need(inn), "crm");
      return { inn, applications: [{ id: `З-${1000 + Math.floor(r(1) * 9000)}`, stage: ["Новая", "Оценка клиента", "Решение"][Math.floor(r(2) * 3)], asset: "Грузовой транспорт", amount_mln: Math.round((3 + r(3) * 30) * 10) / 10 }], sandbox_note: NOTE };
    },
  }),
];
