# Контур контроля лизинговой сделки — прототип (рабочее название)

Портал-прототип для показа кураторам проекта «Гибридные лидеры» (22–23.10.2026) и референс для команды Sber2B.
Это демонстрация, а не продукт. Главные документы для Sber2B: `docs/ТЗ.md` и `docs/openapi.yaml` (шаг 7).

> Репозиторий публичный по решению владельца (доступ кураторам и ТАЛК). Риск учтён: в `seed/calc/core.js` лежат пороги внутреннего регламента.
> Реальных данных клиентов в репозитории нет — проверка: `node scripts/scan-real-data.js`.

## Состав

| Путь | Что это |
|---|---|
| `app/` | Сервис Node.js: вход и роли, страницы, API (`/api/extract`, `/api/connectors/*`) |
| `seed/calc/` | Калькулятор класса: ядро `core.js` (формулы не менять), 124 тестовых случая, страница |
| `seed/ews/` | Раннее предупреждение: генерация условного портфеля, признаки, модель, сверка |
| `test/` | Тесты (`npm test`) |
| `docs/` | ТЗ, OpenAPI, ответы и условия внешних API |
| `Dockerfile`, `docker-compose.yml`, `Caddyfile` | Стек: Caddy (80/443, автосертификат) + app + SQLite в томе |

Потолок памяти всего стека — 600 МБ (`mem_limit`: app 480m, caddy 120m).

## Локальный запуск

```bash
npm ci
npm start          # http://localhost:3000, проверка: /healthz
npm test
```

## Сервер

Рабочий каталог `~/talk-proto` (chmod 700). Секреты — только в `~/talk-proto/.env` (образец: `.env.example`).
Каталоги `~/openclaw` и `~/openclaw-team` и их контейнеры не трогать: у этого стека своё имя Compose-проекта (`talk-proto`), своя сеть и тома.

Первый запуск:

```bash
git clone <repo> ~/talk-proto && chmod 700 ~/talk-proto
cp ~/talk-proto/.env.example ~/talk-proto/.env && chmod 600 ~/talk-proto/.env   # заполнить значения
cd ~/talk-proto && docker compose up -d --build
```

Обновление:

```bash
cd ~/talk-proto && git pull && docker compose up -d --build
```

Проверки после деплоя:

```bash
docker compose ps
curl -sI https://talk.perveev.com
free -h
docker ps --format '{{.Names}}\t{{.Status}}'
```

## Калькулятор класса (`/calc`)

Страница собирается сервером при старте (`app/calc/build.js`) из `seed/calc`: шаблон `page.src.html`, ядро `core.js`
(формулы не менять), условные пакеты A/B/C из `demo_synthetic.json` (классы 1/2/3), шаблон «Пробивки».
JSZip и pdf.js отдаются с собственного сервера (`app/public/vendor`). Распознавание PDF — `POST /api/extract`.

Сверка ядра с эталоном Excel (требование — 124 из 124):

```bash
node scripts/calc-parity.js
docker compose exec app node scripts/calc-parity.js   # на сервере
```

## Распознавание PDF (`POST /api/extract`)

`app/extract/gateway.js`: PDF → страницы в JPEG (`pdfinfo`, `pdftoppm` из poppler, 1600 px) → модель `OPENAI_MODEL`
(OpenAI Responses API, ответ JSON) → графы по кодам строк на все даты документа. Промпт — `app/extract/prompt.js`.
Ключ общий с ботами: из интерфейса не больше `OPENAI_DAILY_LIMIT` вызовов модели в московские сутки; каждый вызов
(с токенами) пишется в таблицу `openai_usage`. В OpenAI отправляются только условные PDF.

Расход за сегодня:

```bash
docker compose exec app node -e "const d=require('./app/db').open();console.table(d.prepare(\"SELECT source, model, count(*) calls, sum(input_tokens) inp, sum(output_tokens) outp FROM openai_usage WHERE day=date('now','+3 hours') GROUP BY 1,2\").all())"
```

### Замер моделей

Набор — 30 условных PDF в `bench/pdf` (пакеты A/B/C, по 10 документов), генератор — `scripts/gen-synthetic-pdf.js`
(`npm ci` с dev-зависимостями, затем `node scripts/gen-synthetic-pdf.js`). Порог приёмки — не ниже 57 из 60 ячеек по каждому пакету.

