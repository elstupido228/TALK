// Шлюз распознавания PDF: POST /api/extract.
// Контракт ответа (его ждёт страница калькулятора):
//   200 {company, inn, form_variant, confirmation, pages, columns:[{kind, header, date, months, values:{код:число|null}, page:{код:номер}}]}
//   4xx/5xx {error:{code, message}}; code: disabled | daily_limit | too_large | not_pdf | invalid_json | upstream_error | unauthorized
// Шаг 3: заглушка. Рендер страниц, вызов модели, лимит и учёт расхода — шаг 4.
const H = require("../http");

const REASON = "шлюз распознавания подключается на шаге 4";

function createGateway() {
  return {
    status: () => ({ enabled: false, reason: REASON }),
    async handle(req, res) {
      req.resume(); // тело не читаем
      return H.sendJson(res, 503, { error: { code: "disabled", message: REASON } });
    },
  };
}

module.exports = { createGateway };
