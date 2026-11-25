(function(root,factory){const model=factory(typeof module==='object'&&module.exports?require('./plan-model.js'):root.PlanModel);if(typeof module==='object'&&module.exports)module.exports=model;else root.DemoScenarios=model;})(typeof window==='object'?window:globalThis,function(P){
  'use strict';
  const clone=x=>JSON.parse(JSON.stringify(x));
  const shift=(month,n)=>{const [y,m]=month.split('-').map(Number),i=y*12+m-1+n;return `${Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}`;};
  const last=month=>{const [y,m]=month.split('-').map(Number);return `${month}-${new Date(Date.UTC(y,m,0)).getUTCDate()}`;};
  const round=n=>Math.round(n*10000)/10000;
  function buildExamples(asOf=P.monthNow()){
    const year=Number(asOf.slice(0,4));
    const specs=[
      ['normal','DRAM · 3개 Step 정상 진행',`${year}-01`,`${year}-12`,[20,30,50],0,'정상','분석·설계·검증을 병행하는 연간 과제. Step 비중 합산과 정상 실적을 확인하세요.'],
      ['delay','HBM · 누적 지연과 만회 계획',shift(asOf,-3),shift(asOf,2),[40,60],18,'지연','매월 같은 목표 증가분을 달성해도 누적 부족분은 남는 사례입니다.'],
      ['missed','NAND · 지난달 누락 후 이번 달 입력',shift(asOf,-2),shift(asOf,2),[35,65],0,'누락','지난달만 비워 두었습니다. 이번 달 정상 실적과 별개로 누락 월을 확인하고 소급 입력해 보세요.'],
      ['multiyear','All Tech · 다개년 단계별 추진',`${year-1}-09`,`${year+1}-06`,[15,25,60],8,'다개년','이전 연도부터 다음 연도까지 이어집니다. 연도 전환과 Step 기간 밖 비활성 칸을 확인하세요.'],
      ['short','DRAM · 3월~5월 단기 완료',`${year}-03`,`${year}-05`,[30,70],0,'완료','3개월만 진행하는 완료 사례. 나머지 월의 비활성 처리와 완료값 자동 반영을 확인하세요.'],
      ['crossyear','NAND · 12월~다음 해 2월 계획',`${year}-12`,`${year+1}-02`,[45,55],0,'차년도','12월부터 다음 해 2월까지의 계획입니다. 미래 월 실적 입력 제한을 확인하세요.'],
      ['scurve','HBM · 후반 집중형 목표',shift(asOf,-2),shift(asOf,3),[25,75],0,'비균등','균등 배분과 다른 후반 집중형 누적 목표입니다. 월별 목표 곡선을 비교하세요.'],
      ['zero','AI/DT · 착수 월 0% 실적',asOf,shift(asOf,3),[100],25,'0%','명시적으로 입력한 0%와 미입력의 차이를 확인하는 사례입니다.']
    ];
    return specs.map(([code,name,start,end,weights,lag,kind,description],index)=>{
      const project={id:`at-demo-planned-v1-${code}`,title:`[체험] ${name}`,team:['예시공정팀','예시품질팀','예시운영팀'][index%3],po:'예시 대표자',pm:`예시 PM ${index+1}`,members:'예시 공동 수행자',tech:[name.startsWith('DRAM')?'DRAM ALL':name.startsWith('HBM')?'HBM ALL':name.startsWith('NAND')?'NAND ALL':'All Tech'],type:index%2?'담당 과제':'팀 과제',special:code==='zero'?['AI','DT']:[],background:`실제 사내 과제가 아닌 테스트용 데이터입니다. ${description}`,kpi:'예시: 검증 항목 완료율 100%, 재작업 시간 20% 감소',plan:'현황 분석 → 개선안 설계 → 검증 및 적용. 월별 값은 전체 과제의 누적 진척률입니다.',status:kind==='완료'&&end<=asOf?'완료':start>asOf?'계획':'진행',startDate:start+'-01',endDate:last(end),startMonth:start,endMonth:end,unit:'%',planMode:'cumulative-percent-v1',stepPlanMode:'weighted-steps-v1',steps:[],stepReports:{},_demoScenario:{version:1,kind,description,referenceMonth:asOf}};
      const months=P.periodMonths(project.startDate,project.endDate);
      project.steps=weights.map((weight,i)=>{
        // The multiyear example has genuinely different Step periods.
        const first=code==='multiyear'&&i>0?months[Math.floor(months.length*(i===1?.2:.5))]:start;
        const final=code==='multiyear'&&i===0?months[Math.floor(months.length*.45)]:end;
        const active=P.periodMonths(first+'-01',last(final));
        const monthly=Object.fromEntries(active.map((m,j)=>[m,{goal:j===active.length-1?100:round(Math.pow((j+1)/active.length,code==='scurve'?1.8:1)*100)}]));
        return {id:`${code}-step-${i+1}`,name:weights.length===1?'적용 및 검증':['현황 분석','개선 설계','적용 검증'][i],weight,startDate:first+'-01',endDate:last(final),monthly,completionCriteria:'계획한 산출물 작성 및 검증 완료',evidenceRequired:false};
      });
      for(const step of project.steps){
        const rows={};
        for(const month of months.filter(m=>m>=step.startDate.slice(0,7)&&m<=asOf)){
          if(code==='missed'&&month===shift(asOf,-1))continue;
          const goal=P.stepGoal(step,month),actual=code==='zero'?0:round(Math.max(0,goal-lag));
          rows[month]={actual,...(actual<goal?{reason:'예시: 선행 데이터 검증 및 설비 확보 지연',catchup:'예시: 병행 검증과 추가 설비 투입으로 누적 부족분 회복'}:{})};
        }
        project.stepReports[step.id]=rows;
      }
      return P.withStepTotals(project);
    });
  }
  function mergeExamples(records,examples){const ids=new Set(records.map(p=>p.id));const added=examples.filter(p=>!ids.has(p.id)).map(clone);return {projects:[...added,...clone(records)],added:added.length};}
  return Object.freeze({buildExamples,mergeExamples});
});
