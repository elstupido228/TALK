// Рабочие страницы: дашборд с запуском сделки, канбан сделок по стадиям, карточка сделки.
const crypto = require("node:crypto");
const { esc } = require("./http");
const STAGES = require("./stages");
const { layout, nf, fdate, clsBadge } = require("./views");
const VT = require("./views-tasks");
const VL = require("./views-list");
const { today } = require("./tasks");

const STATUS = { working: "рабочий модуль", target: "целевая схема", backlog: "бэклог" };
const ASSETS = ["Грузовой транспорт", "Легковой транспорт", "Спецтехника", "Оборудование", "Другое"];
const PIPE = ["application", "assessment", "decision", "contract"]; // до выдачи
const OVERDUE = ["overdue_30", "overdue_30plus"];
const FORWARD = [...PIPE, "monitoring"]; // обычный ход сделки; просрочка — не «следующий шаг», а событие
const REFUSAL_REASONS = ["Стоп-фактор: класс 3 на всех четырёх датах", "Клиент не прошёл проверку", "Клиент отказался", "Не устроили условия", "Другое"];
const active = (ds) => ds.filter((d) => !d.outcome && !d.archived_at);
const mln = (v) => (v === null || v === undefined ? "—" : `${Number(v).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} млн`);
const sum = (ds) => ds.reduce((s, d) => s + (d.amount_mln || 0), 0);
const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? few : many);
const daysAgo = (t) => Math.max(0, Math.floor((Date.now() - t) / 86400000));
const ago = (t) => { const d = daysAgo(t); return d === 0 ? "сегодня" : `${d} ${plural(d, "день", "дня", "дней")}`; };

// Ошибка у поля: подсветка, текст под полем и связь текста с полем для экранного диктора
const fieldErr = (errors = {}) => ({
  bad: (k, id) => (errors[k] ? ` aria-invalid="true" aria-describedby="err-${id}"` : ""),
  msg: (k, id) => (errors[k] ? `<span class="ferr" id="err-${id}">${esc(errors[k])}</span>` : ""),
});

