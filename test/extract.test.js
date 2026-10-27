// Шлюз /api/extract против имитации OpenAI (Responses API): контракт ответа, лимит, учёт расхода, ошибки.
// Рендер PDF подменён (poppler нужен только на сервере); оценка замера проверяется на значениях пакетов.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { open } = require("../app/db");
const { createApp } = require("../app/server");
const { createAuth } = require("../app/auth");
const { createGateway } = require("../app/extract/gateway");
const { toNumber } = require("../app/extract/assemble");
const { score } = require("../scripts/bench-extract");
const demo = require("../seed/calc/demo_synthetic.json");

// ---------- имитация OpenAI ----------
let mode = "ok";
const calls = [];
const PART1 = { company: "ООО «Тест»", inn: "0000000001", form_variant: "standard", confirmation: "none",
  columns: [{ kind: "balance", header: "На 30 июня 2026 г.", date: "30.06.2026", months: null, values: { "1200": 648000, "1600": "1 080 000" }, page: { "1200": 1, "1600": 1 } },
    { kind: "balance", header: "На 31 декабря 2025 г.", date: "31.12.2025", months: null, values: { "1200": 600000 }, page: { "1200": 1 } }] };
const PART2 = { company: null, inn: null, form_variant: null, confirmation: "paper_signature",
  columns: [{ kind: "balance", header: "На 30 июня 2026 г.", date: "30.06.2026", months: null, values: { "1300": 540000, "1370": "(1 000)", "1700": 1080000 }, page: { "1300": 3, "1370": 3, "1700": 3 } }] };

const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = JSON.parse(body);
    calls.push({ auth: req.headers.authorization, model: j.model, format: j.text?.format?.type, images: j.input[0].content.filter((c) => c.type === "input_image").length, text: j.input[0].content[0].text });
    const reply = (status, obj) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(obj)));
    if (mode === "429") return reply(429, { error: { message: "Rate limit" } });
    if (mode === "500") return reply(500, { error: { message: "boom" } });
    const text = mode === "bad" ? "извините, не могу" : JSON.stringify(calls.length % 2 ? PART1 : PART2);
    reply(200, { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { input_tokens: 1500, output_tokens: 120 } });
  });
});

const PDF = Buffer.from("%PDF-1.4\n%условный\n");
const fakeRender = async () => [Buffer.from("img1"), Buffer.from("img2"), Buffer.from("img3")];

