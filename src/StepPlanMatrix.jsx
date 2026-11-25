import React,{useEffect,useRef} from 'react';
import {Scroll,Table,Cell,PercentInput,Note} from './ui';
const fmt=value=>value==null||value===''?'—':`${Math.round(value*100)/100}%`;
export function StepPlanMatrix({project,Plan,year,onGoalChange}){
  const months=Array.from({length:12},(_,i)=>`${year}-${String(i+1).padStart(2,'0')}`),active=Plan.periodMonths(project.startDate,project.endDate),totals=Plan.aggregateSteps(project);
  const scroll=useRef(null);
  useEffect(()=>{const first=months.findIndex(m=>active.includes(m)),cells=scroll.current?.querySelector('thead tr')?.cells;if(cells)scroll.current.scrollLeft=first>0?Math.max(0,cells[first+1].offsetLeft-cells[0].offsetWidth):0;},[year,project.startDate,project.endDate]);
  return <><Note>각 행은 Step별 월말 누적 목표입니다. 비중이 입력 최대값이며, 전체 목표는 아래에서 자동 합산합니다.</Note><Scroll ref={scroll} role="region" aria-label={`${year}년 Step별 월간 계획`} tabIndex={0}><Table><caption>Step별 월간 계획 · 누적 기여도 %</caption><thead><tr><th scope="col">Step / 비중</th>{months.map((m,i)=><th scope="col" key={m}>{i+1}월</th>)}</tr></thead><tbody>{project.steps.map(step=><tr key={step.id}><th scope="row">{step.name}<br/><strong>비중 {step.weight}%</strong></th>{months.map(month=>{
    const within=Plan.periodMonths(step.startDate,step.endDate).includes(month),carried=active.includes(month)&&month>step.endDate.slice(0,7),enabled=active.includes(month)&&within;
    const goal=enabled||carried?Plan.contribution(Plan.stepGoal(step,month),step.weight):null;
    return <Cell key={month} $active={enabled} title={carried?'Step 종료 이후 완료 목표 유지':!enabled?'Step 진행 기간 외':''}>{onGoalChange?<PercentInput type="number" min="0" max={step.weight} step="0.01" disabled={!enabled} aria-label={`${step.name} ${month} 목표 (%)`} value={goal??''} placeholder={enabled?'목표':'—'} onChange={e=>onGoalChange(step,month,e.target.value)}/>:fmt(goal)}</Cell>;
  })}</tr>)}</tbody><tfoot><tr><th scope="row">전체 목표 · 합계</th>{months.map(month=><Cell key={month} $active={active.includes(month)}><strong>{fmt(active.includes(month)?totals[month]?.goal:null)}</strong></Cell>)}</tr></tfoot></Table></Scroll></>;
}
