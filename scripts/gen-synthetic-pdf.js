// Генератор условных PDF бухгалтерской отчётности из seed/calc/demo_synthetic.json.
// Нужен для замера распознавания (/api/extract) без реальных документов клиентов.
//
//   node scripts/gen-synthetic-pdf.js [каталог=bench/pdf] [шрифт.ttf] [жирный.ttf]
//
// Формы по образцу ОКУД 0710001 (баланс) и 0710002 (ОПиУ): полный перечень строк, сравнительные графы,
// отрицательные значения в скобках, нули прочерком, подпись и печать. Значения 12+3 кодов строк берутся
// из демо-пакета как есть; остальные строки формы выводятся из них так, чтобы итоги сходились.
// Сравнительные графы: если дата есть в пакете — значения пакета, иначе масштабированные (вне окна расчёта).
const fs = require("node:fs");
const path = require("node:path");
const PDFDocument = require("pdfkit");

const ROOT = path.join(__dirname, "..");
const OUT = path.resolve(process.argv[2] || path.join(ROOT, "bench", "pdf"));
const FONT_CANDIDATES = [
  [process.argv[3], process.argv[4]],
  ["C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/arialbd.ttf"],
  ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
];
const [FONT, FONT_B] = FONT_CANDIDATES.find(([r, b]) => r && b && fs.existsSync(r) && fs.existsSync(b)) || [];
if (!FONT) throw new Error("Не найден TTF-шрифт с кириллицей: укажите пути к обычному и жирному начертанию");

const demo = JSON.parse(fs.readFileSync(path.join(ROOT, "seed", "calc", "demo_synthetic.json"), "utf8"));

const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const MONTHS_NOM = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const ymd = (iso) => iso.split("-").map(Number);
const dateWords = (iso) => { const [y, m, d] = ymd(iso); return `${d} ${MONTHS_GEN[m - 1]} ${y} г.`; };
const periodWords = (iso, months) => { const [y, m] = ymd(iso); return `За ${MONTHS_NOM[m - months]} - ${MONTHS_NOM[m - 1]} ${y} г.`; };
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const isoOf = (y, m) => `${y}-${String(m).padStart(2, "0")}-${String(lastDay(y, m)).padStart(2, "0")}`;
const fmt = (v) => (v === 0 ? "-" : v < 0 ? `(${Math.abs(v).toLocaleString("ru-RU").replace(/\s/g, " ")})` : v.toLocaleString("ru-RU").replace(/\s/g, " "));

// ---------- Полные строки форм ----------
const BAL_ROWS = [
  ["h", "АКТИВ"], ["s", "I. ВНЕОБОРОТНЫЕ АКТИВЫ"],
  ["r", "Нематериальные активы", "1110"], ["r", "Результаты исследований и разработок", "1120"],
  ["r", "Основные средства", "1150"], ["r", "Финансовые вложения", "1170"],
  ["r", "Отложенные налоговые активы", "1180"], ["r", "Прочие внеоборотные активы", "1190"],
  ["t", "Итого по разделу I", "1100"],
  ["s", "II. ОБОРОТНЫЕ АКТИВЫ"],
  ["r", "Запасы", "1210"], ["r", "Налог на добавленную стоимость по приобретенным ценностям", "1220"],
  ["r", "Дебиторская задолженность", "1230"], ["r", "Финансовые вложения (за исключением денежных эквивалентов)", "1240"],
  ["r", "Денежные средства и денежные эквиваленты", "1250"], ["r", "Прочие оборотные активы", "1260"],
  ["t", "Итого по разделу II", "1200"], ["t", "БАЛАНС", "1600"],
  ["page"],
  ["h", "ПАССИВ"], ["s", "III. КАПИТАЛ И РЕЗЕРВЫ"],
  ["r", "Уставный капитал (складочный капитал, уставный фонд, вклады товарищей)", "1310"],
  ["r", "Собственные акции, выкупленные у акционеров", "1320"], ["r", "Переоценка внеоборотных активов", "1340"],
  ["r", "Добавочный капитал (без переоценки)", "1350"], ["r", "Резервный капитал", "1360"],
  ["r", "Нераспределенная прибыль (непокрытый убыток)", "1370"], ["t", "Итого по разделу III", "1300"],
  ["s", "IV. ДОЛГОСРОЧНЫЕ ОБЯЗАТЕЛЬСТВА"],
  ["r", "Заемные средства", "1410"], ["r", "Отложенные налоговые обязательства", "1420"],
  ["r", "Оценочные обязательства", "1430"], ["r", "Прочие обязательства", "1450"], ["t", "Итого по разделу IV", "1400"],
  ["s", "V. КРАТКОСРОЧНЫЕ ОБЯЗАТЕЛЬСТВА"],
  ["r", "Заемные средства", "1510"], ["r", "Кредиторская задолженность", "1520"], ["r", "Доходы будущих периодов", "1530"],
  ["r", "Оценочные обязательства", "1540"], ["r", "Прочие обязательства", "1550"], ["t", "Итого по разделу V", "1500"],
  ["t", "БАЛАНС", "1700"],
];
const PNL_ROWS = [
  ["r", "Выручка", "2110"], ["r", "Себестоимость продаж", "2120"], ["t", "Валовая прибыль (убыток)", "2100"],
  ["r", "Коммерческие расходы", "2210"], ["r", "Управленческие расходы", "2220"], ["t", "Прибыль (убыток) от продаж", "2200"],
  ["r", "Доходы от участия в других организациях", "2310"], ["r", "Проценты к получению", "2320"],
  ["r", "Проценты к уплате", "2330"], ["r", "Прочие доходы", "2340"], ["r", "Прочие расходы", "2350"],
  ["page"],
  ["t", "Прибыль (убыток) до налогообложения", "2300"], ["r", "Налог на прибыль", "2410"],
  ["r", "в том числе: текущий налог на прибыль", "2411"], ["r", "отложенный налог на прибыль", "2412"],
  ["r", "Прочее", "2460"], ["t", "Чистая прибыль (убыток)", "2400"],
];

