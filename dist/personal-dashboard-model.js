(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.PersonalDashboardModel=factory();})(typeof window==='object'?window:globalThis,function(){
  'use strict';
  const trim=x=>typeof x==='string'?x.trim():'';
  function relations(project,actor,{demo=false}={}){
    const roles=[];const id=actor?.id;
    if(id&&project._ownerId===id)roles.push('과제 대표자');
    if(id&&project._poId===id)roles.push('PO');
    if(id&&project._pmId===id)roles.push('PM');
    if(id&&(project._memberIds||[]).includes(id))roles.push('참여자');
    if(demo&&trim(actor?.name)){
      if(trim(project.po)===trim(actor.name))roles.push('PO');
      if(trim(project.pm)===trim(actor.name))roles.push('PM');
      if(trim(project.members).split(/[,;\n]+/).map(trim).includes(trim(actor.name)))roles.push('공동 수행자');
    }
    return [...new Set(roles)];
  }
  function build(projects,actor,{Plan,month=Plan.monthNow(),demo=false}={}){
    const mine=projects.map(project=>({project,roles:relations(project,actor,{demo})})).filter(p=>p.roles.length),tasks=[],reviews=[];
    for(const {project:p} of mine){
      if(p.archivedAt||['보류','완료'].includes(p.status))continue;
      if(Plan.validatePlan(p).length){tasks.push({kind:'계획 점검',projectId:p.id,title:p.title,month:'',tab:'plan'});continue;}
      const monthly=Plan.withStepTotals(p).monthly;
      for(const m of Plan.periodMonths(p.startDate,p.endDate).filter(m=>m<=month)){
        const state=p._reporting?.[m]?.status;
        if(['submitted','approved'].includes(state))continue;
        const missing=Plan.percent(monthly?.[m]?.actual)===null;
        const kind=state==='returned'?'보완 요청':missing?(m<month?'지난 월 누락':'이번 달 실적 입력'):!demo?'저장됨 · 제출 필요':null;
        if(kind)tasks.push({kind,projectId:p.id,title:p.title,month:m,tab:kind==='저장됨 · 제출 필요'?'review':'report'});
      }
    }
    const self=person=>person?.id===actor.id||trim(person?.name)&&trim(person.name)===trim(actor.name);
    for(const p of projects){
      const scope=actor.role==='at-head'||actor.role==='team-lead'&&actor.team===p.team;
      if(!scope)continue;
      for(const r of p._changeRequests||[])if(r.status==='pending'&&!self(r.requester)&&(actor.role==='at-head'||r.requiredRole==='team-lead'))reviews.push({kind:'계획 변경 승인',projectId:p.id,title:p.title,month:'',tab:'changes',requestId:r.id});
      for(const [m,r] of Object.entries(p._reporting||{}))if(r.status==='submitted'&&!self(r.submittedBy))reviews.push({kind:'실적 검토',projectId:p.id,title:p.title,month:m,tab:'review'});
    }
    const priority={'보완 요청':0,'지난 월 누락':1,'이번 달 실적 입력':2,'저장됨 · 제출 필요':3,'계획 점검':4};
    tasks.sort((a,b)=>priority[a.kind]-priority[b.kind]||a.month.localeCompare(b.month)||a.title.localeCompare(b.title));
    return {mine,tasks,reviews,counts:{participating:mine.length,missing:tasks.filter(t=>t.kind==='지난 월 누락').length,actions:tasks.length,review:reviews.length},month};
  }
  return Object.freeze({relations,build});
});
