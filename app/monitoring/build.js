// Страница «Мониторинг» (раннее предупреждение): разметка и отрисовка; данные и расчёт — с сервера, /api/ews/*
// (app/monitoring/ews.js: features.js + model.json). Портфель в страницу не встраивается.
const fs = require("node:fs");
const path = require("node:path");
const { wrap, withBar } = require("../standalone");

const build = () => wrap(fs.readFileSync(path.join(__dirname, "page.html"), "utf8"));

let cached = null;
const monitoringPage = (user) => withBar((cached ??= build()), user, "monitoring");

module.exports = { build, monitoringPage };
