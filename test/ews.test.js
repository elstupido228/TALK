// Раннее предупреждение, API /api/ews/*: баллы и зоны совпадают с features.js напрямую, загрузка выгрузки, шаблон, роли.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { open } = require("../app/db");
const { createApp } = require("../app/server");
const { createAuth } = require("../app/auth");
const { createGateway } = require("../app/extract/gateway");
const { createConnectors } = require("../app/connectors/core");
const cbr = require("../app/connectors/cbr");
const F = require("../seed/ews/features.js");

const DATA = path.join(__dirname, "..", "seed", "ews", "data");
const demo = require(path.join(DATA, "demo.json"));
const model = require(path.join(DATA, "model.json"));

let server, base, db;
const cookies = {};
before(async () => {
  db = open(":memory:");
  const auth = createAuth(db);
  for (const role of ["admin", "curator", "talk"]) auth.upsertUser({ email: `${role}@example.test`, role, password: "Test-pass-123" });
  const connectors = createConnectors(db, [cbr], { env: { CONNECTOR_CBR_MODE: "sandbox" } });
  server = createApp(db, { gateway: createGateway({ db, env: {} }), connectors }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const role of ["admin", "curator", "talk"]) {
    const r = await fetch(base + "/login", { method: "POST", redirect: "manual", headers: { origin: base, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: `${role}@example.test`, password: "Test-pass-123" }) });
    cookies[role] = r.headers.get("set-cookie").split(";")[0];
  }
});
after(() => (server.close(), db.close()));

const get = (url, role = "admin") => fetch(base + url, { headers: { cookie: cookies[role] } });
const json = async (url, role) => { const r = await get(url, role); assert.strictEqual(r.status, 200, url); return r.json(); };

// балл и зона на дату — прямо по features.js и model.json, как в check_parity.js
function direct(date) {
  const idx = F.prepare(demo);
  const out = new Map();
  for (const r of F.snapshots(idx, { from: date, to: date })) {
    if (r.date !== date) continue;
    const s = F.score(model, r);
    out.set(r.client, { score: s.score, zone: r.status === "оценивается" ? s.zone : "grey", dpd: r.dpd_now, exposure: r.exposure });
  }
  return out;
}

test("API портфеля и карточки: 20 случайных клиентов демо-портфеля — балл и зона как в features.js", async () => {
  const p = await json("/api/ews/portfolio");
  assert.strictEqual(p.date, "2026-09-30");
  assert.strictEqual(p.demo, true);
  assert.match(p.disclaimer, /условные/);
  const ref = direct(p.date);
  assert.strictEqual(p.clients.length, ref.size);
  assert.strictEqual(p.total.clients, ref.size);
  // все клиенты на дату — те же баллы и зоны
  for (const c of p.clients) assert.deepStrictEqual([c.score, c.zone, c.dpd, c.exposure], Object.values(ref.get(c.client)), c.client);
  assert.ok(p.clients.every((c) => c.reasons.length <= 3));
  assert.strictEqual(p.months.length, 24);
  // 20 случайных (детерминированно) — через карточку /api/ews/clients/{code}
  let seed = 20261028;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const codes = [...ref.keys()].sort((a, b) => rnd() - 0.5 || a.localeCompare(b)).slice(0, 20);
  assert.strictEqual(new Set(codes).size, 20);
  for (const code of codes) {
    const c = await json(`/api/ews/clients/${encodeURIComponent(code)}?months=24`);
    const r = ref.get(code);
    assert.deepStrictEqual([c.score, c.zone], [r.score, r.zone], code);
    if (!c.default_date) assert.strictEqual(c.history.at(-1).date, p.date);
    assert.strictEqual(c.contributions.length, model.vars.length);
    assert.strictEqual(Math.round(c.contributions.reduce((s, x) => s + x.points, 0) * 100) / 100, r.score);
  }
  const m = await json("/api/ews/model", "curator");
  assert.deepStrictEqual([m.vars.length, m.zones.red, m.zones.yellow, m.can_upload], [13, 574, 612, false]);
  assert.match(m.disclaimer, /условные/);
});

test("портфель на прошлую дату, ошибки дат и клиентов", async () => {
  const p = await json("/api/ews/portfolio?date=2025-12-15");
  assert.strictEqual(p.date, "2025-11-30"); // ближайший конец месяца не позже даты
  const ref = direct("2025-11-30");
  for (const c of p.clients.slice(0, 30)) assert.strictEqual(c.score, ref.get(c.client).score);
  assert.strictEqual((await get("/api/ews/portfolio?date=31.12.2025")).status, 400);
  assert.strictEqual((await get("/api/ews/clients/" + encodeURIComponent("КЛ-9999"))).status, 404);
  assert.strictEqual((await fetch(base + "/api/ews/model")).status, 401);
});

