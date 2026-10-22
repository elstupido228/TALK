// Шлюз распознавания PDF: POST /api/extract.
// PDF -> страницы в JPEG (poppler: pdfinfo, pdftoppm) -> vision-модель OpenAI (Responses API) -> JSON по кодам строк.
//
// Контракт ответа (его ждёт страница калькулятора):
//   200 {company, inn, form_variant, confirmation, pages, columns:[{kind, header, date, months, primary, values:{код:число|null}, page:{код:номер}}]}
//   4xx/5xx {error:{code, message}}; code: disabled | daily_limit | too_large | not_pdf | too_many_pages | rate_limited | invalid_json | upstream_error
//
// Ключ OpenAI общий с ботами: дневной лимит вызовов модели (OPENAI_DAILY_LIMIT, по московским суткам) для запросов
// из интерфейса; каждый вызов (в том числе замера) пишется в openai_usage с токенами.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const H = require("../http");
const { prompt } = require("./prompt");
const { assemble } = require("./assemble");

const run = promisify(execFile);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS openai_usage (
  id            INTEGER PRIMARY KEY,
  at            INTEGER NOT NULL,
  day           TEXT NOT NULL,
  source        TEXT NOT NULL,
  user_id       INTEGER,
  model         TEXT NOT NULL,
  file          TEXT,
  images        INTEGER,
  status        TEXT NOT NULL,
  ms            INTEGER,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS openai_usage_day ON openai_usage(day, source);
`;

const mskDay = (t = Date.now()) => new Date(t + 3 * 3600 * 1000).toISOString().slice(0, 10);
const fail = (code, message, status) => Object.assign(new Error(message), { code, status });

function config(env) {
  return {
    key: env.OPENAI_API_KEY || "",
    model: env.OPENAI_MODEL || "gpt-5.4-mini",
    base: (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
    dailyLimit: Number(env.OPENAI_DAILY_LIMIT || 50),
    maxImages: Number(env.OPENAI_MAX_IMAGES || 8),
    maxPages: Number(env.EXTRACT_MAX_PAGES || 20),
    maxMb: Number(env.EXTRACT_MAX_MB || 20),
    timeoutMs: Number(env.OPENAI_TIMEOUT_MS || 180000),
    effort: env.OPENAI_REASONING_EFFORT || "",
  };
}

// PDF -> массив JPEG (длинная сторона 1600 px, качество 88 — как в исходной странице).
async function renderPdf(buf, maxPages) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "talk-pdf-"));
  try {
    const file = path.join(dir, "in.pdf");
    fs.writeFileSync(file, buf);
    let pages;
    try {
      const { stdout } = await run("pdfinfo", [file], { timeout: 20000 });
      pages = Number((stdout.match(/^Pages:\s+(\d+)/m) || [])[1]);
    } catch {
      throw fail("not_pdf", "Файл не читается как PDF.", 415);
    }
    if (!pages) throw fail("not_pdf", "В PDF нет страниц.", 415);
    if (pages > maxPages) throw fail("too_many_pages", `Страниц ${pages}, допустимо не больше ${maxPages}.`, 413);
    await run("pdftoppm", ["-jpeg", "-jpegopt", "quality=88", "-scale-to", "1600", file, path.join(dir, "p")], { timeout: 120000 });
    const imgs = fs.readdirSync(dir).filter((f) => /^p-\d+\.jpg$/.test(f)).sort((a, b) => parseInt(a.slice(2)) - parseInt(b.slice(2)));
    return imgs.map((f) => fs.readFileSync(path.join(dir, f)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Текст ответа Responses API
function outputText(j) {
  if (typeof j.output_text === "string") return j.output_text;
  return (j.output || []).filter((o) => o.type === "message").flatMap((o) => o.content || []).filter((c) => c.type === "output_text").map((c) => c.text).join("");
}

function parseJson(text) {
  const s = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(s);
  } catch {
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
    throw new Error("не JSON");
  }
}

function createGateway({ db, env = process.env, render = renderPdf, fetchImpl = (...a) => fetch(...a) } = {}) {
  const cfg = config(env);
  db.exec(SCHEMA);
  const q = {
    log: db.prepare("INSERT INTO openai_usage (at, day, source, user_id, model, file, images, status, ms, input_tokens, output_tokens, error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"),
    usedToday: db.prepare("SELECT count(*) n FROM openai_usage WHERE day = ? AND source = 'ui'"),
  };
  const remaining = () => Math.max(0, cfg.dailyLimit - q.usedToday.get(mskDay()).n);

  // не больше двух распознаваний одновременно: память сервера ограничена
  let active = 0;
  const waiters = [];
  const acquire = () => (active < 2 ? (active++, Promise.resolve()) : new Promise((r) => waiters.push(r)));
  const release = () => (waiters.length ? waiters.shift()() : active--);

  async function callModel({ model, text, images, meta }) {
    const body = {
      model,
      store: false,
      input: [{ role: "user", content: [{ type: "input_text", text }, ...images.map((b) => ({ type: "input_image", image_url: `data:image/jpeg;base64,${b.toString("base64")}`, detail: "high" }))] }],
      text: { format: { type: "json_object" } },
      ...(cfg.effort ? { reasoning: { effort: cfg.effort } } : {}),
    };
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      const t0 = Date.now();
      let status = "ok", usage = {}, err = null;
      try {
        const r = await fetchImpl(`${cfg.base}/responses`, {
          method: "POST",
          headers: { authorization: `Bearer ${cfg.key}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
        const j = await r.json().catch(() => ({}));
        usage = j.usage || {};
        if (r.status === 429) throw fail("rate_limited", j.error?.message || "Превышен лимит запросов OpenAI.", 429);
        if (!r.ok) throw fail("upstream_error", `OpenAI ${r.status}: ${j.error?.message || "ошибка"}`, r.status >= 500 ? 502 : 400);
        if (j.status === "incomplete") throw fail("invalid_json", `Ответ модели неполный: ${j.incomplete_details?.reason || "?"}`, 502);
        try {
          return { json: parseJson(outputText(j)), usage };
        } catch {
          throw fail("invalid_json", "Ответ модели не удалось разобрать.", 502);
        }
      } catch (e) {
        err = e.code ? e : fail("upstream_error", `Сбой соединения с OpenAI: ${e.message}`, 502);
        status = err.code;
        lastErr = err;
      } finally {
        q.log.run(Date.now(), mskDay(), meta.source, meta.userId ?? null, model, meta.file?.slice(0, 200) ?? null, images.length, status,
          Date.now() - t0, usage.input_tokens ?? null, usage.output_tokens ?? null, err ? err.message.slice(0, 300) : null);
      }
      // повтор только при сбое сервиса (5xx/сеть)
      if (!(lastErr.code === "upstream_error" && lastErr.status === 502)) break;
    }
    throw lastErr;
  }

  // Распознать один PDF. opts: {source:'ui'|'bench', userId, model}
  async function extractPdf(buf, name, opts = {}) {
    const model = opts.model || cfg.model;
    const images = await render(buf, cfg.maxPages);
    const parts = [];
    for (let p = 0; p < images.length; p += cfg.maxImages) {
      if (opts.source === "ui" && remaining() <= 0) throw fail("daily_limit", "Исчерпан дневной лимит запросов к нейросети.", 429);
      const chunk = images.slice(p, p + cfg.maxImages);
      const to = p + chunk.length;
      const { json } = await callModel({ model, text: prompt(name, p + 1, to, images.length), images: chunk, meta: { source: opts.source || "ui", userId: opts.userId, file: name } });
      parts.push(json);
    }
    return assemble(parts, images.length);
  }

  return {
    config: cfg,
    extractPdf,
    status: () =>
      cfg.key
        ? { enabled: remaining() > 0, reason: remaining() > 0 ? undefined : "исчерпан дневной лимит запросов", model: cfg.model, remaining: remaining(), limit: cfg.dailyLimit }
        : { enabled: false, reason: "на сервере не задан ключ OpenAI" },
    async handle(req, res, user) {
      if (!cfg.key) return req.resume(), H.sendJson(res, 503, { error: { code: "disabled", message: "На сервере не задан ключ OpenAI." } });
      if (remaining() <= 0) return req.resume(), H.sendJson(res, 429, { error: { code: "daily_limit", message: "Исчерпан дневной лимит запросов к нейросети." } });
      let name = "документ.pdf";
      try {
        name = decodeURIComponent(req.headers["x-file-name"] || name).slice(0, 200);
      } catch {}
      await acquire();
      try {
        const buf = await H.readBody(req, cfg.maxMb * 1024 * 1024).catch((e) => {
          throw e.status === 413 ? fail("too_large", `Файл больше ${cfg.maxMb} МБ.`, 413) : e;
        });
        if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") throw fail("not_pdf", "Файл не является PDF.", 415);
        const result = await extractPdf(buf, name, { source: "ui", userId: user?.id });
        return H.sendJson(res, 200, result);
      } catch (e) {
        if (!e.code) throw e;
        return H.sendJson(res, e.status || 500, { error: { code: e.code, message: e.message } });
      } finally {
        release();
      }
    },
  };
}

module.exports = { createGateway, renderPdf, mskDay };