// ---------- Полные значения формы из кодов пакета ----------
function fullBalance(v) {
  const f = { ...v };
  f["1100"] = v["1600"] - v["1200"];
  f["1150"] = Math.round(f["1100"] * 0.8);
  f["1190"] = f["1100"] - f["1150"];
  f["1210"] = v["1200"] - v["1230"] - v["1240"] - v["1250"];
  f["1310"] = v["1300"] - v["1370"];
  f["1400"] = v["1700"] - v["1300"] - v["1500"];
  f["1410"] = f["1400"];
  const rest = v["1500"] - v["1530"] - v["1540"] - v["1550"];
  f["1510"] = Math.round(rest * 0.4);
  f["1520"] = rest - f["1510"];
  for (const k of ["1110", "1120", "1170", "1180", "1220", "1260", "1320", "1340", "1350", "1360", "1420", "1430", "1450"]) f[k] = 0;
  for (const k of ["1100", "1150", "1190", "1210", "1310", "1400", "1510", "1520"])
    if (f[k] < 0) throw new Error(`отрицательная производная строка ${k}=${f[k]}`);
  if (v["1600"] !== v["1700"]) throw new Error("актив не равен пассиву");
  return f;
}
function fullPnl(v) {
  const f = { ...v };
  const r = v["2110"];
  f["2210"] = -Math.round(r * 0.06);
  f["2220"] = -Math.round(r * 0.04);
  f["2100"] = v["2200"] - f["2210"] - f["2220"];
  f["2120"] = f["2100"] - r;
  if (f["2120"] > 0) throw new Error("себестоимость положительна");
  f["2300"] = v["2400"] > 0 ? Math.round(v["2400"] / 0.8) : v["2400"];
  f["2410"] = v["2400"] - f["2300"];
  f["2411"] = f["2410"];
  f["2310"] = 0; f["2320"] = 0; f["2412"] = 0; f["2460"] = 0;
  f["2330"] = -Math.round(r * 0.01);
  const need = f["2300"] - v["2200"] - f["2330"];
  const small = Math.round(r * 0.005);
  if (need >= 0) { f["2340"] = need + small; f["2350"] = -small; } else { f["2340"] = small; f["2350"] = need - small; }
  const chk = v["2200"] + f["2310"] + f["2320"] + f["2330"] + f["2340"] + f["2350"];
  if (chk !== f["2300"]) throw new Error("ОПиУ не сходится");
  return f;
}
// Масштабированные значения для графы вне окна расчёта (итоги пересчитываются в fullBalance/fullPnl).
function scaled(v, k, kind) {
  const s = Object.fromEntries(Object.entries(v).map(([c, x]) => [c, Math.round(x * k)]));
  if (kind === "balance") {
    s["1200"] = Math.max(s["1200"], s["1230"] + s["1240"] + s["1250"]);
    s["1500"] = Math.max(s["1500"], s["1530"] + s["1540"] + s["1550"]);
    s["1300"] = Math.max(s["1300"], s["1370"] + 10);
    s["1600"] = Math.max(s["1600"], s["1200"], s["1300"] + s["1500"]);
    s["1700"] = s["1600"];
  }
  return s;
}

