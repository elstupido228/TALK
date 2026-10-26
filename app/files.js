// Документы сделки: файлы лежат в DATA_DIR/files/<сделка>/<id>, описание — в таблице deal_files.
// Удаление мягкое (deleted_at): запись и файл остаются, в карточке не показываются; всё — в ленте сделки.
const fs = require("node:fs");
const path = require("node:path");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS deal_files (
  id          INTEGER PRIMARY KEY,
  deal_id     INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  at          INTEGER NOT NULL,
  deleted_at  INTEGER,
  deleted_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS deal_files_deal ON deal_files(deal_id);
`;

// допустимые типы: отчётность, договоры, сканы; тип ответа — по расширению, а не по заявлению клиента
const TYPES = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};
const MAX_BYTES = 20 * 1024 * 1024;
const sizeText = (n) => (n >= 1048576 ? `${(n / 1048576).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`);

function createFiles(db, deals, dir) {
  db.exec(SCHEMA);
  const SEL = "SELECT f.*, u.name user_name, u.email user_email FROM deal_files f LEFT JOIN users u ON u.id = f.uploaded_by";
  const q = {
    insert: db.prepare("INSERT INTO deal_files (deal_id, name, mime, size, uploaded_by, at) VALUES (?,?,?,?,?,?)"),
    get: db.prepare(`${SEL} WHERE f.id = ?`),
    byDeal: db.prepare(`${SEL} WHERE f.deal_id = ? AND f.deleted_at IS NULL ORDER BY f.at DESC`),
    del: db.prepare("UPDATE deal_files SET deleted_at = ?, deleted_by = ? WHERE id = ?"),
  };
  const fileOf = (f) => path.join(dir, String(f.deal_id), String(f.id));

  // имя из заголовка: без пути и управляющих символов; расширение — из списка допустимых
  function check(rawName, size) {
    const name = path.basename(String(rawName || "").replace(/\\/g, "/")).replace(/[\u0000-\u001f"<>]/g, "").trim().slice(0, 150);
    const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
    if (!name || !ext) return { error: "У файла нет имени или расширения." };
    if (!TYPES[ext]) return { error: `Тип «.${ext}» не принимается. Можно: PDF, Excel, Word, JPG, PNG.` };
    if (!size) return { error: "Файл пустой." };
    if (size > MAX_BYTES) return { error: `Файл больше ${sizeText(MAX_BYTES)}.` };
    return { name, mime: TYPES[ext] };
  }

  function add(dealId, { name, mime, body }, userId) {
    const id = Number(q.insert.run(dealId, name, mime, body.length, userId, Date.now()).lastInsertRowid);
    const f = q.get.get(id);
    fs.mkdirSync(path.dirname(fileOf(f)), { recursive: true });
    fs.writeFileSync(fileOf(f), body);
    deals.note(dealId, userId, `Файл добавлен: ${name} (${sizeText(body.length)})`);
    return f;
  }

  function remove(id, userId) {
    const f = q.get.get(id);
    if (!f || f.deleted_at) return null;
    q.del.run(Date.now(), userId, id);
    deals.note(f.deal_id, userId, `Файл удалён из карточки: ${f.name}`);
    return f;
  }

  return { check, add, remove, get: (id) => q.get.get(id) || null, byDeal: (dealId) => q.byDeal.all(dealId), read: (f) => fs.readFileSync(fileOf(f)), MAX_BYTES };
}

module.exports = { createFiles, sizeText, TYPES };