// form: {values, errors: {поле: текст}, error, dups} — после неудачной отправки
function newDealForm(form = {}) {
  const v = form.values || {}, E = fieldErr(form.errors);
  // дубль по ИНН: ссылки на сделки и кнопка внутри формы — введённые значения уходят вместе с подтверждением.
  // Блок стоит после «Запустить сделку»: Enter в поле отправляет форму основной кнопкой, а не подтверждением дубля
  const dups = form.dups?.length ? `<div class="notice dups" role="alert"><p>${form.byInn === false ? "У клиента с таким наименованием" : `По ИНН ${esc(v.inn)}`} уже есть сделки в работе: ${form.dups.map((d) => `<a href="/deals/${d.id}">${esc(d.title)}</a> (${esc(STAGES.find((s) => s.id === d.stage)?.title || d.stage)}${d.amount_mln ? `, ${mln(d.amount_mln)}` : ""})`).join("; ")}.</p><p>Откройте нужную сделку или создайте ещё одну, если это новая заявка того же клиента.</p><button type="submit" name="dup_ok" value="1">Всё равно создать новую сделку</button></div>` : "";
  const field = (k, id, label, attrs) => `<div class="f"><label for="${id}">${label}</label><input id="${id}" name="${k}"${attrs} value="${esc(v[k] || "")}"${E.bad(k, id)}>${E.msg(k, id)}</div>`;
  return `${form.error && !dups ? `<p class="error" role="alert">${esc(form.error)}</p>` : ""}<form class="launch" method="post" action="/deals" data-draft>
  <input type="hidden" name="once" value="${esc(/^[\w-]{16,64}$/.test(v.once || "") ? v.once : crypto.randomUUID())}">
  ${field("inn", "nd-inn", "ИНН клиента", ' inputmode="numeric" autocomplete="off" placeholder="если известен"')}
  ${field("client_name", "nd-name", "Наименование клиента", ' autocomplete="organization" placeholder="при ИНН — из DaData"')}
  ${field("contact_name", "nd-contact", "Контактное лицо", ' autocomplete="name" placeholder="необязательно"')}
  ${field("phone", "nd-phone", "Телефон", ' type="tel" inputmode="tel" autocomplete="tel" placeholder="необязательно"')}
  <div class="f"><label for="nd-asset">Предмет лизинга</label><select id="nd-asset" name="asset"${E.bad("asset", "nd-asset")}><option value="">— выберите —</option>${ASSETS.map((a) => `<option${a === v.asset ? " selected" : ""}>${a}</option>`).join("")}</select>${E.msg("asset", "nd-asset")}</div>
  ${field("amount", "nd-amount", "Сумма, млн руб.", ' inputmode="decimal" placeholder="например, 25"')}
  <button type="submit" data-busy-text="Создаю сделку…">Запустить сделку</button>${dups}
</form>
<p class="muted small">Сделка появится в колонке «Заявка». Достаточно ИНН, наименования клиента или предмета лизинга. По ИНН портал сразу проверит клиента (DaData, ГИР БО) и покажет предварительный класс.</p>`;
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
${m.canEdit || m.myTasks?.length ? VT.myTasksPanel(m.myTasks || [], m.canEdit) : ""}
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
    <ul class="list">${m.deals.slice(0, 5).map((d) => `<li><a href="/deals/${d.id}"><span>${esc(d.title)}<br><span class="muted small">${d.archived_at ? "Архив" : d.outcome ? "Отказ" : esc(STAGES.find((st) => st.id === d.stage)?.title || d.stage)} · ${ago(d.updated_at)}</span></span>${d.cls ? clsBadge(d.cls) : ""}</a></li>`).join("")}</ul>
    <h3>Ключевая ставка ЦБ</h3>
    ${kr ? `<p class="big">${kr.rate.toFixed(2).replace(".", ",")} %</p><p class="muted small">действует с ${fdate(kr.since)}${kr.sandbox_note ? " · условное значение" : ""}</p>` : `<p class="muted">Нет данных</p>`}
  </section>
</div>`,
  });
}

function dealCard(d, canEdit, task) {
  return `<a class="kcard${d.demo ? " demo" : ""}" href="/deals/${d.id}" data-id="${d.id}"${canEdit && !d.outcome ? ' draggable="true"' : ""}>
  <b>${esc(d.title)}</b>
  <span class="muted small">${esc(d.asset || "предмет не указан")}${d.amount_mln ? ` · ${mln(d.amount_mln)}` : ""}</span>
  ${d.owner_name || d.owner_email ? `<span class="muted small kowner">${esc(d.owner_name || d.owner_email)}</span>` : ""}
  ${d.outcome ? `<span class="small refused-reason">Отказ: ${esc(d.outcome_reason)}</span>` : d.note ? `<span class="small">${esc(d.note)}</span>` : ""}
  ${VT.cardTask(task)}
  <span class="kmeta">${d.cls ? `${clsBadge(d.cls)} ` : ""}<span class="muted small">${d.outcome ? `отказ: ${ago(d.outcome_at)}` : `${ago(d.stage_at || d.created_at)} на стадии`}</span>${d.demo ? ' <span class="badge muted">условно</span>' : ""}</span>
</a>`;
}

function dealsBoard(user, m) {
  const live = active(m.deals), refused = m.deals.filter((d) => d.outcome && !d.archived_at);
  const cols = STAGES.map((st) => {
    const ds = live.filter((d) => d.stage === st.id);
    return `<section class="kcol ${st.status}" id="${st.id}" data-stage="${st.id}">
  <header><h2>${esc(st.title)}</h2><span class="muted small">${ds.length}${ds.length ? ` · ${mln(sum(ds))}` : ""}</span>${st.status === "working" ? "" : `<span class="badge muted">${STATUS[st.status]}</span>`}</header>
  <div class="kdrop">${ds.map((d) => dealCard(d, m.canEdit, m.nextTasks?.get(d.id))).join("") || '<p class="kempty muted small">Нет сделок</p>'}</div>
</section>`;
  }).join("");
  return layout({
    title: "Сделки",
    user,
    active: "deals",
    body: `<div class="head-row"><h1>Сделки</h1>${m.canEdit ? '<a class="btn primary" href="/#new">Новая сделка</a>' : ""}</div>
${m.f ? VL.filterBar("board", m.f, m.users || [], m.total, m.deals.length) : ""}
<p class="muted small">${m.canEdit ? "Перетащите карточку в другую колонку, чтобы сменить стадию, или откройте сделку." : "Просмотр: менять стадии могут администратор, команда проекта и ТАЛК."} Условные сделки связаны с демо-данными калькулятора и мониторинга.</p>
<p class="status" id="kstatus" role="status"></p>
<div class="board" id="board">${cols}</div>
${refused.length ? `<details class="panel refused-list"><summary><h2>Отказы</h2><span class="muted small">${refused.length} · ${mln(sum(refused))}</span></summary><div class="kgrid">${refused.map((d) => dealCard(d, false)).join("")}</div></details>` : ""}
<script>
(() => {
  // Ссылка на колонку (#стадия, плитки главной) — к колонке; иначе — то место доски и страницы, где пользователь
  // был до перехода в карточку (до конца сеанса вкладки)
  const board = document.getElementById("board"), KEY = "talk-board-scroll";
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ inline: "start", block: "nearest" });
  else try { const s = JSON.parse(sessionStorage.getItem(KEY) || "null"); if (s) { board.scrollLeft = s.x; scrollTo(0, s.y); } } catch (e) {}
  const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify({ x: board.scrollLeft, y: scrollY })); } catch (e) {} };
  board.addEventListener("scroll", save, { passive: true });
  addEventListener("scroll", save, { passive: true });
  addEventListener("pagehide", save);
})();
</script>
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
      const st = document.getElementById("kstatus"); st.className = "status"; st.textContent = "Сохраняю…";
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 15000);
      try {
        const r = await fetch("/api/deals/" + id + "/stage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: col.dataset.stage }), signal: ctl.signal });
        if (r.ok) return location.reload();
        st.textContent = "Не удалось сменить стадию: " + ((await r.json().catch(() => ({}))).error?.message || "ошибка сервера " + r.status) + ". Карточка осталась на месте.";
      } catch (err) {
        st.textContent = (err.name === "AbortError" ? "Сервер не ответил за 15 с" : "Нет связи с сервером") + " — стадия не изменена, карточка осталась на месте. Повторите, когда связь появится.";
      } finally { clearTimeout(timer); }
      st.className = "status err";
    });
  });
})();
</script>` : ""}`,
  });
}