let db, server, base, cookie, gw;
before(async () => {
  await new Promise((r) => mock.listen(0, r));
  db = open(":memory:");
  createAuth(db).upsertUser({ email: "team@example.test", role: "team", password: "Test-pass-123" });
  gw = createGateway({ db, render: fakeRender, env: { OPENAI_API_KEY: "sk-test", OPENAI_MODEL: "test-model", OPENAI_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1`, OPENAI_DAILY_LIMIT: "5", OPENAI_MAX_IMAGES: "2", EXTRACT_MAX_MB: "0.01" } });
  server = createApp(db, { gateway: gw }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + "/login", { method: "POST", redirect: "manual", headers: { origin: base, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "team@example.test", password: "Test-pass-123" }) });
  cookie = r.headers.get("set-cookie").split(";")[0];
});
after(() => (server.close(), mock.close(), db.close()));

const post = (body, name = "Баланс (условный).pdf") =>
  fetch(base + "/api/extract", { method: "POST", headers: { cookie, origin: base, "content-type": "application/pdf", "x-file-name": encodeURIComponent(name) }, body });
const usage = () => db.prepare("SELECT source, model, images, status, input_tokens, output_tokens FROM openai_usage ORDER BY id").all();

test("без ключа OpenAI шлюз отключён", async () => {
  const g = createGateway({ db: open(":memory:"), env: {} });
  assert.deepStrictEqual(g.status(), { enabled: false, reason: "не настроено подключение к сервису распознавания" });
});

test("распознавание: страницы частями, сведение граф, контракт ответа, учёт расхода", async () => {
  mode = "ok";
  const st = await (await fetch(base + "/api/extract/status", { headers: { cookie } })).json();
  assert.deepStrictEqual([st.enabled, st.model, st.remaining], [true, "test-model", 5]);

  const r = await post(PDF);
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  // 3 страницы при OPENAI_MAX_IMAGES=2 -> два вызова: 2 и 1 изображение
  assert.deepStrictEqual(calls.map((c) => c.images), [2, 1]);
  assert.ok(calls.every((c) => c.auth === "Bearer sk-test" && c.model === "test-model" && c.format === "json_object"));
  assert.match(calls[0].text, /Приложены изображения страниц 1–2 из 3/);
  assert.match(calls[1].text, /страниц 3–3 из 3/);
  assert.strictEqual(j.company, "ООО «Тест»");
  assert.strictEqual(j.inn, "0000000001");
  assert.strictEqual(j.confirmation, "paper_signature"); // лучшее подтверждение из частей
  assert.strictEqual(j.pages, 3);
  const main = j.columns.find((c) => c.date === "2026-06-30");
  assert.strictEqual(main.primary, true);
  assert.deepStrictEqual(main.values, { "1200": 648000, "1600": 1080000, "1300": 540000, "1370": -1000, "1700": 1080000 });
  assert.strictEqual(main.page["1370"], 3);
  assert.strictEqual(j.columns.find((c) => c.date === "2025-12-31").primary, false);
  assert.deepStrictEqual(usage().map((u) => [u.source, u.status, u.images, u.input_tokens, u.output_tokens]), [["ui", "ok", 2, 1500, 120], ["ui", "ok", 1, 1500, 120]]);
});

test("дневной лимит: вызовы из интерфейса останавливаются, статус показывает остаток", async () => {
  mode = "ok";
  // израсходовано 2 из 5; следующий файл — ещё 2 вызова (осталось 1)
  assert.strictEqual((await post(PDF)).status, 200);
  const r = await post(PDF);
  assert.strictEqual(r.status, 429);
  assert.strictEqual((await r.json()).error.code, "daily_limit");
  const st = await (await fetch(base + "/api/extract/status", { headers: { cookie } })).json();
  assert.deepStrictEqual([st.enabled, st.remaining], [false, 0]);
  // вызовы замера (source=bench) в лимит интерфейса не входят, но учитываются
  await gw.extractPdf(PDF, "x.pdf", { source: "bench", model: "other-model" });
  assert.ok(usage().some((u) => u.source === "bench" && u.model === "other-model"));
  db.exec("DELETE FROM openai_usage WHERE source = 'ui'");
});

test("ошибки: не PDF, слишком большой файл, неразборчивый ответ, сбой и лимит OpenAI", async () => {
  mode = "ok";
  let r = await post(Buffer.from("not a pdf"));
  assert.deepStrictEqual([r.status, (await r.json()).error.code], [415, "not_pdf"]);
  r = await post(Buffer.concat([PDF, Buffer.alloc(20 * 1024)]));
  assert.deepStrictEqual([r.status, (await r.json()).error.code], [413, "too_large"]);

  mode = "bad";
  r = await post(PDF);
  assert.deepStrictEqual([r.status, (await r.json()).error.code], [502, "invalid_json"]);

  mode = "500";
  const before = calls.length;
  r = await post(PDF);
  assert.deepStrictEqual([r.status, (await r.json()).error.code], [502, "upstream_error"]);
  assert.strictEqual(calls.length - before, 2, "один повтор при сбое сервиса");

  mode = "429";
  r = await post(PDF);
  assert.deepStrictEqual([r.status, (await r.json()).error.code], [429, "rate_limited"]);
  assert.ok(usage().some((u) => u.status === "rate_limited"));
});

test("числа из ответа модели: скобки, пробелы, прочерк", () => {
  assert.deepStrictEqual(["(1 234)", "1 080 000", "-", "12,5", null, "абв"].map(toNumber), [-1234, 1080000, 0, 12.5, null, null]);
});

test("оценка замера: 60 из 60 на значениях пакета, ошибка в ячейке снижает счёт", () => {
  for (const p of demo.packages) assert.strictEqual(score(p, p.docs).ok, 60, `пакет ${p.id}`);
  const p = demo.packages[0];
  const broken = structuredClone(p.docs);
  broken[0].columns[0].values["1250"] += 1;
  const s = score(p, broken);
  assert.strictEqual(s.ok, 59);
  assert.strictEqual(s.diffs[0].code, "1250");
});
