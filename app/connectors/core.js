// Слой коннекторов /api/connectors/*: единый интерфейс вызова, кэш ответов в SQLite, журнал, режимы.
//
// Коннектор: { id, title, mode: "live"|"sandbox", ops: { имя: { ttlMs, live(params, ctx), sandbox(params) } } }
// Режим задаётся в коннекторе и переопределяется переменной окружения CONNECTOR_<ID>_MODE (например, CONNECTOR_CBR_MODE=sandbox).
//
// live: свежий кэш (моложе ttlMs) -> ответ из кэша; иначе внешний API -> кэш. Если API недоступен — последний
// сохранённый ответ с пометкой stale, а без кэша — ответ песочницы с пометкой fallback. Демо не ломается без сети.
// Ответ: {data, source: "live"|"cache"|"sandbox", fetched_at, stale?, fallback?, error?}
const SCHEMA = `
CREATE TABLE IF NOT EXISTS connector_cache (
  key       TEXT PRIMARY KEY,
  connector TEXT NOT NULL,
  value     TEXT NOT NULL,
  at        INTEGER NOT NULL
);
`;

const fail = (code, message, status) => Object.assign(new Error(message), { code, status });

function createConnectors(db, list, { env = process.env } = {}) {
  db.exec(SCHEMA);
  const q = {
    get: db.prepare("SELECT value, at FROM connector_cache WHERE key = ?"),
    put: db.prepare("INSERT INTO connector_cache (key, connector, value, at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at"),
    log: db.prepare("INSERT INTO connector_log (at, connector, mode, request, status, ms, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)"),
  };
  const byId = new Map(list.map((c) => [c.id, c]));
  const modeOf = (c) => (env[`CONNECTOR_${c.id.toUpperCase()}_MODE`] || c.mode) === "sandbox" ? "sandbox" : "live";

  async function call(id, opName, params = {}, { userId = null } = {}) {
    const c = byId.get(id);
    const op = c?.ops?.[opName];
    if (!op) throw fail("not_found", `Нет метода ${id}/${opName}.`, 404);
    const req = `${opName} ${JSON.stringify(params)}`.slice(0, 300);
    const key = `${id}:${opName}:${JSON.stringify(params)}`;
    const t0 = Date.now();
    const log = (mode, status) => q.log.run(Date.now(), id, mode, req, status, Date.now() - t0, userId);

    if (modeOf(c) === "sandbox") {
      const data = await op.sandbox(params);
      log("sandbox", "ok");
      return { data, source: "sandbox", fetched_at: new Date().toISOString() };
    }
    const cached = q.get.get(key);
    if (cached && Date.now() - cached.at < op.ttlMs) {
      log("cache", "ok");
      return { data: JSON.parse(cached.value), source: "cache", fetched_at: new Date(cached.at).toISOString() };
    }
    try {
      const data = await op.live(params, { env });
      q.put.run(key, id, JSON.stringify(data), Date.now());
      log("live", "ok");
      return { data, source: "live", fetched_at: new Date().toISOString() };
    } catch (e) {
      const msg = String(e.message || e).slice(0, 200);
      if (e.code === "bad_request") { log("live", `ошибка запроса: ${msg}`); throw e; }
      if (cached) {
        log("cache", `устаревший кэш: ${msg}`);
        return { data: JSON.parse(cached.value), source: "cache", stale: true, fetched_at: new Date(cached.at).toISOString(), error: msg };
      }
      const data = await op.sandbox(params);
      log("sandbox", `запасной ответ: ${msg}`);
      return { data, source: "sandbox", fallback: true, fetched_at: new Date().toISOString(), error: msg };
    }
  }

  // Последний сохранённый ответ без обращения к источнику (любой давности) — для страниц, которые не должны ждать сеть
  function peek(id, opName, params = {}) {
    const c = byId.get(id);
    if (!c?.ops?.[opName] || modeOf(c) === "sandbox") return null;
    const r = q.get.get(`${id}:${opName}:${JSON.stringify(params)}`);
    return r ? { data: JSON.parse(r.value), source: "cache", stale: Date.now() - r.at >= c.ops[opName].ttlMs, fetched_at: new Date(r.at).toISOString() } : null;
  }

  // Фактическое состояние живого источника — по последнему обращению к нему (ответ из свежего кэша не в счёт):
  // ok — ответил; down — не ответил (показан сохранённый ответ или условный пример); unknown — обращений не было
  const lastCall = db.prepare("SELECT at, mode, status FROM connector_log WHERE connector = ? AND (mode = 'live' OR status <> 'ok') ORDER BY id DESC LIMIT 1");
  function health(id) {
    const r = lastCall.get(id);
    if (!r) return { state: "unknown" };
    return r.mode === "live" && r.status === "ok" ? { state: "ok", at: r.at } : { state: "down", at: r.at, error: r.status.replace(/^(устаревший кэш|запасной ответ|ошибка запроса): /, "") };
  }
  const describe = () => list.map((c) => ({ id: c.id, title: c.title, what: c.what, mode: modeOf(c), sandboxOnly: !!c.sandboxOnly, ops: Object.keys(c.ops), health: modeOf(c) === "live" && !c.sandboxOnly ? health(c.id) : null }));
  return { call, peek, describe, health, has: (id) => byId.has(id) };
}

module.exports = { createConnectors, fail };
