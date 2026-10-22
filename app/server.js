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

const PUB = path.join(__dirname, "public");
const JS = "text/javascript; charset=utf-8";
// [файл, тип, cache-control]; библиотеки версионированы — кэшируются на сутки
const STATIC = {
  "/static/style.css": [path.join(PUB, "style.css"), "text/css; charset=utf-8", "no-cache"],
  "/vendor/jszip.min.js": [path.join(PUB, "vendor", "jszip.min.js"), JS, "public, max-age=86400"],
  "/vendor/pdf.min.js": [path.join(PUB, "vendor", "pdf.min.js"), JS, "public, max-age=86400"],
  "/vendor/pdf.worker.min.js": [path.join(PUB, "vendor", "pdf.worker.min.js"), JS, "public, max-age=86400"],
};

// Безопасный адрес возврата после входа: только локальный путь.
const safeNext = (s) => (typeof s === "string" && s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/\\") ? s : "/");

function sessionCookie(req, token, maxAgeSec) {
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${H.isHttps(req) ? "; Secure" : ""}`;
}

function createApp(db) {
  const auth = createAuth(db);
  const recentLog = db.prepare("SELECT * FROM connector_log ORDER BY at DESC LIMIT 100");
  const gateway = createGateway({ db });

  // Страницы для вошедших: [путь, право, рендер]
  const PAGES = {
    "/": ["pages.view", (u) => V.lifecyclePage(u)],
    "/calc": ["calc.use", (u) => calcPage(u)],
    "/monitoring": ["pages.view", (u) => V.modulePage(u, { title: "Мониторинг — раннее предупреждение", step: 5 })],
    "/sources": ["pages.view", (u) => V.sourcesPage(u, can(u, "connectors.log") ? recentLog.all() : [])],
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
      return H.send(res, 200, render(user));
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
