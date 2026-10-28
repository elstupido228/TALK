// Чтение xlsx без SheetJS: zip — через zlib, листы — по одному, ячейки — регулярными выражениями по XML.
// Нужно стенду с лимитом 100 МБ: SheetJS разворачивает книгу целиком и на выгрузке размером с демо-портфель
// выходит за лимит. Поддерживается то, что пишут Excel, openpyxl и SheetJS: общие и встроенные строки, числа,
// логические значения, даты ISO (t="d"). Числа в столбцах дат — серийные даты Excel (разбирает вызывающий код).
const zlib = require("node:zlib");

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("не zip-архив");
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("повреждённый zip-архив");
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    entries.set(buf.toString("utf8", p + 46, p + 46 + nl), { method, csize, off });
    p += 46 + nl + el + cl;
  }
  return (name) => {
    const e = entries.get(name);
    if (!e) return null;
    const start = e.off + 30 + buf.readUInt16LE(e.off + 26) + buf.readUInt16LE(e.off + 28);
    const raw = buf.subarray(start, start + e.csize);
    return (e.method === 8 ? zlib.inflateRawSync(raw) : raw).toString("utf8");
  };
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m);
// текст элемента со строкой: все <t> подряд (у форматированных строк их несколько)
const text = (xml) => { let s = ""; for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) s += m[1]; return decode(s); };
const colIndex = (ref) => { let c = 0; for (const ch of ref) { const k = ch.charCodeAt(0); if (k < 65 || k > 90) break; c = c * 26 + k - 64; } return c - 1; };

function openBook(buf) {
  const get = unzip(buf);
  const wb = get("xl/workbook.xml");
  if (!wb) throw new Error("в архиве нет книги Excel");
  const rels = new Map([...(get("xl/_rels/workbook.xml.rels") || "").matchAll(/<Relationship\b[^>]*>/g)].map(([r]) => [(r.match(/\bId="([^"]+)"/) || [])[1], (r.match(/\bTarget="([^"]+)"/) || [])[1]]));
  const sheets = new Map();
  for (const [tag] of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = decode((tag.match(/\bname="([^"]*)"/) || [])[1] || ""), rid = (tag.match(/\br:id="([^"]+)"/) || [])[1];
    const t = rels.get(rid);
    if (t) sheets.set(name, t.startsWith("/") ? t.slice(1) : "xl/" + t.replace(/^\.\//, ""));
  }
  let shared = null;
  const sst = () => (shared ??= [...(get("xl/sharedStrings.xml") || "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => text(m[1])));
  // строки листа: первая — заголовки, остальные — объекты {заголовок: значение}, пустые строки пропускаются
  function rows(name) {
    const path = sheets.get(name);
    const xml = path && get(path);
    if (!xml) return null;
    const out = [];
    let head = null;
    for (const [, body] of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      if (!body) continue;
      const vals = [];
      for (const [, attrs, inner] of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        if (inner === undefined) continue;
        const ref = (attrs.match(/\br="([A-Z]+)/) || [])[1], t = (attrs.match(/\bt="(\w+)"/) || [])[1] || "n";
        const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let x = null;
        if (t === "s") x = v === undefined ? null : sst()[+v] ?? null;
        else if (t === "inlineStr") x = text(inner);
        else if (t === "str" || t === "d" || t === "e") x = v === undefined ? null : decode(v);
        else if (t === "b") x = v === "1";
        else x = v === undefined || v === "" ? null : Number(v);
        vals[ref ? colIndex(ref) : vals.length] = x;
      }
      if (!head) { head = vals.map((h) => (h === null || h === undefined ? "" : String(h).trim())); continue; }
      if (!vals.some((x) => x !== null && x !== undefined && x !== "")) continue;
      const o = {};
      head.forEach((h, i) => { if (h) o[h] = vals[i] ?? null; });
      out.push(o);
    }
    return { head: head || [], rows: out };
  }
  return { names: [...sheets.keys()], rows };
}

module.exports = { openBook };