// Клиент сделки под заголовком: ссылка на карточку клиента и контакты (звонок — в одно касание)
function clientLine(c, canEdit) {
  if (!c) return `<p class="client-line muted">Клиент не указан.${canEdit ? " Укажите ИНН или наименование в разделе «Данные сделки»." : ""}</p>`;
  const tel = c.phone ? ` · <a href="tel:${esc(c.phone.replace(/[^\d+]/g, ""))}">${esc(c.phone)}</a>` : "";
  return `<p class="client-line">Клиент: <a href="/clients/${c.id}">${esc(c.name)}</a>${c.contact_name ? ` · ${esc(c.contact_name)}` : ""}${tel}${!c.contact_name && !c.phone && canEdit ? ` · <a href="/clients/${c.id}">добавить контакт</a>` : ""}</p>`;
}

// Документы сделки: список (открыть, убрать из карточки), загрузка нескольких файлов, расчёт класса по PDF сделки.
// Загрузка — fetch с телом-файлом по одному (без multipart); после последнего — перезагрузка с сообщением.
function docsBlock(d, m, ed) {
  const size = (n) => (n >= 1048576 ? `${(n / 1048576).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`);
  const pdfs = m.files.filter((f) => f.mime === "application/pdf").length;
  const rows = m.files.map((f) => `<li><a href="/files/${f.id}" target="_blank" rel="noopener">${esc(f.name)}</a> <span class="muted small">${size(f.size)} · ${new Date(f.at).toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" })} · ${esc(f.user_name || f.user_email || "—")}</span>${ed ? `<form method="post" action="/files/${f.id}/delete" class="inline"><button type="submit" class="link-danger" data-confirm="${esc(`Убрать файл «${f.name}» из карточки сделки? Запись об этом останется в ленте.`)}">убрать</button></form>` : ""}</li>`).join("");
  return `<section class="panel wide" id="docs">
  <h2>Документы <span class="muted small">${m.files.length ? `файлов: ${m.files.length}` : "нет"}</span></h2>
  ${rows ? `<ul class="plain docs">${rows}</ul>` : `<p class="muted">Документов нет.${ed ? " Добавьте отчётность клиента (PDF), договор, сканы — они будут здесь при каждом открытии сделки." : ""}</p>`}
  <p class="actions">${ed ? `<label class="btn" for="up-${d.id}">Добавить файлы</label><input type="file" id="up-${d.id}" multiple hidden accept=".pdf,.xlsx,.xls,.docx,.doc,.jpg,.jpeg,.png">` : ""}${pdfs ? `<a class="btn" href="/calc#deal=${d.id}">Рассчитать класс по PDF сделки (${pdfs})</a>` : ""}</p>
  ${ed ? `<p class="status" id="up-status" role="status"></p>
<script>
(() => {
  const input = document.getElementById("up-${d.id}"), st = document.getElementById("up-status");
  input.addEventListener("change", async () => {
    const list = [...input.files];
    for (let i = 0; i < list.length; i++) {
      st.className = "status"; st.textContent = "Загрузка " + (i + 1) + " из " + list.length + ": «" + list[i].name + "»…";
      try {
        const r = await fetch("/deals/${d.id}/files", { method: "POST", headers: { "x-file-name": encodeURIComponent(list[i].name) }, body: list[i] });
        if (!r.ok) { st.className = "status err"; st.textContent = "«" + list[i].name + "» не загружен: " + ((await r.json().catch(() => ({}))).error?.message || "ошибка " + r.status); input.value = ""; return; }
      } catch (e) { st.className = "status err"; st.textContent = "Нет связи с сервером — «" + list[i].name + "» не загружен. Повторите."; input.value = ""; return; }
    }
    location.hash = "docs"; location.reload();
  });
})();
</script>` : ""}
</section>`;
}

