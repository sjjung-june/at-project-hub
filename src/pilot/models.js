export const clone=x=>JSON.parse(JSON.stringify(x));
export const locked=(project,month)=>['submitted','approved'].includes(project._reporting?.[month]?.status);
export const statusLabel={draft:'작성 중',submitted:'제출·검토 대기',approved:'확정',returned:'보완 요청'};
export function contributionReportPatch(project,rows,Plan){
  if(!Plan.isWeighted(project)){
    const monthly={};
    for(const [month,row] of Object.entries(rows._overall||{})){
      if(locked(project,month))continue;
      const previous=project.monthly?.[month]||{};
      const value=Object.hasOwn(row,'actual')?row.actual:previous.actual;
      if(value!==''&&value!=null&&Plan.percent(value)===null)throw new Error('누적 실적은 0~100%여야 합니다.');
      monthly[month]={actual:value===''||value==null?null:Number(value),reason:row.reason??previous.reason??'',catchup:row.catchup??previous.catchup??''};
    }
    return {monthly};
  }
  const patch={};
  for(const [stepId,months] of Object.entries(rows)){
    const step=project.steps.find(s=>s.id===stepId);if(!step)throw new Error('등록되지 않은 Step입니다.');
    for(const [month,row] of Object.entries(months)){
      if(locked(project,month))continue;
      if(!Plan.periodMonths(project.startDate,project.endDate).includes(month)||month<step.startDate.slice(0,7))throw new Error('Step 보고 기간을 확인해 주세요.');
      const value=Object.hasOwn(row,'actual')?row.actual:Plan.contribution(Plan.stepActual(step,month,project.stepReports||{}),step.weight);
      const actual=value===''||value==null?null:Plan.normalizedContribution(value,step.weight);
      if(actual!==null&&Plan.percent(actual)===null)throw new Error(`${step.name} 실적은 0~${step.weight}%여야 합니다.`);
      patch[stepId]??={};patch[stepId][month]={actual,reason:row.reason??project.stepReports?.[stepId]?.[month]?.reason??'',catchup:row.catchup??project.stepReports?.[stepId]?.[month]?.catchup??''};
    }
  }
  return {stepReports:patch};
}
export function projectFormErrors(project,Plan){
  const errors=[];
  if(!project.title.trim())errors.push('과제 제목을 입력해 주세요.');
  if(!project.team.trim())errors.push('소속 팀을 입력해 주세요.');
  if(!project.tech.length)errors.push('대상 Tech를 선택해 주세요.');
  return errors.concat(Plan.validatePlan(project).map(e=>e.message));
}

export const canEdit=(project,actor)=>['at-head','system-admin'].includes(actor.role)||actor.role==='team-lead'&&actor.team===project.team||project._ownerId===actor.id||(project._memberIds||[]).includes(actor.id);
