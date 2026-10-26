// Рабочие страницы: дашборд с запуском сделки, канбан сделок по стадиям, карточка сделки.
const { esc } = require("./http");
const STAGES = require("./stages");
const { layout, nf, fdate, clsBadge } = require("./views");

const STATUS = { working: "рабочий модуль", target: "целевая схема", backlog: "бэклог" };
const ASSETS = ["Грузовой транспорт", "Легковой транспорт", "Спецтехника", "Оборудование", "Другое"];
const PIPE = ["application", "assessment", "decision", "contract"]; // до выдачи
const OVERDUE = ["overdue_30", "overdue_30plus"];
const FORWARD = [...PIPE, "monitoring"]; // обычный ход сделки; просрочка — не «следующий шаг», а событие
const REFUSAL_REASONS = ["Стоп-фактор: класс 3 на всех четырёх датах", "Клиент не прошёл проверку", "Клиент отказался", "Не устроили условия", "Другое"];
const active = (ds) => ds.filter((d) => !d.outcome);
const mln = (v) => (v === null || v === undefined ? "—" : `${Number(v).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} млн`);
const sum = (ds) => ds.reduce((s, d) => s + (d.amount_mln || 0), 0);
const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? few : many);
const daysAgo = (t) => Math.max(0, Math.floor((Date.now() - t) / 86400000));
const ago = (t) => { const d = daysAgo(t); return d === 0 ? "сегодня" : `${d} ${plural(d, "день", "дня", "дней")}`; };

// form: {values, error, field} — после неудачной отправки
function newDealForm(form = {}) {
  const v = form.values || {}, bad = (k) => (form.field === k ? ' aria-invalid="true"' : "");
  // дубль по ИНН: ссылки на сделки и кнопка внутри формы — введённые значения уходят вместе с подтверждением.
  // Блок стоит после «Запустить сделку»: Enter в поле отправляет форму основной кнопкой, а не подтверждением дубля
  const dups = form.dups?.length ? `<div class="notice dups" role="alert"><p>По ИНН ${esc(v.inn)} уже есть сделки в работе: ${form.dups.map((d) => `<a href="/deals/${d.id}">${esc(d.title)}</a> (${esc(STAGES.find((s) => s.id === d.stage)?.title || d.stage)}${d.amount_mln ? `, ${mln(d.amount_mln)}` : ""})`).join("; ")}.</p><p>Откройте нужную сделку или создайте ещё одну, если это новая заявка того же клиента.</p><button type="submit" name="dup_ok" value="1">Всё равно создать новую сделку</button></div>` : "";
  return `${form.error && !dups ? `<p class="error" role="alert">${esc(form.error)}</p>` : ""}<form class="launch" method="post" action="/deals">
  <div class="f"><label for="nd-inn">ИНН клиента</label><input id="nd-inn" name="inn" inputmode="numeric" autocomplete="off" placeholder="необязательно" value="${esc(v.inn || "")}"${bad("inn")}></div>
  <div class="f"><label for="nd-asset">Предмет лизинга</label><select id="nd-asset" name="asset"${bad("asset")}><option value="">— выберите —</option>${ASSETS.map((a) => `<option${a === v.asset ? " selected" : ""}>${a}</option>`).join("")}</select></div>
  <div class="f"><label for="nd-amount">Сумма, млн руб.</label><input id="nd-amount" name="amount" inputmode="decimal" placeholder="например, 25" value="${esc(v.amount || "")}"${bad("amount")}></div>
  <button type="submit">Запустить сделку</button>${dups}
</form>
<p class="muted small">Сделка появится в колонке «Заявка». Если указан ИНН, портал сразу проверит клиента (DaData, ГИР БО) и покажет предварительный класс.</p>`;
}

