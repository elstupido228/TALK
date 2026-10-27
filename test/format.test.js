// Единые форматы: суммы с запятой без округления больших сумм, поле ввода с запятой, даты ДД.ММ.ГГГГ, склонение.
const { test } = require("node:test");
const assert = require("node:assert");
const { mln, numInput, fdate, plural } = require("../app/format");

const sp = (s) => s.replace(/\s/g, " "); // toLocaleString ставит неразрывные пробелы

test("суммы: запятая, разряды, до двух знаков", () => {
  assert.strictEqual(sp(mln(50.5)), "50,5 млн");
  assert.strictEqual(sp(mln(999999.99)), "999 999,99 млн", "без округления до «1 000 000»");
  assert.strictEqual(mln(null), "—");
  assert.strictEqual(numInput(50.5), "50,5");
  assert.strictEqual(numInput(null), "");
});

test("даты и склонения", () => {
  assert.strictEqual(fdate("2015-03-01"), "01.03.2015");
  assert.strictEqual(fdate("2026-10-27T10:00:00Z"), "27.10.2026");
  assert.deepStrictEqual([1, 2, 5, 11, 21, 34].map((n) => `${n} ${plural(n, "клиент", "клиента", "клиентов")}`), ["1 клиент", "2 клиента", "5 клиентов", "11 клиентов", "21 клиент", "34 клиента"]);
});
