// Вход: хэши паролей (scrypt), cookie-сессии (токен в cookie, в базе — только его SHA-256),
// ограничение попыток по email и по IP.
const crypto = require("node:crypto");

const ROLES = ["admin", "curator", "sber2b", "talk", "team"];
const ROLE_TITLES = {
  admin: "Администратор",
  curator: "Куратор проекта",
  sber2b: "Команда Sber2B",
  talk: "ТАЛК",
  team: "Команда проекта",
};

// Права по ролям: одно место, где видно, кому что доступно.
const PERMISSIONS = {
  "pages.view": ROLES,
  "calc.use": ROLES,
  "calc.extract": ROLES, // расход ограничен дневным лимитом шлюза
  "connectors.log": ["admin", "sber2b", "team"],
  "users.view": ["admin"],
};
const can = (user, perm) => !!user && (PERMISSIONS[perm] || []).includes(user.role);

const SESSION_TTL_MS = 12 * 3600 * 1000;
const LOCK = { window_ms: 15 * 60 * 1000, max_per_email: 5, max_per_ip: 20 };

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, key] = String(stored).split("$");
  if (alg !== "scrypt") return false;
  const want = Buffer.from(key, "base64");
  const got = crypto.scryptSync(password, Buffer.from(salt, "base64"), want.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(want, got);
}

// Хэш-пустышка: время ответа для несуществующего email такое же, как для существующего.
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString("hex"));

function generatePassword() {
  // 16 символов без похожих (0/O, 1/l/I)
  const abc = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.randomBytes(16), (b) => abc[b % abc.length]).join("");
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

function createAuth(db) {
  const q = {
    userByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
    userBySession: db.prepare(
      "SELECT u.id, u.email, u.role, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0"
    ),
    insertSession: db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, ua) VALUES (?, ?, ?, ?, ?, ?)"),
    deleteSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
    purgeSessions: db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),
    insertAttempt: db.prepare("INSERT INTO login_attempts (email, ip, ok, at) VALUES (?, ?, ?, ?)"),
    // неудачи после последнего успешного входа в пределах окна
    failsByEmail: db.prepare(
      "SELECT count(*) n, min(at) first FROM login_attempts WHERE email = ? AND ok = 0 AND at > max(?, coalesce((SELECT max(at) FROM login_attempts WHERE email = ? AND ok = 1), 0))"
    ),
    failsByIp: db.prepare("SELECT count(*) n, min(at) first FROM login_attempts WHERE ip = ? AND ok = 0 AND at > ?"),
    upsertUser: db.prepare(
      "INSERT INTO users (email, role, name, pass_hash) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET role = excluded.role, name = excluded.name, pass_hash = excluded.pass_hash, disabled = 0"
    ),
    listUsers: db.prepare("SELECT id, email, role, name, disabled, created_at FROM users ORDER BY role, email"),
  };

  // Сколько секунд осталось до разблокировки (0 — не заблокирован).
  function lockedFor(email, ip, now = Date.now()) {
    const since = now - LOCK.window_ms;
    const e = q.failsByEmail.get(email, since, email);
    const i = q.failsByIp.get(ip, since);
    const left = (row, max) => (row.n >= max ? Math.ceil((row.first + LOCK.window_ms - now) / 1000) : 0);
    return Math.max(left(e, LOCK.max_per_email), left(i, LOCK.max_per_ip));
  }

  // -> { ok: true, token, user } | { ok: false, reason: 'locked'|'invalid', retryAfter? }
  function login(email, password, { ip = "", ua = "" } = {}) {
    email = String(email || "").trim().toLowerCase();
    const now = Date.now();
    const wait = lockedFor(email, ip, now);
    if (wait > 0) return { ok: false, reason: "locked", retryAfter: wait };

    const user = email ? q.userByEmail.get(email) : undefined;
    // пробелы по краям — частый след копирования из терминала или письма; сгенерированные пароли их не содержат
    const valid = verifyPassword(String(password || "").trim(), user ? user.pass_hash : DUMMY_HASH) && user && !user.disabled;
    q.insertAttempt.run(email, ip, valid ? 1 : 0, now);
    if (!valid) {
      const after = lockedFor(email, ip, now + 1);
      return after > 0 ? { ok: false, reason: "locked", retryAfter: after } : { ok: false, reason: "invalid" };
    }
    const token = crypto.randomBytes(32).toString("base64url");
    q.purgeSessions.run(now);
    q.insertSession.run(sha256(token), user.id, now, now + SESSION_TTL_MS, ip, String(ua).slice(0, 200));
    return { ok: true, token, user: { id: user.id, email: user.email, role: user.role, name: user.name } };
  }

  const userByToken = (token) => (token ? q.userBySession.get(sha256(token), Date.now()) || null : null);
  const logout = (token) => token && q.deleteSession.run(sha256(token));

  function upsertUser({ email, role, name = null, password }) {
    email = String(email).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error(`некорректный email: ${email}`);
    if (!ROLES.includes(role)) throw new Error(`неизвестная роль «${role}» (допустимо: ${ROLES.join(", ")})`);
    q.upsertUser.run(email, role, name, hashPassword(password));
  }

  return { login, logout, userByToken, upsertUser, listUsers: () => q.listUsers.all(), lockedFor };
}

module.exports = { createAuth, can, hashPassword, verifyPassword, generatePassword, ROLES, ROLE_TITLES, SESSION_TTL_MS, LOCK };
