// Клиенты: список с поиском и карточка клиента (контакты, правка, сделки и их сумма).
const { esc } = require("./http");
const { mln } = require("./format");
const STAGES = require("./stages");
const { layout, fdate } = require("./views");

const sum = (ds) => ds.reduce((s, d) => s + (d.amount_mln || 0), 0);
const live = (ds) => ds.filter((d) => !d.outcome && !d.archived_at);
const stageTitle = (d) => (d.archived_at ? "Архив" : d.outcome ? "Отказ" : STAGES.find((s) => s.id === d.stage)?.title || d.stage);
const SOURCE = { manual: "наименование введено вручную", dadata: "наименование из DaData", placeholder: "наименование временное — DaData ещё не ответила" };
// новая сделка для клиента: форма на главной с подставленными ИНН и наименованием
const newDealHref = (c) => `/?${new URLSearchParams({ ...(c.inn ? { inn: c.inn } : {}), client_name: c.name })}#new`;

// m: {clients: [{...client, deals}], q, canEdit}
function clientsPage(user, m) {
  const rows = m.clients.map((c) => {
    const a = live(c.deals);
    return `<tr><td><a href="/clients/${c.id}">${esc(c.name)}</a></td><td>${esc(c.inn || "—")}</td><td>${esc(c.contact_name || "—")}</td><td>${c.phone ? `<a href="tel:${esc(c.phone.replace(/[^\d+]/g, ""))}">${esc(c.phone)}</a>` : "—"}</td><td class="r">${a.length}</td><td class="r">${a.length ? mln(sum(a)) : "—"}</td></tr>`;
  }).join("");
  return layout({
    title: "Клиенты",
    user,
    active: "clients",
    body: `<h1>Клиенты</h1>
<p class="muted small">Клиент появляется вместе с первой сделкой: по ИНН (наименование — из DaData) или по введённому наименованию.</p>
<form class="search-row" method="get" action="/clients" role="search"><label class="sr" for="cq">Поиск клиента</label><input id="cq" name="q" value="${esc(m.q)}" placeholder="Наименование, ИНН, контакт или телефон"><button type="submit">Найти</button>${m.q ? ' <a class="btn" href="/clients">Сбросить</a>' : ""}</form>
${rows ? `<div class="scroll"><table class="list-table"><thead><tr><th>Клиент</th><th>ИНН</th><th>Контактное лицо</th><th>Телефон</th><th class="r">Сделок в работе</th><th class="r">Сумма в работе</th></tr></thead><tbody>${rows}</tbody></table></div>`
  : `<p class="empty">${m.q ? `По запросу «${esc(m.q)}» клиентов нет. Проверьте написание или ищите по ИНН или телефону.` : "Клиентов пока нет — они появятся вместе с первой сделкой."}${m.canEdit ? ' <a href="/#new">Создать сделку</a>' : ""}</p>`}`,
  });
}

// Сведения DaData об организации клиента: статус, адрес, ОКВЭД, руководитель
function partyInfo(c, party) {
  if (!c.inn) return "";
  const p = party?.data;
  if (!p) return `<p class="muted small">Сведения DaData сейчас недоступны (<a href="/sources">состояние источников</a>).</p>`;
  if (p.found === false) return `<p class="error">DaData: организация с ИНН ${esc(c.inn)} не найдена.</p>`;
  return `<h3>Организация <span class="badge ${p.status === "ACTIVE" ? "ok" : "target"}">${esc(p.status_label || p.status || "статус неизвестен")}</span>${p.sandbox_note ? ' <span class="badge muted">условно</span>' : ""}</h3>
<dl class="kv"><dt>ИНН</dt><dd>${esc(p.inn)}${p.ogrn ? ` · ОГРН ${esc(p.ogrn)}` : ""}</dd><dt>Адрес</dt><dd>${esc(p.address || "—")}</dd><dt>ОКВЭД</dt><dd>${esc(p.okved || "—")}</dd>${p.management ? `<dt>Руководитель</dt><dd>${esc(p.management.name)}${p.management.post ? `, ${esc(p.management.post.toLowerCase())}` : ""}</dd>` : ""}${p.registered ? `<dt>Регистрация</dt><dd>${fdate(p.registered)}</dd>` : ""}</dl>`;
}

