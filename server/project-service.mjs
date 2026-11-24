import {randomUUID} from 'node:crypto';
import Plan from '../dist/plan-model.js';
import Approval from '../dist/approval-model.js';
import Requests from '../dist/report-requests-model.js';
import {transaction} from './db.mjs';
export class ApiError extends Error{constructor(status,message){super(message);this.status=status;}}
const fail=message=>{throw new ApiError(422,message);};
const ensurePlan=project=>{if(!project?.title?.trim()||!project?.team?.trim()||!project?.tech?.length)fail('제목·팀·Tech를 입력해 주세요.');if(project.planMode!=='cumulative-percent-v1')fail('누적 진척률 계획이 필요합니다.');const errors=Plan.validatePlan(project);if(errors.length)fail(errors[0].message);};
function requireActor(actor){if(!actor?.id||!actor?.name||!actor?.role)throw new ApiError(401,'로그인이 필요합니다.');}
function canEdit(project,actor){return actor.role==='at-head'||actor.role==='system-admin'||(actor.role==='team-lead'&&actor.team===project.team)||(project._memberIds||[]).includes(actor.id)||project._ownerId===actor.id;}
function assertEdit(project,actor){if(!canEdit(project,actor))throw new ApiError(403,'이 과제를 수정할 권한이 없습니다.');}
function stripClientOwned(project){const result=structuredClone(project);for(const key of Object.keys(result))if(key.startsWith('_'))delete result[key];for(const key of ['stepReports','monthlyArchive','legacyPlan','legacyAggregateReports','createdAt','updatedAt'])delete result[key];result.monthly=Object.fromEntries(Object.entries(result.monthly||{}).map(([m,row])=>[m,{goal:row.goal}]));return result;}
export function createProjectService(pool){
  async function save(client,project,before,actor,action,details={}){
    const revision=(before?._revision||0)+1;
    const next={...project,_revision:revision,updatedAt:new Date().toISOString()};
    if(!before)next.createdAt=next.updatedAt;
    if(before)await client.query('UPDATE projects SET title=$2,team=$3,revision=$4,document=$5,updated_at=now() WHERE id=$1',[next.id,next.title,next.team,revision,next]);
    else await client.query('INSERT INTO projects(id,title,team,revision,document) VALUES($1,$2,$3,$4,$5)',[next.id,next.title,next.team,revision,next]);
    for(const request of next._changeRequests||[])await client.query('INSERT INTO change_requests(id,project_id,status,document) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,document=EXCLUDED.document',[request.id,next.id,request.status,request]);
    await client.query('INSERT INTO audit_events(id,project_id,action,actor,before_document,after_document,details) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),next.id,action,actor,before||null,next,details]);
    return next;
  }
  async function mutate(id,revision,actor,action,change){requireActor(actor);return transaction(pool,async client=>{
    const row=(await client.query('SELECT document,revision FROM projects WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!row)throw new ApiError(404,'과제를 찾을 수 없습니다.');
    if(!Number.isInteger(revision)||revision!==row.revision)throw new ApiError(409,'다른 사용자가 변경했습니다. 최신 과제를 다시 불러와 주세요.');
    const next=await change(structuredClone(row.document));
    return save(client,next,row.document,actor,action);
  });}
  return {
    async list(actor){requireActor(actor);return (await pool.query('SELECT document FROM projects ORDER BY updated_at DESC LIMIT 500')).rows.map(row=>row.document);},
    async get(id,actor){requireActor(actor);const row=(await pool.query('SELECT document FROM projects WHERE id=$1',[id])).rows[0];if(!row)throw new ApiError(404,'과제를 찾을 수 없습니다.');return row.document;},
    async create(input,actor){requireActor(actor);const clean=stripClientOwned(input);const id=randomUUID();const active=Plan.periodMonths(clean.startDate,clean.endDate);const project=Plan.withStepTotals({...clean,id,startMonth:active[0],endMonth:active.at(-1),status:'계획',unit:'%',_ownerId:actor.id,_memberIds:[],stepReports:{}});ensurePlan(project);project._baseline=Approval.snapshot(project);return transaction(pool,client=>save(client,project,null,actor,'project_created'));},
    reports(id,revision,body,actor){return mutate(id,revision,actor,'reports_saved',project=>{assertEdit(project,actor);if(project.archivedAt)fail('보관 과제는 실적을 수정할 수 없습니다.');let next;if(Plan.isWeighted(project)){
      const reports=structuredClone(project.stepReports||{});
      if(!body.stepReports||typeof body.stepReports!=='object'||Array.isArray(body.stepReports))fail('Step 실적이 필요합니다.');
      for(const [stepId,rows] of Object.entries(body.stepReports)){
        const step=project.steps.find(s=>s.id===stepId);if(!step)fail('등록되지 않은 Step입니다.');
        if(!rows||typeof rows!=='object'||Array.isArray(rows))fail('월별 실적이 올바르지 않습니다.');
        for(const [month,row] of Object.entries(rows)){
          if(!Plan.periodMonths(project.startDate,project.endDate).includes(month)||month<step.startDate.slice(0,7))fail('Step 보고 기간을 확인해 주세요.');
          if(!row||typeof row!=='object'||Array.isArray(row))fail('실적 값이 올바르지 않습니다.');
          reports[stepId]??={};reports[stepId][month]={...reports[stepId][month],...Object.fromEntries(Object.entries(row).filter(([k])=>['actual','reason','catchup'].includes(k)))};
        }
      }
      const errors=Plan.validateStepReports(project,reports);if(errors.length)fail(errors[0].message);next=Plan.withStepTotals(project,reports);
    }else{
      const monthly=structuredClone(project.monthly);for(const [month,row] of Object.entries(body.monthly||{})){if(!monthly[month])fail('과제 보고 기간을 확인해 주세요.');monthly[month]={...monthly[month],...Object.fromEntries(Object.entries(row).filter(([k])=>['actual','reason','catchup'].includes(k)))};}
      const errors=Plan.validateReports(project,monthly);if(errors.length)fail(errors[0].message);next={...project,monthly};
    }return Requests.sync([next]).projects[0];});},
    request(id,revision,candidate,reason,actor){return mutate(id,revision,actor,'change_requested',project=>{assertEdit(project,actor);return Approval.createRequest(project,{...project,...stripClientOwned(candidate),id:project.id},{actor,reason});});},
    decide(id,revision,requestId,decision,comment,actor){return mutate(id,revision,actor,`change_${decision}`,project=>Requests.sync([Approval.decide(project,requestId,{actor,decision,comment})]).projects[0]);},
    async history(id,actor){await this.get(id,actor);return (await pool.query('SELECT id,action,actor,details,created_at FROM audit_events WHERE project_id=$1 ORDER BY created_at DESC,id',[id])).rows;}
  };
}
