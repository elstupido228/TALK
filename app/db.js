// SQLite (встроенный node:sqlite): один файл в DATA_DIR, схема создаётся при старте.
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role       TEXT NOT NULL CHECK (role IN ('admin','curator','sber2b','talk','team')),
  name       TEXT,
  pass_hash  TEXT NOT NULL,
  disabled   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip         TEXT,
  ua         TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS login_attempts (
  id    INTEGER PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  ip    TEXT,
  ok    INTEGER NOT NULL,
  at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_attempts_email_at ON login_attempts(email, at);
CREATE INDEX IF NOT EXISTS login_attempts_ip_at ON login_attempts(ip, at);
CREATE TABLE IF NOT EXISTS connector_log (
  id        INTEGER PRIMARY KEY,
  at        INTEGER NOT NULL,
  connector TEXT NOT NULL,
  mode      TEXT NOT NULL CHECK (mode IN ('live','sandbox','cache')),
  request   TEXT,
  status    TEXT NOT NULL,
  ms        INTEGER,
  user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL
);
`;

function open(dataDir = process.env.DATA_DIR || path.join(__dirname, "..", "data")) {
  const file = dataDir === ":memory:" ? ":memory:" : path.join(dataDir, "talk.sqlite");
  if (file !== ":memory:") fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
  db.exec(SCHEMA);
  return db;
}

module.exports = { open };
