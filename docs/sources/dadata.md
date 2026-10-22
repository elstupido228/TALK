# DaData — «Организация по ИНН»

Проверено 2026-10-22 с сервера прототипа, токен `DADATA_TOKEN` из `.env`. Коннектор: `app/connectors/dadata.js`, метод `dadata/party`.

## Условия (dadata.ru/api/find-party)

- До 10 000 запросов в сутки бесплатно; сверх — годовая подписка.
- Не больше 30 запросов в секунду и 60 новых соединений в минуту с одного IP; запрос — до 300 символов.
- Поля ОКВЭД (`okved`, `okveds`) по описанию относятся к тарифам «Расширенный» и «Максимальный»; на текущем токене `okved` возвращается.
- Ответы кэшируются на 24 часа; без сети — последний сохранённый ответ.

## Запрос

```
POST https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party
Content-Type: application/json
Accept: application/json
Authorization: Token <DADATA_TOKEN>

{"query": "<ИНН>", "branch_type": "MAIN"}
```

`branch_type: MAIN` — только головная организация (без филиалов).

## Ответ (поля, которые использует коннектор; значения заменены)

```json
{"suggestions": [{"value": "ПАО \"…\"", "data": {
  "inn": "…", "kpp": "…", "ogrn": "…", "type": "LEGAL",
  "name": {"short_with_opf": "ПАО \"…\"", "full_with_opf": "…"},
  "state": {"status": "ACTIVE", "registration_date": 1069632000000, "liquidation_date": null},
  "address": {"value": "г Краснодар, ул …", "unrestricted_value": "…"},
  "okved": "68.20.21",
  "management": {"name": "…", "post": "ГЕНЕРАЛЬНЫЙ ДИРЕКТОР", "start_date": 1716854400000, "disqualified": null}}}]}
```

Статусы `state.status`: ACTIVE — действует, LIQUIDATING — ликвидируется, LIQUIDATED — ликвидирована, BANKRUPT — банкротство,
REORGANIZING — реорганизация. Даты — миллисекунды Unix, коннектор переводит в ГГГГ-ММ-ДД. Для ИП руководитель берётся из `fio`.
Пустой `suggestions` — организация не найдена (`found: false`).
