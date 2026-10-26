// Фильтры и сортировка сделок — общие для канбана, списка и выгрузки. Условия живут в адресе (?q=…&owner=…),
// поэтому ссылку на отобранный список можно сохранить или переслать.
const { norm } = require("./clients");
const STAGES = require("./stages");

const STATUSES = { active: "В работе", refused: "Отказы", archived: "Архив", all: "Все" };
const SORTS = { activity: "Активность", client: "Клиент", stage: "Стадия", amount: "Сумма", days: "Дней на стадии", task: "Следующая задача", owner: "Ответственный" };

function parseFilter(url) {
  const g = (k) => (url.searchParams.get(k) || "").trim();
  return {
    q: g("q").slice(0, 100),
    owner: /^(me|\d+)$/.test(g("owner")) ? g("owner") : "",
    stage: STAGES.some((s) => s.id === g("stage")) ? g("stage") : "",
    status: STATUSES[g("status")] ? g("status") : "active",
    sort: SORTS[g("sort")] ? g("sort") : "activity",
    dir: g("dir") === "asc" ? "asc" : g("dir") === "desc" ? "desc" : "",
  };
}

// поиск: наименование, ИНН, № сделки, примечание; цифры ищутся и в ИНН
const matches = (d, q) => {
  if (!q) return true;
  const s = norm(q), digits = q.replace(/\D/g, "");
  return norm(d.title).includes(s) || norm(d.comment).includes(s) || norm(d.note).includes(s) || (digits.length >= 3 && (d.inn || "").includes(digits)) || (/^№?\s*\d+$/.test(q) && String(d.id) === digits);
};
const statusOf = (d) => (d.archived_at ? "archived" : d.outcome ? "refused" : "active");

function filterDeals(ds, f, userId) {
  const owner = f.owner === "me" ? userId : f.owner ? Number(f.owner) : null;
  return ds.filter((d) => (f.status === "all" || statusOf(d) === f.status) && (!f.stage || d.stage === f.stage) && (!owner || d.owner_id === owner) && matches(d, f.q));
}

// tasks — Map(deal_id → ближайшая открытая задача)
function sortDeals(ds, f, tasks = new Map()) {
  const order = (id) => STAGES.findIndex((s) => s.id === id);
  const key = {
    activity: (d) => d.last_at || d.updated_at,
    client: (d) => norm(d.title),
    stage: (d) => order(d.stage),
    amount: (d) => d.amount_mln ?? -1,
    days: (d) => -(d.stage_at || d.created_at),
    task: (d) => tasks.get(d.id)?.due || "9999",
    owner: (d) => norm(d.owner_name || d.owner_email || "яяя"),
  }[f.sort];
  // направление по умолчанию: активность, сумма, дни — по убыванию; остальное — по возрастанию
  const desc = f.dir ? f.dir === "desc" : ["activity", "amount", "days"].includes(f.sort);
  return [...ds].sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * (desc ? -1 : 1); });
}

// адрес с текущими условиями и заменой части: qs(f, {sort: "amount"})
function qs(f, patch = {}) {
  const all = { ...f, ...patch };
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(all)) if (v && !(k === "status" && v === "active") && !(k === "sort" && v === "activity")) p.set(k, v);
  const s = p.toString();
  return s ? "?" + s : "";
}

module.exports = { parseFilter, filterDeals, sortDeals, qs, STATUSES, SORTS, statusOf };