// Архив — внизу карточки, отдельно от частых действий; перенос с подтверждением, возврат — без
function archiveZone(d) {
  return d.archived_at
    ? `<section class="panel wide archive-zone"><form method="post" action="/deals/${d.id}/unarchive" class="inline-form"><span>Сделка в архиве.</span><button type="submit" class="primary-btn">Вернуть из архива</button></form></section>`
    : `<section class="panel wide archive-zone"><form method="post" action="/deals/${d.id}/archive" class="inline-form"><span class="muted">Создана по ошибке или больше не нужна?</span><button type="submit" class="danger" data-confirm="${esc(`Перенести сделку «${d.title}» в архив? Она пропадёт с канбана, из списка «В работе» и счётчиков; задачи по ней скроются. Вернуть: «Сделки» → «Список» → «Архив» → открыть сделку → «Вернуть из архива».`)}">В архив</button></form></section>`;
}

// Ответственный за сделку; передача другому — с подтверждением, с именем нового ответственного
function ownerLine(d, m) {
  const name = d.owner_name || d.owner_email;
  const others = (m.users || []).filter((u) => u.id !== d.owner_id);
  const form = m.canEdit && others.length ? `<details class="owner-pass"><summary>передать</summary><form method="post" action="/deals/${d.id}/owner" class="inline-form">
  <label class="sr" for="ow-to">Новый ответственный</label><select id="ow-to" name="owner_id" required><option value="">— кому —</option>${others.map((u) => `<option value="${u.id}">${esc(u.name || u.email)}</option>`).join("")}</select>
  <button type="submit" data-confirm="${esc(`Передать сделку «${d.title}» сотруднику «{select}»? Он станет ответственным; запись появится в ленте.`)}">Передать</button>
</form></details>` : "";
  return `<div class="owner-line">Ответственный: <b>${name ? esc(name) : "не назначен"}</b>${form}</div>`;
}

