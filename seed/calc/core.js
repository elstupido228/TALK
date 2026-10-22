// ===== Ядро: сведение извлечённых данных, проверки, расчёт по формулам «Пробивки», заполнение xlsx =====
const CODES_BAL = ["1200","1230","1240","1250","1300","1370","1500","1530","1540","1550","1600","1700"];
const CODES_PNL = ["2110","2200","2400"];
// строки шаблона «Пробивка»: строка Excel -> код строки отчётности (как в шаблоне)
const TPL_ROWS = {10:"2110",11:"2200",12:"2400",18:"1230",19:"1240",20:"1250",21:"1200",25:"1300",27:"1530",28:"1550",29:"1500",30:"1600"};
const TPL_COLS = ["E","F","H","J","L"];          // E — только для LTM; класс по F,H,J,L
const CLASS_COLS = ["F","H","J","L"];
const MANUAL_ROWS = {35:"Безнадёжная краткосрочная дебиторская задолженность",36:"Безнадёжная долгосрочная дебиторская задолженность",37:"КФВ в гос. ценные бумаги, ценные бумаги Сбербанка, депозиты",38:"Финансовые вложения в неликвидные ценные бумаги и неплатёжеспособные предприятия",39:"Неликвидные и труднореализуемые запасы"};

function iso(y,m,d){return `${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`}
function parseDate(s){ // "30.09.2025" | "2025-09-30"
  if(!s) return null; let m=String(s).match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/); if(m) return iso(+m[3],+m[2],+m[1]);
  m=String(s).match(/(\d{4})-(\d{2})-(\d{2})/); return m?iso(+m[1],+m[2],+m[3]):null;}
function nextDay(isoD){const d=new Date(isoD+"T00:00:00Z"); d.setUTCDate(d.getUTCDate()+1); return d.toISOString().slice(0,10);}
function addMonths(isoD,k){const [y,m]=isoD.split("-").map(Number); const t=(y*12+(m-1))+k; return iso(Math.floor(t/12),t%12+1,1);}
function fmtDate(isoD){const [y,m,d]=isoD.split("-"); return `${d}.${m}.${y}`;}
function excelSerial(isoD){return Math.round((Date.parse(isoD+"T00:00:00Z")-Date.UTC(1899,11,30))/864e5);}

// Документы: [{name, type:"balance"|"pnl"|"both", columns:[{kind:"balance"|"pnl", date:"YYYY-MM-DD" (дата баланса или конец периода), months, header, primary:bool, values:{code:num|null}, page:{code:n}}]}]
// Возвращает: {dates:[iso x5 (дата «на 1-е число», как в шаблоне)], cells:{col:{code:{value, sources:[{doc,header,value,page,primary}], conflict}}}}
function consolidate(docs){
  // целевая дата — начало месяца, следующего за отчётной датой (как в шаблоне: 01.10.2025 = баланс на 30.09.2025)
  const primaryBal = [];
  docs.forEach(d=>d.columns.forEach(c=>{ if(c.kind==="balance"&&c.primary&&c.date) primaryBal.push(nextDay(c.date)); }));
  if(!primaryBal.length) return {dates:[],cells:{}};
  const last = primaryBal.sort().at(-1);
  const dates = [-12,-9,-6,-3,0].map(k=>addMonths(last,k));
  const cells = {};
  TPL_COLS.forEach((col,i)=>{
    cells[col]={}; const target=dates[i];
    [...CODES_BAL,...CODES_PNL].forEach(code=>{
      const isP = code.startsWith("2"); const srcs=[];
      docs.forEach(d=>d.columns.forEach(c=>{
        if(!c.date || nextDay(c.date)!==target) return;
        if(isP && c.kind!=="pnl") return; if(!isP && c.kind!=="balance") return;
        // ОПиУ: нарастающий итог с начала года — число месяцев = месяц отчётной даты
        if(isP && c.months && +c.months !== +c.date.slice(5,7)) return;
        const v=c.values?.[code]; if(v===undefined) return;
        srcs.push({doc:d.name, header:c.header, value:v, page:c.page?.[code]??null, primary:!!c.primary});
      }));
      srcs.sort((a,b)=>(b.primary-a.primary));
      const vals=[...new Set(srcs.filter(s=>s.value!==null).map(s=>s.value))];
      const main=srcs.find(s=>s.value!==null);
      cells[col][code]={value: main?main.value:null, sources:srcs, conflict: vals.length>1, edited:false};
    });
  });
  return {dates,cells};
}