```bash
docker compose exec app node scripts/bench-extract.js --models gpt-5.4-mini,gpt-5.5,gpt-5.6-luna
```

Скрипт сначала проверяет каждую модель запросом `GET /v1/models/{id}` (404 — модель пропускается). Один прогон — около 30 вызовов на модель
(`--max-calls` — предохранитель, по умолчанию 120). Результаты в JSON — в `/data/bench-results` тома приложения.

## Мониторинг — раннее предупреждение (`/monitoring`)

Страница собирается сервером (`app/monitoring/build.js`, как `build_page.py`) из `seed/ews`: шаблон `page_src.html`,
расчёт признаков и баллов `features.js` (тот же код, что при обучении), балльная карта `data/model.json`, условный
портфель `data/demo.json` (420 клиентов, 607 договоров). В шапке — ключевая ставка Банка России (коннектор `cbr`).
Карта — 13 признаков, обучена на условном пуле из 2 500 клиентов; метрики (Gini 0,64 на проверочном периоде)
получены на условных данных и подаются только с этой оговоркой. Портфель `data/demo.json` в git не хранится —
создаётся генератором при сборке образа (стадия `ews-demo` в `Dockerfile`).

Обучение и сверка с эталоном — разовой командой вне контейнера портала, порядок и версии пакетов — в
[seed/ews/README.md](seed/ews/README.md). На Windows обязателен режим UTF-8 (`PYTHONUTF8=1`).

## Коннекторы (`/api/connectors/*`)

`app/connectors/core.js`: единый вызов `GET /api/connectors/{id}/{метод}`, кэш ответов (`connector_cache`), журнал
(`connector_log`, виден на «Источниках данных»). При недоступности внешнего API — последний ответ из кэша с пометкой
`stale`, без кэша — ответ песочницы с пометкой `fallback`. Режим переключается переменной `CONNECTOR_<ID>_MODE=sandbox`.

| Коннектор | Методы | Источник |
|---|---|---|
| `cbr` | `key-rate`, `curs?date=ГГГГ-ММ-ДД&codes=USD,EUR` | Банк России, DailyInfoWebServ (SOAP), без ключа |
| `dadata` | `party?inn=` | DaData «Организация по ИНН», `DADATA_TOKEN`, 10 000 запросов/сутки — `docs/sources/dadata.md` |
| `fin` | `reports?inn=` | Годовая отчётность: ГИР БО (без ключа) → запасной parser-api.com (`PARSERAPI_KEY`) — `docs/sources/girbo.md`, `docs/sources/parser-api.md` |
| `kontur`, `spark`, `onec`, `crm` | `check`, `risk`, `contracts`, `applications` (`?inn=`) | Только интерфейс и песочница: условные ответы |

### Проверка по ИНН (`/check`) — демо-сценарий

ИНН → DaData (карточка, статус) → ГИР БО (годовая отчётность) → класс на каждую годовую дату по формулам `core.js`
→ «Открыть в калькуляторе» (годовые графы; квартальные даты калькулятор показывает как недостающие — их запрашивают у клиента).
ИНН демо-компаний не хранятся в репозитории: `DEMO_INNS` в `.env` сервера. Прогрев кэша на случай сбоя сети во время показа:

```bash
docker compose exec app node scripts/warm-demo-cache.js
```

## Учётные записи

Вход по email и паролю. Роли: `admin`, `curator`, `sber2b`, `talk`, `team` (права — `PERMISSIONS` в `app/auth.js`).
Пароли генерирует скрипт, в базе хранятся только хэши scrypt. Список — CSV `email,роль[,имя]`:

```bash
cd ~/talk-proto && docker compose exec -T app node scripts/create-users.js - - < users.csv > passwords.txt && chmod 600 passwords.txt
```

Повторный запуск для того же email меняет роль и выдаёт новый пароль. После 5 неверных паролей за 15 минут вход по этому email блокируется на 15 минут (с одного IP — после 20).

## Правила

- В репозиторий не попадают ключи, `.env`, базы, реальные документы клиентов (см. `.gitignore`).
- В OpenAI отправляются только условные PDF, сгенерированные из `seed/calc/demo_synthetic.json`.
- Данные EWS синтетические; Gini 0,69 подаётся только с этой оговоркой.
- Результат считается достигнутым только с выводом проверочной команды.
