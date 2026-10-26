// Каркас портала: вход под каждой ролью, блокировка после серии неверных паролей, права, выход, CSRF.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { open } = require("../app/db");
const { createApp } = require("../app/server");
const { createAuth, ROLES, LOCK } = require("../app/auth");

const PASS = "Test-pass-123";
let server, base, db;

before(async () => {
  db = open(":memory:");
  const auth = createAuth(db);
  for (const role of ROLES) auth.upsertUser({ email: `${role}@example.test`, role, password: PASS });
  server = createApp(db).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => (server.close(), db.close()));

// Запрос «из браузера»: Origin совпадает с Host, редиректы не выполняются.
function req(path, { method = "GET", form, cookie, ip, origin = base } = {}) {
  const headers = {};
  if (form) headers["content-type"] = "application/x-www-form-urlencoded";
  if (method === "POST" && origin) headers.origin = origin;
  if (cookie) headers.cookie = cookie;
  if (ip) headers["x-forwarded-for"] = ip;
  return fetch(base + path, { method, headers, body: form && new URLSearchParams(form), redirect: "manual" });
}
const login = (email, password, ip) => req("/login", { method: "POST", form: { email, password, next: "/" }, ip });
const sid = (r) => (r.headers.get("set-cookie") || "").split(";")[0];

test("/healthz отвечает ok", async () => {
  const r = await req("/healthz");
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).ok, true);
});

test("без входа страницы перенаправляют на /login", async () => {
  for (const p of ["/", "/check", "/process", "/sources", "/about", "/calc", "/monitoring", "/admin/users"]) {
    const r = await req(p);
    assert.strictEqual(r.status, 303, p);
    assert.match(r.headers.get("location"), /^\/login\?next=/, p);
  }
});

test("вход под каждой ролью и доступ к страницам", async () => {
  for (const role of ROLES) {
    const r = await login(`${role}@example.test`, PASS, "10.0.0.1");
    assert.strictEqual(r.status, 303, role);
    const cookie = sid(r);
    assert.match(r.headers.get("set-cookie"), /HttpOnly; SameSite=Lax/);
    const home = await req("/", { cookie });
    assert.strictEqual(home.status, 200, role);
    assert.match(await home.text(), /<h1>Дашборд<\/h1>/);
    for (const p of ["/process", "/sources", "/about", "/calc", "/monitoring"]) assert.strictEqual((await req(p, { cookie })).status, 200, `${role} ${p}`);
    const users = await req("/admin/users", { cookie });
    assert.strictEqual(users.status, role === "admin" ? 200 : 403, `${role} /admin/users`);
    const sources = await (await req("/sources", { cookie })).text();
    assert.strictEqual(sources.includes("Журнал запросов"), ["admin", "sber2b", "team"].includes(role), `${role} журнал`);
  }
});

