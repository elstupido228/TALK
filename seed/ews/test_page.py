"""Проверка страницы в Chromium: ошибки консоли, все вкладки, загрузка примера выгрузки, снимки экранов."""
import sys, json
from pathlib import Path
from playwright.sync_api import sync_playwright
B = Path(__file__).parent
OUT = Path(sys.argv[1]); OUT.mkdir(parents=True, exist_ok=True)
XLSX_JS = Path(sys.argv[2]).read_text()
body = (B / "Раннее_предупреждение_ТАЛК.html").read_text()
html = ('<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">'
        '<style>:root{color-scheme:light}body{margin:0;font:14px sans-serif}img{max-width:100%}[hidden]{display:none!important}</style></head><body>'
        + body + '</body></html>')
(OUT / "page.html").write_text(html)
errs = []
with sync_playwright() as p:
    br = p.chromium.launch()
    def page_for(w, h, scheme):
        ctx = br.new_context(viewport={"width": w, "height": h}, color_scheme=scheme)
        pg = ctx.new_page()
        pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
        pg.on("pageerror", lambda e: errs.append("pageerror: " + str(e)))
        pg.route("https://cdnjs.cloudflare.com/**", lambda r: r.fulfill(body=XLSX_JS, content_type="application/javascript"))
        pg.route("https://fonts.googleapis.com/**", lambda r: r.abort())
        pg.goto((OUT / "page.html").as_uri()); pg.wait_for_function("document.getElementById('bootStatus').hidden === true", timeout=60000)
        return pg
    pg = page_for(1280, 900, "light")
    info = pg.evaluate("""() => ({clients: STATE.clients.length, zones: ['red','yellow','green','grey'].map(z => STATE.clients.filter(c => c.now.zone === z).length),
        today: STATE.today, card: CARD_CLIENT, overflow: document.documentElement.scrollWidth > innerWidth})""")
    print("демо:", info)
    for tab in ["portfolio", "card", "model", "upload"]:
        pg.evaluate(f"showTab('{tab}')"); pg.wait_for_timeout(200)
        pg.screenshot(path=str(OUT / f"{tab}_light.png"), full_page=True)
    # карточка клиента с дефолтом из проверки
    case = pg.evaluate("MODEL.validation.lead.cases[0].client"); pg.evaluate(f"openCard('{case}')"); pg.wait_for_timeout(200)
    pg.screenshot(path=str(OUT / "card_default_case.png"), full_page=True)
    # загрузка: пример выгрузки, собранный тем же шаблоном, должен дать тот же портфель
    res = pg.evaluate("""async () => {
        const wb = buildWorkbook(DEMO); const buf = XLSX.write(wb, {bookType: 'xlsx', type: 'array'});
        await handleFile(new File([buf], 'пример.xlsx'));
        const checks = document.getElementById('upChecks').innerText;
        const before = STATE.clients.map(c => c.cl.client + ':' + c.now.score + ':' + c.now.zone).sort().join('|');
        document.getElementById('upRun').click(); await new Promise(r => setTimeout(r, 300));
        const after = STATE.clients.map(c => c.cl.client + ':' + c.now.score + ':' + c.now.zone).sort().join('|');
        return {checks, date: document.getElementById('upDate').value, same: before === after, n: STATE.clients.length, banner: !document.getElementById('loadedBanner').hidden};
    }""")
    print("загрузка:", json.dumps(res, ensure_ascii=False))
    pg.screenshot(path=str(OUT / "after_upload.png"))
    pg.evaluate("showTab('upload')"); pg.screenshot(path=str(OUT / "upload_report.png"), full_page=True)
    dk = page_for(1280, 900, "dark")
    for tab in ["portfolio", "model"]:
        dk.evaluate(f"showTab('{tab}')"); dk.wait_for_timeout(200); dk.screenshot(path=str(OUT / f"{tab}_dark.png"), full_page=True)
    mb = page_for(390, 844, "light")
    for tab in ["portfolio", "card"]:
        mb.evaluate(f"showTab('{tab}')"); mb.wait_for_timeout(200)
        print(tab, "горизонтальная прокрутка на телефоне:", mb.evaluate("document.documentElement.scrollWidth > innerWidth"))
        mb.screenshot(path=str(OUT / f"{tab}_mobile.png"), full_page=True)
    br.close()
print("ошибки консоли:", errs[:10] or "нет")
