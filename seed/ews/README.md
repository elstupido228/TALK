# Раннее предупреждение ТАЛК — код прототипа

Балльная карта из 13 признаков (27.10.2026), обучена на условном пуле из 2 500 клиентов. Данные сгенерированы:
веса и точность показывают работу метода, а не реальные зависимости. Изменения относительно карты 14.10 (5 признаков) —
в `data/model_5_признаков_2026-10-14.json` (прежняя карта, для сравнения).

В git из данных — только карты (`data/model.json`, `data/model_5_признаков_2026-10-14.json`). Портфель, пул, срезы,
баллы Python пересоздаются командами ниже (детерминированно, seed 20261014). Портал берёт `data/demo.json` из сборки
образа (стадия `ews-demo` в `Dockerfile`).

## Окружение

Python 3.10+ (эталон — 3.13; проверено и на 3.14), Node.js 18+. Эталонные версии:

    pip install numpy==2.5.3 pandas==3.0.5 scikit-learn==1.9.1 optbinning==1.0.0 scipy==1.18.1 ortools==9.15.6755 openpyxl==3.1.5

- pyarrow в этом окружении не ставить: с ним pandas 3 подписывает интервалы отрасли в `model.json` как
  `<ArrowStringArray>` вместо `<StringArray>` и карта формально перестаёт совпадать с эталоном (баллы те же).
- На Windows обязателен режим UTF-8 (`PYTHONUTF8=1` или `python -X utf8`): иначе `gen_data.py` пишет JSON в cp1251,
  названия событий не распознаются и срезы получаются другими.

## Эталон (этап 1)

    python gen_data.py                                    # data/demo.json — демо-портфель портала (420 клиентов)
    python gen_data.py --clients 2500 --out pool.json     # data/pool.json — обучающий пул
    node build_features.js data/pool.json data/pool_snapshots.json   # срезы и даты дефолтов (data/pool_defaults.json)
    python train.py 2024-03-31 data/pool_snapshots.json   # -> data/model.json, data/py_scores_test.csv
    node check_parity.js data/pool.json                   # ожидается расхождение 0.0000

Ожидается: clients 2500, contracts 3578; срезов 90678, с событием 2676 (3.6%), клиентов с событием 341; 13 факторов,
зоны 574 / 612, gini_test 0.642 (0.587–0.692), gini_rule 0.368, p_max 19 при 170 клиентах с дефолтом;
сравнено 24232 срезов, расхождение 0.0000. Карта совпадает с `data/model.json` из git, кроме поля `version`.

## Переобучение на выгрузке заказчика (этап 3)

Данные заказчика — вне репозитория, в каталоге с правами 700. Правила процедуры — `docs/ТЗ.md`, раздел «Раннее предупреждение».

    python xlsx_to_json.py /data/customer/выгрузка.xlsx /data/customer/data.json [--date ГГГГ-ММ-ДД]
    node build_features.js /data/customer/data.json /data/customer/snapshots.json
    python train.py <дата_разделения> /data/customer/snapshots.json
    node check_parity.js /data/customer/data.json

`features.js` — единый расчёт просрочки и признаков для обучения, портала (`/api/ews/*`) и страницы-прототипа.
`page_src.html`, `build_page.py`, `test_page.py` — автономная страница-прототип (как в claude.ai); в портале страница
«Мониторинг» собирается из `app/monitoring`.
