// Мелкие помощники HTTP без фреймворка.
const MAX_BODY = 1024 * 1024;

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// За Caddy: он перезаписывает X-Forwarded-For адресом клиента (входящий заголовок не доверяется).
const clientIp = (req) => (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "";
const isHttps = (req) => req.headers["x-forwarded-proto"] === "https";

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("слишком большой запрос"), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readForm(req) {
  return Object.fromEntries(new URLSearchParams((await readBody(req)).toString("utf8")));
}

function send(res, status, body, type = "text/html; charset=utf-8", headers = {}) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...headers });
  res.end(body);
}
const sendJson = (res, status, obj, headers) => send(res, status, JSON.stringify(obj), "application/json; charset=utf-8", headers);
const redirect = (res, to, headers = {}) => {
  res.writeHead(303, { location: to, ...headers });
  res.end();
};

// Защита от CSRF для POST: запрос должен прийти с той же страницы (Origin/Referer = Host).
function sameOrigin(req) {
  const src = req.headers.origin || req.headers.referer;
  if (!src) return false;
  try {
    return new URL(src).host === req.headers.host;
  } catch {
    return false;
  }
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

module.exports = { parseCookies, clientIp, isHttps, readBody, readForm, send, sendJson, redirect, sameOrigin, esc };
