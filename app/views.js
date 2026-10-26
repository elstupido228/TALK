// Серверные HTML-страницы портала.
const { esc } = require("./http");
const { can, ROLE_TITLES } = require("./auth");
const STAGES = require("./stages");
const shell = require("./shell");

const PROJECT = "Контур контроля лизинговой сделки";

const STATUS = {
  working: ["Рабочий модуль", "ok"],
  target: ["Целевая схема", "target"],
  backlog: ["Бэклог", "muted"],
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
const fdate = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : "—");
const innForm = (inn = "", big = false) => `<form class="inn-form${big ? " big" : ""}" method="get" action="/check">
  <label for="inn">ИНН клиента</label>
  <div class="inn-row"><input id="inn" name="inn" inputmode="numeric" autocomplete="off" pattern="\\d{10}|\\d{12}" title="10 или 12 цифр" required placeholder="10 или 12 цифр" value="${esc(inn)}"><button type="submit" data-busy-text="Проверяю клиента…">Проверить клиента</button></div>
</form>`;
const clsBadge = (c) => (c === null || c === undefined ? `<span class="muted small">нет данных</span>` : `<span class="cls cls-${c}" title="класс ${c}">${c}</span>`);
const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? few : many);

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
их карточки ведут в модули. Остальные стадии — целевая схема и бэклог.</p>
<ol class="ribbon">
${cards}
</ol>
<p class="legend">${Object.values(STATUS).map(([l, c]) => `<span class="badge ${c}">${l}</span>`).join(" ")}</p>`,
  });
}

// list: [{id, title, what, mode: "live"|"sandbox", sandboxOnly, ops}]
function sourcesPage(user, list, log) {
  const MODE = { live: ["Живой", "ok"], sandbox: ["Песочница", "target"] };
  const rows = list.map((c) => {
    const [ml, mc] = MODE[c.mode];
    const state = c.sandboxOnly ? '<span class="badge muted">Только интерфейс</span>' : '<span class="badge ok">Подключён</span>';
    const ops = c.ops ? `<br>${c.ops.map((o) => `<code>${esc(c.id)}/${esc(o)}</code>`).join(" ")}` : "";
    return `<tr><td><b>${esc(c.title)}</b><br><span class="muted">${esc(c.what)}</span>${ops}</td>
<td><span class="badge ${mc}">${ml}</span></td>
<td>${state}</td></tr>`;
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
<p class="lead">Единый слой коннекторов <code>/api/connectors/*</code>: один интерфейс, кэш ответов, журнал, режимы «живой» и «песочница».
Если внешний источник недоступен, отдаётся последний ответ из кэша, а без кэша — условный ответ песочницы.</p>
<div class="scroll"><table><thead><tr><th>Коннектор</th><th>Режим</th><th>Состояние</th></tr></thead><tbody>
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
    const card = p.found === false
      ? `<p class="error">DaData: организация с ИНН ${esc(m.inn)} не найдена.</p>`
      : `<div class="card"><h2>${esc(p.name)}</h2>
<p><span class="badge ${p.status === "ACTIVE" ? "ok" : "target"}">${esc(p.status_label || p.status || "статус неизвестен")}</span> ИНН ${esc(p.inn)}${p.ogrn ? ` · ОГРН ${esc(p.ogrn)}` : ""}${p.registered ? ` · зарегистрирована ${esc(p.registered)}` : ""}</p>
<p>${esc(p.address || "")}</p>
<p>ОКВЭД ${esc(p.okved || "—")}${p.management ? ` · ${esc(p.management.post || "")}: ${esc(p.management.name)}` : ""}</p>
${srcLine(m.party)}</div>`;
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
    const sides = `<h2>Другие источники</h2><p class="muted small">Контур.Фокус, СПАРК, 1С и CRM подключены только интерфейсом: ответы условные.</p>
<div class="grid2">
${sb("Контур.Фокус", side.kontur, (d) => `<p>Арбитраж (ответчик, 12 мес.): ${d.arbitration.as_defendant_12m} дел на ${nf(d.arbitration.sum_mln)} млн руб.</p><p>Исполнительные производства: ${d.fssp.open}</p>${d.flags.length ? `<p>${d.flags.map(esc).join("; ")}</p>` : ""}`)}
${sb("СПАРК", side.spark, (d) => `<p>Должная осмотрительность: ${d.due_diligence_index} · платёжная дисциплина: ${d.payment_discipline_index} · финансовый риск: ${d.financial_risk_index}</p>`)}
${sb("1С", side.onec, (d) => `<p>${d.contracts.map((c) => `${esc(c.number)} — ${esc(c.asset)}, ${nf(c.amount_mln)} млн руб.${c.overdue_days ? `, просрочка ${c.overdue_days} дн.` : ""}`).join("<br>")}</p>`)}
${sb("CRM", side.crm, (d) => `<p>${d.applications.map((a) => `${esc(a.id)}: ${esc(a.stage)}, ${esc(a.asset)}, ${nf(a.amount_mln)} млн руб.`).join("<br>")}</p>`)}
</div>`;
    body = card + fin + sides;
  }
  return layout({
    title: m.party?.data?.name ? `${m.party.data.name} — проверка по ИНН` : "Проверка по ИНН",
    user,
    active: "check",
    body: `<h1>Проверка по ИНН</h1>
<p class="lead">Карточка организации (DaData) и годовая отчётность (ГИР БО) → предварительный класс по формулам калькулятора.</p>
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

module.exports = { layout, nf, fdate, clsBadge, innForm, loginPage, processPage, sourcesPage, checkPage, aboutPage, usersPage, errorPage, PROJECT };
