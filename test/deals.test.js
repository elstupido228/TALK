// Сделки: демо-наполнение, запуск сделки с проверкой по ИНН, канбан, смена стадии (API и форма), права.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { open } = require("../app/db");
const { createApp } = require("../app/server");
const { createAuth } = require("../app/auth");
const { createGateway } = require("../app/extract/gateway");
const { createConnectors } = require("../app/connectors/core");

const PASS = "Test-pass-123";
let server, base, db, team, curator;
before(async () => {
  db = open(":memory:");
  const auth = createAuth(db);
  auth.upsertUser({ email: "team@example.test", role: "team", password: PASS });
  auth.upsertUser({ email: "curator@example.test", role: "curator", password: PASS });
  const all = [require("../app/connectors/cbr"), require("../app/connectors/dadata"), require("../app/connectors/fin"), ...require("../app/connectors/sandboxes")];
  const env = Object.fromEntries(all.map((x) => [`CONNECTOR_${x.id.toUpperCase()}_MODE`, "sandbox"])); // без сети
  server = createApp(db, { gateway: createGateway({ db, env: {} }), connectors: createConnectors(db, all, { env }) }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (email, ip) => (await fetch(base + "/login", { method: "POST", redirect: "manual", headers: { origin: base, "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip }, body: new URLSearchParams({ email, password: PASS }) })).headers.get("set-cookie").split(";")[0];
  team = await login("team@example.test", "10.1.0.1");
  curator = await login("curator@example.test", "10.1.0.2");
});
after(() => (server.close(), db.close()));

const get = async (p, cookie) => { const r = await fetch(base + p, { headers: { cookie }, redirect: "manual" }); return [r.status, await r.text(), r]; };
const post = (p, cookie, body, type = "form") => fetch(base + p, { method: "POST", redirect: "manual", headers: { cookie, origin: base, "content-type": type === "json" ? "application/json" : "application/x-www-form-urlencoded" }, body: type === "json" ? JSON.stringify(body) : new URLSearchParams(body) });

test("демо-наполнение: 14 условных сделок во всех семи колонках, клиенты не повторяются", async () => {
  const [st, html] = await get("/deals", team);
  assert.strictEqual(st, 200);
  assert.strictEqual((html.match(/<section class="kcol /g) || []).length, 7);
  assert.strictEqual((html.match(/class="kcard demo"/g) || []).length, 14);
  for (const id of ["application", "assessment", "decision", "contract", "monitoring", "overdue_30", "overdue_30plus"]) {
    const col = html.split(`id="${id}" data-stage="${id}"`)[1].split("</section>")[0];
    assert.ok(col.includes('class="kcard'), `колонка ${id} не пустая`);
  }
  const codes = [...html.matchAll(/Клиент (КЛ-\d+)/g)].map((m) => m[1]);
  assert.strictEqual(codes.length, new Set(codes).size);
  assert.match(html, /draggable="true"/);
});

test("запуск сделки по ИНН: заявка, карточка из DaData, предварительный класс, история", async () => {
  const r = await post("/deals", team, { inn: "0000000002", asset: "Спецтехника", amount: "25,5" });
  assert.strictEqual(r.status, 303);
  const loc = r.headers.get("location");
  assert.match(loc, /^\/deals\/\d+$/);
  const [st, html] = await get(loc, team);
  assert.strictEqual(st, 200);
  assert.match(html, /<h1>ООО «Бета-Пример»<\/h1>/);
  assert.match(html, /25,5 млн руб\./);
  assert.match(html, /<li class="now"><span>1<\/span>Заявка<\/li>/);
  assert.match(html, /class="cls cls-2"/);
  assert.match(html, /Предварительный класс по годовой отчётности за 2025/);
  assert.match(html, /Сделка создана на стадии «Заявка»/);
  assert.match(html, /href="\/check\?inn=0000000002"/);
  // без ИНН — просто заявка
  const r2 = await post("/deals", team, { asset: "Оборудование" });
  assert.match((await get(r2.headers.get("location"), team))[1], /ИНН ещё не указан/);
  // неверный ИНН
  assert.strictEqual((await post("/deals", team, { inn: "123" })).status, 400);
});

test("смена стадии: перетаскивание (API) и форма; куратор только смотрит", async () => {
  const id = +(await post("/deals", team, { asset: "Оборудование" })).headers.get("location").split("/").pop();
  let r = await post(`/api/deals/${id}/stage`, team, { stage: "assessment" }, "json");
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).deal.stage, "assessment");
  assert.strictEqual((await post(`/api/deals/${id}/stage`, team, { stage: "nope" }, "json")).status, 400);
  r = await post(`/deals/${id}/stage`, team, { stage: "decision" });
  assert.strictEqual(r.status, 303);
  r = await post(`/deals/${id}/stage`, team, { stage: "__any", stage_any: "monitoring" });
  const html = (await get(`/deals/${id}`, team))[1];
  assert.match(html, /<li class="now"><span>5<\/span>Мониторинг<\/li>/);
  for (const t of ["«Заявка» → «Оценка клиента»", "«Оценка клиента» → «Решение»", "«Решение» → «Мониторинг»"]) assert.ok(html.includes(t), t);
  assert.strictEqual((await post(`/api/deals/${id}/stage`, curator, { stage: "contract" }, "json")).status, 403);
  assert.strictEqual((await post("/deals", curator, { asset: "Оборудование" })).status, 403);
  const ch = (await get(`/deals/${id}`, curator))[1];
  assert.ok(!ch.includes('class="move"'), "куратору форма смены стадии не показывается");
  assert.ok(!(await get("/deals", curator))[1].includes('draggable="true"'));
  assert.strictEqual((await get("/deals/99999", team))[0], 404);
});