test("дашборд: показатели, сделки по стадиям, портфель; запуск сделки — только с правом", async () => {
  const cookie = sid(await login("curator@example.test", PASS, "10.0.0.3"));
  const html = await (await req("/", { cookie })).text();
  // плитки — только сделки портала, каждая ведёт к своему отбору в списке
  for (const [label, href] of [["В работе до выдачи", "/deals/list?set=pipe"], ["Заключено за месяц", "/deals/list?set=contract"], ["Дольше 14 дней на стадии", "/deals/list?set=stuck&sort=days"], ["Просроченные задачи", "/tasks?all=1"], ["В мониторинге", "/deals/list?stage=monitoring"], ["В просрочке", "/deals/list?set=overdue"]])
    assert.ok(html.includes(`<a class="tile" href="${href.replace(/&/g, "&amp;")}"><span>${label}</span>`) || html.includes(`<a class="tile" href="${href}"><span>${label}</span>`), label);
  assert.match(html, /переход на «Договор» с 1 по \d+ [а-я]+/);
  assert.strictEqual((html.match(/<li><a href="\/deals\/list\?stage=/g) || []).length, 7, "воронка по семи стадиям");
  assert.match(html, /<h2>Портфель мониторинга на [\d.]+<\/h2>/);
  assert.doesNotMatch(html, /клиентов портфеля в красной зоне/, "портфель — не в плитках сделок");
  assert.ok(!html.includes('action="/deals"'), "куратору форма запуска сделки не показывается");
  const team = sid(await login("team@example.test", PASS, "10.0.0.4"));
  assert.match(await (await req("/", { cookie: team })).text(), /<form class="launch" method="post" action="\/deals" data-draft>/);
  assert.match(html, /href="\/monitoring#card=/);
  assert.match(html, /<a href="\/" aria-current="page">/);
  for (const t of ["Схема процесса", "Источники данных", "О проекте"]) assert.ok(html.includes(t), t);
  assert.ok(!html.includes(">Пользователи<"), "куратору пункт «Пользователи» не показывается");
});

test("схема процесса: семь стадий, рабочие — заявка, оценка клиента и мониторинг", async () => {
  const cookie = sid(await login("curator@example.test", PASS, "10.0.0.2"));
  const html = await (await req("/process", { cookie })).text();
  assert.strictEqual((html.match(/<li class="stage /g) || []).length, 7);
  assert.deepStrictEqual([...html.matchAll(/<li class="stage working" id="(\w+)"/g)].map((m) => m[1]), ["application", "assessment", "monitoring"]);
});

test(`неверный пароль: блокировка после ${LOCK.max_per_email} попыток, даже с верным паролем`, async () => {
  const email = "talk@example.test";
  for (let i = 1; i < LOCK.max_per_email; i++) assert.strictEqual((await login(email, "wrong", "10.0.1.1")).status, 401, `попытка ${i}`);
  const last = await login(email, "wrong", "10.0.1.1");
  assert.strictEqual(last.status, 429);
  assert.ok(+last.headers.get("retry-after") > 0);
  const right = await login(email, PASS, "10.0.1.2");
  assert.strictEqual(right.status, 429, "верный пароль при блокировке тоже отклоняется");
  assert.match(await right.text(), /заблокирован/);
});

test("несуществующий email отвечает так же, как неверный пароль", async () => {
  const r = await login("nobody@example.test", "x", "10.0.2.1");
  assert.strictEqual(r.status, 401);
  assert.match(await r.text(), /Неверный email или пароль/);
});

test("выход завершает сессию", async () => {
  const cookie = sid(await login("team@example.test", PASS, "10.0.3.1"));
  assert.strictEqual((await req("/", { cookie })).status, 200);
  assert.strictEqual((await req("/logout", { method: "POST", cookie })).status, 303);
  assert.strictEqual((await req("/", { cookie })).status, 303);
});

test("POST с чужого источника отклоняется (CSRF)", async () => {
  const r = await req("/login", { method: "POST", form: { email: "admin@example.test", password: PASS }, origin: "https://evil.example" });
  assert.strictEqual(r.status, 403);
  const noOrigin = await req("/login", { method: "POST", form: { email: "admin@example.test", password: PASS }, origin: null });
  assert.strictEqual(noOrigin.status, 403);
});

test("адрес возврата после входа — только локальный путь", async () => {
  const r = await req("/login", { method: "POST", form: { email: "sber2b@example.test", password: PASS, next: "//evil.example/x" }, ip: "10.0.4.1" });
  assert.strictEqual(r.headers.get("location"), "/");
  const ok = await req("/login", { method: "POST", form: { email: "sber2b@example.test", password: PASS, next: "/sources" }, ip: "10.0.4.1" });
  assert.strictEqual(ok.headers.get("location"), "/sources");
});

test("пароль с пробелами по краям (копирование из терминала) принимается", async () => {
  const r = await login("curator@example.test", `  ${PASS}\t`, "10.0.5.1");
  assert.strictEqual(r.status, 303);
  const bad = await login("curator@example.test", "wrong", "10.0.5.1");
  assert.match(await bad.text(), /раскладку/);
});
