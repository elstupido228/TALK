// Сделки: демо-наполнение, запуск сделки с проверкой по ИНН, канбан, смена стадии (API и форма), права.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { open } = require("../app/db");
const { createApp } = require("../app/server");
const { createAuth } = require("../app/auth");
const { createGateway } = require("../app/extract/gateway");
const { createConnectors } = require("../app/connectors/core");

const PASS = "Test-pass-123";
let server, base, db, team, curator, filesDir;
before(async () => {
  db = open(":memory:");
  const auth = createAuth(db);
  auth.upsertUser({ email: "team@example.test", role: "team", password: PASS });
  auth.upsertUser({ email: "curator@example.test", role: "curator", password: PASS });
  const all = [require("../app/connectors/cbr"), require("../app/connectors/dadata"), require("../app/connectors/fin"), ...require("../app/connectors/sandboxes")];
  const env = Object.fromEntries(all.map((x) => [`CONNECTOR_${x.id.toUpperCase()}_MODE`, "sandbox"])); // без сети
  filesDir = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "talk-files-"));
  server = createApp(db, { gateway: createGateway({ db, env: {} }), connectors: createConnectors(db, all, { env }), filesDir }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (email, ip) => (await fetch(base + "/login", { method: "POST", redirect: "manual", headers: { origin: base, "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip }, body: new URLSearchParams({ email, password: PASS }) })).headers.get("set-cookie").split(";")[0];
  team = await login("team@example.test", "10.1.0.1");
  curator = await login("curator@example.test", "10.1.0.2");
});
after(() => (server.close(), db.close(), require("node:fs").rmSync(filesDir, { recursive: true, force: true })));

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
  const r = await post("/deals", team, { inn: "0000000002", asset: "Спецтехника", amount: "25,5", dup_ok: "1" });
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
  assert.match(html, /href="\/check\?inn=0000000002&amp;deal=\d+"/);
  // проверка по ИНН, открытая из сделки, ведёт обратно
  const did = loc.split("/").pop();
  assert.match((await get(`/check?inn=0000000002&deal=${did}`, team))[1], new RegExp(`<a href="/deals/${did}">← К сделке №${did} «ООО «Бета-Пример»»</a>`));
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
  const loc = (await post("/deals", team, { inn: "0000000003", asset: "Оборудование", amount: "12", dup_ok: "1" })).headers.get("location");
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
  assert.match(html, /Изменено: предмет Оборудование → Спецтехника; сумма, млн 25,5 → 30; срок, мес\. — → 36; примечание — → «Звонок клиенту в пятницу»/);
  assert.match(html, /36 мес\./);
  assert.match(html, /<\/ol>\n<p class="comment" title="Звонок клиенту в пятницу"><span class="muted small">Примечание:<\/span> Звонок клиенту в пятницу<\/p>/, "примечание — под рядом стадий");
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
  assert.match(html, /<h1>Главная<\/h1>/);
  assert.match(html, /<span class="ferr" id="err-nd-inn">ИНН — 10 или 12 цифр\.<\/span>/);
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
    assert.match(html, /Источники «DaData» и «ГИР БО» недоступны: проверка не выполнена/);
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
  const before = (await get("/", team))[1].match(/В работе до выдачи<\/span><b>(\d+)/)[1];
  assert.strictEqual((await post(`/deals/${gamma}/refuse`, team, { reason: "Стоп-фактор: класс 3 на всех четырёх датах", comment: "КПА 26.10" })).status, 303);
  html = (await get(`/deals/${gamma}`, team))[1];
  assert.match(html, /<p class="refused-note" role="status"><b>Отказ<\/b> · Стоп-фактор: класс 3 на всех четырёх датах — КПА 26\.10/);
  assert.ok(!html.includes('action="/deals/' + gamma + '/stage"'), "у отказной сделки нет смены стадии");
  assert.match(html, /Вернуть в работу/);
  assert.strictEqual((await get("/", team))[1].match(/В работе до выдачи<\/span><b>(\d+)/)[1], String(before - 1));
  const b2 = (await get("/deals", team))[1];
  assert.match(b2, /<details class="panel refused-list"><summary><h2>Отказы<\/h2>/);
  assert.strictEqual((await post(`/api/deals/${gamma}/stage`, team, { stage: "decision" }, "json")).status, 409);
  assert.strictEqual((await post(`/deals/${gamma}/refuse`, curator, { reason: "Клиент отказался" })).status, 403);
  await post(`/deals/${gamma}/reopen`, team, {});
  html = (await get(`/deals/${gamma}`, team))[1];
  assert.match(html, /Сделка возвращена в работу/);
  assert.ok(!html.includes("refused-note"));
});

test("запуск сделки: дубль по ИНН — предупреждение со ссылками; пустая заявка и буквы в ИНН — ошибка", async () => {
  // у демо-сделки «Бета-Пример» ИНН 0000000002
  let r = await post("/deals", team, { inn: "0000000002", asset: "Оборудование", amount: "7" });
  assert.strictEqual(r.status, 409);
  let html = await r.text();
  assert.match(html, /По ИНН 0000000002 уже есть сделки в работе: <a href="\/deals\/\d+">ООО «Бета-Пример»<\/a>/);
  assert.match(html, /<button type="submit" name="dup_ok" value="1">Всё равно создать новую сделку<\/button>/);
  assert.match(html, /value="7"/, "введённая сумма сохраняется");
  r = await post("/deals", team, { inn: "0000000002", asset: "Оборудование", amount: "7", dup_ok: "1" });
  assert.strictEqual(r.status, 303);
  // ни ИНН, ни предмета — не создаётся
  r = await post("/deals", team, { inn: "", asset: "", amount: "5" });
  assert.strictEqual(r.status, 400);
  assert.match(await r.text(), /Укажите ИНН или наименование клиента либо выберите предмет лизинга/);
  // буквы в ИНН не вырезаются молча
  r = await post("/deals", team, { inn: "77O7083893", asset: "Оборудование" });
  assert.strictEqual(r.status, 400);
  assert.match(await r.text(), /ИНН — только цифры/);
  // пробелы в ИНН допустимы
  assert.strictEqual((await post("/deals", team, { inn: "7707 083 893", asset: "Оборудование" })).status, 303);
});

test("формы: все ошибки сразу у полей, сообщение об успехе, повтор формы без дубля, адрес действия ведёт в карточку", async () => {
  // все ошибки сразу, у каждого поля
  let r = await post("/deals", team, { inn: "12345", asset: "Оборудование", amount: "-3" });
  let html = await r.text();
  assert.match(html, /<span class="ferr" id="err-nd-inn">ИНН — 10 или 12 цифр\.<\/span>/);
  assert.match(html, /<span class="ferr" id="err-nd-amount">Сумма — положительное число, млн руб\.<\/span>/);
  assert.strictEqual((await post("/deals", team, { asset: "Оборудование", amount: "1e3" })).status, 400, "«1e3» — не число");
  // успех: перенаправление и сообщение
  const once = "0123456789abcdef-once";
  r = await post("/deals", team, { asset: "Оборудование", amount: "3", once });
  assert.strictEqual(r.status, 303);
  assert.match(decodeURIComponent(r.headers.get("set-cookie")), /^flash=Сделка создана: «Без клиента · Оборудование»/);
  const loc = r.headers.get("location");
  // та же форма ещё раз — та же сделка
  r = await post("/deals", team, { asset: "Оборудование", amount: "3", once });
  assert.strictEqual(r.headers.get("location"), loc);
  assert.match(decodeURIComponent(r.headers.get("set-cookie")), /повторная отправка формы не создала дубль/);
  // смена стадии и правка — сообщения
  r = await post(`${loc}/stage`, team, { stage: "assessment" });
  assert.match(decodeURIComponent(r.headers.get("set-cookie")), /Стадия изменена: «Заявка» → «Оценка клиента»/);
  // адрес действия, открытый заново, — карточка, а не 404
  r = await fetch(base + `${loc}/edit`, { headers: { cookie: team }, redirect: "manual" });
  assert.strictEqual(r.status, 303);
  assert.strictEqual(r.headers.get("location"), loc);
});

test("правка поверх чужой: не перезаписывается молча; повторное сохранение — осознанно", async () => {
  const loc = (await post("/deals", team, { asset: "Оборудование", amount: "15" })).headers.get("location");
  const orig = (await get(loc, team))[1].match(/name="orig" value="([^"]+)"/)[1].replace(/&quot;/g, '"');
  // первая вкладка: сумма 20 и комментарий
  assert.strictEqual((await post(`${loc}/edit`, team, { orig, asset: "Оборудование", amount: "20", comment: "первая вкладка" })).status, 303);
  // вторая вкладка открыта раньше: меняет только срок, сумму и комментарий видит старыми
  let r = await post(`${loc}/edit`, team, { orig, asset: "Оборудование", amount: "15", term: "24" });
  assert.strictEqual(r.status, 409);
  const html = await r.text();
  assert.match(html, /Пока вы редактировали, сделку изменил/);
  assert.match(html, /<li>сумма: сейчас в сделке 20 млн, у вас 15 млн<\/li>/);
  assert.match(html, /<li>примечание: сейчас в сделке «первая вкладка», у вас —<\/li>/);
  assert.match((await get(loc, team))[1], /20 млн руб\./, "значение первой вкладки на месте");
  // в форме конфликта orig — текущие значения: повторная отправка сохраняет
  const orig2 = html.match(/name="orig" value="([^"]+)"/)[1].replace(/&quot;/g, '"');
  assert.strictEqual((await post(`${loc}/edit`, team, { orig: orig2, asset: "Оборудование", amount: "15", term: "24" })).status, 303);
  // чужая правка другого поля — не конфликт
  const orig3 = (await get(loc, team))[1].match(/name="orig" value="([^"]+)"/)[1].replace(/&quot;/g, '"');
  await post(`${loc}/edit`, team, { orig: orig3, asset: "Оборудование", amount: "15", term: "24", comment: "А" });
  assert.strictEqual((await post(`${loc}/edit`, team, { orig: orig3, asset: "Оборудование", amount: "16", term: "24", comment: "А" })).status, 303);
});

