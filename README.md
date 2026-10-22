# Контур контроля лизинговой сделки — прототип (рабочее название)

Портал-прототип для показа кураторам проекта «Гибридные лидеры» (22–23.10.2026) и референс для команды Sber2B.
Это демонстрация, а не продукт. Главные документы для Sber2B: `docs/ТЗ.md` и `docs/openapi.yaml` (шаг 7).

> Репозиторий **приватный**: в `seed/calc/core.js` лежат пороги внутреннего регламента. Не публиковать.

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

## Правила

- В репозиторий не попадают ключи, `.env`, базы, реальные документы клиентов (см. `.gitignore`).
- В OpenAI отправляются только условные PDF, сгенерированные из `seed/calc/demo_synthetic.json`.
- Данные EWS синтетические; Gini 0,69 подаётся только с этой оговоркой.
- Результат считается достигнутым только с выводом проверочной команды.