// m: {deals, summary, keyRate, canEdit}
function dashboardPage(user, m) {
  const D = active(m.deals), s = m.summary, z = s.zones;
  const by = (ids) => D.filter((d) => ids.includes(d.stage));
  const pipe = by(PIPE), mon = by(["monitoring"]), over = by(OVERDUE);
  const maxN = Math.max(1, ...STAGES.map((st) => D.filter((d) => d.stage === st.id).length));
  const pct = (n) => Math.round((100 * n) / s.total);
  const kr = m.keyRate?.data;
  const tile = (label, value, sub, href) => `<a class="tile" href="${href}"><span>${label}</span><b>${value}</b><small>${sub}</small></a>`;
  return layout({
    title: "Главная",
    user,
    active: "home",
    body: `<h1>Дашборд</h1>
${m.canEdit ? `<section class="panel launch-panel" id="new"><h2>Новая сделка</h2>${newDealForm(m.form)}</section>` : ""}
<div class="tiles4">
  ${tile("Сделок в работе", pipe.length, `${mln(sum(pipe))} · до выдачи`, "/deals")}
  ${tile("На оценке клиента", by(["assessment"]).length, "ждут расчёта класса", "/deals#assessment")}
  ${tile("В мониторинге", mon.length, `портфель: ${s.total} клиентов`, "/deals#monitoring")}
  ${tile("В просрочке", over.length, `${z.red} клиентов портфеля в красной зоне`, "/deals#overdue_30")}
</div>
<div class="dash">
  <section class="panel wide">
    <h2>Сделки по стадиям</h2>
    <ul class="funnel">${STAGES.map((st) => { const ds = D.filter((d) => d.stage === st.id); return `<li><a href="/deals#${st.id}"><span class="fl">${esc(st.title)}${st.status === "working" ? "" : ` <em>${STATUS[st.status]}</em>`}</span><span class="fb"><i style="width:${Math.round((100 * ds.length) / maxN)}%"></i></span><span class="fn">${ds.length}</span><span class="fs">${ds.length ? mln(sum(ds)) : ""}</span></a></li>`; }).join("")}</ul>
    <p><a class="btn" href="/deals">Открыть канбан →</a></p>
  </section>
  <section class="panel">
    <h2>Портфель на ${fdate(s.today)}</h2>
    <div class="zbar" role="img" aria-label="Зоны: красная ${z.red}, жёлтая ${z.yellow}, зелёная ${z.green}, просрочка ${z.grey}">
      <i class="z-red" style="width:${pct(z.red)}%"></i><i class="z-yellow" style="width:${pct(z.yellow)}%"></i><i class="z-green" style="width:${pct(z.green)}%"></i><i class="z-grey" style="width:${pct(z.grey)}%"></i>
    </div>
    <p class="zleg"><span><i class="z-red"></i>красная ${z.red}</span><span><i class="z-yellow"></i>жёлтая ${z.yellow}</span><span><i class="z-green"></i>зелёная ${z.green}</span><span><i class="z-grey"></i>дефолт ${z.grey}</span></p>
    <h3>Требуют внимания</h3>
    <ul class="list">${s.worst.map((w) => `<li><a href="/monitoring#card=${encodeURIComponent(w.client)}"><span>${esc(w.client)}<br><span class="muted small">${esc(w.sector)}</span></span><span class="score" title="балл">${w.score}</span></a></li>`).join("")}</ul>
    <p class="muted small">Условный портфель: данные синтетические.</p>
  </section>
  <section class="panel">
    <h2>Последние сделки</h2>
    <ul class="list">${m.deals.slice(0, 5).map((d) => `<li><a href="/deals/${d.id}"><span>${esc(d.title)}<br><span class="muted small">${d.outcome ? "Отказ" : esc(STAGES.find((st) => st.id === d.stage)?.title || d.stage)} · ${ago(d.updated_at)}</span></span>${d.cls ? clsBadge(d.cls) : ""}</a></li>`).join("")}</ul>
    <h3>Ключевая ставка ЦБ</h3>
    ${kr ? `<p class="big">${kr.rate.toFixed(2).replace(".", ",")} %</p><p class="muted small">действует с ${fdate(kr.since)}${kr.sandbox_note ? " · условное значение" : ""}</p>` : `<p class="muted">Нет данных</p>`}
  </section>
</div>`,
  });
}

