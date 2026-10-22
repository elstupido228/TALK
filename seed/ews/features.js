/* Расчёт просрочки, признаков и баллов по выгрузке в структуре запроса к ТАЛК.
   Один и тот же код работает на странице прототипа и при обучении (Node.js).
   Правила (требуют подтверждения ТАЛК):
   - оплата разносится на самый ранний неоплаченный платёж графика;
   - просрочка клиента — максимальная по его действующим договорам, на конец месяца;
   - дефолт — просрочка 60+ дней на конец месяца или расторжение договора. */
(function (root) {
  "use strict";
  const DAY = 864e5;
  const dnum = (s) => Math.floor(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY);
  const diso = (n) => new Date(n * DAY).toISOString().slice(0, 10);
  const monthEnd = (y, m) => Math.floor(Date.UTC(y, m + 1, 0) / DAY); // m: 0..11
  function monthEnds(fromIso, toIso) {
    const out = []; let y = +fromIso.slice(0, 4), m = +fromIso.slice(5, 7) - 1; const end = dnum(toIso);
    for (;;) { const e = monthEnd(y, m); if (e > end) break; out.push(e); m++; if (m === 12) { m = 0; y++; } }
    return out;
  }
  const addMonths = (dn, k) => { const d = new Date(dn * DAY); return monthEnd(d.getUTCFullYear(), d.getUTCMonth() + k); };

  const EV = { tax: "Налоговая недоимка", suit: "Иск к клиенту", fssp: "Исполнительное производство",
    ceo: "Смена руководителя", bankr: "Намерение кредитора о банкротстве", restr: "Реструктуризация",
    term: "Расторжение договора", seize: "Изъятие предмета лизинга" };
  const DEPR = { "Грузовой транспорт": 0.15, "Спецтехника": 0.12, "Легковой транспорт": 0.18, "Оборудование": 0.20 };

  const FEATURES = [
    { name: "dpd_now", label: "Просрочка на дату оценки, дней", group: "Платёжная дисциплина" },
    { name: "max_dpd_6m", label: "Максимальная просрочка за 6 месяцев, дней", group: "Платёжная дисциплина" },
    { name: "late_cnt_6m", label: "Платежей с опозданием более 5 дней за 6 месяцев", group: "Платёжная дисциплина" },
    { name: "delay_trend", label: "Изменение среднего опоздания: 3 мес. к предыдущим 3 мес., дней", group: "Платёжная дисциплина" },
    { name: "share_paid", label: "Доля выплаченных лизинговых платежей", group: "Сделка и предмет" },
    { name: "ltv", label: "Остаток платежей к текущей стоимости предмета", group: "Сделка и предмет" },
    { name: "guarantee", label: "Поручительство по договорам", group: "Сделка и предмет" },
    { name: "restruct_12m", label: "Реструктуризаций за 12 месяцев", group: "Сделка и предмет" },
    { name: "tenure_m", label: "Срок отношений с компанией, месяцев", group: "Сделка и предмет" },
    { name: "tax_12m", label: "Налоговая недоимка за 12 месяцев", group: "Внешние события" },
    { name: "suits_12m", label: "Исков к клиенту за 12 месяцев", group: "Внешние события" },
    { name: "fssp_12m", label: "Исполнительных производств за 12 месяцев", group: "Внешние события" },
    { name: "ceo_12m", label: "Смена руководителя за 12 месяцев", group: "Внешние события" },
    { name: "eq_ratio", label: "Доля собственного капитала в активах", group: "Отчётность" },
    { name: "net_margin", label: "Рентабельность по чистой прибыли", group: "Отчётность" },
    { name: "rev_growth", label: "Изменение выручки за год", group: "Отчётность" },
    { name: "debt_rev", label: "Долг к выручке", group: "Отчётность" },
    { name: "not_filed", label: "Отчётность за последний год не сдана", group: "Отчётность" },
    { name: "sector", label: "Отрасль клиента", group: "Отрасль", cat: true },
  ];

  function prepare(data) {
    const today = dnum(data.today);
    const clients = new Map(data.clients.map((c) => [c.client, { ...c, since_d: dnum(c.since), contracts: [], events: [], reports: [] }]));
    const cons = new Map();
    for (const c of data.contracts) {
      const cl = clients.get(c.client); if (!cl) continue;
      const o = { ...c, start: dnum(c.date), dues: [], amts: [], pays: [] };
      cons.set(c.contract, o); cl.contracts.push(o);
    }
    const sch = [...data.schedule].sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
    for (const s of sch) { const o = cons.get(s.contract); if (o) { o.dues.push(dnum(s.due)); o.amts.push(+s.amount); } }
    for (const p of data.payments) { const o = cons.get(p.contract); if (o) o.pays.push([dnum(p.date), +p.amount]); }
    for (const o of cons.values()) {
      o.pays.sort((a, b) => a[0] - b[0]);
      o.cum = []; let s = 0; for (const a of o.amts) { s += a; o.cum.push(s); }
      o.total = s;
      // дата полной оплаты каждого платежа графика при разнесении на самый ранний платёж
      o.paid = new Array(o.dues.length).fill(null);
      let k = 0, acc = 0;
      for (const [d, a] of o.pays) { acc += a; while (k < o.cum.length && acc >= o.cum[k] - 0.5) { o.paid[k] = d; k++; } }
      o.closed = o.paid.length && o.paid[o.paid.length - 1] !== null ? o.paid[o.paid.length - 1] : null;
    }
    for (const e of data.events) { const cl = clients.get(e.client); if (cl) cl.events.push({ ...e, d: dnum(e.date) }); }
    for (const r of data.reports) { const cl = clients.get(r.client); if (cl) cl.reports.push({ ...r, f: dnum(r.filed) }); }
    for (const cl of clients.values()) {
      cl.events.sort((a, b) => a.d - b.d); cl.reports.sort((a, b) => a.year - b.year);
      const t = cl.events.find((e) => e.type === EV.term); cl.term_d = t ? t.d : null;
    }
    return { today, clients, ends: monthEnds("2019-01-31", data.today) };
  }

  // индекс первого платежа, не оплаченного полностью на дату t
  function firstUnpaid(o, t) {
    let lo = 0, hi = o.paid.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (o.paid[mid] !== null && o.paid[mid] <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function contractDpd(o, t) {
    const k = firstUnpaid(o, t);
    return k < o.dues.length && o.dues[k] < t ? t - o.dues[k] : 0;
  }
  const isActive = (o, cl, t) => o.start <= t && !(o.closed !== null && o.closed <= t) && !(cl.term_d !== null && cl.term_d <= t);
  function clientDpd(cl, t) {
    let m = 0, any = false;
    for (const o of cl.contracts) if (o.start <= t && !(o.closed !== null && o.closed <= t)) { any = true; m = Math.max(m, contractDpd(o, t)); }
    return any ? m : null;
  }
  const defaultedBy = (cl, t, ends) => {
    if (cl.term_d !== null && cl.term_d <= t) return true;
    for (const e of ends) { if (e > t) break; const d = clientDpd(cl, e); if (d !== null && d >= 60) return true; }
    return false;
  };

  // первый конец месяца, на который у клиента просрочка 60+ или расторгнут договор
  function firstDefault(idx, cl) {
    for (const e of idx.ends) { if (e < cl.since_d) continue; const d = clientDpd(cl, e); if ((d !== null && d >= 60) || (cl.term_d !== null && cl.term_d <= e)) return e; }
    return null;
  }

  function features(idx, cl, t) {
    const act = cl.contracts.filter((o) => isActive(o, cl, t));
    if (!act.length) return null;
    const f = {};
    f.dpd_now = Math.max(...act.map((o) => contractDpd(o, t)));
    let mx = f.dpd_now; for (let j = 1; j < 6; j++) { const e = addMonths(t, -j); const d = clientDpd(cl, e); if (d !== null) mx = Math.max(mx, d); }
    f.max_dpd_6m = mx;
    const t3 = addMonths(t, -3), t6 = addMonths(t, -6);
    let late = 0; const a3 = [], b3 = [];
    let paidSum = 0, totSum = 0, outst = 0, val = 0, guar = 0;
    for (const o of act) {
      for (let k = 0; k < o.dues.length; k++) {
        const due = o.dues[k]; if (due > t) break;
        const pd = o.paid[k] !== null && o.paid[k] <= t ? o.paid[k] : t;
        const delay = pd - due;
        if (due > t6) { if (delay > 5) late++; (due > t3 ? a3 : b3).push(Math.max(0, delay)); }
      }
      const k = firstUnpaid(o, t);
      const paidAmt = k > 0 ? o.cum[k - 1] : 0;
      paidSum += paidAmt; totSum += o.total; outst += o.total - paidAmt;
      const age = Math.max(0, (t - o.start) / 365.25);
      val += o.asset_value * Math.pow(1 - (DEPR[o.asset] ?? 0.15), age);
      if (o.guarantee === true || o.guarantee === "да" || o.guarantee === "Да" || o.guarantee === 1) guar = 1;
    }
    f.late_cnt_6m = late;
    const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
    f.delay_trend = a3.length && b3.length ? Math.round((mean(a3) - mean(b3)) * 10) / 10 : null;
    f.share_paid = totSum ? Math.round((paidSum / totSum) * 1000) / 1000 : null;
    f.ltv = val ? Math.round((outst / val) * 1000) / 1000 : null;
    f.guarantee = guar;
    const t12 = addMonths(t, -12);
    const cnt = (type) => cl.events.filter((e) => e.type === type && e.d > t12 && e.d <= t).length;
    f.restruct_12m = cnt(EV.restr);
    f.tenure_m = Math.floor((t - cl.since_d) / 30.44);
    f.tax_12m = cnt(EV.tax) > 0 ? 1 : 0;
    f.suits_12m = cnt(EV.suit);
    f.fssp_12m = cnt(EV.fssp);
    f.ceo_12m = cnt(EV.ceo) > 0 ? 1 : 0;
    const reps = cl.reports.filter((r) => r.f <= t);
    const last = reps[reps.length - 1];
    if (last && last.assets) {
      f.eq_ratio = Math.round((last.equity / last.assets) * 1000) / 1000;
      f.net_margin = last.revenue ? Math.round((last.net_profit / last.revenue) * 1000) / 1000 : null;
      f.debt_rev = last.revenue ? Math.round((last.debt / last.revenue) * 1000) / 1000 : null;
      const prev = reps.find((r) => r.year === last.year - 1);
      f.rev_growth = prev && prev.revenue ? Math.round((last.revenue / prev.revenue - 1) * 1000) / 1000 : null;
    } else { f.eq_ratio = null; f.net_margin = null; f.debt_rev = null; f.rev_growth = null; }
    const td = new Date(t * DAY); const y = td.getUTCFullYear();
    const expected = td.getUTCMonth() >= 4 ? y - 1 : y - 2; // после 30 апреля ждём отчётность за прошлый год
    f.not_filed = !last || last.year < expected ? 1 : 0;
    f.sector = cl.sector || "Не указана";
    f.stop_bankr = cnt(EV.bankr) > 0 ? 1 : 0;
    f.exposure = Math.round(outst);
    return f;
  }

  // Срезы на концы месяцев. withTarget: исход за следующие 12 месяцев (дефолт 60+ или расторжение)
  function snapshots(idx, opts = {}) {
    const rows = []; const ends = idx.ends;
    const from = opts.from ? dnum(opts.from) : ends[0];
    const to = opts.to ? dnum(opts.to) : idx.today;
    for (const cl of idx.clients.values()) {
      for (let i = 0; i < ends.length; i++) {
        const t = ends[i]; if (t < from || t > to) continue;
        if (t < cl.since_d) continue;
        const f = features(idx, cl, t); if (!f) continue;
        const prior = defaultedBy(cl, addMonths(t, -1), ends) ;
        const row = { client: cl.client, date: diso(t), status: prior ? "дефолт ранее" : f.dpd_now >= 30 ? "просрочка 30+" : "оценивается", ...f };
        if (opts.withTarget) {
          const h = addMonths(t, 12);
          if (h <= idx.today) {
            let y = 0;
            for (let j = i + 1; j < ends.length && ends[j] <= h; j++) { const d = clientDpd(cl, ends[j]); if (d !== null && d >= 60) { y = 1; break; } }
            if (cl.term_d !== null && cl.term_d > t && cl.term_d <= h) y = 1;
            row.y = y;
          } else row.y = null;
        }
        rows.push(row);
      }
    }
    return rows;
  }

  // Применение балльной карты: model.vars [{name, cat, splits|groups, points[], missing}]
  function score(model, f) {
    let s = 0; const parts = {};
    for (const v of model.vars) {
      const x = f[v.name]; let p, bin;
      if (x === null || x === undefined || (typeof x === "number" && !isFinite(x))) { p = v.missing; bin = -1; }
      else if (v.cat) {
        bin = v.groups.findIndex((g) => g.includes(x)); p = bin >= 0 ? v.points[bin] : v.missing;
      } else {
        bin = 0; while (bin < v.splits.length && x >= v.splits[bin]) bin++;
        p = v.points[bin];
      }
      parts[v.name] = { points: p, bin }; s += p;
    }
    s = Math.round(s * 100) / 100;
    let zone = s <= model.zones.red ? "red" : s <= model.zones.yellow ? "yellow" : "green";
    if (f.stop_bankr) zone = "red";
    return { score: s, zone, parts };
  }
  // Причины: факторы, по которым клиент потерял больше всего баллов относительно лучшего интервала
  function reasons(model, parts, n = 3) {
    return model.vars.map((v) => ({ name: v.name, label: v.label, lost: Math.max(...v.points, v.missing) - parts[v.name].points }))
      .filter((r) => r.lost > 0.5).sort((a, b) => b.lost - a.lost).slice(0, n);
  }

  const api = { dnum, diso, monthEnds, addMonths, prepare, features, snapshots, score, reasons, clientDpd, contractDpd, firstDefault, FEATURES, EV };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.TalkEWS = api;
})(typeof window !== "undefined" ? window : globalThis);
