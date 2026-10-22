// Калькулятор класса: сверка ядра с эталоном Excel, условные пакеты, сборка страницы, маршруты портала.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const C = require("../seed/calc/core.js");
const demo = require("../seed/calc/demo_synthetic.json");
const parity = require("../scripts/calc-parity.js");
const { build } = require("../app/calc/build");
const { open } = require("../app/db");
const { createApp } = require("../app/server");
const { createAuth } = require("../app/auth");

test("ядро совпадает с эталоном Excel: 124 из 124", () => {
  const r = parity.run();
  assert.strictEqual(r.total, 124);
  assert.deepStrictEqual(r.fails, []);
  assert.strictEqual(r.ok, 124);
});

test("условные пакеты A, B, C дают классы 1, 2, 3; C — отказ по п. 14.1.6", () => {
  for (const p of demo.packages) {
    const cons = C.consolidate(p.docs);
    const V = {};
    for (const c of C.TPL_COLS) {
      V[c] = {};
      for (const [row, code] of Object.entries(C.TPL_ROWS)) V[c][row] = cons.cells[c][code].value;
    }
    const classes = C.CLASS_COLS.map((c) => C.calcColumn(V[c], {}, true).cls);
    assert.deepStrictEqual(classes, Array(4).fill(p.expected_class), `пакет ${p.id}`);
    const r1416 = C.sideChecks(V, cons.cells.J["1370"].value, cons.cells.L["1370"].value, false, classes)[0];
    assert.strictEqual(r1416.pass, p.expected_class !== 3, `пакет ${p.id}: п. 14.1.6`);
  }
});

test("сборка страницы: плейсхолдеры заменены, внешних CDN и вызовов claude.ai нет, скрипты корректны", () => {
  const html = build();
  assert.strictEqual((html.match(/\/\*__[A-Z]+__\*\//g) || []).length, 0);
  assert.ok(!/window\.claude|useCap|cdnjs|sample\.json/.test(html));
  assert.ok(html.includes("isEvalSupported:false"));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.strictEqual(scripts.length, 2);
  scripts.forEach((s) => new vm.Script(s));
});

let server, base, db;
before(async () => {
  db = open(":memory:");
  createAuth(db).upsertUser({ email: "curator@example.test", role: "curator", password: "Test-pass-123" });
  server = createApp(db).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => (server.close(), db.close()));

async function loginCookie() {
  const r = await fetch(base + "/login", {
    method: "POST",
    redirect: "manual",
    headers: { origin: base, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "curator@example.test", password: "Test-pass-123" }),
  });
  return r.headers.get("set-cookie").split(";")[0];
}

test("страница /calc и библиотеки отдаются порталом", async () => {
  const cookie = await loginCookie();
  const page = await fetch(base + "/calc", { headers: { cookie } });
  assert.strictEqual(page.status, 200);
  const html = await page.text();
  assert.match(html, /Расчёт класса кредитоспособности лизингополучателя/);
  assert.match(html, /← Жизненный цикл сделки/);
  for (const f of ["jszip.min.js", "pdf.min.js", "pdf.worker.min.js"]) {
    const r = await fetch(`${base}/vendor/${f}`);
    assert.strictEqual(r.status, 200, f);
    assert.match(r.headers.get("content-type"), /javascript/);
  }
});

test("/api/extract: без входа 401, на шаге 3 шлюз отключён", async () => {
  assert.strictEqual((await fetch(base + "/api/extract/status")).status, 401);
  const cookie = await loginCookie();
  const st = await (await fetch(base + "/api/extract/status", { headers: { cookie } })).json();
  assert.strictEqual(st.enabled, false);
  const r = await fetch(base + "/api/extract", { method: "POST", headers: { cookie, origin: base, "content-type": "application/pdf" }, body: "%PDF-1.4" });
  assert.strictEqual(r.status, 503);
  assert.strictEqual((await r.json()).error.code, "disabled");
});
