// Demo identity selection changes this view only; it never authenticates or grants permissions.
(function(){
  const previousPage=showPage;
  const page=document.createElement('main');page.id='personalPage';page.className='main';page.hidden=true;page.innerHTML='<div class="top"><div><div class="eyebrow">MY WORKSPACE</div><h1>내 대시보드</h1><p>내가 참여하는 과제와 처리할 일을 한 곳에서 확인하세요.</p></div><button type="button" class="secondary" id="homeReports">실적 입력</button></div><div class="banner"><strong>체험 사용자 · 사내 SSO 연동 전</strong><p>아래 선택은 예시 데이터의 개인 화면을 체험하기 위한 것입니다. 실제 계정과 수정 권한은 바뀌지 않습니다.</p><label for="homePersona">체험할 사용자</label><select id="homePersona"></select></div><div id="personalHomeRoot"></div>';
  document.querySelector('#listPage').before(page);
  const nav=document.createElement('div');nav.id='personalNav';nav.className='dashnav';nav.setAttribute('role','button');nav.tabIndex=0;nav.textContent='내 대시보드';nav.onclick=()=>showPage('home');nav.onkeydown=e=>{if(e.key==='Enter')showPage('home');};document.querySelector('aside .nav').before(nav);
  const personas=[{id:'demo:pm3',name:'예시 PM 3',role:'participant',team:'예시운영팀',label:'예시 PM 3 · PM / 지난 월 누락'},{id:'demo:collaborator',name:'예시 공동 수행자',role:'participant',team:'예시공정팀',label:'예시 공동 수행자 · 참여 과제 조회'},{id:'demo:po',name:'예시 대표자',role:'project-representative',team:'예시공정팀',label:'예시 대표자 · PO'},{id:'demo:member',name:'예시 일반 구성원',role:'member',team:'예시공정팀',label:'예시 일반 구성원 · 담당 전체 조회'},{id:'demo:lead',name:'예시 팀장',role:'team-lead',team:'예시공정팀',label:'예시 팀장 · 팀 검토'},{id:'demo:head',name:'예시 담당',role:'at-head',team:'AT',label:'예시 담당 · 담당 전체 검토'}];
  let actor=personas[0];const select=document.querySelector('#homePersona');for(const p of personas){const option=document.createElement('option');option.value=p.id;option.textContent=p.label;select.append(option);}
  function renderHome(){StepUI.home(document.querySelector('#personalHomeRoot'),{projects:data,actor,demo:true,onAll:()=>showPage('list'),onRegister:()=>{openForm();registrationReturn='home';},onOpen:(id,task)=>{if(task.tab==='changes'){showPage('approvals');return;}if(task.tab==='plan'){detail(id);return;}openPerformance(id);if(task.month)StepUI.selectReportMonth(task.month);}});}
  const profile=document.createElement('div');profile.id='profileRoot';page.before(profile);
  function renderProfile(){StepUI.profile(profile,{actor,demo:true,onHome:()=>showPage('home'),onMine:()=>{showPage('home');const heading=document.querySelector('[data-personal-projects] h2');heading?.scrollIntoView?.({block:'start'});heading?.focus({preventScroll:true});},onAll:()=>showPage('list'),onSwitch:()=>{showPage('home');select.focus();}});}
  renderProfile();
  select.onchange=()=>{actor=personas.find(p=>p.id===select.value)||personas[0];renderHome();renderProfile();};document.querySelector('#homeReports').onclick=()=>showPage('performance');
  showPage=function(name){page.hidden=name!=='home';nav.classList.toggle('selected',name==='home');previousPage(name);if(name==='home')renderHome();};
  const oldRender=render;render=function(){oldRender();if(!page.hidden)renderHome();};
  // A reporting deep link retains its exact task/month instead of being redirected home.
  if(!location.hash.startsWith('#report='))showPage('home');
})();