function dealCard(d, canEdit) {
  return `<a class="kcard${d.demo ? " demo" : ""}" href="/deals/${d.id}" data-id="${d.id}"${canEdit && !d.outcome ? ' draggable="true"' : ""}>
  <b>${esc(d.title)}</b>
  <span class="muted small">${esc(d.asset || "предмет не указан")}${d.amount_mln ? ` · ${mln(d.amount_mln)}` : ""}</span>
  ${d.outcome ? `<span class="small refused-reason">Отказ: ${esc(d.outcome_reason)}</span>` : d.note ? `<span class="small">${esc(d.note)}</span>` : ""}
  <span class="kmeta">${d.cls ? `${clsBadge(d.cls)} ` : ""}<span class="muted small">${d.outcome ? `отказ: ${ago(d.outcome_at)}` : `${ago(d.updated_at)} на стадии`}</span>${d.demo ? ' <span class="badge muted">условно</span>' : ""}</span>
</a>`;
}

function dealsBoard(user, m) {
  const live = active(m.deals), refused = m.deals.filter((d) => d.outcome);
  const cols = STAGES.map((st) => {
    const ds = live.filter((d) => d.stage === st.id);
    return `<section class="kcol ${st.status}" id="${st.id}" data-stage="${st.id}">
  <header><h2>${esc(st.title)}</h2><span class="muted small">${ds.length}${ds.length ? ` · ${mln(sum(ds))}` : ""}</span>${st.status === "working" ? "" : `<span class="badge muted">${STATUS[st.status]}</span>`}</header>
  <div class="kdrop">${ds.map((d) => dealCard(d, m.canEdit)).join("") || '<p class="kempty muted small">Нет сделок</p>'}</div>
</section>`;
  }).join("");
  return layout({
    title: "Сделки",
    user,
    active: "deals",
    body: `<div class="head-row"><h1>Сделки</h1>${m.canEdit ? '<a class="btn primary" href="/#new">Новая сделка</a>' : ""}</div>
<p class="muted small">${m.canEdit ? "Перетащите карточку в другую колонку, чтобы сменить стадию, или откройте сделку." : "Просмотр: менять стадии могут администратор, команда проекта и ТАЛК."} Условные сделки связаны с демо-данными калькулятора и мониторинга.</p>
<div class="board" id="board">${cols}</div>
${refused.length ? `<details class="panel refused-list"><summary><h2>Отказы</h2><span class="muted small">${refused.length} · ${mln(sum(refused))}</span></summary><div class="kgrid">${refused.map((d) => dealCard(d, false)).join("")}</div></details>` : ""}
<p class="status" id="kstatus" role="status"></p>
${m.canEdit ? `<script>
(() => {
  const FORWARD = ${JSON.stringify(FORWARD)};
  let dragId = null;
  document.querySelectorAll(".kcard[draggable]").forEach((c) => {
    c.addEventListener("dragstart", (e) => { dragId = c.dataset.id; e.dataTransfer.setData("text/plain", dragId); c.classList.add("dragging"); });
    c.addEventListener("dragend", () => c.classList.remove("dragging"));
  });
  document.querySelectorAll(".kcol").forEach((col) => {
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("over"); });
    col.addEventListener("dragleave", () => col.classList.remove("over"));
    col.addEventListener("drop", async (e) => {
      e.preventDefault(); col.classList.remove("over");
      const id = e.dataTransfer.getData("text/plain") || dragId; if (!id) return;
      const card = document.querySelector('.kcard[data-id="' + id + '"]'), from = card.closest(".kcol"), to = col.dataset.stage;
      if (from === col) return;
      const name = (c) => c.querySelector("h2").textContent;
      if (FORWARD.indexOf(to) !== FORWARD.indexOf(from.dataset.stage) + 1 || FORWARD.indexOf(to) < 0)
        if (!confirm("Перевести сделку «" + card.querySelector("b").textContent + "» со стадии «" + name(from) + "» на «" + name(col) + "»? Это шаг вне обычного порядка стадий; он попадёт в историю и в счётчики главной.")) return;
      const st = document.getElementById("kstatus"); st.textContent = "Сохраняю…";
      const r = await fetch("/api/deals/" + id + "/stage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: col.dataset.stage }) });
      if (r.ok) location.reload(); else st.textContent = "Не удалось сменить стадию: " + ((await r.json().catch(() => ({}))).error?.message || r.status);
    });
  });
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ inline: "start", block: "nearest" });
})();
</script>` : ""}`,
  });
}