// Клиент в карточке сделки: DaData и годовая отчётность (ГИР БО) с классом по годам
function clientBlock(d, m) {
  if (!d.inn) return `<section class="panel"><h2>Клиент</h2><p class="muted">ИНН ещё не указан.${m.canEdit ? " Укажите его в разделе «Данные сделки» — портал проверит клиента." : ""}</p></section>`;
  const c = m.client || {};
  const p = c.party?.data, f = c.fin?.data;
  const down = [!c.party && "DaData", !c.fin && "ГИР БО"].filter(Boolean);
  const recheck = m.canEdit ? `<form method="post" action="/deals/${d.id}/recheck" class="inline"><button type="submit" data-busy-text="Проверяю…">Проверить снова</button></form>` : "";
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
${down.length ? `<p class="notice">${down.length > 1 ? "Источники" : "Источник"} ${down.map((s) => `«${s}»`).join(" и ")} ${down.length > 1 ? "недоступны" : "недоступен"} — сведения ниже неполные (<a href="/sources">состояние источников</a>). ${recheck}</p>` : ""}
${org}${fin}
<p class="actions"><a class="btn" href="/check?inn=${esc(d.inn)}&amp;deal=${d.id}">Полная проверка по ИНН</a>${down.length ? "" : recheck}</p>
</section>`;
}

// form: {values, errors, conflict: {fields: [{label, key, theirs, mine}], by, at}} — после неудачной отправки.
// orig — значения сделки на момент показа формы: по ним сервер узнаёт чужую правку (см. server.js).
function editForm(d, form = {}) {
  const v = form.values || { inn: d.inn, asset: d.asset, amount: d.amount_mln, term: d.term_months, comment: d.comment };
  const E = fieldErr(form.errors), c = form.conflict;
  const show = (k, x) => (x === null || x === undefined || x === "" ? "—" : k === "amount_mln" ? mln(x) : k === "term_months" ? `${x} мес.` : k === "comment" ? `«${esc(String(x).slice(0, 80))}»` : esc(x));
  const orig = { inn: d.inn, asset: d.asset, amount_mln: d.amount_mln, term_months: d.term_months, comment: d.comment };
  return `<details class="panel edit"${form.errors || c ? " open" : ""}><summary><h2>Данные сделки</h2><span class="muted small">изменить</span></summary>
${c ? `<div class="notice" role="alert"><p>Пока вы редактировали, сделку изменил ${esc(c.by)}${c.at ? ` (${new Date(c.at).toLocaleTimeString("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit" })})` : ""}. Ваши значения не сохранены:</p><ul>${c.fields.map((f) => `<li>${esc(f.label)}: сейчас в сделке ${show(f.key, f.theirs)}, у вас ${show(f.key, f.mine)}</li>`).join("")}</ul><p>Проверьте форму и нажмите «Сохранить» ещё раз — сохранятся значения из формы.</p></div>` : ""}
<form method="post" action="/deals/${d.id}/edit" class="eform" data-draft>
  <input type="hidden" name="orig" value="${esc(JSON.stringify(orig))}">
  <label for="ed-inn">ИНН клиента<input id="ed-inn" name="inn" inputmode="numeric" autocomplete="off" value="${esc(v.inn ?? "")}"${E.bad("inn", "ed-inn")}>${E.msg("inn", "ed-inn")}</label>
  ${d.client_id ? "" : `<label for="ed-name">Наименование клиента<input id="ed-name" name="client_name" autocomplete="organization" value="${esc(v.client_name ?? "")}" placeholder="если ИНН нет"></label>`}
  <label>Предмет лизинга<select name="asset"><option value="">не указан</option>${ASSETS.map((a) => `<option${a === v.asset ? " selected" : ""}>${a}</option>`).join("")}</select></label>
  <label for="ed-amount">Сумма, млн руб.<input id="ed-amount" name="amount" inputmode="decimal" value="${esc(v.amount ?? "")}"${E.bad("amount", "ed-amount")}>${E.msg("amount", "ed-amount")}</label>
  <label for="ed-term">Срок, мес.<input id="ed-term" name="term" inputmode="numeric" value="${esc(v.term ?? "")}"${E.bad("term", "ed-term")}>${E.msg("term", "ed-term")}</label>
  <label class="wide">Примечание к сделке (видно под заголовком; звонки и договорённости — в ленте)<textarea name="comment" rows="2" maxlength="500">${esc(v.comment ?? "")}</textarea></label>
  <p class="muted small wide">При смене ИНН клиент будет проверен заново. Все изменения попадают в историю.</p>
  <button type="submit" data-busy-text="Сохраняю…">Сохранить</button>
