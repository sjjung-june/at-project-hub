(function (root, factory) {
  const dependency = typeof module === 'object' && module.exports
    ? require('./plan-model.js') : root.PlanModel;
  const model = factory(dependency);
  if (typeof module === 'object' && module.exports) module.exports = model;
  if (typeof window === 'object') window.ProjectInsights = model;
  else if (root && !(typeof module === 'object' && module.exports)) root.ProjectInsights = model;
})(typeof globalThis === 'object' ? globalThis : this, function (PlanModel) {
  'use strict';

  const MODE = 'cumulative-percent-v1';
  const LIMIT = 4;
  const FIELD_NAMES = {
    title: '과제 제목', team: '소속 팀', po: 'PO', pm: 'PM', members: '공동 수행자',
    tech: '대상 Tech', background: '배경 / 목표', kpi: 'KPI', plan: '추진 계획'
  };
  const text = value => typeof value === 'string' ? value.trim()
    : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
  const list = value => Array.isArray(value) ? value.map(text).filter(Boolean) : [];
  const clip = (value, length = 160) => {
    const points = Array.from(text(value));
    return points.length > length ? `${points.slice(0, length).join('')}…` : points.join('');
  };
  const monthList = values => values.slice(0, 6).join(', ') + (values.length > 6 ? ` 외 ${values.length - 6}개월` : '');
  const item = (value, evidence) => ({ text: value, evidence });
  const percentText = value => `${value}%`;
  const round = value => Math.round((value + Number.EPSILON) * 1000000) / 1000000;

  function cutoffMonth(value) {
    if (typeof value === 'string' && /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(value)) return value;
    return PlanModel.isDate(value) ? value.slice(0, 7) : PlanModel.monthNow();
  }

  function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
  }

  // A change marker for this local summary, not a security or integrity token.
  function signature(value) {
    let hash = 2166136261;
    for (const character of stable(value)) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return `pi-v1-${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }

  function build(input, asOf) {
    if (!PlanModel) throw new Error('ProjectInsights requires PlanModel.');
    const project = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const cutoff = cutoffMonth(asOf);
    const records = project.monthly && typeof project.monthly === 'object' && !Array.isArray(project.monthly) ? project.monthly : {};
    const fields = Object.fromEntries(Object.keys(FIELD_NAMES).map(key => [key,
      key === 'tech' ? list(project[key]).join(', ')
        : key === 'members' && Array.isArray(project[key]) ? list(project[key]).join(', ') : text(project[key])
    ]));
    const complete = Object.keys(fields).filter(key => fields[key]);
    const narrativeMissing = ['background', 'kpi', 'plan'].filter(key => !fields[key]);
    const ownerMissing = ['team', 'po', 'pm'].filter(key => !fields[key]);
    const planErrors = PlanModel.validatePlan(project);
    const planValid = project.planMode === MODE && !planErrors.length;
    const hasPlan = Boolean(text(project.startDate) || text(project.endDate) || text(project.startMonth) || text(project.endMonth) || Object.keys(records).length);
    const legacy = hasPlan && project.planMode !== MODE;
    const status = PlanModel.summary(project, cutoff);
    const active = planValid ? PlanModel.periodMonths(project.startDate, project.endDate) : [];
    const due = active.filter(month => month <= cutoff);
    const reported = due.filter(month => PlanModel.percent(records[month]?.actual) !== null);
    const missing = due.filter(month => PlanModel.percent(records[month]?.actual) === null);
    const latest = reported[reported.length - 1] || '';
    const delayed = reported.filter(month => PlanModel.percent(records[month].actual) < PlanModel.percent(records[month].goal));
    const missingReason = delayed.filter(month => !text(records[month].reason));
    const missingCatchup = delayed.filter(month => !text(records[month].catchup));
    const filteredRecords = Object.fromEntries(due.map(month => [month, records[month] || {}]));
    const reportErrors = planValid ? PlanModel.validateReports(project, filteredRecords, cutoff).filter(error => error.field === 'actual') : [];
    const invalidActual = due.filter(month => PlanModel.hasValue(records[month]?.actual) && PlanModel.percent(records[month].actual) === null);
    const latestEvidence = latest ? `${latest} 누적 목표: ${percentText(status.goal)} · 누적 실적: ${percentText(status.actual)}${status.late ? ` · 부족: ${status.gap}%p` : ''}` : '';
    const strengths = [];
    const risks = [];
    const improvements = [];

    if (!narrativeMissing.length) strengths.push(item('배경 / 목표, KPI, 추진 계획이 모두 등록되어 있습니다.', '배경 / 목표 · KPI · 추진 계획: 입력 완료'));
    if (!ownerMissing.length) strengths.push(item('소속 팀과 PO·PM이 지정되어 있습니다.', `소속 팀: ${clip(fields.team, 60)} · PO: ${clip(fields.po, 60)} · PM: ${clip(fields.pm, 60)}`));
    if (planValid) strengths.push(item('과제 기간과 월별 누적 목표가 입력 기준을 충족합니다.', `전체 추진 일정: ${project.startDate} ~ ${project.endDate} · ${active.length}개월 · 종료 월 누적 목표: 100%`));
    if (latest && !status.late && !reportErrors.length) {
      const recovered = delayed.some(month => month < latest);
      strengths.unshift(item(recovered ? '최근 입력 실적에서 이전 누적 부족분을 만회했습니다.' : '최근 입력 실적이 해당 월의 누적 목표에 도달했습니다.', latestEvidence));
    }

    if (!planValid) {
      const evidence = legacy ? `계획 방식: ${clip(text(project.planMode) || '미지정', 60)} · 기존 단위: ${clip(text(project.unit) || '미지정', 40)} · 기존 월별 기록은 누적 %로 해석하지 않음`
        : planErrors.slice(0, 3).map(error => `${error.month ? `${error.month} ` : ''}${error.field === 'startDate' ? '시작일' : error.field === 'endDate' ? '종료일' : '누적 목표'}: ${error.message}`).join(' · ');
      risks.push(item(legacy ? '기존 계획을 누적 진척률 기준으로 재확인해야 합니다.' : hasPlan ? '기간 또는 월별 누적 목표에 확인할 항목이 있습니다.' : '전체 추진 일정과 월별 누적 목표가 등록되지 않았습니다.', evidence));
      improvements.push(item('전체 추진 일정과 활성 월의 누적 목표를 확인하고 종료 월을 100%로 설정하세요.', legacy ? '기존 기록을 보존한 뒤 누적 진척률(%) 목표를 새로 확인' : evidence));
    }
    if (status.late) {
      risks.push(item('최근 입력 실적에 누적 목표 대비 부족분이 남아 있습니다.', latestEvidence));
      improvements.push(item('남은 누적 부족분을 기준으로 만회 방법과 예상 회복 시점을 확인하세요.', latestEvidence));
    }
    if (missing.length) {
      risks.push(item(`기준 월까지 실적이 확인되지 않은 달이 ${missing.length}개월입니다.`, `누적 실적 미입력 / 유효값 미확인: ${monthList(missing)} · 기준 월: ${cutoff}`));
      improvements.push(item('실적이 비어 있는 달부터 확인해 월별 보고를 완료하세요.', `확인할 누적 실적: ${monthList(missing)} · 빈 실적은 0%로 계산하지 않음`));
    }
    if (reportErrors.length) {
      const evidence = reportErrors.slice(0, 3).map(error => `${error.month} 누적 실적: ${error.message}`).join(' · ');
      risks.push(item('누적 실적의 값 또는 월별 순서를 확인해야 합니다.', evidence));
      improvements.push(item('누적 실적을 0~100% 범위와 이전 입력 실적 이상으로 확인하세요.', evidence));
    }
    if (missingReason.length || missingCatchup.length) {
      const evidence = [missingReason.length ? `지연 사유 미입력: ${monthList(missingReason)}` : '', missingCatchup.length ? `Catch Up Plan 미입력: ${monthList(missingCatchup)}` : ''].filter(Boolean).join(' · ');
      risks.push(item('지연 기록에 사유 또는 Catch Up Plan이 빠져 있습니다.', evidence));
      improvements.push(item('해당 월의 지연 사유와 Catch Up Plan을 보완하세요.', evidence));
    } else if (delayed.length) {
      strengths.push(item('입력된 지연 월마다 사유와 Catch Up Plan이 등록되어 있습니다.', `지연 사유 · Catch Up Plan 입력: ${monthList(delayed)}`));
    }
    if (narrativeMissing.length) {
      const evidence = `미입력 항목: ${narrativeMissing.map(key => FIELD_NAMES[key]).join(', ')}`;
      risks.push(item('과제 설명에 비어 있는 항목이 있습니다.', evidence));
      improvements.push(item('과제의 배경 / 목표, KPI, 추진 계획 중 비어 있는 내용을 작성하세요.', evidence));
    }
    if (ownerMissing.length || !fields.tech) {
      const evidence = `미지정 항목: ${[...ownerMissing.map(key => FIELD_NAMES[key]), ...(!fields.tech ? ['대상 Tech'] : [])].join(', ')}`;
      risks.push(item('담당 정보 또는 대상 Tech에 비어 있는 항목이 있습니다.', evidence));
      improvements.push(item('과제 담당 정보와 대상 Tech를 확인하세요.', evidence));
    }

    const overview = `${fields.background ? `배경 / 목표: ${clip(fields.background)}` : '배경 / 목표가 입력되지 않았습니다.'} · 현재 상태: ${status.label}${status.note ? ` (${status.note})` : ''}${reportErrors.length ? ' · 누적 실적 검증 항목이 있습니다.' : ''}`;
    const sources = ['과제 제목', '배경 / 목표', 'KPI', '추진 계획', '소속 팀 · PO · PM · 공동 수행자', '대상 Tech', '전체 추진 일정 · 월별 누적 목표'];
    if (planValid && due.length) sources.push(`월별 누적 실적 (기준 월 ${cutoff}까지)`);
    if (delayed.length) sources.push('지연 사유 · Catch Up Plan');
    const coverage = {
      asOf: cutoff, planValid, legacy, statusLabel: status.label,
      totalMonths: active.length, dueMonths: due.length, reportedMonths: reported.length,
      missingMonths: missing, latestMonth: latest, latestGoal: status.goal, latestActual: status.actual,
      gap: status.gap === null ? null : round(status.gap), late: status.late,
      delayedMonths: delayed, missingReasonMonths: missingReason, missingCatchupMonths: missingCatchup,
      invalidActualMonths: invalidActual, reportValidationIssues: reportErrors.length,
      fieldsComplete: complete.length, fieldsTotal: Object.keys(FIELD_NAMES).length
    };
    const snapshot = {
      asOf: cutoff, fields, status: text(project.status), planMode: text(project.planMode),
      startDate: text(project.startDate), endDate: text(project.endDate),
      startMonth: text(project.startMonth), endMonth: text(project.endMonth), unit: text(project.unit),
      monthly: Object.keys(records).sort().map(month => ({ month, goal: records[month]?.goal ?? null,
        ...(month <= cutoff ? { actual: records[month]?.actual ?? null, reason: text(records[month]?.reason), catchup: text(records[month]?.catchup) } : {})
      }))
    };
    return { mode: 'rule-based', title: fields.title || '제목 미입력 과제', overview,
      strengths: strengths.slice(0, LIMIT), risks: risks.slice(0, LIMIT), improvements: improvements.slice(0, LIMIT),
      sources, coverage, signature: signature(snapshot) };
  }

  return Object.freeze({ build });
});
