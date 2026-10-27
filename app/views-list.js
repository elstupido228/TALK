// Сделки списком (с фильтрами и сортировкой), панель фильтров для канбана и списка, поиск по всему порталу.
const { esc } = require("./http");
const STAGES = require("./stages");
const { layout } = require("./views");
const { qs, STATUSES, SORTS, SETS, statusOf } = require("./deal-filter");
const { fmt, status: taskStatus } = require("./tasks");

const mln = (v) => (v === null || v === undefined ? "—" : `${Number(v).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} млн`);
const sum = (ds) => ds.reduce((s, d) => s + (d.amount_mln || 0), 0);
const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? few : many);
const days = (t) => Math.max(0, Math.floor((Date.now() - t) / 86400000));
const ago = (t) => { const n = days(t); return n === 0 ? "сегодня" : `${n} ${plural(n, "день", "дня", "дней")} назад`; };
const stageName = (d) => (statusOf(d) === "archived" ? "Архив" : statusOf(d) === "refused" ? "Отказ" : STAGES.find((s) => s.id === d.stage)?.title || d.stage);

// Переключатель «Канбан / Список» и условия отбора. view: board | list; users — для выбора ответственного
function filterBar(view, f, users, total, shown) {
  const sel = (name, label, opts, value) => `<label class="f">${label}<select name="${name}">${opts.map(([v, t]) => `<option value="${esc(v)}"${String(v) === String(value) ? " selected" : ""}>${esc(t)}</option>`).join("")}</select></label>`;
  const owners = [["", "Все"], ["me", "Мои"], ...users.map((u) => [String(u.id), u.name || u.email])];
  const keep = (f2) => qs({ ...f2, sort: view === "list" ? f2.sort : "", dir: view === "list" ? f2.dir : "" });
  return `<div class="viewbar"><nav class="seg-links" aria-label="Вид"><a href="/deals${keep({ ...f, status: "active", stage: "" })}"${view === "board" ? ' aria-current="page"' : ""}>Канбан</a><a href="/deals/list${qs(f)}"${view === "list" ? ' aria-current="page"' : ""}>Список</a></nav>
<form class="filters-row" method="get" action="${view === "list" ? "/deals/list" : "/deals"}" role="search">
  <label class="f">Поиск<input name="q" value="${esc(f.q)}" placeholder="Клиент, ИНН, № сделки"></label>
  ${sel("owner", "Ответственный", owners, f.owner)}
  ${view === "list" ? sel("status", "Состояние", Object.entries(STATUSES), f.status) + sel("stage", "Стадия", [["", "Все стадии"], ...STAGES.map((s) => [s.id, s.title])], f.stage) : ""}
  ${view === "list" ? `<input type="hidden" name="sort" value="${esc(f.sort)}"><input type="hidden" name="dir" value="${esc(f.dir)}">${f.set ? `<input type="hidden" name="set" value="${esc(f.set)}">` : ""}` : ""}
  <button type="submit">Показать</button>
  ${f.q || f.owner || f.stage || f.status !== "active" ? `<a class="btn" href="${view === "list" ? "/deals/list" : "/deals"}">Сбросить</a>` : ""}
</form>
${f.set && SETS[f.set] ? `<p class="set-caption" role="status">Показаны сделки: <b>${esc(SETS[f.set].title)}</b> — ${shown}. <a href="/deals/list${qs({ ...f, set: "" })}">Показать все</a></p>` : shown !== total ? `<p class="muted small">Показано ${shown} из ${total}.</p>` : ""}</div>`;
}