// m: {client, party, deals, canEdit, form: {values, errors}}
function clientPage(user, m) {
  const c = m.client, a = live(m.deals), closed = m.deals.length - a.length;
  const v = m.form?.values || c, err = m.form?.errors || {};
  const field = (k, label, attrs = "") => `<label for="cl-${k}">${label}<input id="cl-${k}" name="${k}" value="${esc(v[k] ?? "")}"${attrs}${err[k] ? ` aria-invalid="true" aria-describedby="err-cl-${k}"` : ""}>${err[k] ? `<span class="ferr" id="err-cl-${k}">${esc(err[k])}</span>` : ""}</label>`;
  return layout({
    title: c.name,
    user,
    active: "clients",
    body: `<p class="crumbs"><a href="/clients">Клиенты</a> / ${esc(c.name)}</p>
<h1>${esc(c.name)}</h1>
<p class="muted">${c.inn ? `ИНН ${esc(c.inn)} · ` : "ИНН не указан · "}${SOURCE[c.name_source] || ""}</p>
<div class="dash">
  <section class="panel wide">
    <h2>Клиент</h2>
    <dl class="kv"><dt>Контактное лицо</dt><dd>${esc(c.contact_name || "—")}</dd><dt>Телефон</dt><dd>${c.phone ? `<a href="tel:${esc(c.phone.replace(/[^\d+]/g, ""))}">${esc(c.phone)}</a>` : "—"}</dd><dt>Email</dt><dd>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : "—"}</dd>${c.note ? `<dt>Примечание</dt><dd>${esc(c.note)}</dd>` : ""}</dl>
    ${partyInfo(c, m.party)}
    <p class="actions">${m.canEdit ? `<a class="btn primary" href="${esc(newDealHref(c))}">Создать сделку для клиента</a>` : ""}${c.inn ? `<a class="btn" href="/check?inn=${esc(c.inn)}">Отчётность и класс по ИНН</a>` : ""}</p>
  ${m.canEdit ? `<details class="edit client-edit"${m.form ? " open" : ""}><summary><h3>Изменить контакты и примечание</h3></summary>
<form method="post" action="/clients/${c.id}/edit" class="eform" data-draft>
  ${field("name", "Наименование")}
  ${field("inn", "ИНН", ` inputmode="numeric" autocomplete="off"${c.inn ? " readonly" : ""}`)}
  ${field("contact_name", "Контактное лицо")}
  ${field("phone", "Телефон", ' type="tel" inputmode="tel"')}
  ${field("email", "Email", ' type="email" inputmode="email"')}
  <label class="wide" for="cl-note">Примечание<textarea id="cl-note" name="note" rows="2" maxlength="1000">${esc(v.note ?? "")}</textarea></label>
  <p class="muted small wide">Новое наименование появится во всех сделках клиента. ИНН клиента со сделками не меняется.</p>
  <div class="form-actions"><button type="submit" data-busy-text="Сохраняю…">Сохранить</button><button type="button" class="cancel" data-cancel>Отмена</button></div>
</form></details>` : ""}
  </section>
  <section class="panel wide">
    <h2>Сделки клиента</h2>
    <p>${a.length ? `В работе: <b>${a.length}</b> на <b>${mln(sum(a))}</b>` : "В работе сделок нет"}${closed ? ` · закрыто или в архиве: ${closed}` : ""}</p>
    ${m.deals.length ? `<div class="scroll"><table class="list-table"><thead><tr><th>Сделка</th><th>Предмет</th><th>Стадия</th><th class="r">Сумма</th></tr></thead><tbody>${m.deals.map((d) => `<tr${d.outcome || d.archived_at ? ' class="muted"' : ""}><td><a href="/deals/${d.id}">Сделка №${d.id}</a></td><td>${esc(d.asset || "—")}</td><td>${esc(stageTitle(d))}</td><td class="r">${mln(d.amount_mln)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">Сделок нет.</p>`}
  </section>
</div>`,
  });
}

module.exports = { clientsPage, clientPage, newDealHref };
