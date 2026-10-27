// Форматы для всех страниц портала: суммы и числа — с запятой и пробелами между разрядами, даты — ДД.ММ.ГГГГ,
// склонение по числу. Одна функция на тип, чтобы одно и то же значение везде выглядело одинаково.

// сумма в млн руб.: «50,5 млн», «999 999,99 млн» (до двух знаков — без округления больших сумм до целых)
const mln = (v) => (v === null || v === undefined || v === "" ? "—" : `${Number(v).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} млн`);
// число для поля ввода: десятичная запятая, без разрядных пробелов («50,5»)
const numInput = (v) => (v === null || v === undefined ? "" : String(v).replace(".", ","));
// дата ISO (2015-03-01 или 2015-03-01T…) → 01.03.2015
const fdate = (iso) => (iso ? `${String(iso).slice(8, 10)}.${String(iso).slice(5, 7)}.${String(iso).slice(0, 4)}` : "—");
// 1 день, 2 дня, 5 дней
const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? few : many);

module.exports = { mln, numInput, fdate, plural };
