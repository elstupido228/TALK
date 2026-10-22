// Сборка страницы калькулятора из seed/calc: шаблон страницы + ядро + условные пакеты + шаблон «Пробивки».
// Собирается один раз при старте; на запрос подставляется только панель портала.
const fs = require("node:fs");
const path = require("node:path");
const { esc } = require("../http");
const { ROLE_TITLES } = require("../auth");

const SEED = path.join(__dirname, "..", "..", "seed", "calc");
const BAR = "<!--__PORTAL_BAR__-->";

// JSON внутри <script>: «</script>» и разделители строк не должны оборвать скрипт.
const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029), BS = String.fromCharCode(92);
const js = (v) => JSON.stringify(v).split("<").join(BS + "u003c").split(LS).join(BS + "u2028").split(PS).join(BS + "u2029");

function build() {
  const src = fs.readFileSync(path.join(SEED, "page.src.html"), "utf8");
  const demo = JSON.parse(fs.readFileSync(path.join(SEED, "demo_synthetic.json"), "utf8"));
  const parts = {
    "/*__CORE__*/": fs.readFileSync(path.join(SEED, "core.js"), "utf8"),
    "/*__DEMO__*/": js(demo.packages.map(({ id, name, inn, expected_class, docs }) => ({ id, name, inn, expected_class, docs }))),
    "/*__TPL__*/": fs.readFileSync(path.join(SEED, "template_clean.xlsx")).toString("base64"),
    "/*__META__*/": js({ note: demo.note, refSrc: null }),
    // Ручной «Пробивки» для условных пакетов нет: сверка открывается загрузкой файла.
    "/*__REF__*/": "null",
  };
  let page = src;
  for (const [ph, val] of Object.entries(parts)) {
    const n = page.split(ph).length - 1;
    if (n !== 1) throw new Error(`плейсхолдер ${ph} встречается ${n} раз(а)`);
    page = page.split(ph).join(val); // без String.replace: в коде ядра есть «$»
  }
  const cut = page.indexOf("</style>") + "</style>".length;
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
${page.slice(0, cut)}
<style>
.portal-bar{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center;justify-content:space-between;padding:8px 20px;background:var(--surface);border-bottom:1px solid var(--line);font-size:13px}
.portal-bar a{color:var(--accent);text-decoration:none;font-weight:500}
.portal-bar span{color:var(--muted)}
</style>
</head>
<body>
${BAR}
${page.slice(cut)}
</body>
</html>`;
}

let cached = null;
function calcPage(user) {
  cached ??= build();
  const bar = `<div class="portal-bar"><a href="/">← Жизненный цикл сделки</a><span>Оценка клиента · ${esc(user.name || user.email)} · ${esc(ROLE_TITLES[user.role])}</span></div>`;
  return cached.replace(BAR, () => bar);
}

module.exports = { build, calcPage };
