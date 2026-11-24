(function (root, factory) {
  const plan = typeof module === 'object' && module.exports
    ? require('./plan-model.js') : root.PlanModel;
  const model = factory(plan);
  if (typeof module === 'object' && module.exports) module.exports = model;
  if (typeof window === 'object') window.OperationsModel = model;
  else if (root && !(typeof module === 'object' && module.exports)) root.OperationsModel = model;
})(typeof globalThis === 'object' ? globalThis : this, function (PlanModel) {
  'use strict';

  const MODE = 'cumulative-percent-v1';
  const validMonth = value => typeof value === 'string' && /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(value);
  const text = value => value === undefined || value === null ? '' : String(value).trim();

  function selectedMonth(value) {
    const now = PlanModel.monthNow();
    return validMonth(value) ? (value > now ? now : value) : now;
  }

  function buildInbox(projects, options = {}) {
    const month = selectedMonth(options.month);
    const items = [];
    for (const project of Array.isArray(projects) ? projects : []) {
      if (!project || project.archivedAt) continue;
      if (options.team && project.team !== options.team) continue;
      if (options.pm && project.pm !== options.pm) continue;
      const base = {
        projectId: project.id, title: text(project.title) || '제목 없는 과제',
        team: text(project.team), pm: text(project.pm)
      };
      const errors = PlanModel.validatePlan(project);
      if (project.planMode !== MODE || errors.length) {
        const months = [...new Set(errors.map(error => error.month).filter(Boolean))];
        const legacy = project.planMode !== MODE && (project.startMonth || project.endMonth
          || Object.keys(project.monthly || {}).length);
        items.push({ ...base, kind: 'plan', label: '목표 계획 확인', months,
          description: legacy
            ? '기존 단위의 계획을 누적 진척률(%)로 재확인해 주세요. 기존 기록은 유지됩니다.'
            : errors.length ? errors[0].message + (errors.length > 1 ? ` 외 ${errors.length - 1}건` : '')
              : '과제 기간과 월별 누적 진척률(%) 목표를 등록해 주세요.' });
        continue;
      }

      const active = PlanModel.periodMonths(project.startDate, project.endDate);
      const records = project.monthly || {};
      if (project.status === '완료') {
        const lastMonth = active[active.length - 1];
        if (PlanModel.percent(records[lastMonth]?.actual) !== 100) {
          items.push({ ...base, kind: 'complete', label: '완료 실적 확인', months: [lastMonth], lastMonth,
            description: `완료 과제의 종료 월(${lastMonth}) 누적 실적을 100%로 확인해 주세요.` });
        }
        continue;
      }
      if (project.status === '보류') continue;

      const result = PlanModel.summary(project, month);
      if (result.missing) items.push({ ...base, kind: 'missing', label: '실적 미입력',
        months: [...result.missingMonths],
        description: `${result.missingMonths.join(', ')} · ${result.missingMonths.length}개월의 누적 실적을 입력해 주세요.` });
      if (result.late) {
        const due = active.filter(value => value <= month);
        const lastMonth = due.filter(value => PlanModel.percent(records[value]?.actual) !== null).pop();
        items.push({ ...base, kind: 'late', label: '누적 지연', months: lastMonth ? [lastMonth] : [],
          gap: result.gap, lastMonth,
          description: `${result.note} · 지연 사유와 Catch Up Plan을 확인해 주세요.` });
      }
    }

    const filtered = options.kind ? items.filter(item => item.kind === options.kind) : items;
    const counts = { total: filtered.length, totalItems: filtered.length,
      projects: new Set(filtered.map(item => item.projectId)).size, missing: 0, late: 0, plan: 0, complete: 0 };
    for (const item of filtered) counts[item.kind] += 1;
    return { items: filtered, counts };
  }

  function matchesTech(project, filter) {
    const query = text(filter);
    if (!query) return true;
    const values = Array.isArray(project?.tech) ? project.tech.map(text) : [];
    const all = values.some(value => value.toLowerCase() === 'all tech');
    if (query.toLowerCase() === 'all tech') return all;
    const family = /^(DRAM|NAND|HBM)(?:$|\s|:)/i.exec(query)?.[1].toUpperCase();
    if (all && family) return true;
    const normalized = query.toLowerCase();
    return values.some(value => value.toLowerCase().includes(normalized)
      || (family && value.toUpperCase() === `${family} ALL`));
  }

  function valueText(value) {
    if (Array.isArray(value)) return value.map(valueText).sort().join(', ');
    if (value && typeof value === 'object') {
      return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])));
    }
    return text(value);
  }

  function changes(before, after) {
    after = after || {};
    if (!before) return [{ field: 'title', label: '과제 등록', before: '', after: valueText(after.title) }];
    const result = [];
    const fields = [
      ['title', '과제 제목'], ['team', '소속 팀'], ['po', 'PO'], ['pm', 'PM'], ['members', '공동 수행자'],
      ['type', '과제 분류'], ['special', '추가 분류'], ['tech', '대상 Tech'], ['status', '과제 상태'],
      ['background', '배경 / 목표'], ['kpi', 'KPI'], ['plan', '추진 계획'],
      ['startDate', '시작일'], ['endDate', '종료일'],
      ['htrsSub', 'mHTRS / HTRS 하위 분류'], ['aiSub', 'AI / DT 하위 분류']
    ];
    for (const [field, label] of fields) {
      const previous = valueText(before[field]), next = valueText(after[field]);
      if (previous !== next) result.push({ field, label, before: previous, after: next });
    }
    const previousArchive = Boolean(before.archivedAt), nextArchive = Boolean(after.archivedAt);
    if (previousArchive !== nextArchive) result.push({ field: 'archivedAt', label: '보관 상태',
      before: previousArchive ? '보관' : '운영 중', after: nextArchive ? '보관' : '운영 중' });
    const months = [...new Set([...Object.keys(before.monthly || {}), ...Object.keys(after.monthly || {})])].sort();
    for (const month of months) {
      for (const [kind, label] of [['goal', '누적 목표 (%)'], ['actual', '누적 실적 (%)'], ['reason', '지연 사유'], ['catchup', 'Catch Up Plan']]) {
        let previous = valueText(before.monthly?.[month]?.[kind]);
        let next = valueText(after.monthly?.[month]?.[kind]);
        if (kind === 'goal' || kind === 'actual') {
          const previousPercent = PlanModel.percent(previous), nextPercent = PlanModel.percent(next);
          if (previousPercent !== null) previous = String(previousPercent);
          if (nextPercent !== null) next = String(nextPercent);
        }
        if (previous !== next) result.push({ field: `monthly.${month}.${kind}`, label: `${month} ${label}`, before: previous, after: next });
      }
    }
    const beforeSteps = before.steps || [], afterSteps = after.steps || [];
    if ((before.stepPlanMode || '') !== (after.stepPlanMode || '')) result.push({field:'stepPlanMode',label:'Step 계획 적용',before:before.stepPlanMode || '단일 계획',after:after.stepPlanMode || '단일 계획'});
    for (const id of new Set([...beforeSteps.map(s=>s.id), ...afterSteps.map(s=>s.id)])) {
      const a=beforeSteps.find(s=>s.id===id), b=afterSteps.find(s=>s.id===id), name=b?.name || a?.name || id;
      for (const [field,label] of [['name','이름'],['weight','비중 (%)'],['startDate','시작일'],['endDate','종료일']]) {
        const previous=valueText(a?.[field]), next=valueText(b?.[field]);
        if(previous!==next)result.push({field:`steps.${id}.${field}`,label:`${name} · ${label}`,before:previous,after:next});
      }
      for(const month of new Set([...Object.keys(a?.monthly||{}),...Object.keys(b?.monthly||{})])) {
        const previous=valueText(a?.monthly[month]?.goal),next=valueText(b?.monthly[month]?.goal);
        if(previous!==next)result.push({field:`steps.${id}.monthly.${month}.goal`,label:`${name} · ${month} 목표 (%)`,before:previous,after:next});
      }
    }
    for(const id of new Set([...Object.keys(before.stepReports||{}),...Object.keys(after.stepReports||{})])) {
      const name=afterSteps.find(s=>s.id===id)?.name || beforeSteps.find(s=>s.id===id)?.name || id;
      for(const month of new Set([...Object.keys(before.stepReports?.[id]||{}),...Object.keys(after.stepReports?.[id]||{})]))for(const [field,label] of [['actual','실적 (%)'],['reason','지연 사유'],['catchup','Catch Up Plan']]) {
        const previous=valueText(before.stepReports?.[id]?.[month]?.[field]),next=valueText(after.stepReports?.[id]?.[month]?.[field]);
        if(previous!==next)result.push({field:`stepReports.${id}.${month}.${field}`,label:`${name} · ${month} ${label}`,before:previous,after:next});
      }
    }
    return result;
  }

  return Object.freeze({ buildInbox, matchesTech, changes });
});
