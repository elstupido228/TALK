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
    { title: "ООО «Гамма-Пример»", inn: "0000000003", asset: "Оборудование", amount_mln: 12, stage: "assessment", cls: 3, note: "Класс 3 на всех четырёх датах — п. 14.1.6", ago: 3 },
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

function createDeals(db, { portfolio } = {}) {
  db.exec(SCHEMA);
  const q = {
    count: db.prepare("SELECT count(*) n FROM deals"),
    insert: db.prepare("INSERT INTO deals (title, inn, client_code, asset, amount_mln, stage, cls, note, demo, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"),
    event: db.prepare("INSERT INTO deal_events (deal_id, at, user_id, from_stage, to_stage, text) VALUES (?,?,?,?,?,?)"),
    all: db.prepare("SELECT * FROM deals ORDER BY updated_at DESC"),
    get: db.prepare("SELECT * FROM deals WHERE id = ?"),
    events: db.prepare("SELECT e.*, u.name user_name, u.email user_email FROM deal_events e LEFT JOIN users u ON u.id = e.user_id WHERE deal_id = ? ORDER BY at DESC, e.id DESC"),
    move: db.prepare("UPDATE deals SET stage = ?, updated_at = ? WHERE id = ?"),
    update: db.prepare("UPDATE deals SET title = coalesce(?, title), cls = ?, note = coalesce(?, note), updated_at = ? WHERE id = ?"),
  };
  const stageTitle = (id) => STAGES.find((s) => s.id === id)?.title || id;

  function create({ title, inn = null, client_code = null, asset = null, amount_mln = null, stage = "application", cls = null, note = null, demo = 0, userId = null, at = Date.now() }) {
    if (!STAGE_IDS.includes(stage)) throw new Error(`неизвестная стадия ${stage}`);
    const id = Number(q.insert.run(title, inn, client_code, asset, amount_mln, stage, cls, note, demo, userId, at, at).lastInsertRowid);
    q.event.run(id, at, userId, null, stage, `Сделка создана на стадии «${stageTitle(stage)}»`);
    return id;
  }

  if (q.count.get().n === 0 && portfolio) for (const d of demoDeals(portfolio)) create({ ...d, demo: 1 });

  return {
    STAGE_IDS,
    stageTitle,
    create,
    list: () => q.all.all(),
    get: (id) => q.get.get(id) || null,
    events: (id) => q.events.all(id),
    note: (id, userId, text) => q.event.run(id, Date.now(), userId, null, null, text),
    update: (id, { title = null, cls = null, note = null }) => q.update.run(title, cls, note, Date.now(), id),
    move(id, stage, userId) {
      const d = q.get.get(id);
      if (!d) return null;
      if (!STAGE_IDS.includes(stage)) throw Object.assign(new Error("неизвестная стадия"), { status: 400 });
      if (d.stage === stage) return d;
      const now = Date.now();
      q.move.run(stage, now, id);
      q.event.run(id, now, userId, d.stage, stage, `«${stageTitle(d.stage)}» → «${stageTitle(stage)}»`);
      return q.get.get(id);
    },
  };
}

module.exports = { createDeals, demoDeals, STAGE_IDS };