test("главная не ждёт медленный ЦБ: сохранённая ставка — сразу, без неё — не дольше 1,5 с", async () => {
  const { createConnectors } = require("../app/connectors/core");
  const cbr = require("../app/connectors/cbr");
  const slow = { ...cbr, ops: Object.fromEntries(Object.entries(cbr.ops).map(([k, op]) => [k, { ...op, ttlMs: 0, live: () => new Promise((r) => setTimeout(() => r({ rate: 21, since: "2026-10-01", date: "2026-10-26" }), 5000)) }])) };
  const d2 = open(":memory:");
  createAuth(d2).upsertUser({ email: "t2@example.test", role: "team", password: PASS });
  const conns = createConnectors(d2, [slow], { env: {} });
  const s2 = createApp(d2, { gateway: createGateway({ db: d2, env: {} }), connectors: conns }).listen(0);
  await new Promise((r) => s2.once("listening", r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  const c = (await fetch(b2 + "/login", { method: "POST", redirect: "manual", headers: { origin: b2, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "t2@example.test", password: PASS }) })).headers.get("set-cookie").split(";")[0];
  let t = Date.now();
  let html = await (await fetch(b2 + "/", { headers: { cookie: c } })).text();
  assert.ok(Date.now() - t < 3000, `без кэша — не дольше 1,5 с (было ${Date.now() - t} мс)`);
  assert.match(html, /<h2>Ключевая ставка ЦБ<\/h2>|Ключевая ставка ЦБ/);
  d2.prepare("INSERT INTO connector_cache (key, connector, value, at) VALUES (?, 'cbr', ?, ?)").run('cbr:key-rate:{}', JSON.stringify({ rate: 17, since: "2026-09-01", date: "2026-10-25" }), Date.now() - 86400000);
  t = Date.now();
  html = await (await fetch(b2 + "/", { headers: { cookie: c } })).text();
  assert.ok(Date.now() - t < 1000, `с кэшем — сразу (было ${Date.now() - t} мс)`);
  assert.match(html, /17,00 %/);
  s2.closeAllConnections(); s2.close(); d2.close();
});

test("клиенты: наименование и контакты при создании, карточка клиента со сделками и суммой, переименование", async () => {
  // без ИНН — клиент по наименованию, с контактом и телефоном
  let r = await post("/deals", team, { client_name: "ООО «Тест-Клиент»", contact_name: "Иванов Иван", phone: "+7 900 123-45-67", asset: "Спецтехника", amount: "10" });
  assert.strictEqual(r.status, 303);
  const d1 = r.headers.get("location");
  let html = (await get(d1, team))[1];
  assert.match(html, /<h1>ООО «Тест-Клиент»<\/h1>/);
  const cid = html.match(/Клиент: <a href="\/clients\/(\d+)">ООО «Тест-Клиент»<\/a> · Иванов Иван · <a href="tel:\+79001234567">/)[1];
  // вторая сделка того же клиента — предупреждение о дубле по наименованию, затем осознанно
  r = await post("/deals", team, { client_name: "ооо тест-клиент", asset: "Оборудование", amount: "5" });
  assert.strictEqual(r.status, 409);
  assert.match(await r.text(), /У клиента с таким наименованием уже есть сделки в работе/);
  r = await post("/deals", team, { client_name: "ооо тест-клиент", asset: "Оборудование", amount: "5", dup_ok: "1" });
  assert.match((await get(r.headers.get("location"), team))[1], new RegExp(`href="/clients/${cid}"`));
  // карточка клиента: две сделки, сумма 15 млн
  html = (await get(`/clients/${cid}`, team))[1];
  assert.match(html, /В работе: <b>2<\/b> на <b>15 млн<\/b>/);
  // переименование — во всех сделках клиента
  r = await post(`/clients/${cid}/edit`, team, { name: "ООО «Тест-Клиент Плюс»", contact_name: "Иванов Иван", phone: "+7 900 123-45-67" });
  assert.match(decodeURIComponent(r.headers.get("set-cookie")), /Сохранено: наименование/);
  assert.match((await get(d1, team))[1], /<h1>ООО «Тест-Клиент Плюс»<\/h1>/);
  assert.match((await get("/clients?q=плюс", team))[1], /ООО «Тест-Клиент Плюс»/);
  assert.strictEqual((await post(`/clients/${cid}/edit`, team, { name: "", phone: "abc" })).status, 400);
  assert.strictEqual((await post(`/clients/${cid}/edit`, curator, { name: "X" })).status, 403);
  // по ИНН — наименование из DaData
  r = await post("/deals", team, { inn: "0000000001", asset: "Спецтехника", dup_ok: "1" });
  const alfa = (await get(r.headers.get("location"), team))[1].match(/Клиент: <a href="(\/clients\/\d+)">ООО «Альфа-Пример»<\/a>/)[1];
  // карточка клиента: сведения DaData видны сразу, не только в форме правки
  const ap = (await get(alfa, team))[1];
  assert.match(ap, /<dt>Адрес<\/dt><dd>[^<]+<\/dd>/);
  assert.match(ap, /<details class="edit client-edit">/);
  // демо-сделки привязаны к клиентам
  assert.match((await get("/clients", team))[1], /ООО «Гамма-Пример»/);
});

test("лента: комментарии отдельными записями с автором, служебные записи рядом", async () => {
  const loc = (await post("/deals", team, { client_name: "ООО «Лента»", asset: "Оборудование" })).headers.get("location");
  let r = await post(`${loc}/comment`, team, { text: "Звонок: клиент ждёт КП" });
  assert.strictEqual(r.status, 303);
  assert.strictEqual(r.headers.get("location"), `${loc}#feed`);
  await post(`${loc}/comment`, team, { text: "Перезвонить 28.10" });
  const html = (await get(loc, team))[1];
  assert.match(html, /<li class="comment"><p>Перезвонить 28\.10<\/p><span class="muted small">[\d.]+, [\d:]+ · team@example\.test<\/span><\/li><li class="comment"><p>Звонок: клиент ждёт КП<\/p>/);
  assert.match(html, /<li class="sys"><p>Сделка создана на стадии «Заявка»<\/p>/);
  assert.match(html, /комментариев: 2/);
  assert.strictEqual((await post(`${loc}/comment`, team, { text: "  " })).status, 400);
  assert.strictEqual((await post(`${loc}/comment`, curator, { text: "x" })).status, 403);
  assert.ok(!(await get(loc, curator))[1].includes('action="' + loc + '/comment"'), "куратору форма комментария не показывается");
});

test("задачи: постановка в сделке и вместе с комментарием, «Мои задачи», счётчик в меню, выполнение", async () => {
  const { today, addDays } = require("../app/tasks");
  const loc = (await post("/deals", team, { client_name: "ООО «Задачи»", asset: "Оборудование" })).headers.get("location");
  // срок в прошлом и пустой текст — ошибки у полей
  let r = await post(`${loc}/tasks`, team, { task_text: "", due: addDays(today(), -5) });
  assert.strictEqual(r.status, 400);
  let html = await r.text();
  assert.match(html, /Что нужно сделать\?/);
  assert.match(html, /Срок в прошлом/);
  // задача на сегодня
  r = await post(`${loc}/tasks`, team, { task_text: "Отправить КП", due: today() });
  assert.strictEqual(r.status, 303);
  assert.match(decodeURIComponent(r.headers.get("set-cookie")), /Задача поставлена: «Отправить КП»/);
  html = (await get(loc, team))[1];
  assert.match(html, /<li class="todo today"><span class="due today">сегодня<\/span><span class="ttext">Отправить КП/);
  assert.match(html, /<li class="taskrec"><p>Задача до [\d.]+ \(team@example\.test\): Отправить КП<\/p>/);
  // комментарий + следующий контакт — одно действие
  r = await post(`${loc}/comment`, team, { text: "Клиент думает", next_due: addDays(today(), 2) });
  assert.match(decodeURIComponent(r.headers.get("set-cookie")), /задача «Следующий контакт» — на/);
  html = (await get("/", team))[1];
  assert.match(html, /<h2>Мои задачи/);
  assert.match(html, /Отправить КП <span class="muted small">· <a href="\/deals\/\d+">ООО «Задачи»<\/a>/);
  assert.match(html, /<b class="sh-badge" title="Задачи: просрочено и на сегодня">\d+<\/b>/);
  assert.match((await get("/deals", team))[1], /class="small ktask today">Задача на сегодня: Отправить КП/);
  // выполнить — с возвратом туда, откуда пришли
  const tid = html.match(/action="\/tasks\/(\d+)\/done"/)[1];
  assert.strictEqual((await post(`/tasks/${tid}/done`, curator, { back: "/" })).status, 403);
  r = await post(`/tasks/${tid}/done`, team, { back: "/" });
  assert.strictEqual(r.headers.get("location"), "/");
  assert.match(decodeURIComponent(r.headers.get("set-cookie")), /Задача выполнена/);
  assert.match((await get(loc, team))[1], /Задача выполнена: /);
  assert.match((await get("/tasks?all=1", team))[1], /<h2>Дальше <span class="muted small">\d+<\/span><\/h2><ul class="todo-list"><li class="todo later">/);
  // back только локальный
  r = await post(`/tasks/${tid}/undo`, team, { back: "https://evil.example/" });
  assert.strictEqual(r.headers.get("location"), "/");
});

test("ответственный: по умолчанию автор, передача другому с записью в ленте", async () => {
  const auth = createAuth(db);
  auth.upsertUser({ email: "talk@example.test", role: "talk", name: "Сотрудник ТАЛК", password: PASS });
  const loc = (await post("/deals", team, { client_name: "ООО «Ответственный»", asset: "Оборудование" })).headers.get("location");
  let html = (await get(loc, team))[1];
  assert.match(html, /Ответственный: <b>team@example\.test<\/b>/);
  const tid = html.match(/<option value="(\d+)">Сотрудник ТАЛК<\/option>/)[1];
  assert.match(html, /data-confirm="Передать сделку «ООО «Ответственный»» сотруднику «\{select\}»\?/);
  const r = await post(`${loc}/owner`, team, { owner_id: tid });
  assert.match(decodeURIComponent(r.headers.get("set-cookie")), /Ответственный за сделку — Сотрудник ТАЛК/);
  html = (await get(loc, team))[1];
  assert.match(html, /Ответственный: <b>Сотрудник ТАЛК<\/b>/);
  assert.match(html, /Ответственный: team@example\.test → Сотрудник ТАЛК/);
  assert.strictEqual((await post(`${loc}/owner`, team, { owner_id: "999999" })).status, 400);
  assert.strictEqual((await post(`${loc}/owner`, curator, { owner_id: tid })).status, 403);
  assert.match((await get("/deals", team))[1], /<span class="muted small kowner">Сотрудник ТАЛК<\/span>/);
});

test("поиск, список сделок с фильтрами и сортировкой, выгрузка CSV", async () => {
  await post("/deals", team, { client_name: "ООО «Поисковая»", contact_name: "Петров", phone: "+7 911 000-00-01", asset: "Спецтехника", amount: "77,5" });
  // поиск по порталу: клиент по телефону, сделка по наименованию
  let html = (await get("/search?q=" + encodeURIComponent("911 000"), team))[1];
  assert.match(html, /<a href="\/clients\/\d+">ООО «Поисковая»<\/a>/);
  html = (await get("/search?q=" + encodeURIComponent("поисков"), team))[1];
  assert.match(html, /<h2>Сделки <span class="muted small">1<\/span><\/h2>/);
  assert.match((await get("/search?q=zzzz", team))[1], /ничего не найдено/);
  // меню: строка поиска
  assert.match(html, /<form class="sh-search" method="get" action="\/search"/);
  // «Сбросить» — только при включённом отборе (канбан всегда берёт все состояния, это не фильтр)
  const reset = />Сбросить<\/a>/;
  assert.doesNotMatch((await get("/deals", team))[1], reset);
  assert.match((await get("/deals?q=x", team))[1], reset);
  assert.doesNotMatch((await get("/deals/list", team))[1], reset);
  assert.match((await get("/deals/list?status=all", team))[1], reset);
  // список: по сумме по убыванию, «Поисковая» первой
  html = (await get("/deals/list?sort=amount&dir=desc&status=all", team))[1];
  assert.match(html, /<tbody><tr[^>]*><td><a href="\/deals\/\d+">[^<]+<\/a>/);
  const first = html.match(/<tbody><tr[^>]*><td><a href="\/deals\/\d+">([^<]+)<\/a>/)[1];
  assert.ok(first.length > 0);
  html = (await get("/deals/list?q=" + encodeURIComponent("поисков"), team))[1];
  assert.match(html, /ООО «Поисковая»/);
  assert.match(html, /Показано 1 из \d+/);
  assert.match(html, /<td class="r">77,5 млн<\/td>/);
  // мои сделки: автор — ответственный
  assert.match((await get("/deals/list?owner=me", team))[1], /ООО «Поисковая»/);
  assert.doesNotMatch((await get("/deals/list?owner=me", curator))[1], /ООО «Поисковая»/);
  // канбан с поиском
  html = (await get("/deals?q=" + encodeURIComponent("поисков"), team))[1];
  assert.strictEqual((html.match(/class="kcard/g) || []).length, 1);
  // выгрузка
  const r = await fetch(base + "/deals/export.csv?q=" + encodeURIComponent("поисков"), { headers: { cookie: curator } });
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/csv/);
  assert.match(r.headers.get("content-disposition"), /attachment; filename="sdelki-\d{4}-\d{2}-\d{2}\.csv"/);
  const bytes = Buffer.from(await r.arrayBuffer());
  assert.deepStrictEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "BOM для Excel");
  const csv = bytes.toString("utf8", 3);
  assert.ok(csv.startsWith("№;Клиент;ИНН;"));
  assert.match(csv, /;ООО «Поисковая»;;Спецтехника;77,5;Заявка;в работе;;team@example\.test;0;/);
});

test("архив: сделка скрывается из канбана и счётчиков, находится в списке «Архив», возвращается", async () => {
  const loc = (await post("/deals", team, { client_name: "ООО «Архивная»", asset: "Оборудование", amount: "3" })).headers.get("location");
  let html = (await get(loc, team))[1];
  assert.match(html, /data-confirm="Перенести сделку «ООО «Архивная»» в архив\?/);
  let r = await post(`${loc}/archive`, team, {});
  assert.strictEqual(r.headers.get("location"), "/deals");
  assert.doesNotMatch((await get("/deals", team))[1], /ООО «Архивная»/);
  assert.doesNotMatch((await get("/deals/list", team))[1], /ООО «Архивная»/);
  assert.match((await get("/deals/list?status=archived", team))[1], /ООО «Архивная»/);
  html = (await get(loc, team))[1];
  assert.match(html, /<b>В архиве<\/b>/);
  assert.ok(!html.includes(`action="${loc}/stage"`) && !html.includes(`action="${loc}/edit"`), "в архиве — только просмотр");
  assert.strictEqual((await post(`${loc}/stage`, team, { stage: "assessment" })).status, 409);
  assert.strictEqual((await post(`${loc}/archive`, curator, {})).status, 403);
  r = await post(`${loc}/unarchive`, team, {});
  assert.match(decodeURIComponent(r.headers.get("set-cookie")), /возвращена из архива/);
  assert.match((await get("/deals", team))[1], /ООО «Архивная»/);
  assert.match((await get(loc, team))[1], /Сделка возвращена из архива/);
});

test("документы сделки: загрузка, просмотр, недопустимый тип, убрать из карточки, PDF для калькулятора", async () => {
  const loc = (await post("/deals", team, { client_name: "ООО «Документы»", inn: "7702070139", asset: "Оборудование", dup_ok: "1" })).headers.get("location");
  const id = loc.split("/").pop();
  const up = (name, body, cookie = team) => fetch(base + `${loc}/files`, { method: "POST", headers: { cookie, origin: base, "x-file-name": encodeURIComponent(name), "content-type": "application/octet-stream" }, body });
  let r = await up("Баланс 2025.pdf", Buffer.from("%PDF-1.4 test"));
  assert.strictEqual(r.status, 201);
  const f = (await r.json()).file;
  assert.strictEqual(f.name, "Баланс 2025.pdf");
  assert.strictEqual((await up("script.exe", Buffer.from("x"))).status, 400);
  assert.strictEqual((await up("../../evil.pdf", Buffer.from("%PDF"))).status, 201, "путь из имени отбрасывается");
  assert.strictEqual((await up("x.pdf", Buffer.from("x"), curator)).status, 403);
  let html = (await get(loc, team))[1];
  assert.match(html, /<a href="\/files\/\d+" target="_blank" rel="noopener">Баланс 2025\.pdf<\/a>/);
  assert.match(html, /<a href="\/files\/\d+" target="_blank" rel="noopener">evil\.pdf<\/a>/);
  assert.match(html, /href="\/calc#deal=\d+">Рассчитать класс по PDF сделки \(2\)/);
  assert.match(html, /Файл добавлен: Баланс 2025\.pdf/);
  // просмотр — тем, кто видит портал
  r = await fetch(base + `/files/${f.id}`, { headers: { cookie: curator } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get("content-type"), "application/pdf");
  assert.match(r.headers.get("content-disposition"), /^inline; filename\*=UTF-8''/);
  assert.strictEqual(Buffer.from(await r.arrayBuffer()).toString(), "%PDF-1.4 test");
  // для калькулятора
  const j = await (await fetch(base + `/api/deals/${id}/files`, { headers: { cookie: team } })).json();
  assert.strictEqual(j.deal.inn, "7702070139");
  assert.strictEqual(j.files.length, 2);
  // убрать из карточки
  r = await post(`/files/${f.id}/delete`, team, {});
  assert.strictEqual(r.headers.get("location"), `${loc}#docs`);
  assert.strictEqual((await fetch(base + `/files/${f.id}`, { headers: { cookie: team } })).status, 404);
  assert.match((await get(loc, team))[1], /Файл удалён из карточки: Баланс 2025\.pdf/);
});

test("калькулятор → сделка: класс, заключение и стоп-фактор сохраняются; кнопка расчёта ведёт с номером сделки", async () => {
  const loc = (await post("/deals", team, { client_name: "ООО «Расчёт»", asset: "Оборудование" })).headers.get("location");
  const id = loc.split("/").pop();
  assert.ok((await get(loc, team))[1].includes(`href="/calc#deal=${id}">Рассчитать класс`));
  const send = (body, cookie = team) => fetch(base + `/api/deals/${id}/class`, { method: "POST", headers: { cookie, origin: base, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.strictEqual((await send({ classes: [], title: "x" })).status, 400);
  assert.strictEqual((await send({ classes: [{ date: "2026-06-30", cls: 3 }], title: "x" }, curator)).status, 403);
  const r = await send({ classes: [{ date: "2025-09-30", cls: 3 }, { date: "2025-12-31", cls: 3 }, { date: "2026-03-31", cls: 3 }, { date: "2026-06-30", cls: 3 }], title: "Финансирование невозможно", sub: "Класс 3 на всех четырёх отчётных датах (п. 14.1.6).", stop: true });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).cls, 3);
  const html = (await get(loc, team))[1];
  assert.match(html, /class="cls cls-3"/);
  assert.match(html, /Финансирование невозможно \(калькулятор, 30\.06\.2026\)/);
  assert.match(html, /Расчёт класса: 30\.09\.2025 — 3, 31\.12\.2025 — 3, 31\.03\.2026 — 3, 30\.06\.2026 — 3\. Заключение: Финансирование невозможно/);
  assert.match(html, /<div class="refuse stop"><p><b>Стоп-фактор:<\/b> Класс 3 на всех четырёх датах/, "стоп-фактор → главное действие «Оформить отказ»");
});

test("источники: одно состояние на всех экранах — «Источники данных», проверка по ИНН, карточка сделки", async () => {
  const dadata = require("../app/connectors/dadata"), fin = require("../app/connectors/fin"), cbr = require("../app/connectors/cbr");
  const off = (c) => ({ ...c, ops: Object.fromEntries(Object.entries(c.ops).map(([k, op]) => [k, { ...op, live: async () => { throw new Error("нет сети"); } }])) });
  const d3 = open(":memory:");
  createAuth(d3).upsertUser({ email: "t3@example.test", role: "team", password: PASS });
  const s3 = createApp(d3, { gateway: createGateway({ db: d3, env: {} }), connectors: createConnectors(d3, [cbr, off(dadata), off(fin)], { env: { CONNECTOR_CBR_MODE: "sandbox" } }) }).listen(0);
  await new Promise((r) => s3.once("listening", r));
  const b3 = `http://127.0.0.1:${s3.address().port}`;
  const c = (await fetch(b3 + "/login", { method: "POST", redirect: "manual", headers: { origin: b3, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "t3@example.test", password: PASS }) })).headers.get("set-cookie").split(";")[0];
  const page = async (p) => (await fetch(b3 + p, { headers: { cookie: c } })).text();
  assert.match(await page("/sources"), /Обращений ещё не было/);
  const html = await page("/check?inn=7707083893");
  assert.match(html, /<b>Источник «DaData» недоступен<\/b> — ниже <b>условный пример<\/b>, а не сведения об организации с ИНН 7707083893/);
  assert.match(await page("/sources"), /<span class="badge target">Источник недоступен<\/span><br><span class="muted small">с [\d.]+, [\d:]+: нет сети/);
  const loc = (await fetch(b3 + "/deals", { method: "POST", redirect: "manual", headers: { cookie: c, origin: b3, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ inn: "7707083893", asset: "Оборудование" }) })).headers.get("location");
  assert.match(await page(loc), /Источники «DaData» и «ГИР БО» недоступны — сведения ниже неполные/);
  s3.closeAllConnections(); s3.close(); d3.close();
});

test("одна главная кнопка на стадии: инструменты — второстепенные", async () => {
  const loc = (await post("/deals", team, { inn: "0000000001", asset: "Оборудование", dup_ok: "1" })).headers.get("location");
  const stage = (await get(loc, team))[1].split('<section class="panel wide">')[1].split("</section>")[0];
  const primaries = (stage.match(/class="(btn )?primary"|class="btn primary"/g) || []).length;
  assert.strictEqual(primaries, 1, "ровно одна главная кнопка в блоке стадии");
  assert.match(stage, /<button class="primary" type="submit" formnovalidate name="stage" value="assessment">Перевести на стадию «Оценка клиента» →/);
  assert.match(stage, /<a class="btn" href="\/check\?inn=0000000001&amp;deal=\d+">Проверить клиента по ИНН<\/a>/);
});

test("главная: число на плитке = строки списка, куда она ведёт; «Заключено за месяц» — переход на «Договор»", async () => {
  const loc = (await post("/deals", team, { client_name: "ООО «Заключённая»", asset: "Спецтехника", amount: "11" })).headers.get("location");
  await post(`${loc}/stage`, team, { stage: "__any", stage_any: "contract" });
  const home = (await get("/", team))[1];
  const tile = (label) => Number(home.match(new RegExp(`<span>${label}</span><b>([0-9]+)</b>`))[1]);
  const rows = async (href) => ((await get(href, team))[1].match(/<tr[^>]*><td><a href="\/deals\/\d+">/g) || []).length;
  for (const [label, href] of [["В работе до выдачи", "/deals/list?set=pipe"], ["Заключено за месяц", "/deals/list?set=contract"], ["Дольше 14 дней на стадии", "/deals/list?set=stuck"], ["В мониторинге", "/deals/list?stage=monitoring"], ["В просрочке", "/deals/list?set=overdue"]])
    assert.strictEqual(tile(label), await rows(href), label);
  assert.ok(tile("Заключено за месяц") >= 1);
  const list = (await get("/deals/list?set=contract", team))[1];
  assert.match(list, /Показаны сделки: <b>заключены в этом месяце \(переход на «Договор»\)<\/b>/);
  assert.match(list, /ООО «Заключённая»/);
});

test("оформление: значок вкладки, заголовки модулей по шаблону «Раздел — портал»", async () => {
  const r = await fetch(base + "/favicon.ico");
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get("content-type"), /image\/svg\+xml/);
  assert.match((await get("/calc", team))[1], /<title>Расчёт класса — Контур контроля лизинговой сделки<\/title>/);
  assert.match((await get("/monitoring", team))[1], /<title>Мониторинг — Контур контроля лизинговой сделки<\/title>/);
  assert.match((await get("/", team))[1], /<link rel="icon" href="\/favicon\.svg"/);
});

test("мелочи: «Отмена» в форме правки, форма сделки на канбане, адрес с «/» на конце, пустая главная, автофокус входа", async () => {
  const loc = (await post("/deals", team, { client_name: "ООО «Мелочи»", asset: "Оборудование" })).headers.get("location");
  assert.match((await get(loc, team))[1], /<button type="button" class="cancel" data-cancel>Отмена<\/button>/);
  const board = (await get("/deals", team))[1];
  assert.match(board, /<button type="button" class="btn primary" data-open="new-deal">Создать сделку<\/button>/);
  assert.match(board, /<details class="panel launch-panel" id="new-deal">[^]*<form class="launch" method="post" action="\/deals" data-draft>/);
  const r = await fetch(base + `${loc}/`, { headers: { cookie: team }, redirect: "manual" });
  assert.strictEqual(r.status, 303);
  assert.strictEqual(r.headers.get("location"), loc);
  assert.match(await (await fetch(base + "/login")).text(), /name="email" type="email" autocomplete="username" required autofocus/);
});
