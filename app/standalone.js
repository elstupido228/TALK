// Автономные страницы модулей (калькулятор, мониторинг): исходник — фрагмент <title>…<style>…</style> + разметка + скрипты.
// Оборачивается в полный документ; на место BAR при каждом запросе подставляется панель портала с пользователем.
const { esc } = require("./http");
const { ROLE_TITLES } = require("./auth");

const BAR = "<!--__PORTAL_BAR__-->";

// JSON внутри <script>: «</script>» и разделители строк U+2028/U+2029 не должны оборвать скрипт.
const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029), BS = String.fromCharCode(92);
const jsonForScript = (v) => JSON.stringify(v).split("<").join(BS + "u003c").split(LS).join(BS + "u2028").split(PS).join(BS + "u2029");

// Подстановка плейсхолдеров без String.replace (в подставляемом коде встречается «$»); каждый — ровно один раз.
function fill(src, parts) {
  let page = src;
  for (const [ph, val] of Object.entries(parts)) {
    const n = page.split(ph).length - 1;
    if (n !== 1) throw new Error(`плейсхолдер ${ph} встречается ${n} раз(а)`);
    page = page.split(ph).join(val);
  }
  return page;
}

function wrap(fragment) {
  const cut = fragment.indexOf("</style>") + "</style>".length;
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
${fragment.slice(0, cut)}
<style>
[hidden]{display:none!important} /* как в исходной обёртке test_page.py: атрибут hidden сильнее display в стилях модуля */
.portal-bar{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center;justify-content:space-between;padding:8px 20px;background:var(--surface);border-bottom:1px solid var(--line);font-size:13px}
.portal-bar a{color:var(--accent);text-decoration:none;font-weight:500}
.portal-bar span{color:var(--muted)}
</style>
</head>
<body>
${BAR}
${fragment.slice(cut)}
</body>
</html>`;
}

function withBar(html, user, label) {
  const bar = `<div class="portal-bar"><a href="/">← Жизненный цикл сделки</a><span>${esc(label)} · ${esc(user.name || user.email)} · ${esc(ROLE_TITLES[user.role])}</span></div>`;
  return html.replace(BAR, () => bar);
}

module.exports = { wrap, withBar, fill, jsonForScript };
