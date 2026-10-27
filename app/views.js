// Серверные HTML-страницы портала.
const { esc } = require("./http");
const { can, ROLE_TITLES } = require("./auth");
const STAGES = require("./stages");
const shell = require("./shell");

const PROJECT = "Контур контроля лизинговой сделки";

const STATUS = {
  working: ["Работает", "ok"],
  target: ["В разработке", "target"],
  backlog: ["В разработке", "muted"],
};

function layout({ title, user, active = "", body }) {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} — ${PROJECT}</title>
${shell.FONTS}
<link rel="stylesheet" href="/static/style.css">
</head>
<body>
${user ? shell.open(user, active) : ""}
<main class="page">
${body}
</main>
<footer>Демонстрационный прототип. Все данные на страницах условные.</footer>
${user ? shell.close() : ""}
<script src="/static/forms.js"></script>
</body>
</html>`;
}

const nf = (v) => (v === null || v === undefined ? "—" : Number(v).toLocaleString("ru-RU"));
const { fdate, plural } = require("./format");
const innForm = (inn = "", big = false) => `<form class="inn-form${big ? " big" : ""}" method="get" action="/check">
  <label for="inn">ИНН клиента</label>
  <div class="inn-row"><input id="inn" name="inn" inputmode="numeric" autocomplete="off" pattern="\\d{10}|\\d{12}" title="10 или 12 цифр" required placeholder="10 или 12 цифр" value="${esc(inn)}"><button type="submit" data-busy-text="Проверяю клиента…">Проверить клиента</button></div>
</form>`;
const clsBadge = (c) => (c === null || c === undefined ? `<span class="muted small">нет данных</span>` : `<span class="cls cls-${c}" title="класс ${c}">${c}</span>`);

function loginPage({ error = "", email = "", next = "/" } = {}) {
  return layout({
    title: "Вход",
    body: `<section class="login">
  <h1>${PROJECT}</h1>
  <p class="muted">Прототип для кураторов проекта «Гибридные лидеры» и команды Sber2B</p>
  ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
  <form method="post" action="/login">
    <input type="hidden" name="next" value="${esc(next)}">
    <label>Email<input name="email" type="email" autocomplete="username" required value="${esc(email)}"></label>
    <label>Пароль<input name="password" type="password" autocomplete="current-password" required></label>
    <button type="submit">Войти</button>
  </form>
</section>`,
  });
}

function processPage(user) {
  const cards = STAGES.map((s, i) => {
    const [label, cls] = STATUS[s.status];
    const head = `<span class="n">${i + 1}</span><h2>${esc(s.title)}</h2><span class="badge ${cls}">${label}</span>`;
    return `<li class="stage ${s.status}" id="${s.id}">
  ${s.href ? `<a class="stage-head" href="${s.href}">${head}</a>` : `<div class="stage-head">${head}</div>`}
  <p>${esc(s.summary)}</p>
  <p class="src"><b>Источники:</b> ${s.sources.map(esc).join(", ")}</p>
  ${s.href ? `<a class="go" href="${s.href}">Открыть модуль →</a>` : ""}${s.extra ? `<a class="go2" href="${s.extra.href}">${esc(s.extra.label)} →</a>` : ""}
</li>`;
  }).join("\n");
  return layout({
    title: "Схема процесса",
    user,
    active: "process",
    body: `<h1>Схема процесса: жизненный цикл сделки</h1>
<p class="lead">Семь стадий от заявки до работы с просрочкой. В прототипе работают три — <b>заявка</b> (сделки и канбан), <b>оценка клиента</b> и <b>мониторинг</b>,
их карточки ведут в модули. Остальные стадии — в разработке: показано, как они будут устроены.</p>
<ol class="ribbon">
${cards}
</ol>
<p class="legend">${Object.values(STATUS).map(([l, c]) => `<span class="badge ${c}">${l}</span>`).join(" ")}</p>`,
  });
}

// list: [{id, title, what, mode: "live"|"sandbox", sandboxOnly, ops}]
function sourcesPage(user, list, log) {
  const MODE = { live: ["Внешний сервис", "ok"], sandbox: ["Условные ответы", "target"] };
  const rows = list.map((c) => {
    const [ml, mc] = MODE[c.mode];
    // состояние — по последнему обращению, теми же словами, что в карточке сделки и на «Проверке по ИНН»
    const when = (t) => new Date(t).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    const h = c.health;
    const state = c.sandboxOnly ? '<span class="badge muted">Только интерфейс</span>'
      : c.mode === "sandbox" ? '<span class="badge target">Условные ответы</span><br><span class="muted small">включено настройкой</span>'
      : !h ? '<span class="badge ok">Подключён</span>'
      : h.state === "ok" ? `<span class="badge ok">Отвечает</span><br><span class="muted small">последний ответ ${when(h.at)}</span>`
      : h.state === "down" ? `<span class="badge target">Источник недоступен</span><br><span class="muted small">с ${when(h.at)}: ${esc(h.error)}. Показывается сохранённый ответ, а без него — условный пример.</span>`
      : h.state === "ready" ? `<span class="badge ok">Готов</span><br><span class="muted small">${esc(h.note)}</span>`
      : h.state === "off" ? `<span class="badge target">Не работает</span><br><span class="muted small">${esc(h.note)}</span>`
      : '<span class="badge muted">Обращений ещё не было</span>';
    return `<tr><td><b>${esc(c.title)}</b><br><span class="muted">${esc(c.what)}</span></td>
