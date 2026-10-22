# Раннее предупреждение ТАЛК — код прототипа

Порядок запуска (Python 3.10+, Node.js 18+):

    pip install optbinning lightgbm pandas scikit-learn
    python gen_data.py                                   # условный портфель -> data/demo.json (для реальных данных не нужен)
    node build_features.js data/demo.json data/snapshots.json   # срезы «клиент — месяц», исходы, даты дефолта
    python train.py 2024-03-31                           # обучение по эту дату, проверка после -> data/model.json
    node check_parity.js                                 # баллы страницы = баллы Python
    python build_page.py                                 # страница Раннее_предупреждение_ТАЛК.html

Данные ТАЛК: выгрузка по шаблону (кнопка «Скачать шаблон» на странице) переводится в формат data/demo.json
(те же поля: clients, contracts, schedule, payments, events, reports, today) и подаётся в build_features.js вместо демо.
features.js — единый расчёт просрочки и признаков для обучения и для страницы.
