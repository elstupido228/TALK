// Клиенты: наименование, ИНН, контактное лицо, телефон. Сделки ссылаются на клиента (deals.client_id),
// название сделки = наименование клиента (обновляется у всех его сделок при переименовании).
// name_source: manual — введено пользователем (DaData его не перезаписывает), dadata — из DaData,
// placeholder — временное «ИНН …», пока DaData не ответила.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (
  id           INTEGER PRIMARY KEY,
  inn          TEXT UNIQUE,
  client_code  TEXT UNIQUE,
  name         TEXT NOT NULL,
  name_source  TEXT NOT NULL DEFAULT 'manual',
  contact_name TEXT,
  phone        TEXT,
  email        TEXT,
  note         TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
`;

const norm = (s) => String(s || "").toLowerCase().replace(/[«»"'.,]/g, "").replace(/\s+/g, " ").trim();

function createClients(db) {
  db.exec(SCHEMA);
  const q = {
    get: db.prepare("SELECT * FROM clients WHERE id = ?"),
    byInn: db.prepare("SELECT * FROM clients WHERE inn = ?"),
    byCode: db.prepare("SELECT * FROM clients WHERE client_code = ?"),
    noInn: db.prepare("SELECT * FROM clients WHERE inn IS NULL AND client_code IS NULL"),
    all: db.prepare("SELECT * FROM clients ORDER BY name COLLATE NOCASE"),
    insert: db.prepare("INSERT INTO clients (inn, client_code, name, name_source, contact_name, phone, email, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"),
    update: db.prepare("UPDATE clients SET inn = ?, name = ?, name_source = ?, contact_name = ?, phone = ?, email = ?, note = ?, updated_at = ? WHERE id = ?"),
  };
  // таблица сделок создаётся позже (app/deals.js) — запрос готовится при первом переименовании
  let titlesQ = null;
  const titles = (name, id) => (titlesQ ||= db.prepare("UPDATE deals SET title = ? WHERE client_id = ?")).run(name, id);

  // Найти клиента по ИНН, коду портфеля или (без ИНН) по наименованию; нет — создать.
  // Пустые контакты существующего клиента дополняются введёнными.
  function ensure({ inn = null, client_code = null, name = null, source = "manual", contact_name = null, phone = null, email = null }) {
    const now = Date.now();
    let c = inn ? q.byInn.get(inn) : client_code ? q.byCode.get(client_code) : name ? q.noInn.all().find((x) => norm(x.name) === norm(name)) : null;
    if (!c) {
      if (!name) return null;
      const id = Number(q.insert.run(inn, client_code, name, source, contact_name, phone, email, null, now, now).lastInsertRowid);
      return q.get.get(id);
    }
    if ((contact_name && !c.contact_name) || (phone && !c.phone) || (email && !c.email)) {
      q.update.run(c.inn, c.name, c.name_source, c.contact_name || contact_name, c.phone || phone, c.email || email, c.note, now, c.id);
      c = q.get.get(c.id);
    }
    return c;
  }

  // Наименование из DaData: заменяет только временное «ИНН …» (введённое пользователем не трогается)
  function nameFromSource(id, name) {
    const c = q.get.get(id);
    if (!c || !name || c.name_source === "manual" || c.name === name) return c;
    q.update.run(c.inn, name, "dadata", c.contact_name, c.phone, c.email, c.note, Date.now(), id);
    titles(name, id);
    return q.get.get(id);
  }

  // Правка карточки клиента. Возвращает {client, changed: [поля]} или бросает {status: 400, errors}.
  function update(id, f) {
    const c = q.get.get(id);
    if (!c) return null;
    const errors = {};
    const name = String(f.name || "").trim().slice(0, 200);
    if (!name) errors.name = "Укажите наименование клиента.";
    const rawInn = String(f.inn ?? c.inn ?? ""), inn = rawInn.replace(/\D/g, "") || null;
    if (/[^\d\s]/.test(rawInn)) errors.inn = "ИНН — только цифры: 10 для организации, 12 для ИП.";
    else if (inn && !/^(\d{10}|\d{12})$/.test(inn)) errors.inn = "ИНН — 10 или 12 цифр.";
    else if (c.inn && inn !== c.inn) errors.inn = "ИНН клиента со сделками не меняется: заведите нового клиента через новую сделку.";
    else if (inn && inn !== c.inn && q.byInn.get(inn)) errors.inn = "Клиент с таким ИНН уже есть.";
    const phone = String(f.phone || "").trim().slice(0, 40) || null;
    if (phone && !/^[+\d\s()-]{5,40}$/.test(phone)) errors.phone = "Телефон — цифры, пробелы, скобки, «+» и «-».";
    const email = String(f.email || "").trim().slice(0, 120) || null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = "Email в виде name@example.ru.";
    if (Object.keys(errors).length) throw Object.assign(new Error(Object.values(errors).join(" ")), { status: 400, errors });
    const v = { inn, name, contact_name: String(f.contact_name || "").trim().slice(0, 120) || null, phone, email, note: String(f.note || "").trim().slice(0, 1000) || null };
    const changed = Object.keys(v).filter((k) => (c[k] ?? null) !== (v[k] ?? null));
    if (!changed.length) return { client: c, changed };
    q.update.run(v.inn, v.name, changed.includes("name") ? "manual" : c.name_source, v.contact_name, v.phone, v.email, v.note, Date.now(), id);
    if (changed.includes("name")) titles(v.name, id);
    return { client: q.get.get(id), changed };
  }

  function list(query = "") {
    const s = norm(query), digits = String(query).replace(/\D/g, "");
    return q.all.all().filter((c) => !s || norm(c.name).includes(s) || (digits.length >= 3 && (c.inn || "").includes(digits)) || norm(c.contact_name).includes(s) || (digits.length >= 3 && (c.phone || "").replace(/\D/g, "").includes(digits)));
  }

  return { ensure, nameFromSource, update, list, get: (id) => q.get.get(id) || null, byInn: (inn) => q.byInn.get(inn) || null };
}

module.exports = { createClients, norm };