<td><span class="badge ${mc}">${ml}</span></td>
<td>${state}</td></tr>`;
  }).join("\n");
  // журнал словами: название источника, откуда ответ, что спрашивали (без кодов методов и JSON)
  const TITLE = Object.fromEntries(list.map((c) => [c.id, c.title]));
  const FROM = { live: "запрос к источнику", cache: "сохранённый ответ", sandbox: "условный ответ" };
  const OPS = { "key-rate": "ключевая ставка", curs: "курсы валют", party: "организация", reports: "отчётность", check: "проверка контрагента", risk: "индексы риска", contracts: "договоры", applications: "заявки" };
  const requestText = (req) => {
    const [op, json] = String(req || "").split(/ (.*)/);
    let params = {};
    try { params = JSON.parse(json || "{}"); } catch {}
    return [OPS[op] || op, params.inn ? `ИНН ${params.inn}` : "", params.date ? `на ${params.date.split("-").reverse().join(".")}` : ""].filter(Boolean).join(", ");
  };
  const journal = can(user, "connectors.log")
    ? `<h2>Журнал запросов</h2>
${
  log.length
    ? `<div class="scroll"><table><thead><tr><th>Время</th><th>Источник</th><th>Откуда ответ</th><th>Запрос</th><th>Результат</th><th>мс</th></tr></thead><tbody>
${log
  .map(
    (r) => `<tr><td>${new Date(r.at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}</td><td>${esc(TITLE[r.connector] || r.connector)}</td><td>${esc(FROM[r.mode] || r.mode)}</td><td>${esc(requestText(r.request))}</td><td>${r.status === "ok" ? "успешно" : esc(r.status)}</td><td>${r.ms ?? ""}</td></tr>`
  )
  .join("\n")}
</tbody></table></div>`
    : '<p class="muted">Запросов пока не было.</p>'
}`
    : "";
  return layout({
    title: "Источники данных",
    user,
    active: "sources",
    body: `<h1>Источники данных</h1>
<p class="lead">Откуда портал берёт данные и отвечают ли источники сейчас. Если источник не отвечает, показывается последний сохранённый ответ, а без него — условный пример с пометкой.</p>
<div class="scroll"><table><thead><tr><th>Источник</th><th>Подключение</th><th>Состояние</th></tr></thead><tbody>
${rows}
</tbody></table></div>
${journal}`,
  });
}

// m: {inn, error, demo:[inn], party, fin, classes, docs, side:{kontur, spark, onec, crm}} — ответы коннекторов {data, source, …}
function checkPage(user, m) {
  const SRC = { live: "получено из источника", cache: "из кэша", sandbox: "песочница — условные значения" };
  const srcLine = (r) => r ? `<p class="muted small">${esc(r.data?.sandbox_note ? SRC.sandbox : SRC[r.source])}${r.stale ? ", источник недоступен — показан сохранённый ответ" : ""}${r.fallback ? ", источник недоступен" : ""} · ${new Date(r.fetched_at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}</p>` : "";
  const form = `${innForm(m.inn || "")}
${m.demo?.length ? `<p class="muted small">Подготовленные для показа: ${m.demo.map((i) => `<a href="/check?inn=${esc(i)}">${esc(i)}</a>`).join(" · ")} · условные: <a href="/check?inn=0000000001">0000000001</a></p>` : ""}`;
  let body = "";
  if (m.error) body = `<p class="error">${esc(m.error)}</p>`;
  else if (m.party) {
    const p = m.party.data;
    // источник не ответил: условный пример не должен выглядеть как сведения об организации
    const warn = m.party.fallback
      ? `<p class="notice" role="alert"><b>Источник «DaData» недоступен</b> — ниже <b>условный пример</b>, а не сведения об организации с ИНН ${esc(m.inn)}. Повторите проверку позже (<a href="/sources">состояние источников</a>).</p>`
      : m.party.stale ? `<p class="notice">Источник «DaData» недоступен — показан сохранённый ответ от ${new Date(m.party.fetched_at).toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" })}.</p>` : "";
    const card = warn + (p.found === false
      ? `<p class="error">DaData: организация с ИНН ${esc(m.inn)} не найдена.</p>`
      : `<div class="card"><h2>${esc(p.name)}</h2>
<p><span class="badge ${p.status === "ACTIVE" ? "ok" : "target"}">${esc(p.status_label || p.status || "статус неизвестен")}</span> ИНН ${esc(p.inn)}${p.ogrn ? ` · ОГРН ${esc(p.ogrn)}` : ""}${p.registered ? ` · зарегистрирована ${fdate(p.registered)}` : ""}</p>
<p>${esc(p.address || "")}</p>
<p>ОКВЭД ${esc(p.okved || "—")}${p.management ? ` · ${esc(p.management.post || "")}: ${esc(p.management.name)}` : ""}</p>
${srcLine(m.party)}</div>`);
    const f = m.fin?.data;
    let fin = "";
    if (!f || f.found === false || !m.classes?.length) fin = `<h2>Отчётность</h2><p class="muted">${f?.found === false ? "В ГИР БО отчётность по этому ИНН не найдена или не раскрыта (организации вправе ограничить доступ к своей отчётности)." : "Годовой отчётности нет."}</p>${srcLine(m.fin)}
<section class="next"><h2>Что дальше</h2><p>Запросите у клиента баланс и отчёт о финансовых результатах за пять последних квартальных дат.</p><div class="actions"><a class="btn primary" href="/calc#upload">Загрузить отчётность (PDF)</a></div></section>`;
    else {
      const ys = m.classes;
      const row = (label, key) => `<tr><td>${label}</td>${ys.map((y) => `<td class="r">${nf(y[key])}</td>`).join("")}</tr>`;
      fin = `<h2>Годовая отчётность и класс по формулам калькулятора</h2>
<p class="muted small">Источник: ${f.provider === "girbo" ? "ГИР БО (bo.nalog.gov.ru)" : f.provider === "parser-api" ? "parser-api.com (данные ГИР БО)" : "песочница"} · тыс. руб. · отрасль не указана — пороги К4 торговли и лизинга</p>
<div class="scroll"><table><thead><tr><th>Показатель</th>${ys.map((y) => `<th class="r">31.12.${y.year}</th>`).join("")}</tr></thead><tbody>
${row("Выручка (2110)", "revenue")}${row("Чистая прибыль (2400)", "net")}${row("Капитал (1300)", "equity")}${row("Баланс (1600)", "assets")}
<tr><td>Сумма баллов S</td>${ys.map((y) => `<td class="r">${y.S === null ? "—" : y.S.toFixed(2).replace(".", ",")}</td>`).join("")}</tr>
<tr><td><b>Класс кредитоспособности</b></td>${ys.map((y) => `<td class="r">${y.cls === null ? `<span class="muted small">недостаточно данных</span>` : `<span class="cls cls-${y.cls}">${y.cls}</span>`}${y.missing.length ? `<br><span class="muted small">нет строк: ${y.missing.join(", ")}</span>` : ""}${y.variant === "simplified" ? `<br><span class="muted small">упрощённая форма</span>` : ""}</td>`).join("")}</tr>
</tbody></table></div>
${srcLine(m.fin)}
<section class="next">
  <h2>Что дальше</h2>
  <p>В открытых источниках только годовая отчётность. Для заключения по п. 14.1 нужны четыре квартальные даты — их запрашивают у клиента.</p>
  <div class="actions"><button type="button" id="toCalc">Открыть годовую отчётность в калькуляторе</button><a class="btn" href="/calc#upload">Загрузить квартальную отчётность (PDF)</a></div>
</section>
<script>
document.getElementById("toCalc").onclick = () => {
  try { sessionStorage.setItem("talk-calc-import", ${JSON.stringify(JSON.stringify({ inn: m.inn, name: p.name || f.org?.name, source: f.provider, docs: m.docs })).split("<").join("\\u003c")}); } catch (e) {}
  location.href = "/calc";
};
</script>`;
    }
    const side = m.side || {};
    const sb = (title, r, render) => `<div class="card"><h3>${title} <span class="badge target">песочница</span></h3>${r ? render(r.data) : '<p class="muted">нет ответа</p>'}</div>`;
    // сделки портала по этому ИНН — вместо условной заявки из песочницы CRM
    const pd = m.portal?.deals || [], pc = m.portal?.client;
    const stageName = (d) => (d.archived_at ? "архив" : d.outcome ? "отказ" : STAGES.find((s) => s.id === d.stage)?.title || d.stage);
    const portal = `<h2>Сделки в портале</h2>${pd.length
      ? `<ul class="plain">${pd.map((d) => `<li><a href="/deals/${d.id}">Сделка №${d.id}</a> — ${esc(stageName(d))}${d.amount_mln ? `, ${nf(d.amount_mln)} млн руб.` : ""}${d.asset ? `, ${esc(d.asset)}` : ""}</li>`).join("")}</ul>${pc ? `<p><a href="/clients/${pc.id}">Карточка клиента «${esc(pc.name)}» →</a></p>` : ""}`
      : `<p class="muted">По этому ИНН сделок в портале нет.${can(user, "deals.edit") ? ` <a href="/?inn=${esc(m.inn)}#new">Создать сделку</a>` : ""}</p>`}`;
    const sides = `${portal}<h2>Другие источники</h2><p class="muted small">Контур.Фокус, СПАРК и 1С подключены только интерфейсом: ответы условные.</p>
<div class="grid2">
${sb("Контур.Фокус", side.kontur, (d) => `<p>Арбитраж (ответчик, 12 мес.): ${d.arbitration.as_defendant_12m} дел на ${nf(d.arbitration.sum_mln)} млн руб.</p><p>Исполнительные производства: ${d.fssp.open}</p>${d.flags.length ? `<p>${d.flags.map(esc).join("; ")}</p>` : ""}`)}
${sb("СПАРК", side.spark, (d) => `<p>Должная осмотрительность: ${d.due_diligence_index} · платёжная дисциплина: ${d.payment_discipline_index} · финансовый риск: ${d.financial_risk_index}</p>`)}
${sb("1С", side.onec, (d) => `<p>${d.contracts.map((c) => `${esc(c.number)} — ${esc(c.asset)}, ${nf(c.amount_mln)} млн руб.${c.overdue_days ? `, просрочка ${c.overdue_days} дн.` : ""}`).join("<br>")}</p>`)}
</div>`;
    body = card + fin + sides;
  }
  return layout({
    title: m.party?.data?.name ? `${m.party.data.name} — проверка по ИНН` : "Проверка по ИНН",
    user,
    active: "check",
    body: `${m.backDeal ? `<p class="crumbs"><a href="/deals/${m.backDeal.id}">← К сделке №${m.backDeal.id} «${esc(m.backDeal.title)}»</a></p>` : ""}<h1>Проверка клиента по ИНН</h1>
<p class="lead">Карточка организации (<abbr title="DaData — сервис сведений об организациях по ИНН (наименование, статус, адрес, руководитель)">DaData</abbr>) и годовая отчётность (<abbr title="ГИР БО — государственный информационный ресурс бухгалтерской отчётности ФНС (bo.nalog.gov.ru)">ГИР БО</abbr>) → предварительный класс по формулам калькулятора.</p>
${form}
${body}`,
  });
}

function aboutPage(user) {
  return layout({
    title: "О проекте",
    user,
    active: "about",
    body: `<h1>О проекте</h1>
<p class="lead">${PROJECT} — прототип единого портала контроля лизинговой сделки на всех стадиях: от заявки до работы с просрочкой.</p>
<h2>Назначение</h2>
<ul>
  <li>Показ кураторам проекта «Гибридные лидеры» (22–23 октября 2026).</li>
  <li>Референс и основа технического задания для команды Sber2B.</li>
</ul>
<h2>Что работает</h2>
<ul>
  <li><b>Оценка клиента</b> — калькулятор класса по бухгалтерской отчётности с распознаванием PDF.</li>
  <li><b>Мониторинг</b> — раннее предупреждение по балльной карте.</li>
  <li><b>Источники данных</b> — слой коннекторов к внешним API (Банк России, DaData, отчётность) и песочницы.</li>
</ul>
<h2>Оговорки</h2>
<ul>
  <li>Это демонстрация, а не продукт.</li>
  <li>Все данные условные (синтетические). Метрики модели раннего предупреждения получены на условных данных.</li>
</ul>`,
  });
}

function usersPage(user, users) {
  return layout({
    title: "Пользователи",
    user,
    active: "users",
    body: `<h1>Пользователи</h1>
<p class="muted">Учётные записи заводит администратор портала; здесь — кто имеет доступ и с какой ролью.</p>
<div class="scroll"><table><thead><tr><th>Email</th><th>Имя</th><th>Роль</th><th>Состояние</th></tr></thead><tbody>
${users
  .map(
    (u) =>
      `<tr><td>${esc(u.email)}</td><td>${esc(u.name)}</td><td>${esc(ROLE_TITLES[u.role])}</td><td>${u.disabled ? "отключён" : "активен"}</td></tr>`
  )
  .join("\n")}
</tbody></table></div>`,
  });
}

function errorPage(user, status, message) {
  return layout({ title: String(status), user, body: `<h1>${status}</h1><p>${esc(message)}</p><p><a href="/">На главную</a></p>` });
}

module.exports = { layout, nf, fdate, clsBadge, innForm, loginPage, processPage, sourcesPage, checkPage, aboutPage, usersPage, errorPage, PROJECT };
