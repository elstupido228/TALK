"""Сборка страницы прототипа: шаблон + модуль признаков + модель + сжатые демонстрационные данные."""
import json, gzip, base64
from pathlib import Path
B = Path(__file__).parent; D = B / "data"
d = json.loads((D / "demo.json").read_text())
cols = lambda rows, keys: {k: [r.get(k) for r in rows] for k in keys}
c = {"today": d["today"], "clients": d["clients"], "contracts": d["contracts"],
     "schedule": cols(d["schedule"], ["contract", "due", "amount"]), "payments": cols(d["payments"], ["contract", "date", "amount"]),
     "events": d["events"], "reports": d["reports"]}
gz = base64.b64encode(gzip.compress(json.dumps(c, ensure_ascii=False, separators=(",", ":")).encode(), 9)).decode()
model = json.loads((D / "model.json").read_text())
page = (B / "page_src.html").read_text()
page = page.replace("/*FEATURES_JS*/", (B / "features.js").read_text())
page = page.replace("__MODEL_JSON__", json.dumps(model, ensure_ascii=False, separators=(",", ":")))
page = page.replace("__DATA_GZ__", gz)
out = B / "Раннее_предупреждение_ТАЛК.html"; out.write_text(page)
print(out, round(len(page.encode()) / 1024), "КБ")
