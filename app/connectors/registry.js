// Реестр коннекторов. Шаг 2 — только описание для страницы «Источники данных»;
// реализация (единый интерфейс, кэш, журнал, live/sandbox) — шаг 6.
// mode: "live" — реальный внешний API; "sandbox" — заглушка с условными ответами; state: "planned" — ещё не подключён.
module.exports = [
  { id: "cbr", title: "Банк России — DailyInfoWebServ", what: "Ключевая ставка (KeyRate), курсы валют (GetCursOnDate)", mode: "live", state: "planned" },
  { id: "dadata", title: "DaData — организация по ИНН", what: "Наименование, статус, адрес, ОКВЭД, руководитель", mode: "live", state: "planned" },
  { id: "fin", title: "Бухгалтерская отчётность", what: "parser-api.com / ГИР БО → коды строк 1200…2400", mode: "live", state: "planned" },
  { id: "openai", title: "Распознавание PDF (OpenAI)", what: "Страницы отчётности → значения по кодам строк на пять дат", mode: "live", state: "planned" },
  { id: "kontur", title: "Контур.Фокус", what: "Проверка контрагента, арбитраж", mode: "sandbox", state: "planned" },
  { id: "spark", title: "СПАРК", what: "Индексы риска, связи", mode: "sandbox", state: "planned" },
  { id: "1c", title: "1С", what: "Договоры, графики платежей, оплаты", mode: "sandbox", state: "planned" },
  { id: "crm", title: "CRM", what: "Заявки и клиенты", mode: "sandbox", state: "planned" },
];
