// Рабочие страницы: дашборд с запуском сделки, канбан сделок по стадиям, карточка сделки.
const { esc } = require("./http");
const STAGES = require("./stages");
const { layout, nf, fdate, clsBadge } = require("./views");

const STATUS = { working: "рабочий модуль", target: "целевая схема", backlog: "бэклог" };
const ASSETS = ["Грузовой транспорт", "Легковой транспорт", "Спецтехника", "Оборудование", "Другое"];
const PIPE = ["application", "assessment", "decision", "contract"]; // до выдачи
const OVERDUE = ["overdue_30", "overdue_30plus"];
const mln = (v) => (v === null || v === undefined ? "—" : `${Number(v).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} млн`);
const sum = (ds) => ds.reduce((s, d) => s + (d.amount_mln || 0), 0);
const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? few : many);
const daysAgo = (t) => Math.max(0, Math.floor((Date.now() - t) / 86400000));
const ago = (t) => { const d = daysAgo(t); return d === 0 ? "сегодня" : `${d} ${plural(d, "день", "дня", "дней")}`; };

function newDealForm() {
  return `<form class="launch" method="post" action="/deals">
  <div class="f"><label for="nd-inn">ИНН клиента</label><input id="nd-inn" name="inn" inputmode="numeric" autocomplete="off" pattern="\\d{10}|\\d{12}" title="10 или 12 цифр" placeholder="необязательно"></div>
  <div class="f"><label for="nd-asset">Предмет лизинга</label><select id="nd-asset" name="asset">${ASSETS.map((a) => `<option>${a}</option>`).join("")}</select></div>
  <div class="f"><label for="nd-amount">Сумма, млн руб.</label><input id="nd-amount" name="amount" inputmode="decimal" placeholder="например, 25"></div>
  <button type="submit">Запустить сделку</button>
</form>
<p class="muted small">Сделка появится в колонке «Заявка». Если указан ИНН, портал сразу проверит клиента (DaData, ГИР БО) и покажет предварительный класс.</p>`;
}

// m: {deals, summary, keyRate, canEdit}
function dashboardPage(user, m) {
  const D = m.deals, s = m.summary, z = s.zones;
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
${m.canEdit ? `<section class="panel launch-panel" id="new"><h2>Новая сделка</h2>${newDealForm()}</section>` : ""}
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
    <ul class="list">${D.slice(0, 5).map((d) => `<li><a href="/deals/${d.id}"><span>${esc(d.title)}<br><span class="muted small">${esc(STAGES.find((st) => st.id === d.stage)?.title || d.stage)} · ${ago(d.updated_at)}</span></span>${d.cls ? clsBadge(d.cls) : ""}</a></li>`).join("")}</ul>
    <h3>Ключевая ставка ЦБ</h3>
    ${kr ? `<p class="big">${kr.rate.toFixed(2).replace(".", ",")} %</p><p class="muted small">действует с ${fdate(kr.since)}${kr.sandbox_note ? " · условное значение" : ""}</p>` : `<p class="muted">Нет данных</p>`}
  </section>
</div>`,
  });
}

function dealCard(d, canEdit) {
  return `<a class="kcard${d.demo ? " demo" : ""}" href="/deals/${d.id}" data-id="${d.id}"${canEdit ? ' draggable="true"' : ""}>
  <b>${esc(d.title)}</b>
  <span class="muted small">${esc(d.asset || "предмет не указан")}${d.amount_mln ? ` · ${mln(d.amount_mln)}` : ""}</span>
  ${d.note ? `<span class="small">${esc(d.note)}</span>` : ""}
  <span class="kmeta">${d.cls ? `${clsBadge(d.cls)} ` : ""}<span class="muted small">${ago(d.updated_at)} на стадии</span>${d.demo ? ' <span class="badge muted">условно</span>' : ""}</span>
</a>`;
}

function dealsBoard(user, m) {
  const cols = STAGES.map((st) => {
    const ds = m.deals.filter((d) => d.stage === st.id);
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
<p class="status" id="kstatus" role="status"></p>
${m.canEdit ? `<script>
(() => {
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

// m: {deal, events, canEdit}
function dealPage(user, m) {
  const d = m.deal;
  const i = STAGES.findIndex((s) => s.id === d.stage);
  const next = STAGES[i + 1];
  const actions = [];
  if (["application", "assessment", "decision"].includes(d.stage)) {
    if (d.inn) actions.push(`<a class="btn${d.stage !== "application" ? "" : " primary"}" href="/check?inn=${esc(d.inn)}">Проверка по ИНН</a>`);
    actions.push(`<a class="btn${d.stage === "assessment" ? " primary" : ""}" href="/calc#upload">Расчёт класса по отчётности (PDF)</a>`);
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
<p class="muted">${d.inn ? `ИНН ${esc(d.inn)} · ` : ""}${esc(d.asset || "предмет не указан")}${d.amount_mln ? ` · ${mln(d.amount_mln)} руб.` : ""}${d.demo ? ' · <span class="badge muted">условная сделка</span>' : ""}</p>
<ol class="stepper">${STAGES.map((s, k) => `<li class="${k < i ? "done" : k === i ? "now" : ""}"><span>${k + 1}</span>${esc(s.title)}</li>`).join("")}</ol>
<div class="dash">
  <section class="panel wide">
    <h2>Стадия: ${esc(st.title)}${st.status === "working" ? "" : ` <span class="badge muted">${STATUS[st.status]}</span>`}</h2>
    <p>${esc(st.summary)}</p>
    ${d.cls ? `<p>Класс кредитоспособности: ${clsBadge(d.cls)}${d.note ? ` <span class="muted small">${esc(d.note)}</span>` : ""}</p>` : d.note ? `<p class="muted">${esc(d.note)}</p>` : ""}
    ${actions.length ? `<div class="actions">${actions.join("")}</div>` : ""}
    ${m.canEdit ? `<form class="move" method="post" action="/deals/${d.id}/stage">
      ${next ? `<button type="submit" name="stage" value="${next.id}">Перевести на стадию «${esc(next.title)}» →</button>` : ""}
      <label>или выбрать стадию <select name="stage_any">${STAGES.map((s) => `<option value="${s.id}"${s.id === d.stage ? " selected" : ""}>${esc(s.title)}</option>`).join("")}</select></label>
      <button type="submit" name="stage" value="__any">Сменить</button>
    </form>` : ""}
  </section>
  <section class="panel">
    <h2>История</h2>
    <ul class="list hist">${m.events.map((e) => `<li><span>${esc(e.text)}<br><span class="muted small">${new Date(e.at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}${e.user_name || e.user_email ? ` · ${esc(e.user_name || e.user_email)}` : ""}</span></span></li>`).join("")}</ul>
  </section>
</div>`,
  });
}

module.exports = { dashboardPage, dealsBoard, dealPage, ASSETS };
