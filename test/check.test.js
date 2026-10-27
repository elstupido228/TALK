// Шаг 6: коннекторы DaData, отчётность (ГИР БО / parser-api), песочницы; «Проверка по ИНН».
// Внешние API подменяются (global.fetch), чтобы тесты не зависели от сети и ключей.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const C = require("../seed/calc/core.js");
const demo = require("../seed/calc/demo_synthetic.json");
const dadata = require("../app/connectors/dadata");
const fin = require("../app/connectors/fin");
const sandboxes = require("../app/connectors/sandboxes");
const { toDocs, annualClasses } = require("../app/check");
const { open } = require("../app/db");
const { createApp } = require("../app/server");
const { createAuth } = require("../app/auth");
const { createGateway } = require("../app/extract/gateway");
const { createConnectors } = require("../app/connectors/core");

async function withFetch(handler, fn) {
  const orig = global.fetch;
  global.fetch = async (url, init) => handler(String(url), init);
  try { return await fn(); } finally { global.fetch = orig; }
}
const json = (status, obj) => ({ ok: status < 400, status, json: async () => obj, text: async () => JSON.stringify(obj) });

test("годовой класс по песочнице совпадает с классом калькулятора на ту же дату (пакеты A, B, C)", async () => {
  for (const p of demo.packages) {
    const f = await fin.ops.reports.sandbox({ inn: p.inn });
    const y2025 = annualClasses(f).find((y) => y.year === 2025);
    // в калькуляторе баланс на 31.12.2025 и ОПиУ за 12 мес. 2025 — графа H (дата 01.01.2026; графы E, F, H, J, L — минус 12, 9, 6, 3 и 0 мес.)
    const cons = C.consolidate(p.docs), V = {};
    for (const [row, code] of Object.entries(C.TPL_ROWS)) V[row] = cons.cells.H[code].value;
    assert.strictEqual(y2025.cls, C.calcColumn(V, {}, true).cls, `пакет ${p.id}`);
    assert.strictEqual(y2025.cls, p.expected_class, `пакет ${p.id}`);
    // документы для калькулятора: баланс на 31.12.2025 — основная графа, даты окна от 01.01.2025 до 01.01.2026
    const c2 = C.consolidate(toDocs(f));
    assert.deepStrictEqual([c2.dates[0], c2.dates[4]], ["2025-01-01", "2026-01-01"]);
    assert.strictEqual(c2.cells.L["1600"].value, cons.cells.H["1600"].value);
    assert.strictEqual(c2.cells.F["1600"].value, null, "квартальных дат в открытых источниках нет");
  }
});

test("ГИР БО: поиск по ИНН, графы баланса и ОПиУ, упрощённая форма", async () => {
  const bal = { current1200: 500, previous1200: 400, beforePrevious1200: 300, current1600: 900, previous1600: 800, beforePrevious1600: 700, current1370: -5 };
  const fr = { current2110: 1000, previous2110: 950, current2400: 30, previous2400: null };
  const seen = [];
  const res = await withFetch((url) => {
    seen.push(url.replace("https://bo.nalog.gov.ru", ""));
    if (url.includes("/search")) return json(200, { content: [{ id: 9, inn: "<strong>1234567890</strong>", shortName: "ООО «Тест»", ogrn: "1", statusCode: "ACTIVE" }] });
    return json(200, [{ id: 1, period: "2025", knd: "0710096", actualBfoDate: "2026-03-01", typeCorrections: [{ type: 12, correction: { balance: bal, financialResult: fr } }] }]);
  }, () => fin.ops.reports.live({ inn: "1234567890" }, { env: {} }));
  assert.deepStrictEqual(seen, ["/advanced-search/organizations/search?query=1234567890&page=0", "/nbo/organizations/9/bfo/"]);
  assert.strictEqual(res.provider, "girbo");
  const r = res.reports[0];
  assert.deepStrictEqual([r.year, r.variant], [2025, "simplified"]);
  assert.deepStrictEqual([r.balance.current["1200"], r.balance.previous["1200"], r.balance.beforePrevious["1200"], r.balance.current["1370"], r.balance.current["1230"]], [500, 400, 300, -5, null]);
  assert.deepStrictEqual([r.pnl.current["2110"], r.pnl.previous["2110"], r.pnl.previous["2400"]], [1000, 950, null]);
});

