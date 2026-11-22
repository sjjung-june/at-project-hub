(function (root, factory) {
  const model = factory();
  if (typeof module === 'object' && module.exports) module.exports = model;
  if (typeof window === 'object') window.PlanModel = model;
  else if (root && !(typeof module === 'object' && module.exports)) root.PlanModel = model;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const MODE = 'cumulative-percent-v1';
  const round = value => Math.round((value + Number.EPSILON) * 1000000) / 1000000;

  function today() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    const part = name => parts.find(value => value.type === name).value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  }

  function monthNow() { return today().slice(0, 7); }

  function isMonth(value) {
    return typeof value === 'string' && /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(value);
  }

  function isDate(value) {
    if (typeof value !== 'string' || !/^(?!0000)\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  }

  function months(startMonth, endMonth) {
    if (!isMonth(startMonth) || !isMonth(endMonth) || endMonth < startMonth) return [];
    const [startYear, start] = startMonth.split('-').map(Number);
    const [endYear, end] = endMonth.split('-').map(Number);
    const first = startYear * 12 + start - 1;
    const last = endYear * 12 + end - 1;
    return Array.from({ length: last - first + 1 }, (_, index) => {
      const absolute = first + index;
      return `${String(Math.floor(absolute / 12)).padStart(4, '0')}-${String(absolute % 12 + 1).padStart(2, '0')}`;
    });
  }

  function periodMonths(startDate, endDate) {
    return isDate(startDate) && isDate(endDate) && startDate <= endDate
      ? months(startDate.slice(0, 7), endDate.slice(0, 7)) : [];
  }

  function years(startDate, endDate) {
    if (!isDate(startDate) || !isDate(endDate) || startDate > endDate) return [];
    const first = Number(startDate.slice(0, 4));
    const last = Number(endDate.slice(0, 4));
    return Array.from({ length: last - first + 1 }, (_, index) => first + index);
  }

  function hasValue(value) {
    return value !== null && value !== undefined && !(typeof value === 'string' && value.trim() === '');
  }

  function percent(value) {
    if (!hasValue(value) || !['number', 'string'].includes(typeof value)) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
  }

  function issue(month, field, message) { return { month, field, message }; }

  function validatePlan(project) {
    project = project || {};
    const errors = [];
    if (!isDate(project.startDate)) errors.push(issue('', 'startDate', '과제 시작일을 올바른 날짜로 입력해 주세요.'));
    if (!isDate(project.endDate)) errors.push(issue('', 'endDate', '과제 종료일을 올바른 날짜로 입력해 주세요.'));
    if (errors.length) return errors;
    if (project.endDate < project.startDate) return [issue('', 'endDate', '종료일은 시작일과 같거나 이후여야 합니다.')];
    const active = periodMonths(project.startDate, project.endDate);
    const records = project.monthly || {};
    let previous = null;
    for (const month of active) {
      const value = records[month] && records[month].goal;
      const goal = percent(value);
      if (!hasValue(value)) errors.push(issue(month, 'goal', `${month} 누적 목표를 입력해 주세요.`));
      else if (goal === null) errors.push(issue(month, 'goal', `${month} 누적 목표는 0~100%의 숫자로 입력해 주세요.`));
      else {
        if (previous !== null && goal < previous) errors.push(issue(month, 'goal', `${month} 누적 목표는 이전 월의 목표 이상이어야 합니다.`));
        previous = goal;
      }
    }
    const finalMonth = active[active.length - 1];
    const finalGoal = percent(records[finalMonth] && records[finalMonth].goal);
    if (finalGoal !== null && finalGoal !== 100) errors.push(issue(finalMonth, 'goal', '과제 종료 월의 누적 목표는 100%여야 합니다.'));
    return errors;
  }

  function normalizeAsOf(asOf) {
    return isMonth(asOf) ? asOf : isDate(asOf) ? asOf.slice(0, 7) : monthNow();
  }

  function validateReports(project, monthly, asOf = monthNow()) {
    project = project || {};
    const records = monthly || {};
    const cutoff = normalizeAsOf(asOf);
    const errors = [];
    let previous = null;
    for (const month of periodMonths(project.startDate, project.endDate)) {
      const row = records[month] || {};
      if (!hasValue(row.actual)) continue;
      if (month > cutoff) errors.push(issue(month, 'actual', `${month} 실적은 해당 월이 시작된 뒤 입력할 수 있습니다.`));
      const actual = percent(row.actual);
      if (actual === null) {
        errors.push(issue(month, 'actual', `${month} 누적 실적은 0~100%의 숫자로 입력해 주세요.`));
        continue;
      }
      if (previous !== null && actual < previous) errors.push(issue(month, 'actual', `${month} 누적 실적은 이전에 입력한 실적 이상이어야 합니다.`));
      previous = actual;
      // A missing report in an earlier month does not waive this month's explanation.
      const goal = percent(row.goal ?? project.monthly?.[month]?.goal);
      if (goal !== null && actual < goal) {
        if (typeof row.reason !== 'string' || !row.reason.trim()) errors.push(issue(month, 'reason', `${month} 지연 사유를 입력해 주세요.`));
        if (typeof row.catchup !== 'string' || !row.catchup.trim()) errors.push(issue(month, 'catchup', `${month} Catch Up Plan을 입력해 주세요.`));
      }
    }
    return errors;
  }

  function summary(project, asOf = monthNow()) {
    project = project || {};
    const records = project.monthly || {};
    const result = { label: '', note: '', goal: null, actual: null, gap: null, missing: false, missingMonths: [], late: false };
    const hasPlan = hasValue(project.startDate) || hasValue(project.endDate)
      || hasValue(project.startMonth) || hasValue(project.endMonth) || Object.keys(records).length > 0;
    if (!hasPlan) return { ...result, label: '계획 미등록', note: '과제 기간과 월별 누적 목표를 등록해 주세요.' };
    if (project.planMode !== MODE || validatePlan(project).length) {
      return { ...result, label: '계획 재확인', note: '과제 기간과 누적 진척률(%) 목표를 확인해 주세요.' };
    }
    const cutoff = normalizeAsOf(asOf);
    const due = periodMonths(project.startDate, project.endDate).filter(month => month <= cutoff);
    if (!due.length) return { ...result, label: '시작 전', note: '과제 시작 전입니다.' };
    let latest = '';
    for (const month of due) {
      const row = records[month] || {};
      const actual = percent(row.actual);
      if (actual === null) result.missingMonths.push(month);
      else {
        latest = month;
        result.goal = percent(row.goal);
        result.actual = actual;
      }
    }
    result.missing = result.missingMonths.length > 0;
    if (latest) {
      result.gap = round(result.goal - result.actual);
      result.late = result.gap > 0;
      result.note = `${latest} 기준 · 누적 목표 ${result.goal}% / 실적 ${result.actual}%${result.late ? ` · 부족 ${result.gap}%p` : ''}`;
    }
    if (result.missing) result.note += `${result.note ? ' · ' : ''}실적 미입력 ${result.missingMonths.length}개월 (${result.missingMonths.join(', ')})`;
    result.label = result.late ? '지연' : result.missing ? '실적 미입력' : '정상';
    return result;
  }

  return Object.freeze({ today, monthNow, months, periodMonths, years, isDate, hasValue, percent, validatePlan, validateReports, summary });
});
