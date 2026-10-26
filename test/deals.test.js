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
  // свободный выбор стадии: без текущей, обязателен выбор, с подтверждением
  assert.match(html, /<select name="stage_any" required><option value="">— другая стадия —<\/option><option value="application">/);
  assert.doesNotMatch(html, /<option value="monitoring">/);
  assert.match(html, /value="__any" data-confirm="Перевести сделку «[^"]+» со стадии «Мониторинг» на «\{select\}»\?/);
  assert.match((await get("/deals", team))[1], /const FORWARD = \["application","assessment","decision","contract","monitoring"\]/);
  // после выдачи главной кнопки «дальше» нет: просрочка — отдельное действие с подтверждением
  assert.doesNotMatch(html, /Перевести на стадию/);
  assert.match(html, /value="overdue_30" data-confirm="Отметить просрочку до 30 дней: сделка «[^"]+» перейдёт на стадию «Просрочка до 30 дней»/);
  await post(`/deals/${id}/stage`, team, { stage: "overdue_30" });
  const od = (await get(`/deals/${id}`, team))[1];
  assert.match(od, /value="monitoring" data-confirm="Просрочка погашена/);
  assert.match(od, /value="overdue_30plus" data-confirm="Просрочка свыше 30 дней/);
  assert.strictEqual((await post(`/api/deals/${id}/stage`, curator, { stage: "contract" }, "json")).status, 403);
  assert.strictEqual((await post("/deals", curator, { asset: "Оборудование" })).status, 403);
  const ch = (await get(`/deals/${id}`, curator))[1];
  assert.ok(!ch.includes('class="move"'), "куратору форма смены стадии не показывается");
  assert.ok(!(await get("/deals", curator))[1].includes('draggable="true"'));
  assert.strictEqual((await get("/deals/99999", team))[0], 404);
});

test("карточка сделки: блок клиента (DaData, отчётность по годам) и форма правки", async () => {
  const loc = (await post("/deals", team, { inn: "0000000003", asset: "Оборудование", amount: "12" })).headers.get("location");
  const html = (await get(loc, team))[1];
  assert.match(html, /<h2>Клиент<\/h2>/);
  assert.match(html, /<dt>Адрес<\/dt><dd>условный адрес, г\. Москва<\/dd>/);
  assert.match(html, /<dt>Руководитель<\/dt>/);
  assert.match(html, /Годовая отчётность, тыс\. руб\./);
  assert.match(html, /class="cls cls-3"/);
  assert.match(html, /action="\/deals\/\d+\/edit"/);
  assert.ok(!(await get(loc, curator))[1].includes("/edit\""), "куратору форма правки не показывается");
});

test("правка сделки: поля и история; ИНН указан позже — клиент проверяется заново", async () => {
  const loc = (await post("/deals", team, { asset: "Оборудование", amount: "25,5" })).headers.get("location");
  let r = await post(`${loc}/edit`, team, { inn: "", asset: "Спецтехника", amount: "30", term: "36", comment: "Звонок клиенту в пятницу" });
  assert.strictEqual(r.status, 303);
  let html = (await get(loc, team))[1];
  assert.match(html, /Изменено: предмет Оборудование → Спецтехника; сумма, млн 25\.5 → 30; срок, мес\. — → 36; комментарий — → «Звонок клиенту в пятницу»/);
  assert.match(html, /36 мес\./);
  assert.match(html, /<p class="comment">Звонок клиенту в пятницу<\/p>/);
  r = await post(`${loc}/edit`, team, { inn: "0000000001", asset: "Спецтехника", amount: "30", term: "36", comment: "Звонок клиенту в пятницу" });
  html = (await get(loc, team))[1];
  assert.match(html, /<h1>ООО «Альфа-Пример»<\/h1>/);
  assert.match(html, /Проверка клиента по новому ИНН: ООО «Альфа-Пример», класс 1/);
  // ошибка правки — сообщение в форме, форма раскрыта, значения на месте
  r = await post(`${loc}/edit`, team, { inn: "0000000001", amount: "-5" });
  assert.strictEqual(r.status, 400);
  html = await r.text();
  assert.match(html, /<details class="panel edit" open>/);
  assert.match(html, /Сумма — положительное число/);
  assert.match(html, /name="amount" inputmode="decimal" value="-5" aria-invalid="true"/);
  assert.strictEqual((await post(`${loc}/edit`, curator, { amount: "1" })).status, 403);
});

test("ошибка в форме запуска — на дашборде, введённые значения сохраняются", async () => {
  const r = await post("/deals", team, { inn: "12345", asset: "Оборудование", amount: "7" });
  assert.strictEqual(r.status, 400);
  const html = await r.text();
  assert.match(html, /<h1>Дашборд<\/h1>/);
  assert.match(html, /<p class="error" role="alert">ИНН — 10 или 12 цифр\.<\/p>/);
  assert.match(html, /value="12345" aria-invalid="true"/);
  assert.match(html, /<option selected>Оборудование<\/option>/);
});