test("ГИР БО недоступен -> parser-api; без ключа — понятная ошибка", async () => {
  const handler = (url) => {
    if (url.startsWith("https://bo.nalog.gov.ru")) return json(503, {});
    if (url.includes("/search")) return json(200, { success: 1, items: [{ id: 7, inn: "1234567890", short_name: "ООО «Тест»" }] });
    return json(200, { success: 1, reports: [{ period: "2025", balance: [{ code: 1600, current: 900, previous: 800, before_previous: 700 }], financial_result: [{ code: 2110, current: 1000, previous: 950 }] }] });
  };
  const res = await withFetch(handler, () => fin.ops.reports.live({ inn: "1234567890" }, { env: { PARSERAPI_KEY: "k" } }));
  assert.strictEqual(res.provider, "parser-api");
  assert.deepStrictEqual([res.reports[0].balance.beforePrevious["1600"], res.reports[0].pnl.previous["2110"]], [700, 950]);
  await assert.rejects(withFetch(handler, () => fin.ops.reports.live({ inn: "1234567890" }, { env: {} })), /ГИР БО ответил 503/);
  const bad = (url) => (url.startsWith("https://bo.nalog.gov.ru") ? json(503, {}) : json(403, { error: "Invalid access key", error_code: 40301 }));
  await assert.rejects(withFetch(bad, () => fin.ops.reports.live({ inn: "1234567890" }, { env: { PARSERAPI_KEY: "k" } })), /40301/);
  await assert.rejects(fin.ops.reports.live({ inn: "12" }, { env: {} }), { code: "bad_request" });
});

test("DaData: карточка, статус, руководитель, токен в заголовке", async () => {
  let auth;
  const res = await withFetch((url, init) => {
    auth = init.headers.authorization;
    return json(200, { suggestions: [{ data: { inn: "1234567890", ogrn: "1", type: "LEGAL", name: { short_with_opf: "ООО «Тест»" }, state: { status: "LIQUIDATING", registration_date: 1420070400000 },
      address: { value: "г Москва" }, okved: "49.41", management: { name: "Иванов И. И.", post: "ДИРЕКТОР", start_date: 1577836800000 } } }] });
  }, () => dadata.ops.party.live({ inn: "1234567890" }, { env: { DADATA_TOKEN: "t" } }));
  assert.strictEqual(auth, "Token t");
  assert.deepStrictEqual([res.found, res.name, res.status_label, res.registered, res.okved, res.management.since], [true, "ООО «Тест»", "ликвидируется", "2015-01-01", "49.41", "2020-01-01"]);
  const none = await withFetch(() => json(200, { suggestions: [] }), () => dadata.ops.party.live({ inn: "1234567890" }, { env: { DADATA_TOKEN: "t" } }));
  assert.strictEqual(none.found, false);
});

test("песочницы Контур, СПАРК, 1С, CRM: постоянные ответы по ИНН с пометкой, только песочница", async () => {
  const db = open(":memory:");
  const c = createConnectors(db, sandboxes, { env: {} });
  for (const [id, op] of [["kontur", "check"], ["spark", "risk"], ["onec", "contracts"], ["crm", "applications"]]) {
    const a = await c.call(id, op, { inn: "1234567890" }), b = await c.call(id, op, { inn: "1234567890" });
    assert.strictEqual(a.source, "sandbox", id);
    assert.deepStrictEqual(a.data, b.data, id);
    assert.match(a.data.sandbox_note, /условн/);
  }
  assert.ok(c.describe().every((x) => x.sandboxOnly && x.mode === "sandbox"));
  db.close();
});

let server, base, db, cookie;
before(async () => {
  db = open(":memory:");
  createAuth(db).upsertUser({ email: "curator@example.test", role: "curator", password: "Test-pass-123" });
  const all = [require("../app/connectors/cbr"), dadata, fin, ...sandboxes];
  const env = Object.fromEntries(all.map((x) => [`CONNECTOR_${x.id.toUpperCase()}_MODE`, "sandbox"])); // без сети
  server = createApp(db, { gateway: createGateway({ db, env: {} }), connectors: createConnectors(db, all, { env }) }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + "/login", { method: "POST", redirect: "manual", headers: { origin: base, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "curator@example.test", password: "Test-pass-123" }) });
  cookie = r.headers.get("set-cookie").split(";")[0];
});
after(() => (server.close(), db.close()));