// Клиент в карточке сделки: DaData и годовая отчётность (ГИР БО) с классом по годам
function clientBlock(d, m) {
  if (!d.inn) return `<section class="panel"><h2>Клиент</h2><p class="muted">ИНН ещё не указан.${m.canEdit ? " Укажите его в разделе «Данные сделки» — портал проверит клиента." : ""}</p></section>`;
  const c = m.client || {};
  const p = c.party?.data, f = c.fin?.data;
  const down = [!c.party && "DaData", !c.fin && "ГИР БО"].filter(Boolean);
  const recheck = m.canEdit ? `<form method="post" action="/deals/${d.id}/recheck" class="inline"><button type="submit">Проверить снова</button></form>` : "";
  let org = "";
  if (p?.found === false) org = `<p class="error">DaData: организация с ИНН ${esc(d.inn)} не найдена.</p>`;
  else if (p) org = `<p><b>${esc(p.name)}</b> <span class="badge ${p.status === "ACTIVE" ? "ok" : "target"}">${esc(p.status_label || p.status || "статус неизвестен")}</span>${p.sandbox_note ? ' <span class="badge muted">условно</span>' : ""}</p>
<dl class="kv"><dt>ИНН</dt><dd>${esc(p.inn)}${p.ogrn ? ` · ОГРН ${esc(p.ogrn)}` : ""}</dd><dt>Адрес</dt><dd>${esc(p.address || "—")}</dd><dt>ОКВЭД</dt><dd>${esc(p.okved || "—")}</dd>${p.management ? `<dt>Руководитель</dt><dd>${esc(p.management.name)}${p.management.post ? `, ${esc(p.management.post.toLowerCase())}` : ""}</dd>` : ""}${p.registered ? `<dt>Регистрация</dt><dd>${fdate(p.registered)}</dd>` : ""}</dl>`;
  let fin = "";
  if (f && m.classes.length) {
    const ys = m.classes;
    const row = (label, key) => `<tr><td>${label}</td>${ys.map((y) => `<td class="r">${nf(y[key])}</td>`).join("")}</tr>`;
    fin = `<h3>Годовая отчётность, тыс. руб.</h3><div class="scroll"><table><thead><tr><th></th>${ys.map((y) => `<th class="r">${y.year}</th>`).join("")}</tr></thead><tbody>
${row("Выручка", "revenue")}${row("Чистая прибыль", "net")}${row("Капитал", "equity")}${row("Баланс", "assets")}
<tr><td><b>Класс</b></td>${ys.map((y) => `<td class="r">${clsBadge(y.cls)}</td>`).join("")}</tr></tbody></table></div>
<p class="muted small">Предварительно, по формулам калькулятора; пороги К4 — торговля и лизинг. Для заключения нужны квартальные даты.</p>`;
  } else if (f) fin = `<p class="muted">Годовая отчётность в ГИР БО не найдена или не раскрыта.</p>`;
  return `<section class="panel wide"><h2>Клиент</h2>
${down.length ? `<p class="notice">${down.join(" и ")} ${down.length > 1 ? "недоступны" : "недоступен"} — сведения ниже неполные. ${recheck}</p>` : ""}
${org}${fin}
<p class="actions"><a class="btn" href="/check?inn=${esc(d.inn)}">Полная проверка по ИНН</a>${down.length ? "" : recheck}</p>
</section>`;
}

