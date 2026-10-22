// Точка входа портала: маршруты, проверка сессии и прав.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { open } = require("./db");
const { createAuth, can, SESSION_TTL_MS } = require("./auth");
const H = require("./http");
const V = require("./views");
const { calcPage } = require("./calc/build");
const { createGateway } = require("./extract/gateway");
const { monitoringPage } = require("./monitoring/build");
const { createConnectors } = require("./connectors/core");
const CONNECTORS = [require("./connectors/cbr"), require("./connectors/dadata"), require("./connectors/fin"), ...require("./connectors/sandboxes")];
const { toDocs, annualClasses } = require("./check");

const PUB = path.join(__dirname, "public");
const JS = "text/javascript; charset=utf-8";
// [файл, тип, cache-control]; библиотеки версионированы — кэшируются на сутки
const STATIC = {
  "/static/style.css": [path.join(PUB, "style.css"), "text/css; charset=utf-8", "no-cache"],
  "/vendor/jszip.min.js": [path.join(PUB, "vendor", "jszip.min.js"), JS, "public, max-age=86400"],
  "/vendor/pdf.min.js": [path.join(PUB, "vendor", "pdf.min.js"), JS, "public, max-age=86400"],
  "/vendor/pdf.worker.min.js": [path.join(PUB, "vendor", "pdf.worker.min.js"), JS, "public, max-age=86400"],
  "/vendor/xlsx.full.min.js": [path.join(PUB, "vendor", "xlsx.full.min.js"), JS, "public, max-age=86400"],
};

