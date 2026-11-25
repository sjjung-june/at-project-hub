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
    await user.click(body.getByText(exact.title,{exact:true}));
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
