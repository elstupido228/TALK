// Сборка страницы калькулятора из seed/calc: шаблон страницы + ядро + условные пакеты + шаблон «Пробивки».
// Собирается один раз при старте; на запрос подставляется только панель портала.
const fs = require("node:fs");
const path = require("node:path");
const { wrap, withBar, fill, jsonForScript: js } = require("../standalone");

const SEED = path.join(__dirname, "..", "..", "seed", "calc");

function build() {
  const demo = JSON.parse(fs.readFileSync(path.join(SEED, "demo_synthetic.json"), "utf8"));
  return wrap(
    fill(fs.readFileSync(path.join(SEED, "page.src.html"), "utf8"), {
      "/*__CORE__*/": fs.readFileSync(path.join(SEED, "core.js"), "utf8"),
      "/*__SENS__*/": fs.readFileSync(path.join(SEED, "sensitivity.js"), "utf8"),
      "/*__MGVIEW__*/": fs.readFileSync(path.join(SEED, "margins-view.js"), "utf8"),
      "/*__MGCSS__*/": require(path.join(SEED, "margins-view.js")).CSS,
      "/*__DEMO__*/": js(demo.packages.map(({ id, name, inn, expected_class, docs }) => ({ id, name, inn, expected_class, docs }))),
      "/*__TPL__*/": fs.readFileSync(path.join(SEED, "template_clean.xlsx")).toString("base64"),
      "/*__META__*/": js({ note: demo.note, refSrc: null }),
      // Ручной «Пробивки» для условных пакетов нет: сверка открывается загрузкой файла.
      "/*__REF__*/": "null",
    })
  );
}

let cached = null;
const calcPage = (user) => withBar((cached ??= build()), user, "calc");

module.exports = { build, calcPage };
