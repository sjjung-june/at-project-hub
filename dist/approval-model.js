(function (root, factory) {
  const common = typeof module === 'object' && module.exports;
  const model = factory(common ? require('./plan-model.js') : root.PlanModel,
    common ? require('./operations-model.js') : root.OperationsModel);
  if (common) module.exports = model;
  if (typeof window === 'object') window.ApprovalModel = model;
  else if (root && !common) root.ApprovalModel = model;
})(typeof globalThis === 'object' ? globalThis : this, function (PlanModel, OperationsModel) {
  'use strict';

  const MODE = 'cumulative-percent-v1';
  const fields = ['id', 'title', 'team', 'po', 'pm', 'members', 'type', 'tech', 'special', 'status',
    'background', 'kpi', 'plan', 'startDate', 'endDate', 'startMonth', 'endMonth', 'unit', 'planMode', 'htrsSub', 'aiSub'];
  const arrayFields = new Set(['tech', 'special']);
  const text = value => value === null || value === undefined ? '' : String(value).trim();
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const nameKey = value => text(value).normalize('NFC').replace(/\s+/g, ' ').toLocaleLowerCase('ko-KR');
  const uid = () => typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID() : `change-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  // Only approved project information and goals belong to a change request.
  // Report content, audit entries and archived months always come from the live project.
  function snapshot(project = {}) {
    const result = {};
    for (const field of fields) {
      const value = project[field];
      result[field] = arrayFields.has(field)
        ? (Array.isArray(value) ? value.map(text).sort() : [])
        : (Array.isArray(value) ? value.map(text).sort() : text(value));
    }
    if (PlanModel.isWeighted(project)) {
      result.stepPlanMode = 'weighted-steps-v1';
      result.steps = (project.steps || []).map(step => ({id:text(step.id),name:text(step.name),weight:PlanModel.percent(step.weight) ?? text(step.weight),startDate:text(step.startDate),endDate:text(step.endDate),monthly:Object.fromEntries(Object.keys(step.monthly || {}).sort().map(month => [month,{goal:PlanModel.percent(step.monthly[month]?.goal) ?? text(step.monthly[month]?.goal)}]))}));
      project = PlanModel.withStepTotals(project);
    }
    result.archivedAt = text(project.archivedAt) || null;
    result.monthly = {};
    for (const month of Object.keys(project.monthly || {}).sort()) {
      const value = project.monthly[month]?.goal;
      const parsed = PlanModel.percent(value);
      result.monthly[month] = { goal: parsed === null ? text(value) : parsed };
    }
    return result;
  }

  function changes(before, after) {
    const previous = snapshot(before), next = snapshot(after);
    const result = OperationsModel.changes(previous, next);
    for (const [field, label] of [['id', '과제 식별자'], ['startMonth', '시작 월'], ['endMonth', '종료 월'],
      ['unit', '진척률 단위'], ['planMode', '목표 계획 기준']]) {
      if (previous[field] !== next[field]) result.push({ field, label, before: previous[field], after: next[field] });
    }
    if (previous.archivedAt !== next.archivedAt && !result.some(change => change.field === 'archivedAt')) {
      result.push({ field: 'archivedAt', label: '보관 시각', before: previous.archivedAt || '', after: next.archivedAt || '' });
    }
    return result;
  }

  function requiredRole(before, after) {
    return changes(before, after).some(change => ['team', 'po', 'startDate', 'endDate', 'startMonth', 'endMonth', 'archivedAt'].includes(change.field))
      ? 'at-head' : 'team-lead';
  }

  function identity(actor) {
    if (!actor || !text(actor.name)) throw new Error('처리자의 이름을 입력해 주세요.');
    return { id: text(actor.id), name: text(actor.name), role: text(actor.role), team: text(actor.team) };
  }

  function samePerson(first, second) {
    return Boolean((text(first?.id) && text(second?.id) && text(first.id) === text(second.id))
      || (nameKey(first?.name) && nameKey(first?.name) === nameKey(second?.name)));
  }

  function timestamp(value) {
    if (value === undefined) return new Date().toISOString();
    const date = new Date(value);
    if (!text(value) || !Number.isFinite(date.getTime())) throw new Error('변경 처리 시각이 올바르지 않습니다.');
    return date.toISOString();
  }

  function plannedProject(project, candidate) {
    const next = { ...clone(project), ...snapshot(candidate) };
    if (PlanModel.isWeighted(candidate)) {
      if (!PlanModel.isWeighted(project)) next.legacyAggregateReports = clone(project.legacyAggregateReports || {monthly:project.monthly || {}, monthlyArchive:project.monthlyArchive || {}, startDate:project.startDate, endDate:project.endDate});
      // Keep removed Step IDs and out-of-period reports for audit and restoration.
      return PlanModel.withStepTotals(next, project.stepReports || {});
    }
    const active = new Set(PlanModel.periodMonths(next.startDate, next.endDate));
    const hasPercentReports = project.planMode === MODE;
    const current = hasPercentReports ? clone(project.monthly || {}) : {};
    const archive = hasPercentReports ? clone(project.monthlyArchive || {}) : {};
    next.monthly = {};
    for (const month of active) {
      const row = { ...(archive[month] || {}), ...(current[month] || {}) };
      // Candidate reports are deliberately never copied, even if present in its object.
      row.goal = candidate.monthly?.[month]?.goal;
      next.monthly[month] = row;
      delete archive[month];
    }
    for (const [month, row] of Object.entries(current)) {
      if (!active.has(month)) archive[month] = clone(row);
    }
    next.monthlyArchive = archive;
    if (!hasPercentReports && Object.keys(project.monthly || {}).length) {
      next.legacyPlan = clone(project.legacyPlan || { monthly: project.monthly, unit: project.unit || '',
        startMonth: project.startMonth, endMonth: project.endMonth, monthlyArchive: project.monthlyArchive || {} });
    }
    return next;
  }

  function validateCandidate(project, candidate) {
    if (text(candidate.id) !== text(project.id)) throw new Error('과제 식별자는 변경할 수 없습니다.');
    const difference = changes(project, candidate);
    if (difference.length && difference.every(change => change.field === 'archivedAt')) {
      return { ...clone(project), archivedAt: candidate.archivedAt };
    }
    if (!text(candidate.title)) throw new Error('과제 제목을 입력해 주세요.');
    if (!text(candidate.team)) throw new Error('소속 팀을 입력해 주세요.');
    if (!Array.isArray(candidate.tech) || !candidate.tech.length) throw new Error('대상 Tech를 하나 이상 선택해 주세요.');
    if (candidate.planMode !== MODE || candidate.unit !== '%') throw new Error('목표는 누적 진척률(%) 기준으로 입력해 주세요.');
    if (PlanModel.isWeighted(project) && !PlanModel.isWeighted(candidate)) throw new Error('Step 계획을 전체 단일 계획으로 되돌릴 수 없습니다.');
    const errors = PlanModel.validatePlan(candidate);
    if (errors.length) throw new Error(errors[0].message);
    const active = PlanModel.periodMonths(candidate.startDate, candidate.endDate);
    if (candidate.startMonth !== active[0] || candidate.endMonth !== active[active.length - 1]) {
      throw new Error('추진 일정의 시작 월과 종료 월을 확인해 주세요.');
    }
    const merged = plannedProject(project, candidate);
    let previousActual = null;
    for (const month of active) {
      const value = merged.monthly[month]?.actual;
      if (!PlanModel.hasValue(value)) continue;
      const actual = PlanModel.percent(value);
      if (actual === null) throw new Error(`${month} 보존 실적은 0~100%의 숫자여야 합니다. 실적을 확인한 뒤 다시 요청해 주세요.`);
      if (previousActual !== null && actual < previousActual) throw new Error(`${month} 보존 실적이 이전 월보다 낮습니다. 실적을 확인한 뒤 다시 요청해 주세요.`);
      previousActual = actual;
    }
    if (candidate.status === '완료' && PlanModel.percent(merged.monthly[active[active.length - 1]]?.actual) !== 100) {
      throw new Error('완료 상태로 변경하려면 종료 월 누적 실적이 100%여야 합니다.');
    }
    // A revised goal can newly expose a delay in an already submitted report.
    // Keep that report unchanged; its missing explanation is an operational follow-up.
    return merged;
  }

  function event(action, request, actor, at, before, after, comment) {
    return { id: uid(), at, action, actor: clone(actor), requestId: request.id,
      reason: request.reason, comment: text(comment), changes: changes(before, after),
      before: snapshot(before), after: snapshot(after) };
  }

  function createRequest(project, candidate, options = {}) {
    if (!project || !text(project.id)) throw new Error('변경할 과제를 찾을 수 없습니다.');
    const actor = identity(options.actor);
    const reason = text(options.reason);
    if (!reason) throw new Error('과제 변경 사유를 입력해 주세요.');
    if ((project._changeRequests || []).some(request => request.status === 'pending')) {
      throw new Error('검토 중인 변경 요청이 있습니다. 승인, 반려 또는 철회 후 다시 요청해 주세요.');
    }
    const proposed = snapshot({ ...project, ...candidate, id: candidate?.id ?? project.id });
    validateCandidate(project, proposed);
    const difference = changes(project, proposed);
    if (!difference.length) throw new Error('변경된 과제 정보나 목표가 없습니다.');
    const at = timestamp(options.at), id = text(options.id) || uid();
    if ((project._changeRequests || []).some(request => request.id === id)) throw new Error('이미 사용된 변경 요청 번호입니다.');
    const request = { id, status: 'pending', reason, requestedAt: at, requester: actor,
      requiredRole: requiredRole(project, proposed), base: snapshot(project), candidate: proposed, changes: difference };
    const next = clone(project);
    if (!next._baseline) next._baseline = snapshot(project);
    next._changeRequests = [...(next._changeRequests || []), request];
    next._audit = [...(next._audit || []), event('change_requested', request, actor, at, request.base, proposed, '')];
    return next;
  }

  function decide(project, requestId, options = {}) {
    const request = (project?._changeRequests || []).find(item => item.id === requestId);
    if (!request) throw new Error('변경 요청을 찾을 수 없습니다.');
    if (request.status !== 'pending') throw new Error('이미 처리된 변경 요청입니다.');
    const decision = options.decision;
    if (!['approved', 'rejected', 'withdrawn'].includes(decision)) throw new Error('변경 요청 처리 방법이 올바르지 않습니다.');
    const actor = identity(options.actor), comment = text(options.comment);
    if (decision === 'withdrawn') {
      if (!samePerson(actor, request.requester)) throw new Error('변경 요청자만 요청을 철회할 수 있습니다.');
    } else {
      if (samePerson(actor, request.requester)) throw new Error('본인이 요청한 변경을 직접 승인하거나 반려할 수 없습니다.');
      const role = requiredRole(request.base, request.candidate);
      const permitted = actor.role === 'at-head' || (role === 'team-lead'
        && actor.role === 'team-lead' && text(actor.team) === text(request.base.team));
      if (!permitted) throw new Error(role === 'at-head'
        ? '일정, 소속 팀 또는 PO 변경은 AT 담당이 검토해야 합니다.' : '해당 팀의 팀장 또는 AT 담당만 검토할 수 있습니다.');
      if (decision === 'rejected' && !comment) throw new Error('반려 사유를 입력해 주세요.');
    }
    if (!comment) throw new Error(decision === 'withdrawn' ? '철회 사유를 입력해 주세요.' : '승인 검토 의견을 입력해 주세요.');
    if (decision === 'approved' && changes(request.base, project).length) {
      throw new Error('요청 이후 과제 정보 또는 목표가 변경되었습니다. 최신 과제를 기준으로 다시 요청해 주세요.');
    }
    const at = timestamp(options.at);
    let next = decision === 'approved' ? validateCandidate(project, request.candidate) : clone(project);
    next = clone(next);
    if (!next._baseline) next._baseline = snapshot(request.base);
    next._changeRequests = (project._changeRequests || []).map(item => item.id === requestId
      ? { ...clone(item), status: decision, decidedAt: at, reviewer: clone(actor), comment } : clone(item));
    next._audit = [...clone(project._audit || []), event(`change_${decision}`, request, actor, at,
      project, decision === 'approved' ? next : project, comment)];
    return next;
  }

  return Object.freeze({ snapshot, changes, requiredRole, createRequest, decide });
});
