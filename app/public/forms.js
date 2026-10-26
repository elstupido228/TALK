// Формы портала (подключается на всех серверных страницах):
// - подтверждение действий с последствиями: data-confirm на кнопке, {select} — выбранный пункт списка формы;
// - отправка POST без перезагрузки: кнопки блокируются, на нажатой — текст из data-busy-text; ответ с ошибкой
//   заменяет содержимое страницы (адрес остаётся прежним), сбой связи или таймаут — сообщение над формой,
//   введённое остаётся в полях;
// - черновики форм с data-draft: ввод хранится в sessionStorage до успешной отправки и восстанавливается после
//   ухода со страницы; уход с несохранённым вводом — предупреждение браузера;
// - сообщение об успехе из cookie flash (ставит сервер при перенаправлении);
// - поле с ошибкой: блок раскрывается, страница прокручивается к полю, курсор — в поле.
(() => {
  const TIMEOUT_MS = 30000;
  const dirty = new Set();
  let leaving = false;

  function toast(text) {
    const t = document.createElement("div");
    t.className = "toast";
    t.setAttribute("role", "status");
    t.innerHTML = '<span></span><button type="button" aria-label="Закрыть">×</button>';
    t.firstChild.textContent = text;
    t.lastChild.onclick = () => t.remove();
    document.body.append(t);
    let timer = setTimeout(() => t.remove(), 7000);
    t.onmouseenter = () => clearTimeout(timer);
    t.onmouseleave = () => (timer = setTimeout(() => t.remove(), 3000));
  }

  const draftKey = (f) => "draft:" + location.pathname + ":" + f.getAttribute("action");
  const fields = (f) => [...f.elements].filter((e) => e.name && e.type !== "hidden" && e.tagName !== "BUTTON");
  const store = (f) => { try { sessionStorage.setItem(draftKey(f), JSON.stringify(Object.fromEntries(fields(f).map((e) => [e.name, e.value])))); } catch (e) {} };
  const forget = (f) => { dirty.delete(f); try { sessionStorage.removeItem(draftKey(f)); } catch (e) {} };

  function init(root) {
    const flash = document.cookie.match(/(?:^|; )flash=([^;]*)/);
    if (flash) { document.cookie = "flash=; Path=/; Max-Age=0; SameSite=Lax"; toast(decodeURIComponent(flash[1])); }

    root.querySelectorAll("form[data-draft]").forEach((f) => {
      // после ответа с ошибкой в форме уже введённые значения — они не сохранены
      const fromServer = !!f.querySelector('[aria-invalid="true"]') || !!f.closest("details")?.querySelector('.notice[role="alert"]');
      let saved = null;
      try { saved = JSON.parse(sessionStorage.getItem(draftKey(f)) || "null"); } catch (e) {}
      if (fromServer) { dirty.add(f); store(f); }
      else if (saved) {
        let restored = false;
        fields(f).forEach((e) => { if (e.name in saved && e.value !== saved[e.name]) { e.value = saved[e.name]; restored = true; } });
        if (restored) {
          dirty.add(f);
          f.closest("details")?.setAttribute("open", "");
          const p = document.createElement("p");
          p.className = "draft-note wide";
          p.setAttribute("role", "status");
          p.innerHTML = 'Восстановлен несохранённый ввод. <button type="button">Отменить</button>';
          p.querySelector("button").onclick = () => { forget(f); leaving = true; location.reload(); };
          f.prepend(p);
        } else forget(f);
      }
      f.addEventListener("input", () => { dirty.add(f); store(f); });
    });

    const bad = root.querySelector('[aria-invalid="true"]') || root.querySelector('details .notice[role="alert"]');
    if (bad) {
      bad.closest("details")?.setAttribute("open", "");
      bad.scrollIntoView({ block: "center" });
      if (bad.matches("input, select, textarea")) bad.focus({ preventScroll: true });
    }
  }

  function netError(f, text) {
    f.querySelector(".net-error")?.remove();
    const p = document.createElement("p");
    p.className = "error net-error wide";
    p.setAttribute("role", "alert");
    p.textContent = text;
    f.prepend(p);
    p.scrollIntoView({ block: "nearest" });
  }

  document.addEventListener("submit", async (e) => {
    const f = e.target, b = e.submitter;
    const sel = f.querySelector("select");
    const m = b?.dataset.confirm?.replace("{select}", sel?.selectedOptions[0]?.text || "");
    if (m && !confirm(m)) return e.preventDefault();
    const buttons = [...f.querySelectorAll("button")];
    const busy = () => { buttons.forEach((x) => (x.disabled = true)); if (b?.dataset.busyText) { b.dataset.label = b.textContent; b.textContent = b.dataset.busyText; } f.setAttribute("aria-busy", "true"); };
    // GET (проверка по ИНН): обычный переход, только блокировка и индикатор
    if (f.method !== "post") { leaving = true; return setTimeout(busy); }
    e.preventDefault();
    if (f.getAttribute("aria-busy")) return;
    const body = new URLSearchParams(new FormData(f, b));
    busy();
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    const restore = () => { buttons.forEach((x) => (x.disabled = false)); if (b?.dataset.label) b.textContent = b.dataset.label; f.removeAttribute("aria-busy"); };
    try {
      const r = await fetch(f.action, { method: "POST", body, signal: ctl.signal });
      if (r.redirected) { forget(f); leaving = true; location.href = r.url; return; }
      if (r.status >= 500) { restore(); return netError(f, `Сервер ответил ошибкой (${r.status}) — изменения не сохранены. Введённое осталось в форме, повторите отправку.`); }
      // ответ с ошибкой ввода, конфликтом или отказом в доступе — новое содержимое страницы, адрес прежний
      const doc = new DOMParser().parseFromString(await r.text(), "text/html");
      const main = doc.querySelector("main.page");
      if (!main) { restore(); return netError(f, "Не удалось разобрать ответ сервера. Повторите отправку."); }
      document.querySelector("main.page").replaceWith(main);
      document.title = doc.title;
      init(main);
    } catch (err) {
      restore();
      netError(f, err.name === "AbortError"
        ? `Сервер не ответил за ${TIMEOUT_MS / 1000} с — изменения, возможно, не сохранены. Введённое осталось в форме: обновите страницу и проверьте или повторите отправку.`
        : "Нет связи с сервером — изменения не сохранены. Введённое осталось в форме, повторите отправку, когда связь появится.");
    } finally { clearTimeout(timer); }
  });

  addEventListener("beforeunload", (e) => { if (dirty.size && !leaving) { e.preventDefault(); e.returnValue = ""; } });
  init(document);
})();
