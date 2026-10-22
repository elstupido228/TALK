// Проверка приёмки «ни одной записи о реальных клиентах»: ищет в файлах репозитория
// 1) ИНН с верной контрольной суммой (10 цифр — организация, 12 — ИП/физлицо);
// 2) слова-маркеры из файла вне репозитория (по одному на строку): node scripts/scan-real-data.js ~/markers.txt
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const W10 = [2, 4, 10, 3, 5, 9, 4, 6, 8];
const W11 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
const W12 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
const chk = (d, w) => (w.reduce((s, k, i) => s + k * d[i], 0) % 11) % 10;
function validInn(s) {
  const d = [...s].map(Number);
  if (d.length === 10) return chk(d, W10) === d[9];
  if (d.length === 12) return chk(d, W11) === d[10] && chk(d, W12) === d[11];
  return false;
}

const markers = process.argv[2]
  ? fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  : [];
// Сторонние минифицированные библиотеки: числовые константы алгоритмов случайно проходят контрольную сумму ИНН.
const THIRD_PARTY = (f) => f.startsWith("app/public/vendor/");
// Сжатые форматы как текст не читаются: условные PDF собираются из demo_synthetic.json, который проверяется.
const BINARY = (f) => /\.(pdf|xlsx)$/i.test(f);
const all = execFileSync("git", ["-c", "core.quotepath=off", "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const files = all.filter((f) => !THIRD_PARTY(f) && !BINARY(f));

const hits = [];
for (const f of files) {
  const text = fs.readFileSync(f).toString("utf8");
  for (const m of text.matchAll(/(?<!\d)(\d{10}|\d{12})(?!\d)/g)) if (validInn(m[1])) hits.push([f, "ИНН", m[1]]);
  const low = text.toLowerCase();
  for (const mk of markers) if (low.includes(mk.toLowerCase())) hits.push([f, "маркер", mk]);
}

console.log(`файлов: ${files.length} (не читались как текст: ${all.length - files.length} — сторонние библиотеки, PDF, xlsx), маркеров: ${markers.length}, совпадений: ${hits.length}`);
for (const h of hits.slice(0, 50)) console.log(h.join("\t"));
process.exit(hits.length ? 1 : 0);