// ===== Расчёт: построчный перенос формул листа «Класс кредитоспособности» (строки 45–53), без изменений =====
// Семантика Excel: ошибка деления -> "" ; сравнение "" с числом: текст больше любого числа.
const LT=(a,b)=>a===""?false:a<b, GE=(a,b)=>a===""?true:a>=b;
// Excel сравнивает числа с точностью 15 значащих цифр: 2,3500000000000005 в Excel равно 2,35
const X15=x=>x===""?x:Number(Number(x).toPrecision(15));
function div(a,b){return (b===0||!isFinite(a/b))?"":X15(a/b);}
function calcColumn(v, m, lease){ // v: {row:num} по строкам шаблона; m: ручные строки 35–39
  const g=(r)=>+(v[r]??0), h=(r)=>+(m[r]??0);
  const K1=div(g(20)+h(37), g(29)-(g(28)+g(27)));
  const K2=div(g(20)+g(19)-h(38)+g(18)-h(35), g(29)-(g(28)+g(27)));
  const K3=div(g(21)-h(35)-h(36)-h(38)-h(39), g(29)-g(28)-g(27));
  const K4=div(g(25)+g(27)+g(28), g(30));
  const K5=div(g(11),g(10)), K6=div(g(12),g(10));
  const c1=LT(K1,0.05)?3:LT(K1,0.1)?2:1;
  const c2=LT(K2,0.5)?3:LT(K2,0.8)?2:1;
  const c3=LT(K3,1)?3:LT(K3,1.5)?2:1;
  const c4=lease?(LT(K4,0.15)?3:LT(K4,0.25)?2:1):(LT(K4,0.25)?3:LT(K4,0.4)?2:1);
  const c5=g(10)===0?3:LT(K5,0)?3:LT(K5,0.1)?2:1;
  const c6=g(10)===0?3:LT(K6,0)?3:LT(K6,0.06)?2:1;
  const S=X15(c1*0.05+c2*0.10+c3*0.40+c4*0.20+c5*0.15+c6*0.10);
  const chk1=(GE(K5,0.1)&&S<=1.25)?"Да":"Нет";
  const chk2=(S<=2.35&&GE(K5,0)&&chk1==="Нет")?"Да":"Нет";
  const cls=chk1==="Да"?1:chk2==="Да"?2:3;
  return {K:[K1,K2,K3,K4,K5,K6], cat:[c1,c2,c3,c4,c5,c6], S, chk1, chk2, cls};
}
// Дополнительные условия, вынесенные в правую часть листа (п. 14.1.x)
function sideChecks(V, T12, U12, seasonal, classes){
  const r=(c,row)=>+(V[c]?.[row]??0);
  const k3simple=CLASS_COLS.map(c=>div(r(c,21),r(c,29)));             // R9:U9
  const ltm=div(r("L",12)+r("H",12)-r("E",12), r("L",10)+r("H",10)-r("E",10)); // U10
  const q1=div(r("J",12),r("J",10)), q2=div(r("L",12)-r("J",12), r("L",10)-r("J",10)); // T11,U11
  const res=[];
  res.push({id:"14.1.6", title:"Класс кредитоспособности за четыре последних квартала",
    rule:"Не допускается принадлежность только к 3 классу на всех четырёх датах", value:classes.join(" / "),
    pass: !classes.every(c=>c===3), decisive:true});
  res.push({id:"14.1.7", title:"Собственный капитал на последнюю отчётную дату",
    rule:"Итог раздела III (стр. 1300) больше нуля", value:r("L",25), pass:r("L",25)>0});
  const t12=T12===""||T12===null||T12===undefined?null:+T12, u12=U12===""||U12===null||U12===undefined?null:+U12;
  res.push({id:"14.1.8", title:"Нераспределённая прибыль за два последних квартала",
    rule:"Значения в ячейках T12 и U12 больше нуля", value:(t12===null||u12===null)?"не введено":`${t12} / ${u12}`,
    pass:(t12===null||u12===null)?null:(t12>0&&u12>0)});
  res.push({id:"14.1.10", title:"Коэффициент текущей ликвидности (стр. 1200 / стр. 1500)",
    rule:"Больше 1,0 хотя бы в одном из четырёх кварталов", value:k3simple, pass:k3simple.some(x=>x!==""&&x>1)});
  if(seasonal) res.push({id:"14.1.11 б", title:"Рентабельность деятельности за 12 месяцев (LTM)",
    rule:"Положительная, нарастающим итогом за четыре квартала", value:ltm, pass:ltm!==""&&ltm>0});
  else res.push({id:"14.1.11 а", title:"Рентабельность деятельности по кварталам",
    rule:"Положительная в каждом из двух последних кварталов (без нарастающего итога)", value:[q1,q2], pass:q1!==""&&q2!==""&&q1>0&&q2>0});
  return res;
}

