# Модель риска банкротства на открытых данных (RFSD + DaData)

Отдельная модель: прогнозирует банкротство компании по годовой отчётности (RFSD, CC BY 4.0,
https://huggingface.co/datasets/irlspbru/RFSD) и статусу ЕГРЮЛ (DaData `findById/party`). С условной картой клиентов
лизинга (`seed/ews`) не смешивается. Порядок, решения пользователя и точки остановки — задание 28.10.2026 (ред. 2), этап 4.

Запуск на сервере — разовым контейнером с pyarrow и сетью (профиль `train`):

    docker compose run --rm ews-open python rfsd_extract.py --years 2014-2025
    docker compose run --rm ews-open python label_dadata.py --plan-only     # остановиться: план показать пользователю

В git из данных — только `data/model_open.json`; панель RFSD, кэш DaData, наблюдения и имитация — вне git.

Проверка окружения на имитации (28.10.2026, Python 3.14, pyarrow 26.0.0, optbinning 1.0.0) совпала с эталоном:
mock_rfsd — 5000 компаний, 50646 строк, 436 банкротств; план — 2671 в выборке, к запросу 532 (перестала сдавать 383,
прекращена 83, выборка продолжающих 66); build_open — firms 2671, bankrupt_firms 169, obs 26645, events 169;
train_open — обучение 15614 / 103, проверка 4658 / 44, gini_test 0.473; check_open_parity — 0 расхождений признаков,
0.0000 балла. На имитации sample_bankrupt_share = 0,03 (> 0,02) — свойство имитации; на реальных данных проверить.