test("страница «Проверка по ИНН» и «Источники данных»", async () => {
  const get = async (p) => { const r = await fetch(base + p, { headers: { cookie } }); return [r.status, await r.text()]; };
  let [st, html] = await get("/check");
  assert.strictEqual(st, 200);
  assert.match(html, /name="inn"/);
  [st, html] = await get("/check?inn=0000000001");
  assert.strictEqual(st, 200);
  assert.match(html, /ООО «Альфа-Пример»/);
  assert.match(html, /<span class="cls cls-1">1<\/span>/);
  assert.match(html, /Открыть годовую отчётность в калькуляторе/);
  assert.match(html, /href="\/calc#upload"/);
  assert.match(html, /<a href="\/check" aria-current="page">/);
  assert.match(html, /talk-calc-import/);
  assert.ok(!/<\/script>[^]*"docs"[^]*<\/script>/.test(html.split("talk-calc-import")[1].split("location.href")[0]), "данные не обрывают скрипт");
  for (const t of ["Контур.Фокус", "СПАРК", "1С"]) assert.ok(html.includes(t), t);
  // вместо условной заявки CRM — сделки портала по этому ИНН (у демо-сделки «Альфа-Пример» ИНН 0000000001)
  assert.match(html, /<h2>Сделки в портале<\/h2><ul class="plain"><li><a href="\/deals\/\d+">Сделка №\d+<\/a> — Решение, 60 млн руб\./);
  assert.match(html, /Карточка клиента «ООО «Альфа-Пример»» →/);
  assert.ok(!html.includes("З-3792") && !/<h3>CRM/.test(html), "условной заявки CRM нет");
  [st, html] = await get("/check?inn=12");
  assert.match(html, /ИНН — 10 или 12 цифр/);
  [st, html] = await get("/sources");
  for (const t of ["Банк России", "DaData", "ГИР БО", "Контур.Фокус", "СПАРК", "1С", "CRM", "Распознавание PDF"]) assert.ok(html.includes(t), t);
  assert.strictEqual((html.match(/Только интерфейс/g) || []).length, 4);
  assert.doesNotMatch(html, /dadata\/party|\/api\/connectors/, "коды методов и адреса API — не для пользователя");
  const lc = (await get("/process"))[1];
  assert.match(lc, /href="\/check">Проверка по ИНН →/);
});

test("пустые строки ГИР БО (null) — нули, пропуск итоговой строки — отсутствие данных", () => {
  const full = { "1200": 500, "1230": null, "1240": null, "1250": 50, "1300": 300, "1370": null, "1500": 200, "1530": null, "1540": null, "1550": null, "1600": 900, "1700": 900 };
  const pnl = { "2110": 1000, "2200": 100, "2400": 60 };
  const f = { provider: "girbo", org: { inn: "1234567890" }, reports: [{ year: 2025, variant: "standard", balance: { current: full, previous: { ...full, "1600": null, "1700": null, "1200": null, "1300": null, "1500": null }, beforePrevious: full }, pnl: { current: pnl, previous: { ...pnl, "2110": null } } }] };
  const [y] = annualClasses(f);
  assert.deepStrictEqual(y.missing, []);
  const docs = toDocs(f);
  assert.strictEqual(docs[0].columns[0].values["1530"], 0);
  assert.strictEqual(docs[0].columns[1].values["1530"], null, "графа без итогов остаётся пустой");
  const noTotal = annualClasses({ reports: [{ ...f.reports[0], pnl: { current: { ...pnl, "2110": null }, previous: pnl } }] })[0];
  assert.deepStrictEqual(noTotal.missing, ["2110"]);
});

test("без итоговых строк (НКО: нет выручки и раздела «Капитал») класс не рассчитывается", () => {
  const bal = { "1200": 500, "1230": 1, "1240": 0, "1250": 2, "1300": null, "1370": null, "1500": 200, "1530": 0, "1540": 0, "1550": 0, "1600": 900, "1700": 900 };
  const f = { reports: [{ year: 2025, variant: "standard", balance: { current: bal, previous: bal, beforePrevious: bal }, pnl: { current: { "2110": null, "2200": null, "2400": 5 }, previous: {} } }] };
  const [y] = annualClasses(f);
  assert.deepStrictEqual([y.cls, y.S, y.missing.sort()], [null, null, ["1300", "2110", "2200"]]);
});
