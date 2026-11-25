// Browser-local examples only. Never seeds the shared FastAPI database.
(function(){
  const page=document.querySelector('#listPage');if(!page)return;
  const section=document.createElement('section');section.className='banner';section.setAttribute('aria-label','계획이 준비된 체험 과제');
  section.innerHTML='<div><strong>월별 계획이 채워진 체험 과제 9종</strong><p>Step 비중 30/70 예시·정상·누적 지연·지난달 누락·다개년·단기 완료·연도 이월·비균등 목표·0% 실적을 비교해 보세요. 기존 작성 내용은 덮어쓰지 않습니다.</p></div><div class="actions"><button class="secondary" type="button" id="showPlannedExamples">체험 과제만 보기</button><button class="secondary" type="button" id="addPlannedExamples">빠진 체험 과제 추가</button></div>';
  page.querySelector('.banner').after(section);
  function add(silent){const result=DemoScenarios.mergeExamples(data,DemoScenarios.buildExamples());if(result.added){if(!persistRecords(result.projects))return;render();}if(!silent)toast(result.added?`계획이 포함된 체험 과제 ${result.added}개를 추가했습니다.`:'체험 과제가 이미 있습니다. 수정한 내용은 유지했습니다.');}
  document.querySelector('#showPlannedExamples').onclick=()=>{document.querySelector('#search').value='[체험]';for(const id of ['techFilter','classFilter','statusFilter'])document.querySelector('#'+id).value='';render();};
  document.querySelector('#addPlannedExamples').onclick=()=>add(false);
  add(true);
})();
