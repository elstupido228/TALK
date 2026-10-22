# parser-api.com — API к данным ГИР БО (запасной источник)

Проверено 2026-10-22. Коннектор: `app/connectors/fin.js` (используется, если ГИР БО не ответил и задан `PARSERAPI_KEY`).

## Условия (по странице сервиса и документации)

- Сервис сторонний: прямо указано, что не имеет отношения к bo.nalog.gov.ru.
- 200 запросов в месяц бесплатно «без каких-либо условий»; платные тарифы — по запросу (support@parser-api.com), цены не опубликованы.
- В статистику и лимит идут только ответы с `success = 1`. Ошибки доступа: 40301 — неверный ключ, 40302 — подписка истекла,
  40303 — ограничение по IP, 40304/40305 — дневной/месячный лимит; 40001 — ошибка запроса.
- Документация: parser-api.com/nalog-bo (также `/documentation/nalog-bo-api.txt` и OpenAPI `/documentation/openapi/nalog-bo-openapi.yaml`).

## Результат проверки с ключом из `.env` сервера

```
GET https://parser-api.com/parser/nalog_bo_api/search?key=…&inn=<ИНН>
403 {"error":"Invalid access key","error_code":40301}
```

**Ключ не принят.** Пока ключ не заменён, источник не используется: при недоступности ГИР БО коннектор отдаёт кэш,
а без кэша — ответ песочницы. Разбор ответа реализован по документации и проверен тестом на подставном ответе
(`test/check.test.js`), на живых данных — нет.

## Запросы (по документации)

1. `GET https://parser-api.com/parser/nalog_bo_api/search?key=<KEY>&inn=<ИНН>` →
   `{"success": 1, "count": …, "items": [{"id": …, "inn": "…", "ogrn": "…", "short_name": "…", "status": "…", "okved2": "…", "bfo": {"period": …}}]}`
2. `GET https://parser-api.com/parser/nalog_bo_api/details?key=<KEY>&id=<id>` →
   `{"success": 1, "organization": {…}, "reports": [{"period": "2025", "published_date": "…", "url": "…pdf",
   "balance": [{"code": 1600, "name": "…", "current": …, "previous": …, "before_previous": …, "details": [...]}],
   "financial_result": [{"code": 2110, "current": …, "previous": …}], "capital_change": […], "funds_movement": […]}]}`

Маппинг тот же, что для ГИР БО: `current` → 31.12.Y, `previous` → Y−1, `before_previous` → Y−2 (баланс), значения в тыс. руб.
Запросов на организацию — два (поиск и детали), то есть около 100 организаций в месяц на бесплатном лимите; ответы кэшируются на 7 дней.