function editForm(d, form = {}) {
  const v = form.values || { inn: d.inn, asset: d.asset, amount: d.amount_mln, term: d.term_months, comment: d.comment };
  const bad = (k) => (form.field === k ? ' aria-invalid="true"' : "");
  return `<details class="panel edit"${form.error ? " open" : ""}><summary><h2>Данные сделки</h2><span class="muted small">изменить</span></summary>
${form.error ? `<p class="error" role="alert">${esc(form.error)}</p>` : ""}
<form method="post" action="/deals/${d.id}/edit" class="eform">
  <label>ИНН клиента<input name="inn" inputmode="numeric" autocomplete="off" value="${esc(v.inn ?? "")}"${bad("inn")}></label>
  <label>Предмет лизинга<select name="asset"><option value="">не указан</option>${ASSETS.map((a) => `<option${a === v.asset ? " selected" : ""}>${a}</option>`).join("")}</select></label>
  <label>Сумма, млн руб.<input name="amount" inputmode="decimal" value="${esc(v.amount ?? "")}"${bad("amount")}></label>
  <label>Срок, мес.<input name="term" inputmode="numeric" value="${esc(v.term ?? "")}"${bad("term")}></label>
  <label class="wide">Комментарий<textarea name="comment" rows="2" maxlength="500">${esc(v.comment ?? "")}</textarea></label>
  <p class="muted small wide">При смене ИНН клиент будет проверен заново. Все изменения попадают в историю.</p>
  <button type="submit">Сохранить</button>
</form></details>`;
}

// Отказ: при стоп-факторе — главное действие стадии (форма раскрыта), иначе — свёрнутая форма.
// form: {values, error} — после неудачной отправки
function refuseForm(d, stop, form = {}) {
  const v = form.values || (stop ? { reason: REFUSAL_REASONS[0] } : {});
  const body = `${form.error ? `<p class="error" role="alert">${esc(form.error)}</p>` : ""}<form method="post" action="/deals/${d.id}/refuse" class="eform">
  <label class="wide">Причина отказа<select name="reason" required><option value="">— выберите —</option>${REFUSAL_REASONS.map((r) => `<option${r === v.reason ? " selected" : ""}>${esc(r)}</option>`).join("")}</select></label>
  <label class="wide">Комментарий<textarea name="comment" rows="2" maxlength="300">${esc(v.comment || "")}</textarea></label>
  <button type="submit" class="${stop ? "primary" : "danger"}" data-confirm="${esc(`Оформить отказ по сделке «${d.title}»? Сделка уйдёт из воронки и счётчиков; вернуть её можно кнопкой «Вернуть в работу».`)}">Оформить отказ</button>
</form>`;
  return stop ? `<div class="refuse stop"><p><b>Стоп-фактор:</b> ${esc(d.stop_factor)}. По правилу оценки сделка отклоняется.</p>${body}</div>`
    : `<details class="refuse"${form.error ? " open" : ""}><summary>Оформить отказ…</summary>${body}</details>`;
}

