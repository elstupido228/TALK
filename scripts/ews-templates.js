// Шаблон выгрузки «Мониторинга» и пример на демо-портфеле — готовыми файлами в seed/ews/data (при сборке образа).
// Сервер отдаёт их как есть: собрать пример на 45 тыс. строк в памяти стенда (100 МБ) нельзя.
const fs = require("node:fs");
const path = require("node:path");
const { createEws } = require("../app/monitoring/ews");

const DATA = path.join(__dirname, "..", "seed", "ews", "data");
const ews = createEws();
const demo = JSON.parse(fs.readFileSync(path.join(DATA, "demo.json"), "utf8"));
fs.writeFileSync(path.join(DATA, "template.xlsx"), ews.workbook(null));
fs.writeFileSync(path.join(DATA, "template_example.xlsx"), ews.workbook(demo));
console.log("шаблон и пример выгрузки записаны в", DATA);
