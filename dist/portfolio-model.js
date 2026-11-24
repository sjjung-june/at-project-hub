(function(root,factory){const model=factory(typeof module==='object'&&module.exports?require('./plan-model.js'):root.PlanModel);if(typeof module==='object'&&module.exports)module.exports=model;else root.PortfolioModel=model;})(typeof globalThis==='object'?globalThis:this,function(P){
'use strict';
function classify(project,month){
 const base={label:'',note:'',late:false,missing:false,goal:null,actual:null,gap:null};
 if(project.archivedAt)return{...base,label:'보관'};
 if(project.status==='보류')return{...base,label:'보류',note:'보류 과제는 해당 월 진행 판정에서 제외합니다.'};
 if(project.planMode!=='cumulative-percent-v1'||P.validatePlan(project).length)return{...base,label:'계획 재확인',note:'과제 기간과 목표를 확인해 주세요.'};
 const active=P.periodMonths(project.startDate,project.endDate);
 if(month<active[0])return{...base,label:'시작 전',note:'기준 월 이후 시작하는 과제입니다.'};
 if(month>active.at(-1))return{...base,label:'기간 종료',note:'기준 월 보고 대상에 포함되지 않습니다.'};
 const row=(P.isWeighted(project)?P.withStepTotals(project):project).monthly?.[month]||{},goal=P.percent(row.goal),actual=P.percent(row.actual);
 if(actual===null)return{...base,goal,label:'실적 미입력',missing:true,note:`${month} 실적 미입력 · 이전 월 실적을 대신 사용하지 않습니다.`};
 const gap=Math.round((goal-actual)*1000000)/1000000,late=gap>0;
 return{...base,goal,actual,gap,late,label:late?'지연':'정상',note:`${month} 누적 목표 ${goal}% / 실적 ${actual}%${late?` · 부족 ${gap}%p`:''}`};
}
function build(projects,month=P.monthNow()){
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||month>P.monthNow())throw new Error('기준 월을 확인해 주세요.');
 const classified=projects.filter(p=>!p.archivedAt).map(x=>({x,p:classify(x,month)}));
 const eligible=classified.filter(v=>['정상','지연','실적 미입력'].includes(v.p.label));
 return{month,classified,eligible:eligible.length,reported:eligible.filter(v=>!v.p.missing).length,missing:eligible.filter(v=>v.p.missing).length,late:eligible.filter(v=>v.p.late).length};
}
return Object.freeze({classify,build});
});