test("источник недоступен: условные ответы песочницы в сделку не попадают, «Проверить снова» после восстановления", async () => {
  const dadata = require("../app/connectors/dadata"), fin = require("../app/connectors/fin");
  let down = true;
  const flaky = (c, data) => ({ ...c, ops: Object.fromEntries(Object.entries(c.ops).map(([k, op]) => [k, { ...op, live: async () => { if (down) throw new Error("нет сети"); return data; } }])) });
  const live = [flaky(dadata, { found: true, inn: "7700000000", name: "ООО «Живая»", status: "ACTIVE", status_label: "действует", address: "г. Москва" }),
    flaky(fin, { provider: "girbo", found: true, org: { inn: "7700000000" }, reports: [] })];
  const db2 = open(":memory:");
  createAuth(db2).upsertUser({ email: "team@example.test", role: "team", password: PASS });
  const srv = createApp(db2, { gateway: createGateway({ db: db2, env: {} }), connectors: createConnectors(db2, [require("../app/connectors/cbr"), ...live], { env: { CONNECTOR_CBR_MODE: "sandbox" } }) }).listen(0);
  await new Promise((r) => srv.once("listening", r));
  const b = `http://127.0.0.1:${srv.address().port}`;
  const ck = (await fetch(b + "/login", { method: "POST", redirect: "manual", headers: { origin: b, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "team@example.test", password: PASS }) })).headers.get("set-cookie").split(";")[0];
  const p2 = (path, body) => fetch(b + path, { method: "POST", redirect: "manual", headers: { cookie: ck, origin: b, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
  try {
    const loc = (await p2("/deals", { inn: "7700000000" })).headers.get("location");
    let html = await (await fetch(b + loc, { headers: { cookie: ck } })).text();
    assert.match(html, /<h1>ИНН 7700000000<\/h1>/, "не «ООО «Условная организация»» из песочницы");
    assert.ok(!html.includes("Условная организация") && !html.includes("Альфа-Пример"));
    assert.match(html, /DaData и ГИР БО недоступны: проверка не выполнена/);
    assert.match(html, /action="\/deals\/\d+\/recheck"/);
    down = false;
    await p2(`${loc}/recheck`, {});
    html = await (await fetch(b + loc, { headers: { cookie: ck } })).text();
    assert.match(html, /<h1>ООО «Живая»<\/h1>/);
    assert.match(html, /Повторная проверка клиента: ООО «Живая»/);
  } finally {
    srv.close(); db2.close();
  }
});

test("отказ: при стоп-факторе — главное действие; сделка уходит из воронки и возвращается в работу", async () => {
  const [, board] = await get("/deals", team);
  const gamma = +board.match(/class="kcard demo" href="\/deals\/(\d+)"[^>]*>\s*<b>ООО «Гамма-Пример»/)[1];
  let html = (await get(`/deals/${gamma}`, team))[1];
  assert.match(html, /<div class="refuse stop"><p><b>Стоп-фактор:<\/b> Класс 3 на всех четырёх датах/);
  assert.match(html, /<button type="submit" class="primary" data-confirm="Оформить отказ по сделке «ООО «Гамма-Пример»»/);
  assert.doesNotMatch(html, /<button class="primary" type="submit" name="stage"/, "переход дальше — не главное действие");
  // без причины — ошибка; «Другое» — только с комментарием
  assert.strictEqual((await post(`/deals/${gamma}/refuse`, team, { reason: "" })).status, 400);
  assert.match(await (await post(`/deals/${gamma}/refuse`, team, { reason: "Другое" })).text(), /опишите её в комментарии/);
  const before = (await get("/", team))[1].match(/Сделок в работе<\/span><b>(\d+)/)[1];
  assert.strictEqual((await post(`/deals/${gamma}/refuse`, team, { reason: "Стоп-фактор: класс 3 на всех четырёх датах", comment: "КПА 26.10" })).status, 303);
  html = (await get(`/deals/${gamma}`, team))[1];
  assert.match(html, /<p class="refused-note" role="status"><b>Отказ<\/b> · Стоп-фактор: класс 3 на всех четырёх датах — КПА 26\.10/);
  assert.ok(!html.includes('action="/deals/' + gamma + '/stage"'), "у отказной сделки нет смены стадии");
  assert.match(html, /Вернуть в работу/);
  assert.strictEqual((await get("/", team))[1].match(/Сделок в работе<\/span><b>(\d+)/)[1], String(before - 1));
  const b2 = (await get("/deals", team))[1];
  assert.match(b2, /<details class="panel refused-list"><summary><h2>Отказы<\/h2>/);
  assert.strictEqual((await post(`/api/deals/${gamma}/stage`, team, { stage: "decision" }, "json")).status, 409);
  assert.strictEqual((await post(`/deals/${gamma}/refuse`, curator, { reason: "Клиент отказался" })).status, 403);
  await post(`/deals/${gamma}/reopen`, team, {});
  html = (await get(`/deals/${gamma}`, team))[1];
  assert.match(html, /Сделка возвращена в работу/);
  assert.ok(!html.includes("refused-note"));
});
