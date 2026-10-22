// Оболочка портала: постоянное меню на всех страницах — и серверных, и автономных модулях (калькулятор, мониторинг).
// Стили с префиксом sh- и собственными переменными, чтобы не пересекаться со стилями модулей.
// На узком экране меню сворачивается в кнопку «Меню» (флажок + CSS, без скриптов).
const { esc } = require("./http");
const { can, ROLE_TITLES } = require("./auth");

const WORK = [
  ["home", "/", "Главная", '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>'],
  ["deals", "/deals", "Сделки", '<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="10" rx="1"/><rect x="17" y="4" width="4" height="13" rx="1"/>'],
  ["check", "/check", "Проверка по ИНН", '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>'],
  ["calc", "/calc", "Расчёт класса", '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 12h2M12 12h2M16 12h0M8 16h2M12 16h2"/>'],
  ["monitoring", "/monitoring", "Мониторинг", '<path d="M3 12h4l3 7 4-14 3 7h4"/>'],
];
const HELP = [
  ["process", "/process", "Схема процесса", '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M8 6h6a4 4 0 0 1 0 8h-4a4 4 0 0 0 0 8h6"/>'],
  ["sources", "/sources", "Источники данных", '<path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0z"/><path d="M12 16v5"/>'],
  ["about", "/about", "О проекте", '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h0"/>'],
];
const ADMIN = [["users", "/admin/users", "Пользователи", '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 4a3 3 0 0 1 0 6M21 20a6 6 0 0 0-4-5.6"/>']];

const icon = (d) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const link = (active) => ([id, href, label, d]) =>
  `<a href="${href}"${id === active ? ' aria-current="page"' : ""}>${icon(d)}<span>${label}</span></a>`;

const CSS = `
.sh{--sh-bg:#F4F6F4;--sh-side:#FFFFFF;--sh-ink:#15201B;--sh-muted:#5B6862;--sh-line:#D8DED9;--sh-accent:#1B6446;--sh-accent-soft:#E2EFE8;--sh-warn:#8F5A06;--sh-warn-soft:#FBF0DA;
  display:grid;grid-template-columns:232px minmax(0,1fr);min-height:100vh;background:var(--sh-bg)}
@media (prefers-color-scheme:dark){.sh{--sh-bg:#101614;--sh-side:#171F1C;--sh-ink:#E4EBE7;--sh-muted:#9AA8A1;--sh-line:#2C3833;--sh-accent:#5DBB8E;--sh-accent-soft:#1D3329;--sh-warn:#E3AE55;--sh-warn-soft:#352812}}
.sh-side{position:sticky;top:0;height:100vh;overflow:auto;display:flex;flex-direction:column;gap:6px;padding:16px 12px;background:var(--sh-side);border-right:1px solid var(--sh-line);
  font:14px/1.4 "IBM Plex Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--sh-ink)}
.sh-brand{display:block;padding:4px 8px 12px;color:var(--sh-ink);text-decoration:none;font-weight:600;line-height:1.25}
.sh-brand small{display:inline-block;margin-top:4px;font-size:11px;font-weight:600;color:var(--sh-warn);background:var(--sh-warn-soft);padding:1px 6px;border-radius:4px}
.sh-nav{display:flex;flex-direction:column;gap:2px}
.sh-nav a{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;color:var(--sh-ink);text-decoration:none}
.sh-nav a:hover{background:var(--sh-bg)}
.sh-nav a[aria-current="page"]{background:var(--sh-accent-soft);color:var(--sh-accent);font-weight:600}
.sh-nav.help a{color:var(--sh-muted);font-size:13px;padding:6px 10px}
.sh-cap{margin:14px 10px 4px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--sh-muted)}
.sh-user{margin-top:auto;padding:12px 10px 0;border-top:1px solid var(--sh-line);font-size:13px;color:var(--sh-muted)}
.sh-user b{display:block;color:var(--sh-ink);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sh-user button{margin-top:8px;font:inherit;font-size:13px;padding:5px 12px;border-radius:6px;border:1px solid var(--sh-line);background:transparent;color:var(--sh-ink);cursor:pointer}
.sh-main{min-width:0}
.sh-toggle,.sh-burger{display:none}
@media (max-width:900px){
  .sh{grid-template-columns:1fr}
  .sh-side{position:sticky;z-index:20;height:auto;flex-direction:row;flex-wrap:wrap;align-items:center;padding:8px 12px;border-right:0;border-bottom:1px solid var(--sh-line)}
  .sh-brand{padding:4px 0;flex:1}.sh-brand small{margin:0 0 0 6px}
  .sh-burger{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border:1px solid var(--sh-line);border-radius:8px;cursor:pointer;font-size:14px}
  .sh-drawer{display:none;flex-basis:100%;padding:6px 0 4px}
  .sh-toggle:checked ~ .sh-drawer{display:block}
  .sh-user{margin-top:8px}
}
`;

function open(user, active) {
  const help = [...HELP, ...(can(user, "users.view") ? ADMIN : [])];
  return `<style>${CSS}</style>
<div class="sh">
<aside class="sh-side" aria-label="Меню портала">
  <a class="sh-brand" href="/">Контур контроля лизинговой сделки<br><small>прототип</small></a>
  <input type="checkbox" id="sh-toggle" class="sh-toggle"><label class="sh-burger" for="sh-toggle">${icon('<path d="M4 7h16M4 12h16M4 17h16"/>')}Меню</label>
  <div class="sh-drawer">
    <nav class="sh-nav">${WORK.map(link(active)).join("")}</nav>
    <div class="sh-cap">Справка</div>
    <nav class="sh-nav help">${help.map(link(active)).join("")}</nav>
    <form class="sh-user" method="post" action="/logout"><b title="${esc(user.email)}">${esc(user.name || user.email)}</b>${esc(ROLE_TITLES[user.role])}<br><button type="submit">Выйти</button></form>
  </div>
</aside>
<div class="sh-main">`;
}
const close = () => `</div></div>`;

const FONTS = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">';

module.exports = { open, close, FONTS };
