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
const { portfolioSummary } = require("./monitoring/summary");
const { createDeals } = require("./deals");
const W = require("./views-work");
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

  // Последние проверки пользователя: ИНН из журнала коннектора отчётности, название и класс — из кэша ответов
  const q = {
    recentFin: db.prepare("SELECT request FROM connector_log WHERE connector = 'fin' AND user_id = ? ORDER BY id DESC LIMIT 50"),
    cache: db.prepare("SELECT value FROM connector_cache WHERE key = ?"),
  };
  function recentChecks(user) {
    const inns = [];
    for (const { request } of q.recentFin.all(user.id)) {
      const inn = (request.match(/"inn":"(\d+)"/) || [])[1];
      if (inn && !inns.includes(inn)) inns.push(inn);
      if (inns.length === 5) break;
    }
    const cached = (key) => { const r = q.cache.get(key); return r ? JSON.parse(r.value) : null; };
    return inns.map((inn) => {
      const party = cached(`dadata:party:${JSON.stringify({ inn })}`);
      const fin = cached(`fin:reports:${JSON.stringify({ inn })}`);
      const y = fin?.reports?.length ? annualClasses(fin)[0] : null;
      return { inn, name: party?.name || fin?.org?.name || null, cls: y ? y.cls : null, year: y?.year || null };
    });
  }
  const deals = opts.deals || createDeals(db, { portfolio: portfolioSummary() });
  async function homeModel(user) {
    const keyRate = await connectors.call("cbr", "key-rate", {}, { userId: user.id }).catch(() => null);
    return { summary: portfolioSummary(), keyRate, deals: deals.list(), canEdit: can(user, "deals.edit") };
  }

  // Поля сделки из формы (запуск и правка). Ошибка — {status: 400, field}
  function dealFields(f) {
    const bad = (field, message) => Object.assign(new Error(message), { status: 400, field });
    const inn = String(f.inn || "").replace(/\D/g, "");
    if (inn && !/^(\d{10}|\d{12})$/.test(inn)) throw bad("inn", "ИНН — 10 или 12 цифр.");
    const num = (x) => (x === undefined || String(x).trim() === "" ? null : Number(String(x).replace(/\s/g, "").replace(",", ".")));
    const amount = num(f.amount);
    if (amount !== null && !(amount > 0 && amount < 1e6)) throw bad("amount", "Сумма — положительное число, млн руб.");
    const term = num(f.term);
    if (term !== null && !(Number.isInteger(term) && term >= 1 && term <= 120)) throw bad("term", "Срок — целое число месяцев от 1 до 120.");
    return { inn: inn || null, asset: W.ASSETS.includes(f.asset) ? f.asset : null, amount_mln: amount, term_months: term, comment: String(f.comment || "").trim().slice(0, 500) || null };
  }

  // Проверка клиента для сделки: DaData + ГИР БО. Условный ответ песочницы (fallback при недоступном источнике)
  // в сделку с реальным ИНН не подставляется — вместо этого пометка «источник недоступен».
  async function checkClient(user, inn) {
    const call = (id, op) => connectors.call(id, op, { inn }, { userId: user.id }).catch(() => null);
    const [party, fin] = await Promise.all([call("dadata", "party"), call("fin", "reports")]);
    const usable = (r) => (r && !r.fallback ? r : null);
    return { party: usable(party), fin: usable(fin) };
  }
  function checkSummary(inn, { party, fin }) {
    const p = party?.data, f = fin?.data;
    const title = p?.found ? p.name : `ИНН ${inn}`;
    const down = [!party && "DaData", !fin && "ГИР БО"].filter(Boolean);
    if (down.length) return { title, cls: null, note: `${down.join(" и ")} ${down.length > 1 ? "недоступны" : "недоступен"}: проверка не выполнена — «Проверить снова»`, ok: false };
    if (p.found === false) return { title, cls: null, note: "DaData: организация с таким ИНН не найдена", ok: true };
    const y = f.reports?.length ? annualClasses(f)[0] : null;
    let note = y ? (y.cls ? `Предварительный класс по годовой отчётности за ${y.year} (ГИР БО)` : `Отчётность за ${y.year}: нет итоговых строк, класс не рассчитан`) : "Годовая отчётность в ГИР БО не найдена или не раскрыта";
    if (p.status && p.status !== "ACTIVE") note = `Статус: ${p.status_label}. ${note}`;
    return { title, cls: y ? y.cls : null, note, ok: true };
  }

  // Карточка сделки: клиент (DaData, ГИР БО) — из кэша коннекторов, без условных ответов
  async function dealModel(user, deal) {
    const client = deal.inn ? await checkClient(user, deal.inn) : null;
    const classes = client?.fin?.data?.reports?.length ? annualClasses(client.fin.data) : [];
    return { deal, events: deals.events(deal.id), canEdit: can(user, "deals.edit"), client, classes };
  }

  async function launchDeal(user, f) {
    const v = dealFields(f);
    let sum = { title: v.inn ? `ИНН ${v.inn}` : `Новая заявка${v.asset ? ` · ${v.asset}` : ""}`, cls: null, note: v.inn ? null : "ИНН ещё не указан" };
    if (v.inn) sum = checkSummary(v.inn, await checkClient(user, v.inn));
    return deals.create({ ...v, title: sum.title, cls: sum.cls, note: sum.note, userId: user.id });
  }

  // Повторная проверка клиента сделки (после смены ИНН или когда источник был недоступен)
  async function recheckDeal(user, deal, reason) {
    if (!deal.inn) return deals.setCheck(deal.id, { title: deal.title, cls: null, note: "ИНН ещё не указан" }, user.id, null);
    const sum = checkSummary(deal.inn, await checkClient(user, deal.inn));
    deals.setCheck(deal.id, sum, user.id, `${reason}: ${sum.ok ? `${sum.title}${sum.cls ? `, класс ${sum.cls}` : ""}` : "источник недоступен"}`);
  }

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
    "/": ["pages.view", async (u) => W.dashboardPage(u, await homeModel(u))],
    "/deals": ["pages.view", (u) => W.dealsBoard(u, { deals: deals.list(), canEdit: can(u, "deals.edit") })],
    "/process": ["pages.view", (u) => V.processPage(u)],
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
        return H.send(res, 401, V.loginPage({ error: "Неверный email или пароль. Пароль — латинские буквы и цифры: проверьте раскладку клавиатуры.", email: f.email, next: safeNext(f.next) }));
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
      const dm = p.match(/^\/api\/deals\/(\d+)\/stage$/);
      if (dm && req.method === "POST") {
        if (!can(user, "deals.edit")) return H.sendJson(res, 403, { error: { code: "forbidden", message: "Недостаточно прав." } });
        let body = {};
        try { body = JSON.parse((await H.readBody(req, 4096)).toString("utf8") || "{}"); } catch { return H.sendJson(res, 400, { error: { code: "bad_request", message: "Нужен JSON." } }); }
        if (!deals.STAGE_IDS.includes(body.stage)) return H.sendJson(res, 400, { error: { code: "bad_request", message: "Неизвестная стадия." } });
        const d = deals.move(+dm[1], body.stage, user.id);
        return d ? H.sendJson(res, 200, { deal: d }) : H.sendJson(res, 404, { error: { code: "not_found", message: "Нет такой сделки." } });
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

    // Сделки: создание (форма с дашборда), смена стадии (форма карточки), карточка
    if (p === "/deals" && req.method === "POST") {
      if (!user) return H.redirect(res, "/login");
      if (!can(user, "deals.edit")) return H.send(res, 403, V.errorPage(user, 403, "Создавать сделки могут администратор, команда проекта и ТАЛК."));
      const f = await H.readForm(req);
      try {
        const id = await launchDeal(user, f);
        return H.redirect(res, `/deals/${id}`);
      } catch (e) {
        if (!e.status) throw e;
        // ошибка ввода — сообщением в форме на дашборде, введённые значения сохраняются
        return H.send(res, e.status, W.dashboardPage(user, { ...(await homeModel(user)), form: { values: f, error: e.message, field: e.field } }));
      }
    }
    const dp = p.match(/^\/deals\/(\d+)(\/stage|\/edit|\/recheck)?$/);
    if (dp) {
      if (!user) return H.redirect(res, "/login?next=" + encodeURIComponent(p));
      const deal = deals.get(+dp[1]);
      if (!deal) return H.send(res, 404, V.errorPage(user, 404, "Сделка не найдена."));
      if ((dp[2] === "/edit" || dp[2] === "/recheck") && req.method === "POST") {
        if (!can(user, "deals.edit")) return H.send(res, 403, V.errorPage(user, 403, "Недостаточно прав."));
        const f = dp[2] === "/edit" ? await H.readForm(req) : {};
        if (dp[2] === "/recheck") {
          await recheckDeal(user, deal, "Повторная проверка клиента");
          return H.redirect(res, `/deals/${deal.id}`);
        }
        try {
          const v = dealFields(f);
          const changed = deals.edit(deal.id, v, user.id);
          if (changed.includes("inn")) await recheckDeal(user, deals.get(deal.id), "Проверка клиента по новому ИНН");
          return H.redirect(res, `/deals/${deal.id}`);
        } catch (e) {
          if (!e.status) throw e;
          return H.send(res, 400, W.dealPage(user, { ...(await dealModel(user, deal)), form: { values: f, error: e.message, field: e.field } }));
        }
      }
      if (dp[2] === "/stage" && req.method === "POST") {
        if (!can(user, "deals.edit")) return H.send(res, 403, V.errorPage(user, 403, "Недостаточно прав."));
        const f = await H.readForm(req);
        const stage = f.stage === "__any" ? f.stage_any : f.stage;
        if (!deals.STAGE_IDS.includes(stage)) return H.send(res, 400, V.errorPage(user, 400, "Неизвестная стадия."));
        deals.move(deal.id, stage, user.id);
        return H.redirect(res, `/deals/${deal.id}`);
      }
      if (!dp[2] && req.method === "GET") return H.send(res, 200, W.dealPage(user, await dealModel(user, deal)));
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
