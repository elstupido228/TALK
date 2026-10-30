// ===== Запас до смены класса: разметка блока (лестница классов + шкала запаса по коэффициентам) =====
// Один рендер на калькулятор и страницу проверки по ИНН. Данные — результат classMargins.margins (sensitivity.js).
// Цвета задаёт страница-хозяин через переменные --mg-* на .mg (см. CSS ниже и style.css / page.src.html).
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.marginsView = factory();
})(typeof window !== "undefined" ? window : globalThis, function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  const num = (v, d = 2) => v.toLocaleString("ru-RU", { minimumFractionDigits: d, maximumFractionDigits: d });
  const sign = (v) => (v > 0 ? "+" : v < 0 ? "−" : "");
  const pct = (p) => (p === null ? "с нуля" : `${sign(p)}${Math.abs(Math.round(p * 100))} %`);
  const ZONES = [
    { cls: 1, rule: "S ≤ 1,25 и К5 ≥ 0,10" },
    { cls: 2, rule: "S ≤ 2,35 и К5 ≥ 0" },
    { cls: 3, rule: "остальные случаи" },
  ];

  // «оборотные активы +85 000 тыс. руб. (+22 %)»
  const step = (c, mv, unit = "тыс. руб.") => `${esc(c.label)} <b>${sign(mv.delta)}${Math.abs(mv.delta).toLocaleString("ru-RU")}</b> ${unit} <span class="mg-nw">(${pct(mv.pct)})</span>`;
  const joinAnd = (parts) => (parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} и ${parts[parts.length - 1]}`);

  function upText(m) {
    if (!m.up) return "Даже сочетанием двух-трёх строк до ближайших порогов класс не улучшается.";
    const parts = m.up.ks.map((k) => step(m.coefs[k - 1], m.coefs[k - 1].better));
    return m.up.ks.length === 1 ? `Если ${parts[0]}.` : `Одной строкой не получится. Нужны ${m.up.ks.length === 2 ? "оба шага" : "все три шага"}: ${joinAnd(parts)}.`;
  }

  function downText(m) {
    const singles = m.threats.slice(0, 2).map((k) => step(m.coefs[k - 1], m.coefs[k - 1].worse));
    const pair = m.pairs[0] ? joinAnd([m.pairs[0].a, m.pairs[0].b].map((k) => step(m.coefs[k - 1], m.coefs[k - 1].worse))) : "";
    if (!singles.length && !pair) return "Ни одна строка в одиночку или в паре с другой до ближайшего порога класс не меняет.";
    const s = singles.join(" <span class=\"mg-or\">или</span> ");
    return `Если ${s}${pair ? `${s ? ' <span class="mg-or">или вместе</span> ' : "вместе "}${pair}` : ""}.`;
  }

  function hereText(m) {
    const k5 = num(m.K5, 3);
    if (m.cls === 1) return `Запас по сумме баллов до класса 2 — ${num(m.toS1)}. К5 сейчас ${k5}, для класса 1 нужно не ниже 0,10.`;
    if (m.cls === 2) return `До класса 1 не хватает ${num(-m.toS1)} балла, запас до класса 3 — ${num(m.toS2)}. К5 сейчас ${k5}${m.K5 < 0.1 ? ", для класса 1 нужно не ниже 0,10" : ""}.`;
    return `До класса 2 не хватает ${num(-m.toS2)} балла${m.K5 < 0 ? `, и К5 должна стать не ниже 0 (сейчас ${k5})` : ""}.`;
  }

  function ladder(m) {
    return ZONES.map((z) => {
      const here = z.cls === m.cls;
      const side = here ? `<p class="mg-side mg-here-text">${hereText(m)}</p>`
        : z.cls === m.cls - 1 ? `<p class="mg-side"><span class="mg-dir mg-up">Подняться в класс ${z.cls}.</span> ${upText(m)}</p>`
        : z.cls === m.cls + 1 ? `<p class="mg-side"><span class="mg-dir mg-down">Класс станет ${z.cls}.</span> ${downText(m)}</p>`
        : '<p class="mg-side mg-far"></p>';
      return `<div class="mg-zone mg-z${z.cls}${here ? " mg-current" : ""}"><b>Класс ${z.cls}</b><span>${z.rule}</span>${here ? `<span class="mg-pin">здесь · S ${num(m.S)}</span>` : ""}</div>${side}`;
    }).join("");
  }

  function bar(c, mv, dir, m) {
    if (c.noDen) return `<div class="mg-cell mg-${dir}"><span class="mg-lbl">делитель не положительный</span></div>`;
    if (!mv) return `<div class="mg-cell mg-${dir}"><span class="mg-lbl">${dir === "worse" ? "худшая категория" : "лучшая категория"}</span></div>`;
    const w = mv.pct === null ? 100 : Math.max(2, Math.min(100, Math.abs(mv.pct) * 100));
    // выделение: сдвиг сам меняет класс; входит в путь наверх; входит в пару ухудшений, которая вместе меняет класс
    const pair = dir === "worse" && m.pairs[0] && [m.pairs[0].a, m.pairs[0].b].includes(c.k) ? [m.pairs[0].a, m.pairs[0].b].find((k) => k !== c.k) : null;
    const note = dir === "worse" ? (mv.cls > m.cls ? `класс станет ${mv.cls}` : pair ? `вместе с К${pair} — класс ${m.pairs[0].cls}` : "")
      : mv.cls < m.cls ? `класс станет ${mv.cls}` : m.up && m.up.ks.includes(c.k) ? "шаг наверх" : "";
    const tone = !note ? "" : pair && mv.cls === m.cls ? " mg-pair" : " mg-flip";
    return `<div class="mg-cell mg-${dir}"><span class="mg-bar${tone}" style="width:${w.toFixed(0)}%"></span><span class="mg-lbl">${step(c, mv, "тыс.")}${note ? ` · <em class="mg-t${tone.replace(" mg-", "-")}">${note}</em>` : ""}</span></div>`;
  }

  function scale(m) {
    const rows = m.coefs.map((c) => `<div class="mg-row"${c.alt ? ` title="${esc(c.alt)}"` : ""}><span class="mg-name">${esc(c.name)}</span>${bar(c, c.worse, "worse", m)}<span class="mg-cat" aria-label="категория ${c.cat}">${c.cat}</span>${bar(c, c.better, "better", m)}</div>`).join("");
    return `<div class="mg-scale"><div class="mg-row mg-head"><span class="mg-name">Коэффициент</span><span class="mg-worse">← до худшей категории</span><span class="mg-cat" title="категория коэффициента">кат.</span><span class="mg-better">до лучшей →</span></div>${rows}</div>`;
  }

  // m — результат margins(); caption — откуда данные («по годовой отчётности за 2025 год»), необязательно
  function html(m, { caption = "" } = {}) {
    if (!m) return "";
    return `<div class="mg">${caption ? `<p class="mg-src">${esc(caption)}</p>` : ""}<div class="mg-ladder">${ladder(m)}</div>${scale(m)}
<p class="mg-note">Суммы — в тыс. руб. Короче полоса — ближе порог. Цветная полоса меняет класс сама или в паре. Сдвиг одной строки при прочих равных: связанные строки (денежные средства входят и в оборотные активы) не пересчитываются.</p></div>`;
  }

  const CSS = `.mg{display:flex;flex-direction:column;gap:16px;font-size:14px}
.mg b{font-weight:600}.mg em{font-style:normal;font-weight:600}
.mg-src{margin:0;color:var(--mg-muted)}
.mg-ladder{display:grid;grid-template-columns:minmax(150px,200px) minmax(0,1fr);gap:8px 16px;align-items:center}
.mg-zone{border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:2px;position:relative;min-height:56px;justify-content:center}
.mg-zone span{font-size:14px}
.mg-z1{background:var(--mg-1-bg);color:var(--mg-1)}.mg-z2{background:var(--mg-2-bg);color:var(--mg-2)}.mg-z3{background:var(--mg-3-bg);color:var(--mg-3)}
.mg-current{min-height:80px;box-shadow:inset 0 0 0 2px currentColor}
.mg-pin{font-weight:600}
.mg-side{margin:0;line-height:1.45}
.mg-dir{font-weight:600}.mg-up{color:var(--mg-1)}.mg-down{color:var(--mg-3)}
.mg-here-text{color:var(--mg-muted)}
.mg-or{color:var(--mg-muted)}
.mg-scale{display:flex;flex-direction:column}
.mg-row{display:grid;grid-template-columns:minmax(130px,1fr) minmax(0,1.4fr) 36px minmax(0,1.4fr);gap:4px 10px;align-items:center;padding:8px 0;border-top:1px solid var(--mg-line)}
.mg-head{color:var(--mg-muted);border-top:0;padding-top:0}
.mg-head .mg-worse{text-align:right}
.mg-cat{text-align:center;font-weight:600}
.mg-cell{display:flex;flex-direction:column;gap:4px;min-width:0}
.mg-worse{align-items:flex-end;text-align:right}
.mg-bar{display:block;height:10px;border-radius:2px;background:var(--mg-track)}
.mg-worse .mg-flip{background:var(--mg-3)}.mg-better .mg-flip{background:var(--mg-1)}.mg-bar.mg-pair{background:var(--mg-2)}
.mg-lbl{color:var(--mg-muted);line-height:1.35}
.mg-lbl b{color:var(--mg-ink)}
.mg-worse .mg-lbl em{color:var(--mg-3)}.mg-better .mg-lbl em{color:var(--mg-1)}.mg-lbl em.mg-t-pair{color:var(--mg-2)}.mg-nw{white-space:nowrap}
.mg-note{margin:0;color:var(--mg-muted)}
@media (max-width:640px){.mg-ladder{grid-template-columns:1fr}.mg-side{margin-bottom:6px}.mg-far{display:none}
.mg-row{grid-template-columns:minmax(0,1fr) 28px minmax(0,1fr)}.mg-row .mg-name{grid-column:1/-1;font-weight:600}.mg-head .mg-name{display:none}}`;

  return { html, CSS };
});