// ===== Заполнение исходного файла «Пробивка»: меняются только ячейки ввода, формулы не трогаются =====
function xmlEsc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
function setCell(xml, ref, val){
  const re=new RegExp(`<c r="${ref}"([^>]*?)(/>|>[\\s\\S]*?</c>)`);
  const m=xml.match(re); if(!m) throw new Error("Нет ячейки "+ref);
  const attrs=m[1].replace(/\s+t="[^"]*"/,"");
  let cell;
  if(val===null||val===undefined||val==="") cell=`<c r="${ref}"${attrs}/>`;
  else if(typeof val==="number") cell=`<c r="${ref}"${attrs}><v>${val}</v></c>`;
  else cell=`<c r="${ref}"${attrs} t="inlineStr"><is><t>${xmlEsc(val)}</t></is></c>`;
  return xml.replace(re,cell);
}
async function fillTemplate(JSZip, templateBytes, data){
  // data: {dates:[iso x5], V:{col:{row:num}}, M:{col:{row:num}}, name, industryText (или "" — оставить D5 пустым), T12, U12}
  const zip=await JSZip.loadAsync(templateBytes);
  const p="xl/worksheets/sheet1.xml"; let x=await zip.file(p).async("string");
  TPL_COLS.forEach((c,i)=>{ x=setCell(x,`${c}9`,excelSerial(data.dates[i])); });
  TPL_COLS.forEach(c=>Object.keys(TPL_ROWS).forEach(r=>{ const v=data.V[c]?.[r]; x=setCell(x,`${c}${r}`, v===null||v===undefined?0:+v); }));
  CLASS_COLS.forEach(c=>Object.keys(MANUAL_ROWS).forEach(r=>{ x=setCell(x,`${c}${r}`, +(data.M[c]?.[r]??0)); }));
  if(data.name) x=setCell(x,"D4",data.name);
  x=setCell(x,"D5",data.industryText||"");
  x=setCell(x,"T12",data.T12===""||data.T12==null?"":+data.T12);
  x=setCell(x,"U12",data.U12===""||data.U12==null?"":+data.U12);
  zip.file(p,x);
  let wb=await zip.file("xl/workbook.xml").async("string");
  wb=wb.replace(/<calcPr[^>]*\/>/,'<calcPr fullCalcOnLoad="1"/>');
  zip.file("xl/workbook.xml",wb);
  return zip.generateAsync({type:"uint8array"});
}
if(typeof module!=="undefined") module.exports={consolidate,calcColumn,sideChecks,fillTemplate,TPL_ROWS,TPL_COLS,CLASS_COLS,MANUAL_ROWS,nextDay,fmtDate,parseDate};