// m: {deal, events, canEdit, client:{party, fin}|null, classes, form, refuse}
function dealPage(user, m) {
  const d = m.deal;
  const i = STAGES.findIndex((s) => s.id === d.stage);
  const next = FORWARD.includes(d.stage) && d.stage !== "monitoring" ? STAGES[i + 1] : null;
  // события после выдачи: отдельные кнопки с подтверждением, не главное действие
  const title = (id) => STAGES.find((s) => s.id === id).title;
  const event = (to, label, effect) => `<button type="submit" formnovalidate name="stage" value="${to}" data-confirm="${esc(`${label}: сделка «${d.title}» перейдёт на стадию «${title(to)}». ${effect}`)}">${label}</button>`;
  const events = {
    monitoring: [event("overdue_30", "Отметить просрочку до 30 дней", "Она войдёт в счётчик «В просрочке» на главной.")],
    overdue_30: [event("monitoring", "Просрочка погашена", "Она вернётся в мониторинг."), event("overdue_30plus", "Просрочка свыше 30 дней", "Начнётся работа с проблемной задолженностью.")],
    overdue_30plus: [event("monitoring", "Задолженность урегулирована", "Она вернётся в мониторинг.")],
  }[d.stage] || [];
  const stop = d.stop_factor && !d.outcome && PIPE.includes(d.stage);
  const actions = [];
  if (["application", "assessment", "decision"].includes(d.stage)) {
    if (d.inn) actions.push(`<a class="btn${d.stage !== "application" ? "" : " primary"}" href="/check?inn=${esc(d.inn)}">Проверка по ИНН</a>`);
    actions.push(`<a class="btn${d.stage === "assessment" && !d.stop_factor ? " primary" : ""}" href="/calc#upload">Расчёт класса по отчётности (PDF)</a>`);
  }
  if (d.client_code) actions.push(`<a class="btn primary" href="/monitoring#card=${encodeURIComponent(d.client_code)}">Карточка клиента в мониторинге</a>`);
  if (d.stage === "monitoring" && !d.client_code) actions.push(`<a class="btn" href="/monitoring">Мониторинг портфеля</a>`);
  const st = STAGES[i];
  return layout({
    title: d.title,
    user,
    active: "deals",
    body: `<p class="crumbs"><a href="/deals">Сделки</a> / ${esc(d.title)}</p>
<h1>${esc(d.title)}</h1>
<p class="muted">${d.inn ? `ИНН ${esc(d.inn)} · ` : ""}${esc(d.asset || "предмет не указан")}${d.amount_mln ? ` · ${mln(d.amount_mln)} руб.` : ""}${d.term_months ? ` · ${d.term_months} мес.` : ""}${d.demo ? ' · <span class="badge muted">условная сделка</span>' : ""}</p>
${d.comment ? `<p class="comment">${esc(d.comment)}</p>` : ""}
${d.outcome ? `<p class="refused-note" role="status"><b>Отказ</b> · ${esc(d.outcome_reason)} · ${new Date(d.outcome_at).toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" })}</p>` : ""}
<ol class="stepper">${STAGES.map((s, k) => `<li class="${k < i ? "done" : k === i ? "now" : ""}"><span>${k + 1}</span>${esc(s.title)}</li>`).join("")}</ol>
<div class="dash">
  <section class="panel wide">
    <h2>Стадия: ${esc(st.title)}${st.status === "working" ? "" : ` <span class="badge muted">${STATUS[st.status]}</span>`}</h2>
    <p>${esc(st.summary)}</p>
    ${d.cls ? `<p>Класс кредитоспособности: ${clsBadge(d.cls)}${d.note ? ` <span class="muted small">${esc(d.note)}</span>` : ""}</p>` : d.note ? `<p class="muted">${esc(d.note)}</p>` : ""}
    ${actions.length ? `<div class="actions">${actions.join("")}</div>` : ""}
    ${m.canEdit && d.outcome ? `<form class="move" method="post" action="/deals/${d.id}/reopen"><button type="submit" data-confirm="${esc(`Вернуть сделку «${d.title}» в работу? Она снова появится на стадии «${st.title}» и в счётчиках.`)}">Вернуть в работу</button></form>` : ""}
    ${m.canEdit && !d.outcome && PIPE.includes(d.stage) ? refuseForm(d, stop, m.refuse) : ""}
    ${m.canEdit && !d.outcome ? `<form class="move" method="post" action="/deals/${d.id}/stage">
      ${next ? `<button${stop ? "" : ' class="primary"'} type="submit" formnovalidate name="stage" value="${next.id}">Перевести на стадию «${esc(next.title)}» →</button>` : ""}${events.join("")}
      <label>или выбрать стадию <select name="stage_any" required><option value="">— другая стадия —</option>${STAGES.filter((s) => s.id !== d.stage).map((s) => `<option value="${s.id}">${esc(s.title)}</option>`).join("")}</select></label>
      <button type="submit" name="stage" value="__any" data-confirm="${esc(`Перевести сделку «${d.title}» со стадии «${st.title}» на «{select}»? Это шаг вне обычного порядка стадий; он попадёт в историю и в счётчики главной.`)}">Сменить</button>
    </form>` : ""}
  </section>
  ${d.client_code ? "" : clientBlock(d, m)}
  ${m.canEdit ? editForm(d, m.form) : ""}
  <section class="panel">
    <h2>История</h2>
    <ul class="list hist">${m.events.map((e) => `<li><span>${esc(e.text)}<br><span class="muted small">${new Date(e.at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}${e.user_name || e.user_email ? ` · ${esc(e.user_name || e.user_email)}` : ""}</span></span></li>`).join("")}</ul>
  </section>
</div>`,
  });
}

module.exports = { dashboardPage, dealsBoard, dealPage, ASSETS, REFUSAL_REASONS };