// Безопасный адрес возврата после входа: только локальный путь.
const safeNext = (s) => (typeof s === "string" && s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/\\") ? s : "/");

function sessionCookie(req, token, maxAgeSec) {
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${H.isHttps(req) ? "; Secure" : ""}`;
}

function createApp(db, opts = {}) {
  const auth = createAuth(db);
  const recentLog = db.prepare("SELECT * FROM connector_log ORDER BY at DESC LIMIT 100");
  const gateway = opts.gateway || createGateway({ db });
  const connectors = opts.connectors || createConnectors(db, CONNECTORS);
  // Шлюз распознавания — отдельный модуль (POST /api/extract), но на «Источниках данных» показывается рядом с коннекторами
  const sourcesList = () => [...connectors.describe(), { id: "extract", title: "Распознавание PDF (OpenAI)", what: "Страницы отчётности → значения по кодам строк на все даты документа", mode: "live", ops: null }];
  const demoInns = (process.env.DEMO_INNS || "").split(",").map((s) => s.trim()).filter((s) => /^\d{10}(\d{2})?$/.test(s));

  // «Проверка по ИНН»: DaData + отчётность + песочницы; классы — по формулам core.js
  async function checkModel(user, url) {
    const inn = (url.searchParams.get("inn") || "").replace(/\D/g, "");
    const m = { inn, demo: demoInns };
    if (!inn) return m;
    if (!/^(\d{10}|\d{12})$/.test(inn)) return { ...m, error: "ИНН — 10 или 12 цифр." };
    const call = (id, op) => connectors.call(id, op, { inn }, { userId: user.id }).catch((e) => ({ failed: e.message }));
    const [party, fin, kontur, spark, onec, crm] = await Promise.all([call("dadata", "party"), call("fin", "reports"), call("kontur", "check"), call("spark", "risk"), call("onec", "contracts"), call("crm", "applications")]);
    if (party.failed) return { ...m, error: `DaData: ${party.failed}` };
    const ok = (r) => (r.failed ? null : r);
    return { ...m, party, fin: ok(fin), classes: fin.data?.reports ? annualClasses(fin.data) : [], docs: fin.data?.reports ? toDocs(fin.data) : [], side: { kontur: ok(kontur), spark: ok(spark), onec: ok(onec), crm: ok(crm) } };
  }

  // Страницы для вошедших: [путь, право, рендер]
  const PAGES = {
    "/": ["pages.view", (u) => V.lifecyclePage(u)],
    "/calc": ["calc.use", (u) => calcPage(u)],
    "/monitoring": ["pages.view", (u) => monitoringPage(u)],
    "/sources": ["pages.view", (u) => V.sourcesPage(u, sourcesList(), can(u, "connectors.log") ? recentLog.all() : [])],
    "/check": ["calc.use", async (u, url) => V.checkPage(u, await checkModel(u, url))],
    "/about": ["pages.view", (u) => V.aboutPage(u)],
    "/admin/users": ["users.view", (u) => V.usersPage(u, auth.listUsers())],
  };

  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    const token = H.parseCookies(req).sid;
    const user = auth.userByToken(token);

    if (p === "/healthz") return H.sendJson(res, 200, { ok: true, rss_mb: Math.round(process.memoryUsage().rss / 1048576) });

    if (STATIC[p] && req.method === "GET") {
      const [file, type, cache] = STATIC[p];
      return H.send(res, 200, fs.readFileSync(file), type, { "cache-control": cache });
    }

    if (req.method === "POST" && !H.sameOrigin(req)) return H.send(res, 403, V.errorPage(user, 403, "Запрос отклонён: другой источник."));

    if (p === "/login") {
      if (req.method === "GET") return user ? H.redirect(res, "/") : H.send(res, 200, V.loginPage({ next: safeNext(url.searchParams.get("next")) }));
      if (req.method === "POST") {
        const f = await H.readForm(req);
        const r = auth.login(f.email, f.password, { ip: H.clientIp(req), ua: req.headers["user-agent"] });
        if (r.ok) return H.redirect(res, safeNext(f.next), { "set-cookie": sessionCookie(req, r.token, SESSION_TTL_MS / 1000) });
        if (r.reason === "locked") {
          const min = Math.ceil(r.retryAfter / 60);
          return H.send(res, 429, V.loginPage({ error: `Слишком много неудачных попыток. Вход заблокирован на ${min} мин.`, email: f.email, next: safeNext(f.next) }), undefined, { "retry-after": String(r.retryAfter) });
        }
        return H.send(res, 401, V.loginPage({ error: "Неверный email или пароль.", email: f.email, next: safeNext(f.next) }));
      }
    }

    // API: без входа — 401 в JSON, а не перенаправление
    if (p.startsWith("/api/")) {
      if (!user) return H.sendJson(res, 401, { error: { code: "unauthorized", message: "Требуется вход." } });
      if (p === "/api/extract/status" && req.method === "GET") return H.sendJson(res, 200, can(user, "calc.extract") ? gateway.status(user) : { enabled: false, reason: "нет прав" });
      if (p === "/api/extract" && req.method === "POST") {
        if (!can(user, "calc.extract")) return H.sendJson(res, 403, { error: { code: "forbidden", message: "Недостаточно прав." } });
        return gateway.handle(req, res, user);
      }
      if (p === "/api/connectors" && req.method === "GET") return H.sendJson(res, 200, { connectors: connectors.describe() });
      const m = p.match(/^\/api\/connectors\/([a-z0-9_-]+)\/([a-z0-9_-]+)$/);
      if (m && req.method === "GET" && connectors.has(m[1])) {
        try {
          return H.sendJson(res, 200, await connectors.call(m[1], m[2], Object.fromEntries(url.searchParams), { userId: user.id }));
        } catch (e) {
          if (!e.code) throw e;
          return H.sendJson(res, e.status || 500, { error: { code: e.code, message: e.message } });
        }
      }
      return H.sendJson(res, 404, { error: { code: "not_found", message: "Нет такого метода." } });
    }

    if (p === "/logout" && req.method === "POST") {
      auth.logout(token);
      return H.redirect(res, "/login", { "set-cookie": sessionCookie(req, "", 0) });
    }

    const page = PAGES[p];
    if (page && req.method === "GET") {
      if (!user) return H.redirect(res, "/login?next=" + encodeURIComponent(p + url.search));
      const [perm, render] = page;
      if (!can(user, perm)) return H.send(res, 403, V.errorPage(user, 403, "Недостаточно прав для этой страницы."));
      return H.send(res, 200, await render(user, url));
    }

    return H.send(res, 404, V.errorPage(user, 404, "Страница не найдена."));
  }

  return http.createServer((req, res) =>
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) H.send(res, e.status || 500, V.errorPage(null, e.status || 500, e.status ? e.message : "Внутренняя ошибка."));
    })
  );
}

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  const db = open();
  const server = createApp(db).listen(PORT, () => console.log(`talk-proto: порт ${PORT}`));
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => (db.close(), process.exit(0))));
}

module.exports = { createApp };
