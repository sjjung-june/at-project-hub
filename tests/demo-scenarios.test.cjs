const test=require('node:test');const assert=require('node:assert/strict');const P=require('../dist/plan-model.js');const D=require('../dist/demo-scenarios.js');
test('eight planned demo variants have valid cumulative plans, weights and reports across calendar boundaries',()=>{
 for(const asOf of ['2026-11','2027-01','2028-02','2028-12']){
  const examples=D.buildExamples(asOf);assert.equal(examples.length,8);
  for(const p of examples){assert.deepEqual(P.validatePlan(p),[],p.title);assert.deepEqual(P.validateStepReports(p,p.stepReports,asOf),[],p.title);assert.equal(p.steps.reduce((a,s)=>a+s.weight,0),100);assert.equal(p.monthly[p.endMonth].goal,100);for(const rows of Object.values(p.stepReports))assert.ok(Object.keys(rows).every(m=>m<=asOf));}
 }
});
test('missing prior month stays unknown while current month meets goal; zero and delay are distinct',()=>{
 const examples=D.buildExamples('2026-11'),get=code=>examples.find(p=>p.id.endsWith(code));
 assert.equal(get('missed').monthly['2026-10'].actual,undefined);assert.equal(get('missed').monthly['2026-11'].actual,get('missed').monthly['2026-11'].goal);
 assert.equal(get('zero').monthly['2026-11'].actual,0);assert.ok(get('delay').monthly['2026-11'].actual<get('delay').monthly['2026-11'].goal);
 assert.equal(get('short').monthly['2026-05'].actual,100);assert.ok(P.years(get('multiyear').startDate,get('multiyear').endDate).length>=3);
});
test('reloading or adding examples never overwrites edits, duplicates IDs or modifies existing data',()=>{
 const existing=[{id:'user',title:'실제 사용자 작성',monthly:{'2026-11':{goal:30,actual:12}}}],before=JSON.stringify(existing),examples=D.buildExamples('2026-11');
 const first=D.mergeExamples(existing,examples);assert.equal(first.added,8);assert.equal(JSON.stringify(existing),before);
 first.projects[0].title='사용자가 수정한 체험 과제';first.projects[0].steps[0].name='수정한 Step';
 const next=D.mergeExamples(first.projects,D.buildExamples('2026-12'));assert.equal(next.added,0);assert.equal(next.projects[0].title,'사용자가 수정한 체험 과제');assert.equal(next.projects[0].steps[0].name,'수정한 Step');assert.deepEqual(next.projects.find(p=>p.id==='user'),existing[0]);
});
