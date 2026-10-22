// Точка входа портала. Шаг 1: заглушка с проверкой живости; вход, роли и страницы — шаг 2.
const http = require("node:http");

const PORT = Number(process.env.PORT) || 3000;

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, rss_mb: Math.round(process.memoryUsage().rss / 1048576) }));
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end("<!doctype html><meta charset=utf-8><title>Контур контроля лизинговой сделки</title><p>Прототип: каркас развёрнут.</p>");
});

server.listen(PORT, () => console.log(`talk-proto: порт ${PORT}`));

for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
