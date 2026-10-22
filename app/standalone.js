// Автономные страницы модулей (калькулятор, мониторинг): исходник — фрагмент <title>…<style>…</style> + разметка + скрипты.
// Оборачивается в полный документ; при каждом запросе вокруг модуля подставляется меню портала (app/shell.js).
const shell = require("./shell");

const OPEN = "<!--__SHELL_OPEN__-->", CLOSE = "<!--__SHELL_CLOSE__-->";

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
body{margin:0}
</style>
</head>
<body>
${OPEN}
${fragment.slice(cut)}
${CLOSE}
</body>
</html>`;
}

// Меню портала вокруг модуля; active — пункт меню, который подсвечивается
function withBar(html, user, active) {
  return html.replace(OPEN, () => shell.open(user, active)).replace(CLOSE, () => shell.close());
}

module.exports = { wrap, withBar, fill, jsonForScript };
