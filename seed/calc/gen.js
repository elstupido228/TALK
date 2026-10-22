const fs=require('fs'),JSZip=require('/home/claude/app/node_modules/jszip');const C=require('/home/claude/app/core.js');
const tpl=fs.readFileSync('/home/claude/app/template_clean.xlsx');
let seed=7;const rnd=()=>{seed=(seed*16807)%2147483647;return seed/2147483647;};
const R=(a,b)=>Math.round(a+(b-a)*rnd());
function randCol(){ // правдоподобный баланс и ОПиУ
  const cur=R(1000,500000), ar=R(0,cur), stfi=rnd()<.3?R(0,cur/5):0, cash=R(0,cur/3);
  const sec5=R(100,600000), dbp=rnd()<.2?R(0,sec5/10):0, r1550=rnd()<.5?R(0,sec5/5):0;
  const total=cur+R(0,800000); const eq=R(-100000,total);
  const rev=rnd()<.05?0:R(1000,3000000); const sp=R(-rev*0.2,rev*0.4); const np=R(-rev*0.2,rev*0.3);
  return {10:rev,11:sp,12:np,18:ar,19:stfi,20:cash,21:cur,25:eq,27:dbp,28:r1550,29:sec5,30:total};
}
function man(){return rnd()<.3?{35:R(0,5000),36:R(0,5000),37:R(0,5000),38:R(0,3000),39:R(0,5000)}:{};}
// граничные случаи: точные пороги и деление на ноль
const B=[];
const base={10:1000000,11:150000,12:80000,18:300000,19:0,20:100000,21:1000000,25:500000,27:0,28:0,29:1000000,30:1000000};
const edge=[{20:50000},{20:100000},{18:700000,20:100000},{18:400000,20:100000},{21:1500000},{21:1000000},{21:999999},
 {25:400000},{25:250000},{25:150000},{25:249999},{11:100000},{11:0},{11:-1},{12:60000},{12:0},{12:-1},{10:0},
 {29:0},{30:0},{29:500000,28:500000},{27:1000000},{11:99999},{25:-10}];
edge.forEach(e=>B.push(Object.assign({},base,e)));
// комбинации для S = 1,25 и 2,35 ровно
B.push(Object.assign({},base,{20:40000,18:360000,21:1200000,25:300000})); // подбор
const cases=[];for(let i=0;i<96;i++)cases.push({V:randCol(),M:man()});B.forEach(v=>cases.push({V:v,M:{}}));
while(cases.length%4) cases.push({V:randCol(),M:{}});
const files=[];
(async()=>{for(let f=0;f*4<cases.length;f++){const lease=f%2===0;
  const V={E:{}},M={};const cols=["F","H","J","L"];cols.forEach((c,i)=>{V[c]=cases[f*4+i].V;M[c]=cases[f*4+i].M;});
  Object.keys(C.TPL_ROWS).forEach(r=>V.E[r]=0);
  const b=await C.fillTemplate(JSZip,tpl,{dates:["2025-07-01","2025-10-01","2026-01-01","2026-04-01","2026-07-01"],V,M,name:"T"+f,industryText:lease?"":"Прочие отрасли",T12:1,U12:1});
  fs.writeFileSync(`in/case${String(f).padStart(3,"0")}.xlsx`,b);
  files.push({file:`case${String(f).padStart(3,"0")}.xlsx`,lease,js:cols.map(c=>C.calcColumn(V[c],M[c],lease)),inputs:cols.map(c=>({V:V[c],M:M[c]}))});}
 fs.writeFileSync('js.json',JSON.stringify(files));console.log(files.length,'files',cases.length,'cases');})();