// ---------- Отрисовка ----------
const A4W = 595.28, M = 36, W = A4W - 2 * M;
const COLW = { note: 50, code: 34 };

function header(doc, { title, subtitle, okud, dateIso, pkg }) {
  const [y, m, d] = ymd(dateIso);
  doc.font("B").fontSize(12).text(title, M, M + 8, { width: W - 150, align: "center" });
  doc.font("R").fontSize(10).text(subtitle, M, doc.y + 2, { width: W - 150, align: "center" });
  // блок кодов справа
  const bx = M + W - 140, rows = [["Коды", ""], ["Форма по ОКУД", okud], ["Дата (число, месяц, год)", `${String(d).padStart(2, "0")} | ${String(m).padStart(2, "0")} | ${y}`],
    ["по ОКПО", "00000000"], ["ИНН", pkg.inn], ["по ОКВЭД 2", "77.39.1"], ["по ОКОПФ / ОКФС", "12300 | 16"], ["по ОКЕИ", "384"]];
  let yy = M;
  doc.fontSize(7);
  for (const [l, v] of rows) {
    doc.text(l, bx - 90, yy + 3, { width: 86, align: "right" });
    doc.rect(bx, yy, 140, 14).stroke();
    doc.text(v, bx, yy + 3.5, { width: 140, align: "center" });
    yy += 14;
  }
  doc.fontSize(8.5);
  let ly = yy + 8;
  for (const [l, v] of [["Организация", pkg.name], ["Идентификационный номер налогоплательщика", pkg.inn],
    ["Вид экономической деятельности", "Аренда и лизинг прочих машин и оборудования (условно)"],
    ["Организационно-правовая форма / форма собственности", "Общество с ограниченной ответственностью / частная"],
    ["Единица измерения:", "в тыс. рублей"], ["Местонахождение (адрес)", "условный адрес, г. Москва"]]) {
    doc.font("R").text(`${l}  `, M, ly, { continued: true }).font("B").text(v);
    ly = doc.y + 2;
  }
  return ly + 6;
}

function table(doc, y0, heads, rows, values, colsCount) {
  const valW = (W - COLW.note - COLW.code - 210) / colsCount;
  const nameW = 210;
  const xs = [M, M + COLW.note, M + COLW.note + nameW, M + COLW.note + nameW + COLW.code];
  const draw = (cells, y, h, bold) => {
    doc.font(bold ? "B" : "R").fontSize(8);
    const widths = [COLW.note, nameW, COLW.code, ...Array(colsCount).fill(valW)];
    let x = M;
    cells.forEach((c, i) => {
      doc.rect(x, y, widths[i], h).stroke();
      doc.text(c ?? "", x + 3, y + 3, { width: widths[i] - 6, align: i >= 3 ? "right" : i === 2 ? "center" : "left" });
      x += widths[i];
    });
  };
  let y = y0;
  draw(["Пояснения", "Наименование показателя", "Код", ...heads], y, 26, true);
  y += 26;
  const pages = [];
  for (const row of rows) {
    if (row[0] === "page") { pages.push(y); doc.addPage(); y = M; draw(["Пояснения", "Наименование показателя", "Код", ...heads], y, 26, true); y += 26; continue; }
    if (row[0] === "h" || row[0] === "s") {
      doc.rect(M, y, W, 14).stroke();
      doc.font("B").fontSize(8).text(row[1], M + COLW.note + 3, y + 3, { width: nameW + 200, align: row[0] === "h" ? "center" : "left" });
      y += 14; continue;
    }
    const [, name, code] = row;
    const h = doc.font("R").fontSize(8).heightOfString(name, { width: nameW - 6 }) + 6;
    draw(["", name, code, ...values.map((v) => fmt(v[code] ?? 0))], y, Math.max(14, h), row[0] === "t");
    y += Math.max(14, h);
  }
  return y;
}