test("шаблон и пример выгрузки — файлы xlsx с Content-Disposition; загрузка примера даёт тот же портфель", async () => {
  const t = await get("/api/ews/template", "curator");
  assert.strictEqual(t.status, 200);
  assert.match(t.headers.get("content-type"), /spreadsheetml/);
  assert.match(t.headers.get("content-disposition"), /attachment; .*filename\*=UTF-8''/);
  const desc = await json("/api/ews/template?format=json", "curator");
  assert.deepStrictEqual(desc.sheets.map((s) => s.name), ["Клиенты", "Договоры", "График", "Платежи", "События", "Отчётность"]);
  const ex = Buffer.from(await (await get("/api/ews/template?example=1")).arrayBuffer());
  assert.strictEqual(ex.subarray(0, 2).toString(), "PK");
  const up = (role, body) => fetch(base + "/api/ews/upload?name=example.xlsx", { method: "POST", headers: { cookie: cookies[role], origin: base, "content-type": "application/octet-stream" }, body });
  // кураторы и Sber2B — без загрузки
  assert.strictEqual((await up("curator", ex)).status, 403);
  const r = await (await up("talk", ex)).json();
  assert.strictEqual(r.fatal, false, JSON.stringify(r.checks));
  assert.deepStrictEqual(r.counts, { clients: 420, contracts: 607, schedule: 24660, payments: 19187, events: 1792, reports: 2224 });
  assert.ok(r.checks.every((c) => c.status === "ok"), JSON.stringify(r.checks));
  assert.strictEqual(r.suggested_date, "2026-09-30");
  const a = await json("/api/ews/portfolio", "talk");
  const b = await json(`/api/ews/portfolio?dataset=${r.dataset}`, "talk");
  assert.strictEqual(b.label, "upload");
  assert.deepStrictEqual(b.clients.map((c) => [c.client, c.score, c.zone]), a.clients.map((c) => [c.client, c.score, c.zone]));
  // чужая выгрузка не видна
  assert.strictEqual((await get(`/api/ews/portfolio?dataset=${r.dataset}`, "admin")).status, 404);
  // не тот файл
  const bad = await up("admin", Buffer.from("не xlsx"));
  assert.strictEqual(bad.status, 400);
});

test("клиент на экране — наименование и ИНН, ID только служебный; условные реквизиты помечены", async () => {
  const p = await json("/api/ews/portfolio");
  for (const c of p.clients) {
    assert.match(c.inn, /^000001\d{4}$/, c.client);
    assert.match(c.name, /^ООО «Пример-/, c.client);
  }
  const c = await json("/api/ews/clients/" + encodeURIComponent(p.clients[0].client));
  assert.deepStrictEqual([c.name, c.inn, c.conditional], [p.clients[0].name, p.clients[0].inn, true]);
  // главная: «Требуют внимания» — наименования, без ID
  const home = await (await get("/")).text();
  assert.ok(home.includes(p.clients[0].name.replace(/"/g, "&quot;")) || home.includes(p.clients[0].name), "наименование на главной");
  assert.doesNotMatch(home.replace(/href="[^"]*"/g, ""), /КЛ-\d{4}/);
  // справочник портала важнее условного: сделка мониторинга ссылается на клиента по client_code
  const row = db.prepare("SELECT c.name, c.inn, c.client_code FROM clients c WHERE c.client_code IS NOT NULL LIMIT 1").get();
  assert.ok(row && !/^Клиент /.test(row.name), JSON.stringify(row));
  db.prepare("UPDATE clients SET name = 'ООО «Переименован»' WHERE client_code = ?").run(row.client_code);
  assert.strictEqual((await json("/api/ews/clients/" + encodeURIComponent(row.client_code))).name, "ООО «Переименован»");
});

test("выгрузка с наименованием и ИНН и со старым заголовком «Код клиента»", async () => {
  const { createEws } = require("../app/monitoring/ews");
  const e = createEws({ env: {} });
  const small = { ...demo, clients: demo.clients.slice(0, 5).map((c, i) => ({ ...c, name: i === 0 ? "ООО «Своё имя»" : null, inn: i === 0 ? "7700000000" : null })) };
  const keep = new Set(small.clients.map((c) => c.client));
  for (const k of ["contracts", "events", "reports"]) small[k] = demo[k].filter((r) => keep.has(r.client));
  const cons = new Set(small.contracts.map((c) => c.contract));
  for (const k of ["schedule", "payments"]) small[k] = demo[k].filter((r) => cons.has(r.contract));
  const r = e.upload(e.workbook(small), { id: 7 }, {});
  assert.strictEqual(r.fatal, false, JSON.stringify(r.checks));
  const c = e.client(r.dataset, small.clients[0].client, {}, { id: 7 });
  assert.deepStrictEqual([c.name, c.inn, c.conditional], ["ООО «Своё имя»", "7700000000", false]);
  assert.strictEqual(e.client(r.dataset, small.clients[1].client, {}, { id: 7 }).name, null); // у выгрузки заказчика условных имён нет
});
