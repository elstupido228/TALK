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
const { createClients, norm } = require("./clients");
const W = require("./views-work");
const VC = require("./views-clients");
const VT = require("./views-tasks");
const VL = require("./views-list");
const DF = require("./deal-filter");
const STAGES = require("./stages");
const { createTasks, today: taskToday } = require("./tasks");
const { createFiles, sizeText } = require("./files");
const { createConnectors } = require("./connectors/core");
const CONNECTORS = [require("./connectors/cbr"), require("./connectors/dadata"), require("./connectors/fin"), ...require("./connectors/sandboxes")];
const { toDocs, annualClasses } = require("./check");

const PUB = path.join(__dirname, "public");
const JS = "text/javascript; charset=utf-8";
// [файл, тип, cache-control]; библиотеки версионированы — кэшируются на сутки
const STATIC = {
  "/static/style.css": [path.join(PUB, "style.css"), "text/css; charset=utf-8", "no-cache"],
  "/static/forms.js": [path.join(PUB, "forms.js"), JS, "no-cache"],
  // значок вкладки; /favicon.ico браузеры запрашивают сами — отдаётся тот же SVG
  "/favicon.svg": [path.join(PUB, "favicon.svg"), "image/svg+xml", "public, max-age=86400"],
  "/favicon.ico": [path.join(PUB, "favicon.svg"), "image/svg+xml", "public, max-age=86400"],
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
  const sourcesList = () => {
    const g = gateway.status();
    return [...connectors.describe(), { id: "extract", title: "Распознавание PDF (OpenAI)", what: "Страницы отчётности → значения по кодам строк на все даты документа", mode: "live", ops: null, health: g.enabled ? { state: "ready", note: `модель ${g.model}, осталось запросов на сегодня: ${g.remaining}` } : { state: "off", note: g.reason } }];
  };
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
  const clients = createClients(db);
  const deals = opts.deals || createDeals(db, { portfolio: portfolioSummary(), clients });
  const tasks = createTasks(db, deals);
  // просроченные задачи: всего и у пользователя (плитка главной)
  const lateTasks = (user) => { const late = tasks.open().filter((t) => t.due < taskToday()); return { lateTasks: late.length, myLate: late.filter((t) => t.assignee_id === user.id).length }; };
  // документы сделок — рядом с базой (DATA_DIR/files); в тестах — отдельный каталог (opts.filesDir)
  const files = createFiles(db, deals, opts.filesDir || path.join(process.env.DATA_DIR || path.join(__dirname, "..", "data"), "files"));
  // исполнители задач — те, кто может вести сделки
  const editors = () => auth.listUsers().filter((u) => !u.disabled && can(u, "deals.edit"));
  // ближайшая открытая задача по каждой сделке (для карточек канбана)
  const nextTasks = () => { const m = new Map(); for (const t of tasks.open()) if (!m.has(t.deal_id)) m.set(t.deal_id, t); return m; };
  async function homeModel(user) {
    // Ставка ЦБ не задерживает главную: сохранённое значение — сразу, обновление — в фоне (результат попадёт в кэш
    // к следующему открытию). Без сохранённого значения ждём источник не дольше 1,5 с.
    const fresh = connectors.call("cbr", "key-rate", {}, { userId: user.id }).catch(() => null);
    const keyRate = connectors.peek("cbr", "key-rate", {}) || (await Promise.race([fresh, new Promise((r) => setTimeout(() => r(null), 1500))]));
    return { summary: portfolioSummary(), keyRate, deals: deals.list(), canEdit: can(user, "deals.edit"), myTasks: tasks.open().filter((t) => t.assignee_id === user.id), ...lateTasks(user) };
  }

  // Поля сделки из формы (запуск и правка). Ошибка — {status: 400, field}
  // Ошибки — все сразу: {status: 400, errors: {поле: текст}}. launch — запуск: нужен ИНН или предмет.
  function dealFields(f, { launch = false } = {}) {
    const errors = {};
    const raw = String(f.inn || ""), inn = raw.replace(/\D/g, "");
    if (/[^\d\s]/.test(raw)) errors.inn = "ИНН — только цифры: 10 для организации, 12 для ИП.";
    else if (inn && !/^(\d{10}|\d{12})$/.test(inn)) errors.inn = "ИНН — 10 или 12 цифр.";
    // число с запятой или точкой; «1e3», «0x10» и подобное — ошибка, а не 1000
    const num = (x) => { const s = String(x ?? "").replace(/\s/g, ""); return s === "" ? null : /^-?\d+([.,]\d+)?$/.test(s) ? Number(s.replace(",", ".")) : NaN; };
    const amount = num(f.amount);
    if (amount !== null && !(amount > 0 && amount < 1e6)) errors.amount = "Сумма — положительное число, млн руб.";
    const term = num(f.term);
    if (term !== null && !(Number.isInteger(term) && term >= 1 && term <= 120)) errors.term = "Срок — целое число месяцев от 1 до 120.";
    const asset = W.ASSETS.includes(f.asset) ? f.asset : null;
    const client_name = String(f.client_name || "").trim().slice(0, 200) || null, contact_name = String(f.contact_name || "").trim().slice(0, 120) || null;
    const phone = String(f.phone || "").trim().slice(0, 40) || null;
    if (phone && !/^[+\d\s()-]{5,40}$/.test(phone)) errors.phone = "Телефон — цифры, пробелы, скобки, «+» и «-».";
    if (launch && !inn && !asset && !client_name && !errors.inn) errors.asset = "Укажите ИНН или наименование клиента либо выберите предмет лизинга.";
    if (Object.keys(errors).length) throw Object.assign(new Error(Object.values(errors).join(" ")), { status: 400, errors });
    return { inn: inn || null, asset, amount_mln: amount, term_months: term, comment: String(f.comment || "").trim().slice(0, 500) || null, client: { name: client_name, contact_name, phone } };
  }

  // Ответ после успешного действия: перенаправление и короткое сообщение (cookie flash читает скрипт форм)
  const done = (res, to, msg) => H.redirect(res, to, { "set-cookie": `flash=${encodeURIComponent(msg)}; Path=/; Max-Age=60; SameSite=Lax` });
  const FIELD_LABEL = { inn: "ИНН", asset: "предмет", amount_mln: "сумма", term_months: "срок", comment: "примечание", client: "клиент" };

  // Одноразовые токены формы запуска: повторная отправка той же формы (двойной клик, повтор после обрыва связи)
  // не создаёт вторую сделку, а ведёт к уже созданной. null — сделка ещё создаётся.
  const onces = new Map();
  async function once(token, run) {
    if (!/^[\w-]{16,64}$/.test(token || "")) return run();
    while (onces.get(token) === null) await new Promise((r) => setTimeout(r, 100));
    if (onces.has(token)) return { id: onces.get(token), repeated: true };
    onces.set(token, null);
    try {
      const id = await run();
      onces.set(token, id);
      if (onces.size > 2000) onces.delete(onces.keys().next().value);
      return { id };
    } catch (e) { onces.delete(token); throw e; }
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
    if (down.length) return { title, cls: null, note: `${down.length > 1 ? "Источники" : "Источник"} ${down.map((s) => `«${s}»`).join(" и ")} ${down.length > 1 ? "недоступны" : "недоступен"}: проверка не выполнена — «Проверить снова»`, ok: false };
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
    return { deal, events: deals.events(deal.id), canEdit: can(user, "deals.edit"), client, classes, clientRec: deal.client_id ? clients.get(deal.client_id) : null, tasks: tasks.byDeal(deal.id), users: editors(), user, files: files.byDeal(deal.id) };
  }

  async function launchDeal(user, f) {
    const v = dealFields(f, { launch: true });
    // по этому ИНН уже есть сделки в работе — новая создаётся только после явного подтверждения
    // (без ИНН — у клиента с тем же наименованием)
    const known = v.inn ? clients.byInn(v.inn) : v.client.name ? clients.list(v.client.name).find((c) => !c.inn && norm(c.name) === norm(v.client.name)) : null;
    const dups = f.dup_ok !== "1" ? deals.list().filter((d) => !d.outcome && ((v.inn && d.inn === v.inn) || (known && d.client_id === known.id))) : [];
    if (dups.length) throw Object.assign(new Error(v.inn ? "По этому ИНН уже есть сделки в работе." : "У клиента с таким наименованием уже есть сделки в работе."), { status: 409, dups, byInn: !!v.inn });
    let sum = { title: null, cls: null, note: v.inn ? null : "ИНН ещё не указан" };
    if (v.inn) sum = checkSummary(v.inn, await checkClient(user, v.inn));
    // наименование: введённое пользователем > DaData > временное «ИНН …»
    const fromSource = v.inn && sum.ok && sum.title !== `ИНН ${v.inn}` ? sum.title : null;
    let client = clients.ensure({ inn: v.inn, name: v.client.name || fromSource || (v.inn ? `ИНН ${v.inn}` : null), source: v.client.name ? "manual" : fromSource ? "dadata" : "placeholder", contact_name: v.client.contact_name, phone: v.client.phone });
    if (client && fromSource) client = clients.nameFromSource(client.id, fromSource);
    const title = client ? client.name : `Без клиента${v.asset ? ` · ${v.asset}` : ""}`;
    return deals.create({ ...v, title, client_id: client?.id ?? null, cls: sum.cls, note: sum.note, userId: user.id });
  }

  // Повторная проверка клиента сделки (после смены ИНН или когда источник был недоступен)
  async function recheckDeal(user, deal, reason) {
    if (!deal.inn) return deals.setCheck(deal.id, { title: deal.title, cls: null, note: "ИНН ещё не указан" }, user.id, null);
    const sum = checkSummary(deal.inn, await checkClient(user, deal.inn));
    // название сделки — по клиенту: DaData заменяет только временное «ИНН …»
    const client = deal.client_id && sum.ok && sum.title !== `ИНН ${deal.inn}` ? clients.nameFromSource(deal.client_id, sum.title) : deal.client_id ? clients.get(deal.client_id) : null;
    if (client) sum.title = client.name;
    deals.setCheck(deal.id, sum, user.id, `${reason}: ${sum.ok ? `${sum.title}${sum.cls ? `, класс ${sum.cls}` : ""}` : "источник недоступен"}`);
  }

  // «Проверка по ИНН»: DaData + отчётность + песочницы; классы — по формулам core.js
  async function checkModel(user, url) {
    const inn = (url.searchParams.get("inn") || "").replace(/\D/g, "");
    const m = { inn, demo: demoInns };
    // пришли из карточки сделки (?deal=…) — ссылка «← К сделке»
    const from = deals.get(Number(url.searchParams.get("deal")) || 0);
    if (from) m.backDeal = { id: from.id, title: from.title };
    if (!inn) return m;
    if (!/^(\d{10}|\d{12})$/.test(inn)) return { ...m, error: "ИНН — 10 или 12 цифр." };
    const call = (id, op) => connectors.call(id, op, { inn }, { userId: user.id }).catch((e) => ({ failed: e.message }));
    const [party, fin, kontur, spark, onec, crm] = await Promise.all([call("dadata", "party"), call("fin", "reports"), call("kontur", "check"), call("spark", "risk"), call("onec", "contracts"), call("crm", "applications")]);
    if (party.failed) return { ...m, error: `DaData: ${party.failed}` };
    const ok = (r) => (r.failed ? null : r);
    const portal = { client: clients.byInn(inn), deals: deals.list().filter((d) => d.inn === inn) };
    return { ...m, party, fin: ok(fin), classes: fin.data?.reports ? annualClasses(fin.data) : [], docs: fin.data?.reports ? toDocs(fin.data) : [], side: { kontur: ok(kontur), spark: ok(spark), onec: ok(onec), crm: ok(crm) }, portal };
  }

  // Страницы для вошедших: [путь, право, рендер]
  const PAGES = {
    // /?inn=…&client_name=… — форма новой сделки с подставленным клиентом (из карточки клиента)
    "/": ["pages.view", async (u, url) => W.dashboardPage(u, { ...(await homeModel(u)), form: url.searchParams.has("client_name") || url.searchParams.has("inn") ? { values: { inn: url.searchParams.get("inn") || "", client_name: url.searchParams.get("client_name") || "" } } : undefined })],
    "/clients": ["pages.view", (u, url) => { const q = (url.searchParams.get("q") || "").trim(); return VC.clientsPage(u, { q, canEdit: can(u, "deals.edit"), clients: clients.list(q).map((c) => ({ ...c, deals: deals.byClient(c.id) })) }); }],
    // канбан: поиск и ответственный (стадия — колонки, отказы — отдельным блоком); список — все условия и сортировка
    "/deals": ["pages.view", (u, url) => { const f = { ...DF.parseFilter(url), status: "all", stage: "", sort: "", dir: "" }; const all = deals.list(); return W.dealsBoard(u, { deals: DF.filterDeals(all, f, u.id), f, users: editors(), total: all.length, canEdit: can(u, "deals.edit"), nextTasks: nextTasks() }); }],
    "/deals/list": ["pages.view", (u, url) => { const f = DF.parseFilter(url), all = deals.list(), t = nextTasks(); return VL.dealsList(u, { deals: DF.sortDeals(DF.filterDeals(all, f, u.id), f, t), f, users: editors(), total: all.length, tasks: t, canEdit: can(u, "deals.edit") }); }],
    "/search": ["pages.view", (u, url) => { const q = (url.searchParams.get("q") || "").trim().slice(0, 100); return VL.searchPage(u, { q, clients: q ? clients.list(q) : [], deals: q ? DF.filterDeals(deals.list(), { q, status: "all" }, u.id) : [] }); }],
    "/tasks": ["pages.view", (u, url) => VT.tasksPage(u, { tasks: tasks.open(), done: tasks.recentDone(), mine: !url.searchParams.has("all"), canEdit: can(u, "deals.edit"), userId: u.id })],
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
    // «/deals/15/» и подобные — тот же адрес без косой черты на конце, а не 404
    if (p.length > 1 && p.endsWith("/") && req.method === "GET") return H.redirect(res, p.replace(/\/+$/, "") + url.search);
    const token = H.parseCookies(req).sid;
    const user = auth.userByToken(token);
    if (user) user.tasksDue = tasks.dueCount(user.id); // счётчик в меню: просрочено и на сегодня

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
        if (deals.get(+dm[1])?.archived_at) return H.sendJson(res, 409, { error: { code: "archived", message: "Сделка в архиве — сначала верните её из архива." } });
        if (deals.get(+dm[1])?.outcome) return H.sendJson(res, 409, { error: { code: "refused", message: "Сделка закрыта отказом — сначала верните её в работу." } });
        const d = deals.move(+dm[1], body.stage, user.id);
        return d ? H.sendJson(res, 200, { deal: d }) : H.sendJson(res, 404, { error: { code: "not_found", message: "Нет такой сделки." } });
      }
      // PDF сделки для калькулятора (/calc#deal=…): список файлов и реквизиты клиента
      // результат калькулятора — в сделку: {classes: [{date, cls}], title, sub, stop}
      const dc = p.match(/^\/api\/deals\/(\d+)\/class$/);
      if (dc && req.method === "POST") {
        if (!can(user, "deals.edit")) return H.sendJson(res, 403, { error: { code: "forbidden", message: "Недостаточно прав." } });
        const d = deals.get(+dc[1]);
        if (!d) return H.sendJson(res, 404, { error: { code: "not_found", message: "Нет такой сделки." } });
        let b = null;
        try { b = JSON.parse((await H.readBody(req, 8192)).toString("utf8")); } catch {}
        const cl = Array.isArray(b?.classes) ? b.classes.filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c?.date) && [1, 2, 3].includes(c?.cls)) : [];
        if (!cl.length || cl.length > 5 || typeof b.title !== "string") return H.sendJson(res, 400, { error: { code: "bad_request", message: "Нужны классы по датам и заключение." } });
        const last = [...cl].sort((x, y) => y.date.localeCompare(x.date))[0];
        const dt = (s) => s.split("-").reverse().join(".");
        const title = b.title.slice(0, 100), sub = String(b.sub || "").slice(0, 300);
        const stop = b.stop ? "Класс 3 на всех четырёх датах — п. 14.1.6" : null;
        deals.setClass(d.id, { cls: last.cls, note: `${title} (калькулятор, ${dt(last.date)})`, stop }, user.id,
          `Расчёт класса: ${cl.map((c) => `${dt(c.date)} — ${c.cls}`).join(", ")}. Заключение: ${title}${sub ? `. ${sub}` : ""}`);
        return H.sendJson(res, 200, { ok: true, cls: last.cls, url: `/deals/${d.id}` }, { "set-cookie": `flash=${encodeURIComponent(`Класс ${last.cls} из калькулятора сохранён в сделке`)}; Path=/; Max-Age=60; SameSite=Lax` });
      }
      const df = p.match(/^\/api\/deals\/(\d+)\/files$/);
      if (df && req.method === "GET") {
        if (!can(user, "calc.use")) return H.sendJson(res, 403, { error: { code: "forbidden", message: "Недостаточно прав." } });
        const d = deals.get(+df[1]);
        if (!d) return H.sendJson(res, 404, { error: { code: "not_found", message: "Нет такой сделки." } });
        return H.sendJson(res, 200, { deal: { id: d.id, title: d.title, inn: d.inn }, files: files.byDeal(d.id).map((f) => ({ id: f.id, name: f.name, mime: f.mime, size: f.size, url: `/files/${f.id}` })) });
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
        const r = await once(f.once, () => launchDeal(user, f));
        const id = r.id ?? r;
        return done(res, `/deals/${id}`, r.repeated ? "Эта сделка уже создана — повторная отправка формы не создала дубль." : `Сделка создана: «${deals.get(id).title}»`);
      } catch (e) {
        if (!e.status) throw e;
        // ошибка ввода — у полей формы на дашборде, введённые значения сохраняются
        return H.send(res, e.status, W.dashboardPage(user, { ...(await homeModel(user)), form: { values: f, errors: e.errors, error: e.errors ? null : e.message, dups: e.dups, byInn: e.byInn } }));
      }
    }
    const dp = p.match(/^\/deals\/(\d+)(\/stage|\/edit|\/recheck|\/refuse|\/reopen|\/comment|\/tasks|\/owner|\/archive|\/unarchive|\/files)?$/);
    if (dp) {
      if (!user) return H.redirect(res, "/login?next=" + encodeURIComponent(p));
      const deal = deals.get(+dp[1]);
      if (!deal) return H.send(res, 404, V.errorPage(user, 404, "Сделка не найдена."));
      // адрес действия, открытый заново (обновление страницы после ошибки, закладка) — карточка сделки
      if (dp[2] && req.method === "GET") return H.redirect(res, `/deals/${deal.id}`);
      if ((dp[2] === "/edit" || dp[2] === "/recheck") && req.method === "POST") {
        if (!can(user, "deals.edit")) return H.send(res, 403, V.errorPage(user, 403, "Недостаточно прав."));
        const f = dp[2] === "/edit" ? await H.readForm(req) : {};
        if (dp[2] === "/recheck") {
          await recheckDeal(user, deal, "Повторная проверка клиента");
          return done(res, `/deals/${deal.id}`, `Клиент проверен заново: ${deals.get(deal.id).note || deals.get(deal.id).title}`);
        }
        try {
          const v = dealFields(f);
          // правка поверх чужой: поле изменил кто-то другой после открытия формы, а в форме другое значение —
          // не перезаписываем молча, а показываем оба значения. В форме уже текущие значения сделки (orig):
          // повторное «Сохранить» запишет значения пользователя осознанно.
          let orig = null; try { orig = JSON.parse(f.orig || "null"); } catch {}
          const clash = orig ? Object.keys(FIELD_LABEL).filter((k) => (deal[k] ?? null) !== (orig[k] ?? null) && (v[k] ?? null) !== (deal[k] ?? null)) : [];
          if (clash.length) {
            const by = deals.events(deal.id)[0];
            return H.send(res, 409, W.dealPage(user, { ...(await dealModel(user, deal)), form: { values: f, conflict: { fields: clash.map((k) => ({ label: FIELD_LABEL[k], key: k, theirs: deal[k], mine: v[k] })), by: by?.user_name || by?.user_email || "другой пользователь", at: by?.at } } }));
          }
          const changed = deals.edit(deal.id, v, user.id);
          // новый ИНН — другой клиент (найденный или новый); заявке без клиента — клиент по введённому наименованию
          if (changed.includes("inn") && v.inn) deals.setClient(deal.id, clients.ensure({ inn: v.inn, name: `ИНН ${v.inn}`, source: "placeholder" }), user.id);
          if (!deal.client_id && !v.inn && v.client.name) { deals.setClient(deal.id, clients.ensure({ name: v.client.name, contact_name: v.client.contact_name, phone: v.client.phone }), user.id); changed.push("client"); }
          if (changed.includes("inn")) await recheckDeal(user, deals.get(deal.id), "Проверка клиента по новому ИНН");
          return done(res, `/deals/${deal.id}`, changed.length ? `Сохранено: ${changed.map((k) => FIELD_LABEL[k]).join(", ")}` : "Изменений нет — данные сделки те же.");
        } catch (e) {
          if (!e.status) throw e;
          return H.send(res, 400, W.dealPage(user, { ...(await dealModel(user, deal)), form: { values: f, errors: e.errors } }));
        }
      }
      if (dp[2] === "/comment" && req.method === "POST") {
        if (!can(user, "deals.edit")) return H.send(res, 403, V.errorPage(user, 403, "Недостаточно прав."));
        const f = await H.readForm(req);
        const text = String(f.text || "").trim().slice(0, 2000);
        if (!text) return H.send(res, 400, W.dealPage(user, { ...(await dealModel(user, deal)), feed: { error: "Напишите комментарий.", values: f } }));
        // «Следующий контакт» в той же форме — задача автору (результат звонка и следующий шаг одним действием)
        let next = null;
        if (f.next_due) { try { next = tasks.fields({ task_text: "Следующий контакт с клиентом", due: f.next_due }, []); } catch (e) { return H.send(res, 400, W.dealPage(user, { ...(await dealModel(user, deal)), feed: { error: e.errors.due, values: f } })); } }
        deals.comment(deal.id, user.id, text);
        if (next) tasks.add(deal.id, { ...next, assignee_id: user.id }, user.id);
        return done(res, `/deals/${deal.id}#feed`, next ? `Комментарий добавлен, задача «Следующий контакт» — на ${next.due.split("-").reverse().join(".")}.` : "Комментарий добавлен.");
      }
      // загрузка документа: тело — сам файл, имя — в заголовке X-File-Name (encodeURIComponent); ответ JSON
      if (dp[2] === "/files" && req.method === "POST") {
        if (!can(user, "deals.edit")) return H.sendJson(res, 403, { error: { code: "forbidden", message: "Недостаточно прав." } });
        if (deal.archived_at) return H.sendJson(res, 409, { error: { code: "archived", message: "Сделка в архиве." } });
        let name = "";
        try { name = decodeURIComponent(req.headers["x-file-name"] || ""); } catch {}
        const pre = files.check(name, Number(req.headers["content-length"]) || 1);
        if (pre.error) return H.sendJson(res, 400, { error: { code: "bad_file", message: pre.error } });
        const body = await H.readBody(req, files.MAX_BYTES).catch((e) => { if (e.status === 413) return null; throw e; });
        if (!body) return H.sendJson(res, 413, { error: { code: "too_large", message: `Файл больше ${sizeText(files.MAX_BYTES)}.` } });
        const ok = files.check(name, body.length);
        if (ok.error) return H.sendJson(res, 400, { error: { code: "bad_file", message: ok.error } });
        const f = files.add(deal.id, { name: ok.name, mime: ok.mime, body }, user.id);
        return H.sendJson(res, 201, { file: { id: f.id, name: f.name, size: f.size } }, { "set-cookie": `flash=${encodeURIComponent(`Файл добавлен: ${f.name}`)}; Path=/; Max-Age=60; SameSite=Lax` });
      }
      if ((dp[2] === "/archive" || dp[2] === "/unarchive") && req.method === "POST") {
        if (!can(user, "deals.edit")) return H.send(res, 403, V.errorPage(user, 403, "Недостаточно прав."));
        const on = dp[2] === "/archive";
        if (!!deal.archived_at !== on) deals.archive(deal.id, user.id, on);
        return done(res, on ? "/deals" : `/deals/${deal.id}`, on ? `Сделка «${deal.title}» перенесена в архив. Вернуть: «Сделки» → «Список» → «Архив».` : "Сделка возвращена из архива.");
      }
      if (dp[2] === "/owner" && req.method === "POST") {
        if (!can(user, "deals.edit")) return H.send(res, 403, V.errorPage(user, 403, "Недостаточно прав."));
        const f = await H.readForm(req);
        const to = editors().find((u) => String(u.id) === String(f.owner_id));
        if (!to) return H.send(res, 400, V.errorPage(user, 400, "Выберите сотрудника из списка."));
        const changed = deals.setOwner(deal.id, to.id, user.id, deal.owner_name || deal.owner_email, to.name || to.email);
        return done(res, `/deals/${deal.id}`, changed ? `Ответственный за сделку — ${to.name || to.email}.` : "Ответственный не изменился.");
      }
      if (dp[2] === "/tasks" && req.method === "POST") {
        if (!can(user, "deals.edit")) return H.send(res, 403, V.errorPage(user, 403, "Недостаточно прав."));
        const f = await H.readForm(req);
        try {
          const v = tasks.fields(f, editors());
          const t = tasks.add(deal.id, { ...v, assignee_id: v.assignee_id ?? user.id }, user.id); // исполнитель по умолчанию — автор
          return done(res, `/deals/${deal.id}#tasks`, `Задача поставлена: «${t.text}» до ${t.due.split("-").reverse().join(".")}`);
        } catch (e) {
          if (!e.status) throw e;
          return H.send(res, 400, W.dealPage(user, { ...(await dealModel(user, deal)), taskForm: { values: f, errors: e.errors } }));
        }
      }
      if ((dp[2] === "/refuse" || dp[2] === "/reopen") && req.method === "POST") {
        if (!can(user, "deals.edit")) return H.send(res, 403, V.errorPage(user, 403, "Недостаточно прав."));
        const f = await H.readForm(req);
        if (dp[2] === "/reopen") deals.reopen(deal.id, user.id);
        else {
          const why = String(f.comment || "").trim().slice(0, 300);
          const error = !W.REFUSAL_REASONS.includes(f.reason) ? "Выберите причину отказа." : f.reason === "Другое" && !why ? "Для причины «Другое» опишите её в комментарии." : null;
          if (error) return H.send(res, 400, W.dealPage(user, { ...(await dealModel(user, deal)), refuse: { values: f, error } }));
          if (!deal.outcome) deals.refuse(deal.id, f.reason === "Другое" ? why : why ? `${f.reason} — ${why}` : f.reason, user.id);
        }
        return done(res, `/deals/${deal.id}`, dp[2] === "/reopen" ? "Сделка возвращена в работу." : "Отказ оформлен: сделка убрана из воронки и счётчиков.");
      }
      if (dp[2] === "/stage" && req.method === "POST") {
        if (!can(user, "deals.edit")) return H.send(res, 403, V.errorPage(user, 403, "Недостаточно прав."));
        const f = await H.readForm(req);
        const stage = f.stage === "__any" ? f.stage_any : f.stage;
        if (!deals.STAGE_IDS.includes(stage)) return H.send(res, 400, V.errorPage(user, 400, "Неизвестная стадия."));
        if (deal.archived_at) return H.send(res, 409, V.errorPage(user, 409, "Сделка в архиве — сначала верните её из архива."));
        if (deal.outcome) return H.send(res, 409, V.errorPage(user, 409, "Сделка закрыта отказом — сначала верните её в работу."));
        deals.move(deal.id, stage, user.id);
        return done(res, `/deals/${deal.id}`, stage === deal.stage ? "Стадия не изменилась." : `Стадия изменена: «${deals.stageTitle(deal.stage)}» → «${deals.stageTitle(stage)}»`);
      }
      if (!dp[2] && req.method === "GET") return H.send(res, 200, W.dealPage(user, await dealModel(user, deal)));
    }

    // Клиент: карточка и правка
    const cp = p.match(/^\/clients\/(\d+)(\/edit)?$/);
    if (cp) {
      if (!user) return H.redirect(res, "/login?next=" + encodeURIComponent(p));
      if (!can(user, "pages.view")) return H.send(res, 403, V.errorPage(user, 403, "Недостаточно прав для этой страницы."));
      const client = clients.get(+cp[1]);
      if (!client) return H.send(res, 404, V.errorPage(user, 404, "Клиент не найден."));
      if (!cp[2] && req.method === "GET") return H.send(res, 200, VC.clientPage(user, { client, deals: deals.byClient(client.id), canEdit: can(user, "deals.edit") }));
      if (cp[2] && req.method === "GET") return H.redirect(res, `/clients/${client.id}`);
      if (cp[2] && req.method === "POST") {
        if (!can(user, "deals.edit")) return H.send(res, 403, V.errorPage(user, 403, "Недостаточно прав."));
        const f = await H.readForm(req);
        try {
          const { changed } = clients.update(client.id, f);
          const L = { name: "наименование", inn: "ИНН", contact_name: "контактное лицо", phone: "телефон", email: "email", note: "примечание" };
          if (changed.length) for (const d of deals.byClient(client.id)) deals.note(d.id, user.id, `Клиент изменён: ${changed.map((k) => L[k]).join(", ")}`);
          return done(res, `/clients/${client.id}`, changed.length ? `Сохранено: ${changed.map((k) => L[k]).join(", ")}` : "Изменений нет — данные клиента те же.");
        } catch (e) {
          if (!e.status) throw e;
          return H.send(res, 400, VC.clientPage(user, { client, deals: deals.byClient(client.id), canEdit: true, form: { values: f, errors: e.errors } }));
        }
      }
    }

    // Документ сделки: просмотр или скачивание; удаление из карточки (мягкое) — с подтверждением на странице
    const fp = p.match(/^\/files\/(\d+)(\/delete)?$/);
    if (fp) {
      if (!user) return H.redirect(res, "/login?next=" + encodeURIComponent(p));
      if (!can(user, "pages.view")) return H.send(res, 403, V.errorPage(user, 403, "Недостаточно прав для этой страницы."));
      const f = files.get(+fp[1]);
      if (!f || f.deleted_at) return H.send(res, 404, V.errorPage(user, 404, "Файл не найден или удалён из карточки сделки."));
      if (!fp[2] && req.method === "GET") {
        const inline = /^(application\/pdf|image\/)/.test(f.mime);
        return H.send(res, 200, files.read(f), f.mime, { "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`, "x-content-type-options": "nosniff" });
      }
      if (fp[2] && req.method === "POST") {
        if (!can(user, "deals.edit")) return H.send(res, 403, V.errorPage(user, 403, "Недостаточно прав."));
        files.remove(f.id, user.id);
        return done(res, `/deals/${f.deal_id}#docs`, `Файл «${f.name}» убран из карточки сделки.`);
      }
    }

    // Выгрузка сделок для отчёта: CSV для Excel (UTF-8 с BOM, разделитель «;»), условия — как у списка
    if (p === "/deals/export.csv" && req.method === "GET") {
      if (!user) return H.redirect(res, "/login?next=" + encodeURIComponent(p + url.search));
      if (!can(user, "pages.view")) return H.send(res, 403, V.errorPage(user, 403, "Недостаточно прав для этой страницы."));
      const f = DF.parseFilter(url), t = nextTasks();
      const rows = DF.sortDeals(DF.filterDeals(deals.list(), f, user.id), f, t);
      const cell = (v) => { const s = v === null || v === undefined ? "" : String(v); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const num = (v) => (v === null || v === undefined ? "" : String(v).replace(".", ","));
      const date = (ms) => (ms ? new Date(ms).toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" }) : "");
      const stage = (d) => STAGES.find((s) => s.id === d.stage)?.title || d.stage;
      const STATE = { active: "в работе", refused: "отказ", archived: "архив" };
      const head = ["№", "Клиент", "ИНН", "Предмет", "Сумма, млн руб.", "Стадия", "Состояние", "Причина отказа", "Ответственный", "На стадии, дней", "Следующая задача", "Срок задачи", "Последняя активность", "Создана"];
      const lines = rows.map((d) => [d.id, d.title, d.inn, d.asset, num(d.amount_mln), stage(d), STATE[DF.statusOf(d)], d.outcome_reason, d.owner_name || d.owner_email, Math.floor((Date.now() - (d.stage_at || d.created_at)) / 86400000), t.get(d.id)?.text, t.get(d.id)?.due?.split("-").reverse().join("."), date(d.last_at || d.updated_at), date(d.created_at)].map(cell).join(";"));
      const name = `sdelki-${new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Moscow" })}.csv`;
      return H.send(res, 200, "\uFEFF" + [head.join(";"), ...lines].join("\r\n"), "text/csv; charset=utf-8", { "content-disposition": `attachment; filename="${name}"` });
    }

    // Задача: выполнено / вернуть в работу; back — откуда пришли (только локальный путь)
    const tp = p.match(/^\/tasks\/(\d+)\/(done|undo)$/);
    if (tp && req.method === "POST") {
      if (!user) return H.redirect(res, "/login");
      if (!can(user, "deals.edit")) return H.send(res, 403, V.errorPage(user, 403, "Недостаточно прав."));
      const t = tasks.get(+tp[1]);
      if (!t) return H.send(res, 404, V.errorPage(user, 404, "Задача не найдена."));
      const back = safeNext((await H.readForm(req)).back || `/deals/${t.deal_id}#tasks`);
      tasks.setDone(t.id, user.id, tp[2] === "done");
      return done(res, back, tp[2] === "done" ? `Задача выполнена: «${t.text}»` : `Задача снова в работе: «${t.text}»`);
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
