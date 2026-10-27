// Задачи: блок в карточке сделки, «Мои задачи» на главной, страница «Задачи», отметка на карточке канбана.
const { esc } = require("./http");
const { plural } = require("./format");
const { layout } = require("./views");
const { today, addDays, fmt, status, daysLate } = require("./tasks");

const who = (t) => esc(t.assignee_name || t.assignee_email || "без исполнителя");

// срок задачи словами и цветом: просрочена / сегодня / завтра / дата
function dueBadge(t) {
  const s = status(t);
  if (s === "done") return `<span class="due done">выполнена</span>`;
  if (s === "overdue") { const n = daysLate(t); return `<span class="due overdue">просрочена на ${n} ${plural(n, "день", "дня", "дней")}</span>`; }
  if (s === "today") return `<span class="due today">сегодня</span>`;
  if (s === "soon") return `<span class="due">завтра</span>`;
  return `<span class="due">до ${fmt(t.due)}</span>`;
}

// одна задача; back — куда вернуться после «Выполнено»
function taskItem(t, { canEdit, back, showDeal = false }) {
  const toggle = canEdit ? `<form method="post" action="/tasks/${t.id}/${t.done_at ? "undo" : "done"}" class="inline"><input type="hidden" name="back" value="${esc(back)}"><button type="submit" class="${t.done_at ? "" : "done-btn"}" data-busy-text="…">${t.done_at ? "Вернуть в работу" : "Выполнено"}</button></form>` : "";
  return `<li class="todo ${status(t)}">${dueBadge(t)}<span class="ttext">${esc(t.text)}${showDeal ? ` <span class="muted small">· <a href="/deals/${t.deal_id}">${esc(t.deal_title)}</a></span>` : ""}<br><span class="muted small">${who(t)}</span></span>${toggle}</li>`;
}

// Блок «Задачи» в карточке сделки. m: {tasks, users, user, canEdit, taskForm: {values, errors}}
function dealTasks(d, m) {
  const open = m.tasks.filter((t) => !t.done_at), done = m.tasks.filter((t) => t.done_at);
  const v = m.taskForm?.values || {}, err = m.taskForm?.errors || {};
  const bad = (k, id) => (err[k] ? ` aria-invalid="true" aria-describedby="err-${id}"` : "");
  const msg = (k, id) => (err[k] ? `<span class="ferr" id="err-${id}">${esc(err[k])}</span>` : "");
  const back = `/deals/${d.id}#tasks`;
  const form = m.canEdit && !d.outcome && !d.archived_at ? `<details class="task-add"${m.taskForm ? " open" : ""}><summary>Поставить задачу</summary>
<form method="post" action="/deals/${d.id}/tasks" class="eform" data-draft>
  <label class="wide" for="tk-text">Что сделать<input id="tk-text" name="task_text" maxlength="300" value="${esc(v.task_text || "")}" placeholder="Например: перезвонить, отправить КП, запросить отчётность"${bad("task_text", "tk-text")}>${msg("task_text", "tk-text")}</label>
  <label for="tk-due">Срок<input id="tk-due" name="due" type="date" min="${today()}" value="${esc(v.due || addDays(today(), 1))}"${bad("due", "tk-due")}>${msg("due", "tk-due")}</label>
  <label for="tk-who">Исполнитель<select id="tk-who" name="assignee_id">${m.users.map((u) => `<option value="${u.id}"${String(u.id) === String(v.assignee_id || m.user.id) ? " selected" : ""}>${esc(u.name || u.email)}</option>`).join("")}</select></label>
  <button type="submit" data-busy-text="Ставлю…">Поставить задачу</button>
</form></details>` : "";
  return `<section class="panel wide" id="tasks">
  <h2>Задачи <span class="muted small">${open.length ? `открыто: ${open.length}` : "открытых нет"}</span></h2>
  ${open.length ? `<ul class="todo-list">${open.map((t) => taskItem(t, { canEdit: m.canEdit, back })).join("")}</ul>` : `<p class="muted">Открытых задач нет.${form ? " Поставьте следующий шаг, чтобы сделка не потерялась." : ""}</p>`}
  ${form}
  ${done.length ? `<details class="tasks-done"><summary>Выполненные (${done.length})</summary><ul class="todo-list">${done.map((t) => taskItem(t, { canEdit: m.canEdit, back })).join("")}</ul></details>` : ""}
</section>`;
}

// «Мои задачи» на главной: просроченные и на сегодня — сверху. tasks — открытые задачи пользователя.
function myTasksPanel(tasks, canEdit) {
  const late = tasks.filter((t) => status(t) === "overdue").length, now = tasks.filter((t) => status(t) === "today").length;
  return `<section class="panel wide my-tasks">
  <h2>Мои задачи <span class="muted small">${late ? `<b class="overdue-n">просрочено: ${late}</b> · ` : ""}на сегодня: ${now} · всего открыто: ${tasks.length}</span></h2>
  ${tasks.length ? `<ul class="todo-list">${tasks.slice(0, 6).map((t) => taskItem(t, { canEdit, back: "/", showDeal: true })).join("")}</ul>` : `<p class="muted">Открытых задач нет. Задачи ставятся в карточке сделки или вместе с комментарием о звонке.</p>`}
  <p><a class="btn" href="/tasks">Все задачи →</a></p>
</section>`;
}

// Страница «Задачи». m: {tasks, done, mine, canEdit, userId}
function tasksPage(user, m) {
  const list = m.mine ? m.tasks.filter((t) => t.assignee_id === m.userId) : m.tasks;
  const group = (title, ts, empty) => `<section class="panel wide"><h2>${title} <span class="muted small">${ts.length}</span></h2>${ts.length ? `<ul class="todo-list">${ts.map((t) => taskItem(t, { canEdit: m.canEdit, back: `/tasks${m.mine ? "" : "?all=1"}`, showDeal: true })).join("")}</ul>` : `<p class="muted">${empty}</p>`}</section>`;
  return layout({
    title: "Задачи",
    user,
    active: "tasks",
    body: `<h1>Задачи</h1>
<p class="seg-links"><a href="/tasks"${m.mine ? ' aria-current="page"' : ""}>Мои</a><a href="/tasks?all=1"${m.mine ? "" : ' aria-current="page"'}>Все</a></p>
<div class="dash">
${group("Просрочено", list.filter((t) => status(t) === "overdue"), "Просроченных задач нет.")}
${group("Сегодня", list.filter((t) => status(t) === "today"), "На сегодня задач нет.")}
${group("Дальше", list.filter((t) => ["soon", "later"].includes(status(t))), "Задач на будущие дни нет.")}
${m.done.length ? `<details class="panel wide tasks-done"><summary><h2>Недавно выполненные</h2></summary><ul class="todo-list">${(m.mine ? m.done.filter((t) => t.assignee_id === m.userId) : m.done).map((t) => taskItem(t, { canEdit: m.canEdit, back: "/tasks", showDeal: true })).join("")}</ul></details>` : ""}
</div>`,
  });
}

// отметка на карточке канбана: ближайшая открытая задача
const cardTask = (t) => (t ? `<span class="small ktask ${status(t)}">${status(t) === "overdue" ? "Задача просрочена" : status(t) === "today" ? "Задача на сегодня" : `Задача до ${fmt(t.due)}`}: ${esc(t.text)}</span>` : "");

module.exports = { dealTasks, myTasksPanel, tasksPage, cardTask, dueBadge };
