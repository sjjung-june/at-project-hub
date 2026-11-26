const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {JSDOM,VirtualConsole}=require('jsdom');
const html=fs.readFileSync('dist/index.html','utf8').replace(/<script src="([^"]+)"><\/script>/g,(_,url)=>'<script>'+fs.readFileSync(path.resolve('dist',url.split('?')[0]),'utf8').replace(/<\/script/gi,'<\\/script')+'</script>');
const p={id:'monthly-old',title:'기존 계획 월별 점검',team:'AT팀',tech:['All Tech'],status:'진행',po:'대표',pm:'PM',members:'',type:'팀 과제',special:[],planMode:'cumulative-percent-v1',startDate:'2025-01-01',endDate:'2025-02-28',monthly:{'2025-01':{goal:50},'2025-02':{goal:100}}};
test('P25 legacy single-plan monthly flow restores drafts, preserves annual edits, and opens exact messenger month',async()=>{
  const errors=[];const console=new VirtualConsole();console.on('jsdomError',e=>errors.push(e));
  const dom=new JSDOM(html,{url:'http://localhost/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:console,beforeParse(w){w.scrollTo=()=>{};w.localStorage.setItem('at-project-demo-v1',JSON.stringify([p]));w.HTMLElement.prototype.scrollIntoView=()=>{};}});
  await new Promise(resolve=>dom.window.addEventListener('load',resolve,{once:true}));
  const {within,waitFor}=require('@testing-library/dom');const userEvent=require('@testing-library/user-event').default;const body=within(dom.window.document.body);const user=userEvent.setup({document:dom.window.document});
  try{
    await user.click(body.getByRole('button',{name:'실적 입력',exact:true}));await user.selectOptions(body.getByLabelText('과제',{exact:true}),'monthly-old');
    assert.equal(body.getByLabelText('입력할 보고 월').value,'2025-01');
    await user.type(body.getByLabelText('전체 과제 2025-01 실적 (%)'),'40');await user.type(body.getByLabelText('전체 과제 2025-01 지연 사유'),'입력 점검');await user.type(body.getByLabelText('전체 과제 2025-01 Catch Up Plan'),'추가 검증');
    await user.click(body.getByRole('button',{name:'연간 표 펼치기'}));assert.equal(body.getByLabelText('전체 과제 2025-01 실적 (%)').value,'40');
    await user.click(body.getByRole('button',{name:'한 달씩 입력'}));assert.equal(body.getByLabelText('전체 과제 2025-01 지연 사유').value,'입력 점검');
    // Reopening mimics a recovered page: working copy is restored without changing stored records.
    await user.click(body.getByRole('button',{name:'전체 과제 보기'}));await user.click(body.getByRole('button',{name:'실적 입력',exact:true}));await user.selectOptions(body.getByLabelText('과제',{exact:true}),'monthly-old');
    assert.equal(body.getByLabelText('전체 과제 2025-01 실적 (%)').value,'40');assert.equal(body.getByLabelText('전체 과제 2025-01 Catch Up Plan').value,'추가 검증');
    assert.equal(JSON.parse(dom.window.localStorage.getItem('at-project-demo-v1')).find(p=>p.id==='monthly-old').monthly['2025-01'].actual,undefined);
    dom.window.location.hash='#report=monthly-old&month=2025-02';
    await waitFor(()=>assert.equal(body.getByLabelText('입력할 보고 월').value,'2025-02'),{container:dom.window.document.body});
    assert.ok(body.getByLabelText('전체 과제 2025-02 실적 (%)'));
    assert.deepEqual(errors,[]);
  }finally{dom.window.close();}
});

test('P26 project detail exposes each Step monthly plan and the automatic sum across years',async()=>{
  const exact=require('../dist/demo-scenarios.js').buildExamples('2026-11').find(p=>p.id.endsWith('step-30-70'));
  const errors=[];const console=new VirtualConsole();console.on('jsdomError',e=>errors.push(e));
  const dom=new JSDOM(html,{url:'http://localhost/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:console,beforeParse(w){w.scrollTo=()=>{};w.localStorage.setItem('at-project-demo-v1',JSON.stringify([exact]));w.HTMLElement.prototype.scrollIntoView=()=>{};}});
  await new Promise(resolve=>dom.window.addEventListener('load',resolve,{once:true}));
  const {within}=require('@testing-library/dom'),user=require('@testing-library/user-event').default.setup({document:dom.window.document}),body=within(dom.window.document.body);
  try{
    await user.click(body.getByRole('button',{name:'담당 전체 과제 보기',exact:true}));await user.click(body.getByText(exact.title,{exact:true}));
    const region=within(body.getByRole('region',{name:'2026년 Step별 월간 계획'}));
    const values=name=>within(region.getByRole('row',{name})).getAllByRole('cell').map(c=>c.textContent);
    assert.deepEqual(values(/Step 1/).slice(9),['0%','10%','20%']);assert.deepEqual(values(/Step 2/).slice(9),['0%','20%','70%']);
    assert.deepEqual(values(/전체 목표/).slice(9),['0%','30%','90%']);
    await user.selectOptions(body.getByLabelText('계획 조회 연도'),'2027');
    const next=within(body.getByRole('region',{name:'2027년 Step별 월간 계획'}));
    assert.equal(within(next.getByRole('row',{name:/전체 목표/})).getAllByRole('cell')[0].textContent,'100%');
    assert.deepEqual(errors,[]);
  }finally{dom.window.close();}
});

test('P30 demo starts at personal home; collaborators see their roles and general members reach the full list',async()=>{
  const dom=new JSDOM(html,{url:'http://localhost/',runScripts:'dangerously',pretendToBeVisual:true,beforeParse(w){w.scrollTo=()=>{};w.localStorage.setItem('at-project-demo-v1',JSON.stringify([p]));w.HTMLElement.prototype.scrollIntoView=()=>{};}});
  await new Promise(resolve=>dom.window.addEventListener('load',resolve,{once:true}));
  const {within}=require('@testing-library/dom'),user=require('@testing-library/user-event').default.setup({document:dom.window.document}),body=within(dom.window.document.body);
  try{
    assert.ok(body.getByRole('heading',{name:'내 대시보드',exact:true}));
    await user.selectOptions(body.getByLabelText('체험할 사용자'),'demo:collaborator');
    assert.equal(body.getAllByText(/내 역할: 공동 수행자/).length,9);
    await user.selectOptions(body.getByLabelText('체험할 사용자'),'demo:member');
    assert.ok(body.getByText('연결된 담당·참여 과제가 없습니다. 담당 전체 과제는 계속 조회할 수 있습니다.'));
    await user.click(body.getByRole('button',{name:'담당 전체 과제 보기',exact:true}));
    assert.ok(body.getByRole('heading',{name:'전체 과제 현황'}));assert.ok(body.getByText(p.title,{exact:true}));
  }finally{dom.window.close();}
});

test('P33 knowledge demo persists edits, shows reverse relationships and keeps general members read-only',async()=>{
 const dom=new JSDOM(html,{url:'http://localhost/',runScripts:'dangerously',pretendToBeVisual:true,beforeParse(w){w.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};}});await new Promise(resolve=>dom.window.addEventListener('load',resolve,{once:true}));const {within}=require('@testing-library/dom'),user=require('@testing-library/user-event').default.setup({document:dom.window.document}),body=within(dom.window.document.body);
 try{await user.selectOptions(body.getByLabelText('체험할 사용자'),'demo:po');await user.click(body.getByRole('button',{name:'지식자산',exact:true}));await user.click(body.getAllByRole('button',{name:'경험·연결맵 보기'})[0]);assert.ok(body.getByRole('button',{name:/후속 과제 · 역방향 참조/}));await user.click(body.getByRole('button',{name:'경험 카드 작성·수정'}));await user.clear(body.getByLabelText('시행착오와 배운 점'));await user.type(body.getByLabelText('시행착오와 배운 점'),'사용자가 남긴 재사용 경험');await user.click(body.getByRole('button',{name:'확인 후 공유'}));await body.findByText('경험 카드를 공유했습니다.');const stored=JSON.parse(dom.window.localStorage.getItem('at-project-demo-v1')),first=stored.find(p=>p._knowledge?.lessons==='사용자가 남긴 재사용 경험');assert.ok(first);assert.ok(first._audit.some(e=>e.action==='경험 카드·과제 관계 저장'&&e.before&&e.after));await user.click(body.getByRole('button',{name:/후속 과제 · 역방향 참조/}));assert.equal(body.queryByText('사용자가 남긴 재사용 경험'),null);await user.click(body.getByRole('button',{name:/선행 과제/}));assert.ok(body.getAllByText('사용자가 남긴 재사용 경험').length);await user.click(body.getByRole('button',{name:'경험 카드 작성·수정'}));await user.click(body.getByRole('button',{name:'확인 후 공유'}));await body.findByText('경험 카드를 공유했습니다.');await user.click(body.getByRole('button',{name:'내 대시보드',exact:true}));await user.selectOptions(body.getByLabelText('체험할 사용자'),'demo:member');await user.click(body.getByRole('button',{name:'지식자산',exact:true}));await user.click(body.getAllByRole('button',{name:'경험·연결맵 보기'})[0]);assert.equal(body.getByRole('button',{name:'경험 카드 작성·수정'}).disabled,true);
 }finally{dom.window.close();}
});

test('P35 automatic evidence, candidate review and source-derived draft work without manual graph input',async()=>{
 const dom=new JSDOM(html,{url:'http://localhost/',runScripts:'dangerously',pretendToBeVisual:true,beforeParse(w){w.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};}});await new Promise(resolve=>dom.window.addEventListener('load',resolve,{once:true}));const {within}=require('@testing-library/dom'),user=require('@testing-library/user-event').default.setup({document:dom.window.document}),body=within(dom.window.document.body);
 try{await user.selectOptions(body.getByLabelText('체험할 사용자'),'demo:po');await user.click(body.getByRole('button',{name:'지식자산',exact:true}));await user.click(body.getAllByRole('button',{name:'경험·연결맵 보기'})[0]);assert.ok(body.getByRole('heading',{name:'업무 기록에서 지식 연결'}));await user.click(body.getByRole('button',{name:'참고 사례·확인',exact:true}));assert.ok(body.getAllByText('미확인 후보').length);await user.click(body.getAllByRole('button',{name:'결과 활용 확인'})[0]);await body.findByText('근거를 확인한 관계를 저장했습니다.');const stored=JSON.parse(dom.window.localStorage.getItem('at-project-demo-v1'));assert.ok(stored.some(p=>Object.values(p._knowledgeDecisions||{}).some(d=>d.type==='reuses'&&d.evidence.length&&d.contextEvidence.length)));await user.click(body.getByRole('button',{name:'경험 초안',exact:true}));await user.click(body.getByRole('button',{name:'빈 경험 항목에 초안 적용'}));assert.ok(body.getByText('이미 작성한 항목은 유지했습니다.'));assert.equal(body.getByLabelText('해결하려던 문제').value,'[체험] 공정 데이터 형식 차이로 분석과 재검증이 반복되었습니다.');
 }finally{dom.window.close();}
});
