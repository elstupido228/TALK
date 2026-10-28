// Раннее предупреждение на сервере: портфель, карточка клиента, загрузка выгрузки, шаблон — тем же кодом features.js
// и картой model.json, что при обучении и сверке с Python (check_parity.js). Python в рантайме не нужен.
// Наборы данных: «demo» — условный портфель data/demo.json; загруженные выгрузки — только в памяти, на время сеанса расчёта.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const F = require("../../seed/ews/features.js");
const { openBook } = require("./xlsx-read");
const { demoParty } = require("./directory");

const DATA = path.join(__dirname, "..", "..", "seed", "ews", "data");
const XLSX_LIB = path.join(__dirname, "..", "public", "vendor", "xlsx.full.min.js");
const DISCLAIMER = "Данные условные: портфель сгенерирован, веса и точность показывают работу метода, а не реальные зависимости.";
const HISTORY = 24; // месяцев в графике зон и в карточке
const UPLOAD_TTL_MS = 30 * 60 * 1000;
// износ предмета в год — как на странице-прототипе; нормы условные, их задаёт ТАЛК
const DEPR = { "Грузовой транспорт": 0.15, "Спецтехника": 0.12, "Легковой транспорт": 0.18, "Оборудование": 0.20 };

// Шаблон выгрузки: 6 листов, [заголовок, поле, тип (s — строка, d — дата, n — число, b — да/нет), пояснение]
const SHEETS = [
  { name: "Клиенты", key: "clients", src: "1С:Лизинг", cols: [["ID клиента", "client", "s", "Служебный идентификатор клиента в учётной системе (обезличенный)"], ["Наименование", "name", "s", "Необязательно: показывается в портале, в расчёт не идёт"], ["ИНН", "inn", "s", "Необязательно: показывается в портале, в расчёт не идёт"], ["Отрасль", "sector", "s", "Отрасль по основному ОКВЭД"], ["Регион", "region", "s", ""], ["Дата начала отношений", "since", "d", "Дата первого договора"]] },
  { name: "Договоры", key: "contracts", src: "1С:Лизинг", cols: [["Номер договора", "contract", "s", "Код договора"], ["ID клиента", "client", "s", ""], ["Дата договора", "date", "d", ""], ["Тип предмета лизинга", "asset", "s", "Грузовой транспорт, Спецтехника, Легковой транспорт, Оборудование"], ["Стоимость предмета, руб.", "asset_value", "n", "Стоимость при передаче"], ["Аванс, руб.", "advance", "n", ""], ["Срок, мес.", "term", "n", ""], ["Поручительство (да/нет)", "guarantee", "b", ""]] },
  { name: "График", key: "schedule", src: "1С:Лизинг", cols: [["Номер договора", "contract", "s", ""], ["Дата платежа", "due", "d", "Действующая версия графика"], ["Сумма платежа, руб.", "amount", "n", ""]] },
  { name: "Платежи", key: "payments", src: "1С:Лизинг", cols: [["Номер договора", "contract", "s", ""], ["Дата оплаты", "date", "d", "Дата поступления"], ["Сумма оплаты, руб.", "amount", "n", "Без пеней"]] },
  { name: "События", key: "events", src: "1С:Лизинг, протоколы КПА (коллегиального органа по проблемным активам), внешние источники по ИНН", cols: [["ID клиента", "client", "s", ""], ["Дата", "date", "d", "Дата события, не дата его обнаружения"], ["Тип события", "type", "s", Object.values(F.EV).join("; ")], ["Сумма, руб.", "amount", "n", "Для исков, недоимки, исполнительных производств"]] },
  { name: "Отчётность", key: "reports", src: "ГИР БО, СПАРК или Контур по ИНН", cols: [["ID клиента", "client", "s", ""], ["Год", "year", "n", "Отчётный год"], ["Дата представления", "filed", "d", "Дата сдачи в ФНС"], ["Выручка, тыс. руб.", "revenue", "n", "стр. 2110"], ["Чистая прибыль, тыс. руб.", "net_profit", "n", "стр. 2400"], ["Капитал, тыс. руб.", "equity", "n", "стр. 1300"], ["Активы, тыс. руб.", "assets", "n", "стр. 1600"], ["Долг, тыс. руб.", "debt", "n", "стр. 1410 + 1510"]] },
];
// прежние заголовки шаблона, которые по-прежнему принимаются
const ALIASES = { "ID клиента": ["Код клиента"] };
const REQUIRED = ["client", "contract", "date", "due", "amount", "year", "filed", "type"];

