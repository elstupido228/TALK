// Дымовая проверка каркаса: сервер поднимается и отвечает на /healthz.
const { test } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const path = require("node:path");

test("/healthz отвечает ok", async () => {
  const port = 3999;
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "app", "server.js")], { env: { ...process.env, PORT: String(port) } });
  try {
    await new Promise((resolve, reject) => {
      proc.stdout.once("data", resolve);
      proc.once("exit", (code) => reject(new Error(`сервер завершился, код ${code}`)));
    });
    const r = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).ok, true);
  } finally {
    proc.kill();
  }
});