function signature(doc, y) {
  doc.font("R").fontSize(9);
  doc.text("Руководитель  ____________________  Петров П. П. (условно)", M, y + 20);
  doc.text("(подпись)", M + 80, doc.y, { width: 80, align: "center" });
  doc.text("«__» ____________ 20__ г.", M, doc.y + 10);
  // условная печать
  doc.save().strokeColor("#3355aa").lineWidth(1.2).circle(M + 330, y + 45, 34).stroke().circle(M + 330, y + 45, 24).stroke();
  doc.fillColor("#3355aa").fontSize(6).text("М.П. ОБРАЗЕЦ", M + 300, y + 42, { width: 60, align: "center" }).restore();
  doc.fillColor("black");
}

function footer(doc) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // сноска ниже поля страницы не должна порождать новую страницу
    doc.font("R").fontSize(6.5).fillColor("#777")
      .text("Условный документ для тестирования распознавания. Организация и значения вымышлены, не является отчётностью реальной организации.", M, 812, { width: W, align: "center", lineBreak: false });
    doc.fillColor("black");
  }
}

// ---------- Документы пакета ----------
function writeDoc(file, build) {
  const doc = new PDFDocument({ size: "A4", margin: M, bufferPages: true, autoFirstPage: true,
    info: { Title: path.basename(file, ".pdf"), Author: "Условный генератор TALK", CreationDate: new Date("2026-10-01T00:00:00Z") } });
  doc.registerFont("R", FONT); doc.registerFont("B", FONT_B);
  doc.lineWidth(0.5);
  const out = fs.createWriteStream(file);
  doc.pipe(out);
  build(doc);
  footer(doc);
  doc.end();
  return new Promise((res) => out.on("finish", res));
}

async function genPackage(pkg) {
  const dir = path.join(OUT, pkg.id);
  fs.mkdirSync(dir, { recursive: true });
  const known = { balance: {}, pnl: {} };
  for (const d of pkg.docs) for (const c of d.columns) known[c.kind][c.date + "|" + (c.months || "")] = c.values;
  const files = [];
  for (const d of pkg.docs) {
    const c = d.columns.find((x) => x.primary);
    const [y, m] = ymd(c.date);
    const file = path.join(dir, d.name);
    if (c.kind === "balance") {
      const cols = [c.date, isoOf(y - 1, 12), isoOf(y - 2, 12)];
      const vals = cols.map((iso, i) => fullBalance(known.balance[iso + "|"] || scaled(c.values, i === 1 ? 0.92 : 0.85, "balance")));
      const heads = cols.map((iso) => `На ${dateWords(iso)}`);
      await writeDoc(file, (doc) => {
        const y0 = header(doc, { title: "Бухгалтерский баланс", subtitle: `на ${dateWords(c.date)}`, okud: "0710001", dateIso: c.date, pkg });
        table(doc, y0, heads, BAL_ROWS, vals, 3);
        doc.addPage(); signature(doc, M);
        doc.font("R").fontSize(8).text("Пояснения к бухгалтерскому балансу приводятся в приложении (условно не приложены).", M, 200);
      });
    } else {
      const cols = [[c.date, c.months], [isoOf(y - 1, m), c.months]];
      const vals = cols.map(([iso, mm], i) => fullPnl(known.pnl[iso + "|" + mm] || scaled(c.values, i === 1 ? 0.9 : 1, "pnl")));
      const heads = cols.map(([iso, mm]) => periodWords(iso, mm));
      await writeDoc(file, (doc) => {
        const y0 = header(doc, { title: "Отчет о финансовых результатах", subtitle: periodWords(c.date, c.months).replace(/^З/, "з"), okud: "0710002", dateIso: c.date, pkg });
        const yEnd = table(doc, y0, heads, PNL_ROWS, vals, 2);
        signature(doc, yEnd + 10);
      });
    }
    files.push(path.relative(ROOT, file));
  }
  return files;
}

(async () => {
  for (const pkg of demo.packages) {
    const files = await genPackage(pkg);
    console.log(`пакет ${pkg.id} (${pkg.name}): ${files.length} PDF → ${path.relative(ROOT, path.join(OUT, pkg.id))}`);
  }
})();