const err = (status, code, message) => Object.assign(new Error(message), { status, code });
const isoOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "") && !isNaN(Date.parse(s));
const fdate = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : "");

function createEws(opts = {}) {
  const env = opts.env || process.env;
  // EWS_MODEL — файл карты в seed/ews/data (или абсолютный путь); по умолчанию эталонная карта model.json
  const modelFile = path.resolve(DATA, env.EWS_MODEL || "model.json");
  // выгрузок в памяти одновременно: индекс выгрузки размером с демо-портфель — около 15 МБ, память стенда — 100 МБ
  const uploadMax = Math.max(1, Number(env.EWS_UPLOADS_MAX) || 2);
  const model = JSON.parse(fs.readFileSync(modelFile, "utf8"));
  let lookup = opts.lookup || (() => null); // ID → {name, inn} из справочника клиентов портала
  const sets = new Map(); // id -> {idx, assets, label, name, owner, expires, cache}
  let xlsx = null;
  const X = () => (xlsx ??= require(XLSX_LIB));

  function demoSet() {
    if (!sets.has("demo")) {
      const data = JSON.parse(fs.readFileSync(path.join(DATA, "demo.json"), "utf8"));
      // сырой JSON после подготовки индекса не держим (память стенда); тип предмета — для сводки на главной
      const assets = new Map(data.contracts.map((c) => [c.client, c.asset])); // последний договор клиента
      sets.set("demo", { id: "demo", idx: F.prepare(data), assets, label: "demo", cache: new Map() });
    }
    return sets.get("demo");
  }
  function sweep() {
    const now = Date.now();
    for (const [id, s] of sets) if (s.expires && s.expires < now) sets.delete(id);
  }
  // набор данных: demo или выгрузка этого пользователя (чужие выгрузки не видны)
  function dataset(id, user) {
    sweep();
    if (!id || id === "demo") return demoSet();
    const s = sets.get(id);
    if (!s || s.owner !== user?.id) throw err(404, "not_found", "Выгрузка не найдена или срок расчёта истёк — загрузите файл снова.");
    s.expires = Date.now() + UPLOAD_TTL_MS;
    return s;
  }

  // наименование и ИНН клиента; ID на экран не выводится
  function party(ds, id) {
    const demo = ds.label === "demo" ? demoParty(id, ds.idx.clients.get(id)?.sector) : null;
    const p = lookup(id) || ds.parties?.get(id) || demo;
    // условные — реквизиты демо-портфеля (в том числе перенесённые в справочник портала условными сделками)
    return { name: p?.name || null, inn: p?.inn || null, conditional: !!demo && p.inn === demo.inn };
  }
  const named = (ds, out) => ({ ...out, clients: out.clients.map((c) => ({ ...c, ...party(ds, c.client) })) });

  // ---------- карта ----------
  function modelInfo() {
    const { lead, ...validation } = model.validation;
    return {
      version: model.version, file: path.basename(modelFile), data: model.data, target: model.target, scaling: model.scaling,
      zones: model.zones, vars: model.vars, candidates: model.candidates,
      validation: { ...validation, lead: { ...lead, cases: lead.cases.map((c) => { const ds = demoSet(); return ds.idx.clients.has(c.client) ? { ...c, ...party(ds, c.client) } : { ...c, name: null, inn: null, pool: true }; }) } },
      features: F.FEATURES.map(({ name, label, group }) => ({ name, label, group })), events: Object.values(F.EV),
      disclaimer: DISCLAIMER,
    };
  }

  // ---------- портфель на дату ----------
  function zoneOf(f) {
    const s = F.score(model, f);
    return { ...s, zone: f.status === "оценивается" ? s.zone : "grey" };
  }
  function monthEnd(ds, date) {
    const ends = ds.idx.ends;
    if (!date) return ends.length - 1;
    if (!isoOk(date)) throw err(400, "bad_request", "Дата — ГГГГ-ММ-ДД.");
    const t = F.dnum(date);
    let i = ends.length - 1;
    while (i >= 0 && ends[i] > t) i--; // ближайший конец месяца не позже даты
    if (i < 0) throw err(400, "bad_request", `Дата раньше начала данных (${F.diso(ends[0])}).`);
    return i;
  }
  function portfolio(ds, date) {
    const ei = monthEnd(ds, date);
    const key = String(ei);
    if (ds.cache.has(key)) return ds.cache.get(key);
    const ends = ds.idx.ends.slice(Math.max(0, ei - HISTORY), ei + 1).map(F.diso);
    const asOf = ends[ends.length - 1], prevDate = ends.length > 1 ? ends[ends.length - 2] : null;
    const by = new Map(), months = {};
    for (const r of F.snapshots(ds.idx, { from: ends[0], to: asOf })) {
      if (!by.has(r.client)) by.set(r.client, new Map());
      const z = zoneOf(r);
      by.get(r.client).set(r.date, { r, ...z });
      const mc = (months[r.date] ??= { red: 0, yellow: 0, green: 0, grey: 0 });
      mc[z.zone]++;
    }
    const clients = [];
    for (const [cid, h] of by) {
      const now = h.get(asOf);
      if (!now) continue; // нет действующих договоров на дату оценки
      const prev = prevDate ? h.get(prevDate) : null;
      const cl = ds.idx.clients.get(cid), f = now.r;
      clients.push({
        client: cid, sector: cl.sector || "", region: cl.region || "", zone: now.zone, score: now.score,
        prev_zone: prev ? prev.zone : null, delta: prev && now.zone !== "grey" ? Math.round((now.score - prev.score) * 100) / 100 : null,
        exposure: f.exposure, dpd: f.dpd_now, ltv: f.ltv, status: f.status, stop_bankr: !!f.stop_bankr,
        reasons: now.zone === "grey" ? [] : F.reasons(model, now.parts, 3).map(({ name, label, lost }) => ({ name, label, lost: Math.round(lost * 100) / 100 })),
      });
    }
    const ZORD = { red: 0, yellow: 1, green: 2, grey: 3 };
    clients.sort((a, b) => ZORD[a.zone] - ZORD[b.zone] || a.score - b.score);
    const zones = {};
    for (const z of ["red", "yellow", "green", "grey"]) {
      const l = clients.filter((c) => c.zone === z);
      zones[z] = { clients: l.length, exposure: l.reduce((s, c) => s + c.exposure, 0) };
    }
    const order = ["green", "yellow", "red", "grey"];
    const migration = Object.fromEntries(order.map((a) => [a, Object.fromEntries(order.map((b) => [b, 0]))]));
    for (const c of clients) if (c.prev_zone) migration[c.prev_zone][c.zone]++;
    const out = {
      dataset: ds.id, label: ds.label, date: asOf, prev_date: prevDate, model_version: model.version,
      demo: ds.label === "demo", disclaimer: ds.label === "demo" ? DISCLAIMER : "Баллы по балльной карте, обученной на условных данных.",
      total: { clients: clients.length, exposure: clients.reduce((s, c) => s + c.exposure, 0) }, zones, migration,
      worsened: clients.filter((c) => c.prev_zone && ZORD[c.zone] < ZORD[c.prev_zone] && c.zone !== "grey").length,
      months: ends.slice(1).map((d) => ({ date: d, ...(months[d] || { red: 0, yellow: 0, green: 0, grey: 0 }) })),
      clients,
    };
    if (ds.cache.size > 6) ds.cache.delete(ds.cache.keys().next().value);
    ds.cache.set(key, out);
    return out;
  }

  // ---------- карточка клиента ----------
  function binLabel(v, bin) {
    if (bin === -1) return "нет данных";
    if (v.cat) return (v.groups[bin] || []).join(", ");
    const s = v.splits, fmt = (x) => String(Math.round(x * 1000) / 1000).replace(".", ",");
    return bin === 0 ? `< ${fmt(s[0])}` : bin === s.length ? `≥ ${fmt(s[s.length - 1])}` : `${fmt(s[bin - 1])} – ${fmt(s[bin])}`;
  }
  function client(ds, code, { months = HISTORY, date } = {}) {
    const cl = ds.idx.clients.get(code);
    if (!cl) throw err(404, "not_found", `Клиента ${code} нет в наборе данных.`);
    const n = Math.min(60, Math.max(3, Number(months) || HISTORY));
    const ends = ds.idx.ends;
    const asI = monthEnd(ds, date);
    // история: n месяцев до даты оценки, для дефолта — до 3 месяцев после него
    let endI = asI;
    const fd = F.firstDefault(ds.idx, cl);
    const defIdx = fd === null ? null : ends.indexOf(fd);
    if (defIdx !== null && defIdx >= 0 && defIdx < asI) endI = Math.min(asI, defIdx + 3);
    const startI = Math.max(0, endI - (defIdx !== null && defIdx < asI ? Math.min(n, 18) : n));
    const history = [];
    let last = null;
    for (let i = startI; i <= endI; i++) {
      const t = ends[i], d = F.diso(t);
      const f = t >= cl.since_d ? F.features(ds.idx, cl, t) : null;
      if (!f) { history.push({ date: d, score: null, zone: null, status: "нет договоров", dpd: F.clientDpd(cl, t) }); continue; }
      const status = defIdx !== null && i > defIdx ? "дефолт" : f.dpd_now >= 30 ? "просрочка 30+" : "оценивается";
      const s = F.score(model, f);
      const p = { date: d, score: s.score, zone: status === "оценивается" ? s.zone : "grey", status, dpd: f.dpd_now };
      history.push(p);
      last = { ...p, f, parts: s.parts };
    }
    const cur = portfolio(ds, date).clients.find((c) => c.client === code) || null;
    // клиент в портфеле на дату — шапка и вклад факторов на дату оценки (история могла закончиться у дефолта)
    if (cur) {
      const fNow = F.features(ds.idx, cl, ends[asI]), s = F.score(model, fNow);
      last = { date: F.diso(ends[asI]), score: s.score, zone: cur.zone, f: fNow, parts: s.parts };
    }
    const f = last ? last.f : null;
    const asOf = cur ? F.diso(ends[asI]) : last ? last.date : null;
    const contributions = f ? model.vars.map((v) => {
      const p = last.parts[v.name], best = Math.max(...v.points, v.missing);
      return { name: v.name, label: v.label, group: v.group, value: f[v.name] ?? null, bin: p.bin, bin_label: binLabel(v, p.bin), points: p.points, best, lost: Math.round((best - p.points) * 100) / 100 };
    }).sort((a, b) => b.lost - a.lost) : [];
    const tNow = asOf ? F.dnum(asOf) : ds.idx.today;
    const t12 = F.addMonths(tNow, -12);
    const inScore = { fssp_12m: F.EV.fssp, tax_12m: F.EV.tax, suits_12m: F.EV.suit, ceo_12m: F.EV.ceo };
    const scored = new Set(model.vars.map((v) => inScore[v.name]).filter(Boolean));
    const events = cl.events.filter((e) => e.d > t12 && e.d <= tNow).reverse()
      .map((e) => ({ date: e.date, type: e.type, amount: e.amount ?? null, role: e.type === F.EV.bankr ? "стоп-фактор" : scored.has(e.type) ? "в балле" : "сигнал" }));
    const contracts = cl.contracts.map((o) => {
      let k = 0; while (k < o.paid.length && o.paid[k] !== null && o.paid[k] <= tNow) k++;
      const out = o.total - (k > 0 ? o.cum[k - 1] : 0);
      const val = o.asset_value * Math.pow(1 - (DEPR[o.asset] ?? 0.15), Math.max(0, (tNow - o.start) / 365.25));
      const closed = o.closed !== null && o.closed <= tNow, term = cl.term_d !== null && cl.term_d <= tNow;
      const st = o.start > tNow ? "не начат" : term ? "расторгнут" : closed ? "исполнен" : "действует";
      return { contract: o.contract, asset: o.asset, date: o.date, term: o.term, asset_value: o.asset_value,
        outstanding: st === "исполнен" ? 0 : Math.round(out), dpd: st === "действует" || st === "расторгнут" ? F.contractDpd(o, tNow) : 0,
        ltv: st === "действует" ? Math.round((out / val) * 100) / 100 : null, guarantee: o.guarantee === true || o.guarantee === "да", status: st };
    });
    return {
      dataset: ds.id, client: code, ...party(ds, code), sector: cl.sector || "", region: cl.region || "", since: cl.since, as_of: asOf,
      zone: cur ? cur.zone : last ? last.zone : "grey", score: last ? last.score : null, delta: cur ? cur.delta : null,
      default_date: defIdx !== null && defIdx >= 0 ? F.diso(ends[defIdx]) : null, stop_bankr: !!(f && f.stop_bankr),
      facts: f ? { exposure: f.exposure, dpd: f.dpd_now, ltv: f.ltv, max_dpd_6m: f.max_dpd_6m, share_paid: f.share_paid, contracts: cl.contracts.length } : null,
      reasons: contributions.filter((c) => c.lost > 0.5).slice(0, 3).map(({ name, label, lost }) => ({ name, label, lost })),
      contributions, history, events, contracts,
    };
  }

  // ---------- загрузка выгрузки (xlsx) ----------
  const normDate = (v) => {
    if (v === null || v === undefined || v === "") return null;
    if (v instanceof Date && !isNaN(v)) return new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate())).toISOString().slice(0, 10);
    if (typeof v === "number") return isFinite(v) && v > 60 && v < 2958466 ? new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 864e5).toISOString().slice(0, 10) : null; // серийная дата Excel
    const s = String(v).trim(); let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/); if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  };
  const normNum = (v) => { if (v === null || v === undefined || v === "") return null; if (typeof v === "number") return v; const x = parseFloat(String(v).replace(/\s/g, "").replace(",", ".")); return isFinite(x) ? x : null; };
  const normBool = (v) => { const s = String(v ?? "").trim().toLowerCase(); return s === "да" || s === "1" || s === "true" || s === "yes"; };

  // Проверка файла: листы и столбцы, связи между листами, нераспознанные события. Файл не пишется на диск и не логируется.
  function parseUpload(input) {
    const buf = Buffer.from(input.buffer ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : input);
    if (buf.subarray(0, 2).toString("latin1") !== "PK") throw err(400, "bad_file", "Нужен файл xlsx по шаблону.");
    let book;
    try { book = openBook(buf); } catch { throw err(400, "bad_file", "Файл не читается как xlsx."); }
    const names = book.names;
    const checks = [], data = {};
    let fatal = false;
    for (const s of SHEETS) {
      if (!names.includes(s.name)) { checks.push({ status: "error", title: `Лист «${s.name}» не найден`, detail: "" }); fatal = true; data[s.key] = []; continue; }
      // по одному листу (xlsx-read.js): SheetJS на выгрузке размером с демо-портфель не помещается в 100 МБ стенда
      let { head, rows } = book.rows(s.name);
      const col = (t) => [t, ...(ALIASES[t] || [])].find((h) => head.includes(h));
      const miss = s.cols.filter((c) => !col(c[0])).map((c) => c[0]);
      const req = s.cols.filter((c) => REQUIRED.includes(c[1]) && miss.includes(c[0]));
      let bad = 0;
      data[s.key] = rows.map((r) => {
        const o = {};
        for (const [h, k, t] of s.cols) { const v = r[col(h)]; o[k] = t === "d" ? normDate(v) : t === "n" ? normNum(v) : t === "b" ? normBool(v) : v === null ? null : String(v).trim(); }
        return o;
      }).filter((o) => { const ok = s.cols.every(([, k, t]) => !(t === "d" && ["date", "due", "filed"].includes(k) && !o[k])); if (!ok) bad++; return ok; });
      if (req.length) { fatal = true; checks.push({ status: "error", title: `Лист «${s.name}»: нет обязательных столбцов`, detail: req.map((c) => c[0]).join(", ") }); }
      else checks.push({ status: bad ? "warn" : "ok", title: `Лист «${s.name}»: ${data[s.key].length.toLocaleString("ru-RU")} строк`, detail: (miss.length ? `нет столбцов: ${miss.join(", ")}. ` : "") + (bad ? `пропущено строк без даты: ${bad}` : "") });
    }
    let suggested = null;
    if (!fatal) {
      const conIds = new Set(data.contracts.map((c) => c.contract)), cliIds = new Set(data.clients.map((c) => c.client)), schIds = new Set(data.schedule.map((s) => s.contract));
      const orphanCon = data.contracts.filter((c) => !cliIds.has(c.client)).length, orphanPay = data.payments.filter((p) => !conIds.has(p.contract)).length;
      const noSched = data.contracts.filter((c) => !schIds.has(c.contract)).length;
      checks.push({ status: orphanCon || orphanPay || noSched ? "warn" : "ok", title: "Связи между листами", detail: `договоров без клиента: ${orphanCon}; платежей без договора: ${orphanPay}; договоров без графика: ${noSched}` });
      const known = new Set(Object.values(F.EV)), unknown = data.events.filter((e) => !known.has(e.type));
      checks.push({ status: unknown.length ? "warn" : "ok", title: "Типы событий", detail: unknown.length ? `не распознано ${unknown.length} событий: ${[...new Set(unknown.map((e) => e.type))].slice(0, 4).join(", ")}` : "все типы распознаны" });
      for (const c of data.clients) if (!c.since) c.since = data.contracts.filter((o) => o.client === c.client).map((o) => o.date).filter(Boolean).sort()[0] || null;
      const noSince = data.clients.filter((c) => !c.since).length;
      if (noSince) { fatal = true; checks.push({ status: "error", title: "Клиенты без даты начала отношений и без договоров", detail: `${noSince} клиентов` }); }
      // дата оценки по умолчанию — последний полный месяц по платежам и событиям
      const maxD = [...data.payments.map((p) => p.date), ...data.events.map((e) => e.date)].filter(Boolean).sort().pop();
      if (maxD) {
        const d = F.dnum(maxD), dt = new Date(d * 864e5);
        let me = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0) / 864e5;
        if (me > d) me = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 0) / 864e5;
        suggested = F.diso(me);
      }
    }
    return { fatal, checks, data, suggested_date: suggested };
  }
  function upload(buf, user, { name = "", date } = {}) {
    const r = parseUpload(buf);
    const out = { fatal: r.fatal, checks: r.checks, suggested_date: r.suggested_date, counts: Object.fromEntries(SHEETS.map((s) => [s.key, r.data[s.key].length])) };
    if (r.fatal) return out;
    const today = date || r.suggested_date;
    if (!isoOk(today)) throw err(400, "bad_request", "Не удалось определить дату оценки — укажите её (ГГГГ-ММ-ДД).");
    const data = { ...r.data, today };
    let idx;
    try { idx = F.prepare(data); } catch (e) { throw err(400, "bad_file", `Ошибка расчёта по выгрузке: ${e.message}`); }
    sweep();
    for (const [id, s] of sets) if (s.owner === user.id) sets.delete(id); // одна выгрузка на пользователя
    while ([...sets.values()].filter((s) => s.owner).length >= uploadMax) sets.delete([...sets.keys()].find((k) => k !== "demo"));
    const id = crypto.randomBytes(9).toString("base64url");
    const parties = new Map(data.clients.filter((c) => c.name || c.inn).map((c) => [c.client, { name: c.name || null, inn: c.inn ? String(c.inn).replace(/\D/g, "") : null }]));
    sets.set(id, { id, idx, parties, label: "upload", name: String(name).slice(0, 120), owner: user.id, expires: Date.now() + UPLOAD_TTL_MS, cache: new Map() });
    return { ...out, dataset: id, date: today, expires_in_s: UPLOAD_TTL_MS / 1000 };
  }

  // ---------- шаблон ----------
  // пример выгрузки: условные наименования и ИНН в необязательных столбцах листа «Клиенты»
  const withDemoParties = (data) => ({ ...data, clients: data.clients.map((c) => ({ ...c, ...demoParty(c.client, c.sector), conditional: undefined })) });
  function workbook(data) {
    const XL = X(), wb = XL.utils.book_new();
    const desc = [["Лист", "Столбец", "Пояснение", "Источник"]];
    SHEETS.forEach((s) => s.cols.forEach((c, i) => desc.push([i === 0 ? s.name : "", c[0], c[3], i === 0 ? s.src : ""])));
    desc.push([], ["Даты — в формате ДД.ММ.ГГГГ или как даты Excel. Суммы — числами, без пробелов-разделителей."]);
    if (data) desc.push([], ["Пример заполнен демонстрационными данными: портфель сгенерирован, клиенты обозначены кодами."]);
    XL.utils.book_append_sheet(wb, XL.utils.aoa_to_sheet(desc), "Описание");
    for (const s of SHEETS) {
      const rows = [s.cols.map((c) => c[0])];
      if (data) for (const r of data[s.key]) rows.push(s.cols.map(([, k, t]) => { const v = r[k]; if (v === null || v === undefined) return ""; if (t === "d") return fdate(v); if (t === "b") return v ? "да" : "нет"; return v; }));
      const ws = XL.utils.aoa_to_sheet(rows, { dense: true });
      ws["!cols"] = s.cols.map((c) => ({ wch: Math.max(14, c[0].length + 2) }));
      XL.utils.book_append_sheet(wb, ws, s.name);
    }
    return Buffer.from(XL.write(wb, { bookType: "xlsx", type: "buffer", compression: true }));
  }
  // Шаблон и пример собираются при сборке образа (scripts/ews-templates.js): пример на 45 тыс. строк SheetJS
  // в 100 МБ стенда не соберёт. Нет готового файла (разработка, тесты) — собираем здесь.
  const template = ({ example: ex } = {}) => {
    const file = path.join(DATA, ex ? "template_example.xlsx" : "template.xlsx");
    if (fs.existsSync(file)) return fs.readFileSync(file);
    return workbook(ex ? withDemoParties(JSON.parse(fs.readFileSync(path.join(DATA, "demo.json"), "utf8"))) : null);
  };

  return {
    model, modelInfo, SHEETS: SHEETS.map(({ name, key, src, cols }) => ({ name, key, src, cols: cols.map(([title, field, type, note]) => ({ title, field, type, note })) })),
    portfolio: (id, date, user) => { const ds = dataset(id, user); return named(ds, portfolio(ds, date)); },
    client: (id, code, o, user) => client(dataset(id, user), code, o),
    setLookup: (fn) => { lookup = fn; },
    upload, parseUpload, template, workbook, withDemoParties, dataset,
  };
}

module.exports = { createEws, SHEETS, DISCLAIMER };

// Один экземпляр на процесс: демо-портфель и кэш расчётов общие для страницы, API и сводки на главной
let shared = null;
module.exports.defaultEws = () => (shared ??= createEws());
