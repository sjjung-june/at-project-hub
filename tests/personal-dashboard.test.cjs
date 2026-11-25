const test=require('node:test'),assert=require('node:assert/strict');const P=require('../dist/plan-model.js'),H=require('../dist/personal-dashboard-model.js'),D=require('../dist/demo-scenarios.js');
const member={id:'member-1',name:'홍길동',role:'member',team:'AT팀'};
test('personal membership uses stable IDs; names cannot impersonate PO or partial collaborator',()=>{
 const p={id:'p',po:'홍길동',pm:'다른 이름',members:'홍길동2, 김담당',_memberIds:['member-1']};
 assert.deepEqual(H.relations(p,member),['참여자']);assert.deepEqual(H.relations({...p,_memberIds:[]},member),[]);
 assert.deepEqual(H.relations(p,{...member,id:'other',name:'홍길동'},{demo:true}),['PO']);
 assert.deepEqual(H.relations(p,{...member,id:'other',name:'홍길'},{demo:true}),[]);
});
test('collaborators see their participation, while missed prior months survive a current on-target result',()=>{
 const p=D.buildExamples('2026-11').find(p=>p.id.endsWith('missed'));p._memberIds=[member.id];
 const home=H.build([p],member,{Plan:P,month:'2026-11'});assert.equal(home.mine.length,1);assert.deepEqual(home.mine[0].roles,['참여자']);
 assert.ok(home.tasks.some(t=>t.kind==='지난 월 누락'&&t.month==='2026-10'));
 assert.ok(home.tasks.some(t=>t.kind==='저장됨 · 제출 필요'&&t.month==='2026-11'));
 assert.equal(H.build([p],{...member,id:'outsider'},{Plan:P,month:'2026-11'}).mine.length,0);
});
test('review queues apply team scope and separate 담당 authority from system admin; self-review excluded',()=>{
 const p=D.buildExamples('2026-11')[0];p._changeRequests=[{id:'r',status:'pending',requiredRole:'at-head',requester:{id:'owner',name:'대표'}}];p._reporting={'2026-11':{status:'submitted',submittedBy:{id:'owner',name:'대표'}}};
 assert.equal(H.build([p],{id:'lead',name:'팀장',role:'team-lead',team:p.team},{Plan:P,month:'2026-11'}).reviews.length,1);
 assert.equal(H.build([p],{id:'head',name:'담당',role:'at-head',team:'AT'},{Plan:P,month:'2026-11'}).reviews.length,2);
 assert.equal(H.build([p],{id:'admin',name:'관리자',role:'system-admin',team:p.team},{Plan:P,month:'2026-11'}).reviews.length,0);
 assert.equal(H.build([p],{id:'owner',name:'대표',role:'at-head',team:'AT'},{Plan:P,month:'2026-11'}).reviews.length,0);
});
