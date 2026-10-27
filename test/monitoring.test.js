// Раннее предупреждение: сверка баллов страницы с Python, сборка страницы «Мониторинг»; слой коннекторов и ЦБ.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const zlib = require("node:zlib");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { open } = require("../app/db");
const { createApp } = require("../app/server");
const { createAuth } = require("../app/auth");
const { createGateway } = require("../app/extract/gateway");
const { createConnectors } = require("../app/connectors/core");
const cbr = require("../app/connectors/cbr");
const { build } = require("../app/monitoring/build");

test("check_parity.js: баллы страницы совпадают с баллами Python", () => {
  const out = execFileSync(process.execPath, ["check_parity.js"], { cwd: path.join(__dirname, "..", "seed", "ews"), encoding: "utf8" });
  const m = out.match(/сравнено (\d+) срезов, максимальное расхождение ([\d.]+) балла/);
  assert.ok(m, out);
  assert.strictEqual(+m[1], 4048);
  assert.ok(+m[2] <= 0.01, out);
  assert.ok(!out.includes("нет среза"), out);
});

test("сборка «Мониторинга»: плейсхолдеры, без CDN и claude.ai, данные портфеля внутри", () => {
  const html = build();
  for (const ph of ["/*FEATURES_JS*/", "__MODEL_JSON__", "__DATA_GZ__"]) assert.ok(!html.includes(ph), ph);
  assert.ok(!/window\.claude|cdnjs/.test(html));
  assert.ok(html.includes('src="/vendor/xlsx.full.min.js"'));
  [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach((s) => new vm.Script(s[1]));
  const gz = html.match(/const DEMO_GZ = "([^"]+)"/)[1];
  const data = JSON.parse(zlib.gunzipSync(Buffer.from(gz, "base64")));
  assert.strictEqual(data.clients.length, 420);
  assert.strictEqual(data.contracts.length, 607);
});

test("коннекторы: кэш, устаревший кэш при сбое, запасной ответ песочницы, режим из окружения, журнал", async () => {
  const db = open(":memory:");
  let up = true, calls = 0;
  const fake = { id: "fake", title: "Тест", mode: "live", ops: { v: { ttlMs: 50, live: async () => { calls++; if (!up) throw new Error("нет сети"); return { n: calls }; }, sandbox: async () => ({ n: 0 }) } } };
  const c = createConnectors(db, [fake], { env: {} });
  const first = await c.call("fake", "v");
  assert.deepStrictEqual([first.source, first.data.n], ["live", 1]);
  assert.strictEqual((await c.call("fake", "v")).source, "cache");
  await new Promise((r) => setTimeout(r, 60));
  up = false;
  const stale = await c.call("fake", "v");
  assert.deepStrictEqual([stale.source, stale.stale, stale.data.n, stale.error], ["cache", true, 1, "нет сети"]);
  const fb = await c.call("fake", "v", { other: 1 }); // для этих параметров кэша нет
  assert.deepStrictEqual([fb.source, fb.fallback, fb.data.n], ["sandbox", true, 0]);
  const sb = createConnectors(db, [fake], { env: { CONNECTOR_FAKE_MODE: "sandbox" } });
  assert.strictEqual((await sb.call("fake", "v")).source, "sandbox");
  await assert.rejects(c.call("fake", "nope"), { code: "not_found" });
  const log = db.prepare("SELECT mode, status FROM connector_log ORDER BY id").all().map((r) => `${r.mode}:${r.status.split(":")[0]}`);
  assert.deepStrictEqual(log, ["live:ok", "cache:ok", "cache:устаревший кэш", "sandbox:запасной ответ", "sandbox:ok"]);
  db.close();
});

test("ЦБ: разбор ответа KeyRate и дата начала действия текущей ставки", async () => {
  const xml = `<KeyRate xmlns=""><KR><DT>2026-10-21T00:00:00+03:00</DT><Rate>14.00</Rate></KR><KR><DT>2026-07-27T00:00:00+03:00</DT><Rate>14.00</Rate></KR>
    <KR><DT>2026-07-25T00:00:00+03:00</DT><Rate>14.25</Rate></KR><KR><DT>2026-06-22T00:00:00+03:00</DT><Rate>14.25</Rate></KR><KR><DT>2026-06-20T00:00:00+03:00</DT><Rate>14.50</Rate></KR></KeyRate>`;
  const orig = global.fetch;
  global.fetch = async () => ({ ok: true, text: async () => xml });
  try {
    const k = await cbr.ops["key-rate"].live({});
    assert.deepStrictEqual([k.rate, k.date, k.since], [14, "2026-10-21", "2026-07-27"]);
    assert.deepStrictEqual(k.changes.map((c) => [c.since, c.rate]), [["2026-07-27", 14], ["2026-06-22", 14.25], ["2026-06-20", 14.5]]);
  } finally {
    global.fetch = orig;
  }
});

let server, base, db, cookie;
before(async () => {
  db = open(":memory:");
  createAuth(db).upsertUser({ email: "admin@example.test", role: "admin", password: "Test-pass-123" });
  const connectors = createConnectors(db, [cbr], { env: { CONNECTOR_CBR_MODE: "sandbox" } }); // без сети
  server = createApp(db, { gateway: createGateway({ db, env: {} }), connectors }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + "/login", { method: "POST", redirect: "manual", headers: { origin: base, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "admin@example.test", password: "Test-pass-123" }) });
  cookie = r.headers.get("set-cookie").split(";")[0];
});
after(() => (server.close(), db.close()));

test("маршруты: /monitoring, xlsx, /api/connectors, журнал на «Источниках данных»", async () => {
  const page = await fetch(base + "/monitoring", { headers: { cookie } });
  assert.strictEqual(page.status, 200);
  assert.match(await page.text(), /Раннее предупреждение о просрочке/);
  assert.strictEqual((await fetch(base + "/vendor/xlsx.full.min.js")).status, 200);
  assert.strictEqual((await fetch(base + "/api/connectors/cbr/key-rate")).status, 401);
  const list = await (await fetch(base + "/api/connectors", { headers: { cookie } })).json();
  assert.deepStrictEqual(list.connectors.map((c) => [c.id, c.mode]), [["cbr", "sandbox"]]);
  const kr = await (await fetch(base + "/api/connectors/cbr/key-rate", { headers: { cookie } })).json();
  assert.deepStrictEqual([kr.source, kr.data.rate], ["sandbox", 14]);
  assert.strictEqual((await fetch(base + "/api/connectors/cbr/nope", { headers: { cookie } })).status, 404);
  const sources = await (await fetch(base + "/sources", { headers: { cookie } })).text();
  assert.match(sources, /<td>Банк России — DailyInfoWebServ<\/td><td>условный ответ<\/td><td>ключевая ставка<\/td><td>успешно<\/td>/);
});