// m: {deals (отобранные и отсортированные), f, users, total, tasks: Map, canEdit}
function dealsList(user, m) {
  const f = m.f;
  const th = (key, label, cls = "") => {
    const on = f.sort === key, dir = on ? (f.dir || (["activity", "amount", "days"].includes(key) ? "desc" : "asc")) : "";
    const next = on ? (dir === "desc" ? "asc" : "desc") : "";
    return `<th class="${cls}"${on ? ` aria-sort="${dir === "desc" ? "descending" : "ascending"}"` : ""}><a href="/deals/list${qs(f, { sort: key, dir: next })}">${label}${on ? (dir === "desc" ? " ↓" : " ↑") : ""}</a></th>`;
  };
  const task = (t) => (t ? `<span class="due ${taskStatus(t)}">${taskStatus(t) === "overdue" ? "просрочена" : taskStatus(t) === "today" ? "сегодня" : "до " + fmt(t.due)}</span> ${esc(t.text)}` : `<span class="muted">нет</span>`);
  const rows = m.deals.map((d) => `<tr${statusOf(d) !== "active" ? ' class="muted"' : ""}><td><a href="/deals/${d.id}">${esc(d.title)}</a><br><span class="muted small">№${d.id} · ${esc(d.asset || "предмет не указан")}</span></td><td>${esc(stageName(d))}</td><td class="r">${mln(d.amount_mln)}</td><td>${esc(d.owner_name || d.owner_email || "—")}</td><td class="r">${days(d.stage_at || d.created_at)}</td><td>${task(m.tasks.get(d.id))}</td><td>${ago(d.last_at || d.updated_at)}</td></tr>`).join("");
  return layout({
    title: "Сделки — список",
    user,
    active: "deals",
    body: `<div class="head-row"><h1>Сделки</h1>${m.canEdit ? '<a class="btn primary" href="/#new">Создать сделку</a>' : ""}</div>
${filterBar("list", f, m.users, m.total, m.deals.length)}
${m.deals.length ? `<div class="scroll"><table class="list-table deals-table"><thead><tr>${th("client", SORTS.client)}${th("stage", SORTS.stage)}${th("amount", SORTS.amount, "r")}${th("owner", SORTS.owner)}${th("days", "На стадии, дн.", "r")}${th("task", SORTS.task)}${th("activity", "Последняя активность")}</tr></thead><tbody>${rows}</tbody>
<tfoot><tr><td>Итого: ${m.deals.length}</td><td></td><td class="r">${mln(sum(m.deals))}</td><td colspan="4"></td></tr></tfoot></table></div>
<p><a class="btn" href="/deals/export.csv${qs(f)}" download>Скачать CSV (Excel)</a> <span class="muted small">— выгрузка с текущими условиями отбора</span></p>`
  : `<p class="empty">Под условия ничего не подходит.${f.q ? ` По запросу «${esc(f.q)}» сделок нет — проверьте написание или ищите по ИНН.` : ""} Измените условия или <a href="/deals/list">сбросьте фильтры</a>.</p>`}`,
  });
}

// Поиск по порталу: клиенты и сделки. m: {q, clients, deals}
function searchPage(user, m) {
  const clientRows = m.clients.slice(0, 20).map((c) => `<li><a href="/clients/${c.id}">${esc(c.name)}</a> <span class="muted small">${c.inn ? `ИНН ${esc(c.inn)}` : "без ИНН"}${c.contact_name ? ` · ${esc(c.contact_name)}` : ""}${c.phone ? ` · ${esc(c.phone)}` : ""}</span></li>`).join("");
  const dealRows = m.deals.slice(0, 30).map((d) => `<li><a href="/deals/${d.id}">${esc(d.title)}</a> <span class="muted small">№${d.id} · ${esc(stageName(d))}${d.amount_mln ? ` · ${mln(d.amount_mln)}` : ""}</span></li>`).join("");
  return layout({
    title: m.q ? `Поиск: ${m.q}` : "Поиск",
    user,
    active: "",
    body: `<h1>Поиск</h1>
<form class="search-row" method="get" action="/search" role="search"><label class="sr" for="sq">Что найти</label><input id="sq" name="q" value="${esc(m.q)}" placeholder="Клиент, ИНН, телефон, № сделки" autofocus><button type="submit">Найти</button></form>
${!m.q ? `<p class="muted">Ищутся клиенты (наименование, ИНН, контакт, телефон) и сделки (клиент, ИНН, номер, примечание).</p>`
  : !m.clients.length && !m.deals.length ? `<p class="empty">По запросу «${esc(m.q)}» ничего не найдено. Проверьте раскладку и написание, попробуйте часть наименования или ИНН.</p>`
  : `<div class="dash"><section class="panel"><h2>Клиенты <span class="muted small">${m.clients.length}</span></h2>${clientRows ? `<ul class="plain">${clientRows}</ul>` : `<p class="muted">Нет.</p>`}</section>
<section class="panel"><h2>Сделки <span class="muted small">${m.deals.length}</span></h2>${dealRows ? `<ul class="plain">${dealRows}</ul><p><a href="/deals/list?q=${encodeURIComponent(m.q)}&amp;status=all">Все найденные сделки списком →</a></p>` : `<p class="muted">Нет.</p>`}</section></div>`}`,
  });
}

module.exports = { filterBar, dealsList, searchPage };
