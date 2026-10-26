// Сделки: карточки канбана по стадиям жизненного цикла (app/stages.js), история переходов.
// При первом запуске — условные сделки, связанные с демо-данными портала: пакеты A/B/C калькулятора на ранних
// стадиях, клиенты условного портфеля мониторинга — на стадиях мониторинга и просрочки. Все помечены demo = 1.
const STAGES = require("./stages");

const STAGE_IDS = STAGES.map((s) => s.id);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS deals (
  id          INTEGER PRIMARY KEY,
  title       TEXT NOT NULL,
  inn         TEXT,
  client_code TEXT,
  asset       TEXT,
  amount_mln  REAL,
  term_months INTEGER,
  comment     TEXT,
  stage       TEXT NOT NULL,
  cls         INTEGER,
  note        TEXT,
  demo        INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS deal_events (
  id         INTEGER PRIMARY KEY,
  deal_id    INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  at         INTEGER NOT NULL,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  from_stage TEXT,
  to_stage   TEXT,
  text       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deal_events_deal ON deal_events(deal_id, at);
`;

const DAY = 24 * 3600 * 1000;

// Условные сделки. portfolio — сводка мониторинга ({clients:[{client, sector, zone, score, dpd, status, exposure, asset}]})
function demoDeals(portfolio) {
  const now = Date.now();
  const pick = (f, n) => portfolio.clients.filter(f).slice(0, n);
  const early = [
    { title: "ООО «Пример-Логистик»", asset: "Грузовой транспорт", amount_mln: 18.5, stage: "application", note: "Заявка с сайта, ИНН ещё не указан", ago: 1 },
    { title: "ООО «Пример-Агро»", asset: "Спецтехника", amount_mln: 42, stage: "application", note: "Заявка от партнёра-дилера, ИНН ещё не указан", ago: 2 },
    { title: "ООО «Гамма-Пример»", inn: "0000000003", asset: "Оборудование", amount_mln: 12, stage: "assessment", cls: 3, note: "Класс 3 на всех четырёх датах — п. 14.1.6", stop_factor: "Класс 3 на всех четырёх датах — п. 14.1.6", ago: 3 },
    { title: "ООО «Бета-Пример»", inn: "0000000002", asset: "Грузовой транспорт", amount_mln: 25, stage: "assessment", cls: 2, ago: 4 },
    { title: "ООО «Альфа-Пример»", inn: "0000000001", asset: "Спецтехника", amount_mln: 60, stage: "decision", cls: 1, ago: 6 },
    { title: "ООО «Пример-Строй»", asset: "Спецтехника", amount_mln: 33, stage: "contract", cls: 2, note: "Решение принято, договор на подписании", ago: 12 },
  ];
  const late = [
    ...pick((c) => c.status === "оценивается" && c.zone === "red", 2),
    ...pick((c) => c.status === "оценивается" && c.zone === "yellow", 1),
    ...pick((c) => c.status === "оценивается" && c.zone === "green", 1),
  ].map((c) => ({ ...c, stage: "monitoring" }));
  const used = new Set(late.map((c) => c.client)); // клиент — только в одной колонке
  const dpd = portfolio.clients.filter((c) => c.status === "оценивается" && c.dpd > 0 && c.dpd < 30 && !used.has(c.client)).sort((a, b) => b.dpd - a.dpd).slice(0, 2).map((c) => ({ ...c, stage: "overdue_30" }));
  const def = pick((c) => c.status !== "оценивается", 2).map((c) => ({ ...c, stage: "overdue_30plus" }));
  const fromPortfolio = [...late, ...dpd, ...def].map((c, i) => ({
    title: `Клиент ${c.client} · ${c.sector}`, client_code: c.client, asset: c.asset || null, amount_mln: Math.round(c.exposure / 1e5) / 10,
    stage: c.stage, note: c.stage === "monitoring" ? `Зона ${{ red: "красная", yellow: "жёлтая", green: "зелёная" }[c.zone]}, балл ${c.score}`
      : c.stage === "overdue_30" ? `Просрочка ${c.dpd} дн. на дату оценки` : "Дефолт ранее — работа с проблемной задолженностью",
    ago: 20 + i * 7,
  }));
  return [...early, ...fromPortfolio].map((d) => ({ ...d, at: now - d.ago * DAY }));
}

// clients — модуль app/clients.js: сделка ссылается на клиента (client_id), название сделки — его наименование
function createDeals(db, { portfolio, clients = null } = {}) {
  db.exec(SCHEMA);
  // базы, созданные до появления срока и комментария
  const cols = new Set(db.prepare("PRAGMA table_info(deals)").all().map((c) => c.name));
  if (!cols.has("term_months")) db.exec("ALTER TABLE deals ADD COLUMN term_months INTEGER");
  if (!cols.has("comment")) db.exec("ALTER TABLE deals ADD COLUMN comment TEXT");
  // исход сделки (сейчас только отказ) и стоп-фактор оценки
  if (!cols.has("outcome")) {
    db.exec("ALTER TABLE deals ADD COLUMN outcome TEXT; ALTER TABLE deals ADD COLUMN outcome_reason TEXT; ALTER TABLE deals ADD COLUMN outcome_at INTEGER; ALTER TABLE deals ADD COLUMN stop_factor TEXT");
    db.exec(`UPDATE deals SET stop_factor = note WHERE demo = 1 AND note LIKE 'Класс 3 на всех четырёх датах%'`);
  }
  // тип записи ленты: comment — комментарий пользователя, task — задача; без типа — служебная запись
  if (!new Set(db.prepare("PRAGMA table_info(deal_events)").all().map((c) => c.name)).has("kind")) db.exec("ALTER TABLE deal_events ADD COLUMN kind TEXT");
  // ответственный за сделку; у прежних сделок — автор
  if (!cols.has("owner_id")) { db.exec("ALTER TABLE deals ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL"); db.exec("UPDATE deals SET owner_id = created_by"); }
  // архив: сделка скрыта из канбана, списков и счётчиков, но не удалена и возвращается одним действием
  if (!cols.has("archived_at")) db.exec("ALTER TABLE deals ADD COLUMN archived_at INTEGER");
  const linkOld = !cols.has("client_id");
  if (linkOld) db.exec("ALTER TABLE deals ADD COLUMN client_id INTEGER REFERENCES clients(id)");
  // в выборках: owner_* — ответственный, stage_at — вход на текущую стадию, last_at — последняя запись ленты,
  // contract_at — переход на стадию «Договор» (сделка заключена)
  const q = {
    count: db.prepare("SELECT count(*) n FROM deals"),
    insert: db.prepare("INSERT INTO deals (title, inn, client_code, client_id, asset, amount_mln, stage, cls, note, stop_factor, demo, created_by, owner_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"),
    setClient: db.prepare("UPDATE deals SET client_id = ?, title = ?, updated_at = ? WHERE id = ?"),
    byClient: db.prepare("SELECT d.*, u.name owner_name, u.email owner_email, (SELECT max(e.at) FROM deal_events e WHERE e.deal_id = d.id AND e.to_stage IS NOT NULL) stage_at, (SELECT max(e.at) FROM deal_events e WHERE e.deal_id = d.id) last_at, (SELECT max(e.at) FROM deal_events e WHERE e.deal_id = d.id AND e.to_stage = 'contract') contract_at FROM deals d LEFT JOIN users u ON u.id = d.owner_id WHERE d.client_id = ? ORDER BY d.updated_at DESC"),
    setOwner: db.prepare("UPDATE deals SET owner_id = ?, updated_at = ? WHERE id = ?"),
    event: db.prepare("INSERT INTO deal_events (deal_id, at, user_id, from_stage, to_stage, text) VALUES (?,?,?,?,?,?)"),
    typed: db.prepare("INSERT INTO deal_events (deal_id, at, user_id, text, kind) VALUES (?,?,?,?,?)"),
    all: db.prepare("SELECT d.*, u.name owner_name, u.email owner_email, (SELECT max(e.at) FROM deal_events e WHERE e.deal_id = d.id AND e.to_stage IS NOT NULL) stage_at, (SELECT max(e.at) FROM deal_events e WHERE e.deal_id = d.id) last_at, (SELECT max(e.at) FROM deal_events e WHERE e.deal_id = d.id AND e.to_stage = 'contract') contract_at FROM deals d LEFT JOIN users u ON u.id = d.owner_id ORDER BY d.updated_at DESC"),
    get: db.prepare("SELECT d.*, u.name owner_name, u.email owner_email, (SELECT max(e.at) FROM deal_events e WHERE e.deal_id = d.id AND e.to_stage IS NOT NULL) stage_at, (SELECT max(e.at) FROM deal_events e WHERE e.deal_id = d.id) last_at, (SELECT max(e.at) FROM deal_events e WHERE e.deal_id = d.id AND e.to_stage = 'contract') contract_at FROM deals d LEFT JOIN users u ON u.id = d.owner_id WHERE d.id = ?"),
    events: db.prepare("SELECT e.*, u.name user_name, u.email user_email FROM deal_events e LEFT JOIN users u ON u.id = e.user_id WHERE deal_id = ? ORDER BY at DESC, e.id DESC"),
    move: db.prepare("UPDATE deals SET stage = ?, updated_at = ? WHERE id = ?"),
    setCheck: db.prepare("UPDATE deals SET title = ?, cls = ?, note = ?, updated_at = ? WHERE id = ?"),
    edit: db.prepare("UPDATE deals SET inn = ?, asset = ?, amount_mln = ?, term_months = ?, comment = ?, updated_at = ? WHERE id = ?"),
    outcome: db.prepare("UPDATE deals SET outcome = ?, outcome_reason = ?, outcome_at = ?, updated_at = ? WHERE id = ?"),
    setCalc: db.prepare("UPDATE deals SET cls = ?, note = ?, stop_factor = ?, updated_at = ? WHERE id = ?"),
    archive: db.prepare("UPDATE deals SET archived_at = ?, updated_at = ? WHERE id = ?"),
  };
  const stageTitle = (id) => STAGES.find((s) => s.id === id)?.title || id;

  // Клиент для сделки без явного client_id (демо-наполнение, перенос старых баз): по ИНН, коду портфеля или названию.
  // «ИНН …» и «Новая заявка · …» — не наименование.
  const named = (t) => !!t && !/^(ИНН d|Новая заявка)/.test(t);
  function clientFor({ inn, client_code, title }) {
    if (!clients) return null;
    const c = clients.ensure({ inn, client_code, name: named(title) ? title : inn ? `ИНН ${inn}` : null, source: named(title) ? (inn ? "dadata" : "manual") : "placeholder" });
    return c?.id ?? null;
  }

  function create({ title, inn = null, client_code = null, client_id, asset = null, amount_mln = null, term_months = null, comment = null, stage = "application", cls = null, note = null, stop_factor = null, demo = 0, userId = null, at = Date.now() }) {
    if (!STAGE_IDS.includes(stage)) throw new Error(`неизвестная стадия ${stage}`);
    if (client_id === undefined) client_id = clientFor({ inn, client_code, title });
    const id = Number(q.insert.run(title, inn, client_code, client_id, asset, amount_mln, stage, cls, note, stop_factor, demo, userId, userId, at, at).lastInsertRowid);
    if (term_months !== null || comment) q.edit.run(inn, asset, amount_mln, term_months, comment, at, id);
    q.event.run(id, at, userId, null, stage, `Сделка создана на стадии «${stageTitle(stage)}»`);
    return id;
  }

  if (q.count.get().n === 0 && portfolio) for (const d of demoDeals(portfolio)) create({ ...d, demo: 1 });
  // базы до появления клиентов: связать сделки с клиентами (название сделки не меняется)
  if (linkOld && clients) for (const d of q.all.all()) if (!d.client_id) { const cid = clientFor(d); if (cid) q.setClient.run(cid, clients.get(cid).name, d.updated_at, d.id); }

  return {
    STAGE_IDS,
    stageTitle,
    create,
    list: () => q.all.all(),
    byClient: (clientId) => q.byClient.all(clientId),
    // привязать сделку к клиенту (новый ИНН, наименование для заявки без клиента); название — по клиенту
    // передать сделку другому ответственному: from/to — имена для ленты
    setOwner(id, ownerId, userId, from, to) {
      const d = q.get.get(id);
      if (!d || d.owner_id === ownerId) return false;
      q.setOwner.run(ownerId, Date.now(), id);
      q.event.run(id, Date.now(), userId, null, null, `Ответственный: ${from || "не назначен"} → ${to}`);
      return true;
    },
    setClient(id, client, userId) {
      const d = q.get.get(id);
      if (!d || !client || d.client_id === client.id) return;
      q.setClient.run(client.id, client.name, Date.now(), id);
      q.event.run(id, Date.now(), userId, null, null, `Клиент: ${client.name}`);
    },
    get: (id) => q.get.get(id) || null,
    events: (id) => q.events.all(id),
    note: (id, userId, text, kind = null) => q.typed.run(id, Date.now(), userId, text, kind),
    comment: (id, userId, text) => q.typed.run(id, Date.now(), userId, text, "comment"),
    // результат проверки клиента (DaData, ГИР БО): название, предварительный класс, пояснение
    setCheck(id, { title, cls, note }, userId, text) {
      q.setCheck.run(title, cls, note, Date.now(), id);
      if (text) q.event.run(id, Date.now(), userId, null, null, text);
    },
    // результат калькулятора: класс, заключение и стоп-фактор (класс 3 на всех четырёх датах); в ленту — text
    setClass(id, { cls, note, stop }, userId, text) {
      const now = Date.now();
      q.setCalc.run(cls, note, stop, now, id);
      q.event.run(id, now, userId, null, null, text);
    },
    // правка полей; в историю — список изменений. Возвращает изменённые поля.
    edit(id, v, userId) {
      const d = q.get.get(id);
      if (!d) return null;
      const LABEL = { inn: "ИНН", asset: "предмет", amount_mln: "сумма, млн", term_months: "срок, мес.", comment: "примечание" };
      const changed = Object.keys(LABEL).filter((k) => (d[k] ?? null) !== (v[k] ?? null));
      if (!changed.length) return [];
      q.edit.run(v.inn, v.asset, v.amount_mln, v.term_months, v.comment, Date.now(), id);
      const show = (k, x) => (x === null || x === undefined || x === "" ? "—" : k === "comment" ? `«${String(x).slice(0, 60)}»` : String(x));
      q.event.run(id, Date.now(), userId, null, null, `Изменено: ${changed.map((k) => `${LABEL[k]} ${show(k, d[k])} → ${show(k, v[k])}`).join("; ")}`);
      return changed;
    },
    move(id, stage, userId) {
      const d = q.get.get(id);
      if (!d) return null;
      if (!STAGE_IDS.includes(stage)) throw Object.assign(new Error("неизвестная стадия"), { status: 400 });
      if (d.outcome || d.archived_at) throw Object.assign(new Error(d.archived_at ? "Сделка в архиве — сначала верните её из архива." : "Сделка закрыта отказом — сначала верните её в работу."), { status: 409 });
      if (d.stage === stage) return d;
      const now = Date.now();
      q.move.run(stage, now, id);
      q.event.run(id, now, userId, d.stage, stage, `«${stageTitle(d.stage)}» → «${stageTitle(stage)}»`);
      return q.get.get(id);
    },
    // отказ: сделка остаётся на своей стадии, но выходит из воронки и счётчиков
    refuse(id, reason, userId) {
      const now = Date.now();
      q.outcome.run("refused", reason, now, now, id);
      q.event.run(id, now, userId, null, null, `Отказ: ${reason}`);
    },
    archive(id, userId, on = true) {
      const now = Date.now();
      q.archive.run(on ? now : null, now, id);
      q.event.run(id, now, userId, null, null, on ? "Сделка перенесена в архив" : "Сделка возвращена из архива");
    },
    reopen(id, userId) {
      const now = Date.now();
      q.outcome.run(null, null, null, now, id);
      q.event.run(id, now, userId, null, null, "Сделка возвращена в работу");
    },
  };
}

module.exports = { createDeals, demoDeals, STAGE_IDS };