</form></details>`;
}

// Лента сделки: комментарии (результаты звонков, договорённости) и служебные записи — изменения, стадии, проверки.
// Новые сверху; комментарий выделен, у каждой записи — время и автор. m.feed: {error} после пустой отправки.
function feed(d, m) {
  const when = (t) => new Date(t).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const who = (e) => esc(e.user_name || e.user_email || "система");
  const nComments = m.events.filter((e) => e.kind === "comment").length;
  return `<section class="panel wide" id="feed">
  <h2>Лента <span class="muted small">${nComments ? `комментариев: ${nComments} · ` : ""}записей: ${m.events.length}</span></h2>
  ${m.canEdit && !d.archived_at ? `<form class="comment-form" method="post" action="/deals/${d.id}/comment" data-draft>
    ${m.feed?.error ? `<p class="error" role="alert">${esc(m.feed.error)}</p>` : ""}
    <label class="sr" for="cm-text">Комментарий</label><textarea id="cm-text" name="text" rows="2" maxlength="2000" placeholder="Результат звонка, договорённости, следующий шаг"${m.feed?.error ? ' aria-invalid="true"' : ""}>${esc(m.feed?.values?.text || "")}</textarea>
    <div class="comment-row"><label for="cm-next">Следующий контакт <span class="muted small">(необязательно — станет задачей)</span><input id="cm-next" name="next_due" type="date" min="${today()}" value="${esc(m.feed?.values?.next_due || "")}"></label>
    <button type="submit" data-busy-text="Добавляю…">Добавить комментарий</button></div>
  </form>` : ""}
  <ul class="feed">${m.events.map((e) => `<li class="${e.kind === "task" ? "taskrec" : e.kind || "sys"}"><p>${esc(e.text)}</p><span class="muted small">${when(e.at)} · ${who(e)}</span></li>`).join("")}</ul>
