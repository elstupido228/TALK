// Серверные HTML-страницы портала.
const { esc } = require("./http");
const { can, ROLE_TITLES } = require("./auth");
const STAGES = require("./stages");
const CONNECTORS = require("./connectors/registry");

const PROJECT = "Контур контроля лизинговой сделки";

const STATUS = {
  working: ["Рабочий модуль", "ok"],
  target: ["Целевая схема", "target"],
  backlog: ["Бэклог", "muted"],
};

function layout({ title, user, active = "", body }) {
  const nav = [
    ["/", "Жизненный цикл", "lifecycle"],
    ["/sources", "Источники данных", "sources"],
    ["/about", "О проекте", "about"],
    ...(can(user, "users.view") ? [["/admin/users", "Пользователи", "users"]] : []),
  ];
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} — ${PROJECT}</title>
<link rel="stylesheet" href="/static/style.css">
</head>
<body>
${
  user
    ? `<header class="top">
  <a class="brand" href="/">${PROJECT}<span class="proto">прототип</span></a>
  <nav>${nav.map(([href, label, id]) => `<a href="${href}"${id === active ? ' aria-current="page"' : ""}>${label}</a>`).join("")}</nav>
  <form class="who" method="post" action="/logout">
    <span title="${esc(user.email)}">${esc(user.name || user.email)} · ${esc(ROLE_TITLES[user.role])}</span>
    <button type="submit">Выйти</button>
  </form>
</header>`
    : ""
}
<main>
${body}
</main>
<footer>Демонстрационный прототип. Все данные на страницах условные.</footer>
</body>
</html>`;
}

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

function lifecyclePage(user) {
  const cards = STAGES.map((s, i) => {
    const [label, cls] = STATUS[s.status];
    const head = `<span class="n">${i + 1}</span><h2>${esc(s.title)}</h2><span class="badge ${cls}">${label}</span>`;
    return `<li class="stage ${s.status}" id="${s.id}">
  ${s.href ? `<a class="stage-head" href="${s.href}">${head}</a>` : `<div class="stage-head">${head}</div>`}
  <p>${esc(s.summary)}</p>
  <p class="src"><b>Источники:</b> ${s.sources.map(esc).join(", ")}</p>
  ${s.href ? `<a class="go" href="${s.href}">Открыть модуль →</a>` : ""}
</li>`;
  }).join("\n");
  return layout({
    title: "Жизненный цикл сделки",
    user,
    active: "lifecycle",
    body: `<h1>Жизненный цикл лизинговой сделки</h1>
<p class="lead">Семь стадий от заявки до работы с просрочкой. В прототипе работают две: <b>оценка клиента</b> и <b>мониторинг</b>.
Остальные показаны как целевая схема и бэклог.</p>
<ol class="ribbon">
${cards}
</ol>
<p class="legend">${Object.values(STATUS).map(([l, c]) => `<span class="badge ${c}">${l}</span>`).join(" ")}</p>`,
  });
}

function modulePage(user, { title, active = "lifecycle", step }) {
  return layout({
    title,
    user,
    active,
    body: `<p class="crumbs"><a href="/">Жизненный цикл</a> / ${esc(title)}</p>
<h1>${esc(title)}</h1>
<p class="notice">Модуль подключается к порталу на шаге ${step} работ.</p>`,
  });
}

function sourcesPage(user, log) {
  const MODE = { live: ["Живой", "ok"], sandbox: ["Песочница", "target"] };
  const rows = CONNECTORS.map((c) => {
    const [ml, mc] = MODE[c.mode];
    return `<tr><td><b>${esc(c.title)}</b><br><span class="muted">${esc(c.what)}</span></td>
<td><span class="badge ${mc}">${ml}</span></td>
<td>${c.state === "planned" ? '<span class="badge muted">Не подключён</span>' : '<span class="badge ok">Работает</span>'}</td></tr>`;
  }).join("\n");
  const journal = can(user, "connectors.log")
    ? `<h2>Журнал запросов</h2>
${
  log.length
    ? `<div class="scroll"><table><thead><tr><th>Время</th><th>Коннектор</th><th>Режим</th><th>Запрос</th><th>Статус</th><th>мс</th></tr></thead><tbody>
${log
  .map(
    (r) => `<tr><td>${new Date(r.at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}</td><td>${esc(r.connector)}</td><td>${esc(r.mode)}</td><td>${esc(r.request)}</td><td>${esc(r.status)}</td><td>${r.ms ?? ""}</td></tr>`
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
<p class="lead">Единый слой коннекторов <code>/api/connectors/*</code>: один интерфейс, кэш ответов, журнал, режимы «живой» и «песочница».</p>
<div class="scroll"><table><thead><tr><th>Коннектор</th><th>Режим</th><th>Состояние</th></tr></thead><tbody>
${rows}
</tbody></table></div>
${journal}`,
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
<p class="muted">Учётные записи создаются скриптом <code>scripts/create-users.js</code> на сервере.</p>
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

module.exports = { loginPage, lifecyclePage, modulePage, sourcesPage, aboutPage, usersPage, errorPage, PROJECT };
