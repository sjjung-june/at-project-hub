(function (root, factory) {
  const plan = typeof module === 'object' && module.exports ? require('./plan-model.js') : root.PlanModel;
  const model = factory(plan);
  if (typeof module === 'object' && module.exports) module.exports = model;
  else root.ReportRequestsModel = model;
})(typeof globalThis === 'object' ? globalThis : this, function (PlanModel) {
  'use strict';
  const waiting = ['awaiting_integration', 'queued', 'sending', 'sent', 'delivered'];
  const clean = value => value == null ? '' : String(value).trim();
  const validMonth = value => typeof value === 'string' && /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(value);
  const clone = value => JSON.parse(JSON.stringify(value));
  function day(value) {
    if (!value) return PlanModel.today();
    const str = String(value).slice(0, 10);
    return validDate(str) ? str : PlanModel.today();
  }
  function validDate(value) {
    if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T00:00:00Z');
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  function timestamp(value) { return value ? new Date(value.length === 10 ? value + 'T00:00:00Z' : value).toISOString() : new Date().toISOString(); }
  function reported(project, month) { return PlanModel.percent(project.monthly?.[month]?.actual) !== null; }
  function eligible(project, month) {
    return project && !project.archivedAt && !project.deletedAt && clean(project.pm)
      && !['보류', '완료'].includes(project.status)
      && project.planMode === 'cumulative-percent-v1' && !PlanModel.validatePlan(project).length
      && PlanModel.periodMonths(project.startDate, project.endDate).includes(month) && !reported(project, month);
  }
  function key(project, month) { return `${project.id}:${month}:${clean(project.pm)}`; }
  function activeDuplicate(project, month) {
    return (project._reportRequests || []).some(request => waiting.includes(request.status) && request.idempotencyKey === key(project, month));
  }
  function candidates(projects, month, options = {}) {
    if (!validMonth(month) || month > day(options.now).slice(0, 7)) return [];
    return (Array.isArray(projects) ? projects : []).filter(project => eligible(project, month)
      && (!options.team || project.team === options.team)).map(project => ({
      projectId: project.id, title: clean(project.title), team: clean(project.team), pm: clean(project.pm),
      reportMonth: month, alreadyRequested: activeDuplicate(project, month)
    }));
  }
  function deepLink(baseUrl, projectId, month) {
    const url = new URL(baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('허용되지 않는 입력 주소입니다.');
    url.search = '';
    url.hash = `report=${encodeURIComponent(String(projectId))}&month=${month}`;
    return url.href;
  }
  function message(project, month, dueDate, link) {
    return `[AT 과제 실적 입력 요청]\n과제: ${clean(project.title)}\n대상 월: ${month}\n담당 PM: ${clean(project.pm)}\n입력 기한: ${dueDate}\n누적 진척률(%)을 입력해 주세요. 목표 미달 시 지연 사유와 Catch Up Plan을 함께 작성해 주세요.\n${link}`;
  }
  function queue(projects, selectedIds, options = {}) {
    const unchanged = { projects, requests: [], skipped: [] };
    const today = day(options.now), month = options.month, dueDate = options.dueDate;
    if (!validMonth(month) || month > today.slice(0, 7)) return { ...unchanged, error: '현재 월까지의 요청 대상 월을 선택해 주세요.' };
    if (!validDate(dueDate) || dueDate < today) return { ...unchanged, error: '입력 기한은 오늘 이후 날짜로 지정해 주세요.' };
    const ids = [...new Set((Array.isArray(selectedIds) ? selectedIds : []).map(String))];
    if (!ids.length) return { ...unchanged, error: '요청할 과제를 선택해 주세요.' };
    let base;
    try { base = deepLink(options.baseUrl, 'validation', month); } catch { return { ...unchanged, error: '실적 입력 주소를 확인해 주세요.' }; }
    const next = clone(projects), requests = [], skipped = [], at = timestamp(options.now);
    for (const id of ids) {
      const project = next.find(record => String(record.id) === id);
      if (!eligible(project, month)) { skipped.push({ projectId: id, reason: '실적이 입력되었거나 현재 요청 대상이 아닙니다.' }); continue; }
      if (activeDuplicate(project, month)) { skipped.push({ projectId: id, reason: '같은 월과 담당자에게 준비된 요청이 이미 있습니다.' }); continue; }
      const link = deepLink(base, project.id, month);
      const request = {
        requestId: typeof crypto === 'object' && crypto.randomUUID ? crypto.randomUUID() : `request-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        idempotencyKey: key(project, month), projectId: project.id, status: 'awaiting_integration',
        recipient: { name: clean(project.pm), accountId: null },
        payload: { title: clean(project.title), reportMonth: month, dueDate, deepLink: link, message: message(project, month, dueDate, link) },
        createdAt: at, createdBy: clean(options.actor) || '시연 사용자 · SSO 미연동', attempts: [],
        events: [{ type: 'prepared', at, actor: clean(options.actor) || '시연 사용자 · SSO 미연동' }]
      };
      project._reportRequests = [...(project._reportRequests || []), request];
      requests.push(request);
    }
    return { projects: next, requests, skipped };
  }
  function cancel(projects, requestId, reason, actor, at) {
    if (!clean(reason)) return { projects, error: '취소 사유를 입력해 주세요.' };
    const next = clone(projects);
    const request = next.flatMap(project => project._reportRequests || []).find(item => item.requestId === requestId);
    if (!request || request.status !== 'awaiting_integration') return { projects, error: '연동 대기 중인 요청만 취소할 수 있습니다.' };
    const time = timestamp(at), who = clean(actor) || '시연 사용자 · SSO 미연동';
    Object.assign(request, { status: 'cancelled', cancelledAt: time, cancelledBy: who, cancellationReason: clean(reason) });
    request.events = [...(request.events || []), { type: 'cancelled', at: time, actor: who, reason: clean(reason) }];
    return { projects: next, request };
  }
  function sync(projects, at) {
    let changed = false;
    const next = clone(projects);
    for (const project of next) for (const request of project._reportRequests || []) {
      if (waiting.includes(request.status) && reported(project, request.payload?.reportMonth)) {
        const time = timestamp(at);
        request.status = 'reported'; request.resolvedAt = time;
        request.events = [...(request.events || []), { type: 'reported', at: time, actor: '실적 입력 확인' }];
        changed = true;
      } else if (request.status === 'awaiting_integration' && (!eligible(project, request.payload?.reportMonth) || clean(project.pm) !== clean(request.recipient?.name))) {
        const time = timestamp(at), reason = '과제 상태·담당자 또는 목표 계획이 변경되어 요청 대상을 다시 확인해야 합니다.';
        Object.assign(request, { status: 'cancelled', cancelledAt: time, cancelledBy: '요청 대상 재확인', cancellationReason: reason });
        request.events = [...(request.events || []), { type: 'cancelled', at: time, actor: '요청 대상 재확인', reason }];
        changed = true;
      }
    }
    return { projects: changed ? next : projects, changed };
  }
  function outbound(projects, requestIds) {
    const ids = new Set(Array.isArray(requestIds) ? requestIds : []);
    return (projects || []).flatMap(project => (project._reportRequests || [])
      .filter(request => ids.has(request.requestId) && request.status === 'awaiting_integration'
        && eligible(project, request.payload?.reportMonth) && clean(project.pm) === clean(request.recipient?.name))
      .map(request => clone({ requestId: request.requestId, idempotencyKey: request.idempotencyKey,
        recipient: request.recipient, payload: request.payload })));
  }
  function recordExport(projects, requestIds, actor, at) {
    const requests = outbound(projects, requestIds);
    if (!requests.length) return { projects, requests: [] };
    const ids = new Set(requests.map(request => request.requestId)), next = clone(projects), time = timestamp(at);
    for (const project of next) for (const request of project._reportRequests || []) {
      if (ids.has(request.requestId)) request.events = [...(request.events || []), { type: 'export_prepared', at: time, actor: clean(actor) || '시연 사용자 · SSO 미연동' }];
    }
    return { projects: next, requests };
  }
  return Object.freeze({ validMonth, validDate, candidates, queue, cancel, sync, outbound, recordExport, deepLink });
});