</section>`;
}

// Отказ: при стоп-факторе — главное действие стадии (форма раскрыта), иначе — свёрнутая форма.
// form: {values, error} — после неудачной отправки
function refuseForm(d, stop, form = {}) {
  const v = form.values || (stop ? { reason: REFUSAL_REASONS[0] } : {});
  const body = `${form.error ? `<p class="error" role="alert">${esc(form.error)}</p>` : ""}<form method="post" action="/deals/${d.id}/refuse" class="eform" data-draft>
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
  const ed = m.canEdit && !d.archived_at; // сделка в архиве — только просмотр и возврат
  // инструменты стадии — второстепенные; главная кнопка одна: «Перевести на стадию …» (или «Оформить отказ» при
  // стоп-факторе), а после выдачи, где перехода «дальше» нет, — карточка клиента в мониторинге
  const actions = [];
  if (["application", "assessment", "decision"].includes(d.stage)) {
    if (d.inn) actions.push(`<a class="btn" href="/check?inn=${esc(d.inn)}&amp;deal=${d.id}">Проверка по ИНН</a>`);
    actions.push(`<a class="btn" href="/calc#deal=${d.id}">Расчёт класса по отчётности (PDF)</a>`);
  }
  if (d.client_code) actions.push(`<a class="btn${PIPE.includes(d.stage) ? "" : " primary"}" href="/monitoring?deal=${d.id}#card=${encodeURIComponent(d.client_code)}">Карточка клиента в мониторинге</a>`);
  if (d.stage === "monitoring" && !d.client_code) actions.push(`<a class="btn" href="/monitoring">Мониторинг портфеля</a>`);
  const st = STAGES[i];
  return layout({
    title: d.title,
    user,
    active: "deals",
    body: `<p class="crumbs"><a href="/deals">Сделки</a> / ${esc(d.title)}</p>
<h1>${esc(d.title)}</h1>
${clientLine(m.clientRec, m.canEdit)}
${ownerLine(d, m)}
<p class="muted">${d.inn ? `ИНН ${esc(d.inn)} · ` : ""}${esc(d.asset || "предмет не указан")}${d.amount_mln ? ` · ${mln(d.amount_mln)} руб.` : ""}${d.term_months ? ` · ${d.term_months} мес.` : ""}${d.demo ? ' · <span class="badge muted">условная сделка</span>' : ""}</p>
${d.comment ? `<p class="comment">${esc(d.comment)}</p>` : ""}
${d.archived_at ? `<p class="archived-note" role="status"><b>В архиве</b> с ${new Date(d.archived_at).toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" })}: сделка не видна на канбане, в списке «В работе» и в счётчиках.</p>` : ""}
${d.outcome ? `<p class="refused-note" role="status"><b>Отказ</b> · ${esc(d.outcome_reason)} · ${new Date(d.outcome_at).toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" })}</p>` : ""}
<ol class="stepper">${STAGES.map((s, k) => `<li class="${k < i ? "done" : k === i ? "now" : ""}"><span>${k + 1}</span>${esc(s.title)}</li>`).join("")}</ol>
<div class="dash">
  <section class="panel wide">
    <h2>Стадия: ${esc(st.title)}${st.status === "working" ? "" : ` <span class="badge muted">${STATUS[st.status]}</span>`}</h2>
    <p>${esc(st.summary)}</p>
    ${d.cls ? `<p>Класс кредитоспособности: ${clsBadge(d.cls)}${d.note ? ` <span class="muted small">${esc(d.note)}</span>` : ""}</p>` : d.note ? `<p class="muted">${esc(d.note)}</p>` : ""}
    ${actions.length ? `<div class="actions">${actions.join("")}</div>` : ""}
    ${ed && d.outcome ? `<form class="move" method="post" action="/deals/${d.id}/reopen"><button type="submit" data-confirm="${esc(`Вернуть сделку «${d.title}» в работу? Она снова появится на стадии «${st.title}» и в счётчиках.`)}">Вернуть в работу</button></form>` : ""}
    ${ed && !d.outcome && PIPE.includes(d.stage) ? refuseForm(d, stop, m.refuse) : ""}
    ${ed && !d.outcome ? `<form class="move" method="post" action="/deals/${d.id}/stage">
      ${next ? `<button${stop ? "" : ' class="primary"'} type="submit" formnovalidate name="stage" value="${next.id}">Перевести на стадию «${esc(next.title)}» →</button>` : ""}${events.join("")}
      <label>или выбрать стадию <select name="stage_any" required><option value="">— другая стадия —</option>${STAGES.filter((s) => s.id !== d.stage).map((s) => `<option value="${s.id}">${esc(s.title)}</option>`).join("")}</select></label>
      <button type="submit" name="stage" value="__any" data-confirm="${esc(`Перевести сделку «${d.title}» со стадии «${st.title}» на «{select}»? Это шаг вне обычного порядка стадий; он попадёт в историю и в счётчики главной.`)}">Сменить</button>
    </form>` : ""}
  </section>
  ${m.tasks ? VT.dealTasks(d, m) : ""}
  ${feed(d, m)}
  ${m.files ? docsBlock(d, m, ed) : ""}
  ${d.client_code ? "" : clientBlock(d, m)}
  ${ed ? editForm(d, m.form) : ""}
  ${m.canEdit ? archiveZone(d) : ""}
</div>`,
  });
}

module.exports = { dashboardPage, dealsBoard, dealPage, ASSETS, REFUSAL_REASONS };
