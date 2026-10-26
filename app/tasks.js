// Задачи по сделкам: текст, срок (дата), исполнитель, отметка о выполнении.
// Постановка и выполнение попадают в ленту сделки. «Сегодня» — по московскому времени.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY,
  deal_id     INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  due         TEXT NOT NULL,
  assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  done_at     INTEGER,
  done_by     INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS tasks_deal ON tasks(deal_id);
CREATE INDEX IF NOT EXISTS tasks_open ON tasks(done_at, assignee_id, due);
`;

const today = (t = Date.now()) => new Date(t).toLocaleDateString("sv-SE", { timeZone: "Europe/Moscow" });
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const fmt = (iso) => iso.split("-").reverse().join(".");
// срок относительно сегодня: overdue / today / soon (завтра) / later
const status = (t, now = today()) => (t.done_at ? "done" : t.due < now ? "overdue" : t.due === now ? "today" : t.due === addDays(now, 1) ? "soon" : "later");
const daysLate = (t, now = today()) => Math.round((new Date(now) - new Date(t.due)) / 86400000);

function createTasks(db, deals) {
  db.exec(SCHEMA);
  const SEL = `SELECT t.*, d.title deal_title, d.stage deal_stage, u.name assignee_name, u.email assignee_email
    FROM tasks t JOIN deals d ON d.id = t.deal_id LEFT JOIN users u ON u.id = t.assignee_id`;
  const q = {
    insert: db.prepare("INSERT INTO tasks (deal_id, text, due, assignee_id, created_by, created_at) VALUES (?,?,?,?,?,?)"),
    get: db.prepare(`${SEL} WHERE t.id = ?`),
    byDeal: db.prepare(`${SEL} WHERE t.deal_id = ? ORDER BY t.done_at IS NOT NULL, t.due, t.id`),
    open: db.prepare(`${SEL} WHERE t.done_at IS NULL AND d.outcome IS NULL ORDER BY t.due, t.id`),
    done: db.prepare(`${SEL} WHERE t.done_at IS NOT NULL ORDER BY t.done_at DESC LIMIT 50`),
    setDone: db.prepare("UPDATE tasks SET done_at = ?, done_by = ? WHERE id = ?"),
    dueCount: db.prepare("SELECT count(*) n FROM tasks t JOIN deals d ON d.id = t.deal_id WHERE t.done_at IS NULL AND d.outcome IS NULL AND t.assignee_id = ? AND t.due <= ?"),
  };
  const who = (t) => t.assignee_name || t.assignee_email || "без исполнителя";

  // Проверка полей: {text, due, assignee_id}. Ошибки — все сразу {status: 400, errors}.
  function fields(f, users) {
    const errors = {};
    const text = String(f.task_text ?? f.text ?? "").trim().slice(0, 300);
    if (!text) errors.task_text = "Что нужно сделать?";
    const due = String(f.due || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(Date.parse(due))) errors.due = "Укажите срок — дату.";
    else if (due < addDays(today(), -1)) errors.due = "Срок в прошлом: укажите сегодняшнюю или будущую дату.";
    const assignee = f.assignee_id ? users.find((u) => String(u.id) === String(f.assignee_id)) : null;
    if (f.assignee_id && !assignee) errors.assignee_id = "Выберите исполнителя из списка.";
    if (Object.keys(errors).length) throw Object.assign(new Error(Object.values(errors).join(" ")), { status: 400, errors });
    return { text, due, assignee_id: assignee?.id ?? null };
  }

  return {
    fields,
    add(dealId, { text, due, assignee_id }, userId) {
      const id = Number(q.insert.run(dealId, text, due, assignee_id, userId, Date.now()).lastInsertRowid);
      const t = q.get.get(id);
      deals.note(dealId, userId, `Задача до ${fmt(due)} (${who(t)}): ${text}`, "task");
      return t;
    },
    setDone(id, userId, done = true) {
      const t = q.get.get(id);
      if (!t || !!t.done_at === done) return t;
      q.setDone.run(done ? Date.now() : null, done ? userId : null, id);
      deals.note(t.deal_id, userId, `${done ? "Задача выполнена" : "Задача снова открыта"}: ${t.text}`);
      return q.get.get(id);
    },
    get: (id) => q.get.get(id) || null,
    byDeal: (dealId) => q.byDeal.all(dealId),
    open: () => q.open.all(),
    recentDone: () => q.done.all(),
    dueCount: (userId) => q.dueCount.get(userId, today()).n,
  };
}

module.exports = { createTasks, today, addDays, fmt, status, daysLate };
