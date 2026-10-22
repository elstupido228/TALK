// Создание учётных записей из CSV «email,роль[,имя]» (без заголовка или с ним).
// Пароли генерируются и выводятся в файл с правами 600 — вне репозитория. В базе хранятся только хэши.
//
//   node scripts/create-users.js users.csv ~/talk-proto/passwords.txt
//   (в контейнере) docker compose exec -T app node scripts/create-users.js - - < users.csv > ~/talk-proto/passwords.txt
//
// Повторный запуск для того же email меняет роль и выдаёт новый пароль.
const fs = require("node:fs");
const { open } = require("../app/db");
const { createAuth, generatePassword, ROLES } = require("../app/auth");

const [input = "-", output = "-"] = process.argv.slice(2);
const text = fs.readFileSync(input === "-" ? 0 : input, "utf8");

const rows = text
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"))
  .map((l) => l.split(/[,;\t]/).map((s) => s.trim()))
  .filter(([email]) => email.toLowerCase() !== "email");

if (!rows.length) {
  console.error(`Пустой список. Формат строки: email,роль[,имя]; роли: ${ROLES.join(", ")}`);
  process.exit(1);
}

const db = open();
const auth = createAuth(db);
const lines = ["email\tроль\tпароль"];
for (const [email, role, name] of rows) {
  const password = generatePassword();
  auth.upsertUser({ email, role, name: name || null, password });
  lines.push(`${email.toLowerCase()}\t${role}\t${password}`);
}
db.close();

const out = lines.join("\n") + "\n";
if (output === "-") process.stdout.write(out);
else fs.writeFileSync(output, out, { mode: 0o600 });
console.error(`Готово, учётных записей: ${rows.length}${output === "-" ? "" : `, пароли — в ${output}`}.`);
