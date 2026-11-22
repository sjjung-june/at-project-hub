const test = require('node:test');
const assert = require('node:assert/strict');
const Model = require('../dist/report-requests-model.js');
function project(overrides = {}) { return { id: 'p1', title: 'HBM 검증', team: '품질팀', pm: '김담당', status: '진행', planMode: 'cumulative-percent-v1', startDate: '2026-10-01', endDate: '2026-12-31', monthly: { '2026-10': { goal: 30 }, '2026-11': { goal: 70 }, '2026-12': { goal: 100 } }, ...overrides }; }
const options = { month: '2026-11', dueDate: '2026-11-30', now: '2026-11-23T01:00:00Z', actor: '테스트 사용자', baseUrl: 'https://example.test/app?ignored=1#old' };
test('only missing active valid projects with PM become candidates; zero is reported', () => {
  const records = [project(), project({ id: 'zero', monthly: { '2026-10': { goal: 30 }, '2026-11': { goal: 70, actual: 0 }, '2026-12': { goal: 100 } } }), project({ id: 'paused', status: '보류' }), project({ id: 'done', status: '완료' }), project({ id: 'archived', archivedAt: 'x' }), project({ id: 'noPm', pm: ' ' }), project({ id: 'invalid', planMode: '' })];
  assert.deepEqual(Model.candidates(records, '2026-11', { now: options.now }).map(item => item.projectId), ['p1']);
  assert.equal(Model.candidates(records, '2026-11', { team: '개발팀', now: options.now }).length, 0);
  assert.equal(Model.candidates(records, '2026-12', { now: options.now }).length, 0);
});
test('queue records unconnected recipient and message without mutating input or claiming send', () => {
  const original = [project()]; const result = Model.queue(original, ['p1'], options); const request = result.requests[0];
  assert.equal(original[0]._reportRequests, undefined);
  assert.equal(request.status, 'awaiting_integration'); assert.deepEqual(request.attempts, []);
  assert.deepEqual(request.recipient, { name: '김담당', accountId: null });
  assert.equal(request.createdBy, '테스트 사용자');
  assert.equal(request.payload.deepLink, 'https://example.test/app#report=p1&month=2026-11');
  assert.match(request.payload.message, /2026-11-30/); assert.match(request.payload.message, /누적 진척률/);
});
test('queue prevents active duplicates but cancelled requests can be prepared again with same idempotency key', () => {
  const first = Model.queue([project()], ['p1', 'p1'], options);
  assert.equal(first.requests.length, 1);
  assert.equal(Model.candidates(first.projects, '2026-11', { now: options.now })[0].alreadyRequested, true);
  const second = Model.queue(first.projects, ['p1'], options); assert.equal(second.requests.length, 0); assert.equal(second.skipped.length, 1);
  const cancelled = Model.cancel(first.projects, first.requests[0].requestId, '기한 변경', '검토자', options.now);
  const replacement = Model.queue(cancelled.projects, ['p1'], options);
  assert.equal(replacement.requests.length, 1);
  assert.equal(replacement.requests[0].idempotencyKey, first.requests[0].idempotencyKey);
  assert.notEqual(replacement.requests[0].requestId, first.requests[0].requestId);
});
test('stale selection is rechecked so actuals entered after preview are excluded', () => {
  const current = project(); current.monthly['2026-11'].actual = 70;
  const result = Model.queue([current, project({ id: 'valid' })], ['p1', 'valid', 'removed'], options);
  assert.deepEqual(result.requests.map(item => item.projectId), ['valid']); assert.equal(result.skipped.length, 2);
});
test('invalid month, past/invalid due dates and unsafe URL are rejected', () => {
  for (const override of [{ month: '2026-12' }, { month: 'bad' }, { dueDate: '2026-11-22' }, { dueDate: '2026-02-30' }, { baseUrl: 'javascript:alert(1)' }, { baseUrl: 'https://user:secret@example.test' }]) {
    const result = Model.queue([project()], ['p1'], { ...options, ...override }); assert.ok(result.error); assert.equal(result.requests.length, 0);
  }
  assert.equal(Model.queue([project()], ['p1'], { ...options, dueDate: '2026-11-23' }).requests.length, 1);
});
test('cancel requires reason, preserves original request and records actor/time', () => {
  const first = Model.queue([project()], ['p1'], options); const id = first.requests[0].requestId;
  assert.ok(Model.cancel(first.projects, id, ' ', '검토자', options.now).error);
  const result = Model.cancel(first.projects, id, '계획 보류', '검토자', options.now);
  assert.equal(first.requests[0].status, 'awaiting_integration'); assert.equal(result.request.status, 'cancelled');
  assert.equal(result.request.events.at(-1).reason, '계획 보류'); assert.equal(result.request.cancelledBy, '검토자');
  assert.ok(Model.cancel(result.projects, id, '재취소', '검토자', options.now).error);
});
test('report sync resolves pending requests even when actual is zero; repeated sync is stable', () => {
  const first = Model.queue([project()], ['p1'], options); first.projects[0].monthly['2026-11'].actual = 0;
  const result = Model.sync(first.projects, options.now); assert.equal(result.changed, true);
  const request = result.projects[0]._reportRequests[0]; assert.equal(request.status, 'reported'); assert.equal(request.events.at(-1).type, 'reported');
  const again = Model.sync(result.projects, options.now); assert.equal(again.changed, false); assert.equal(again.projects, result.projects);
  assert.equal(Model.outbound(result.projects, [request.requestId]).length, 0);
});
test('outbound requires explicit selection and returns only waiting safe contract', () => {
  const first = Model.queue([project(), project({ id: 'p2' })], ['p1', 'p2'], options);
  assert.deepEqual(Model.outbound(first.projects), []);
  const outbound = Model.outbound(first.projects, [first.requests[0].requestId]); assert.equal(outbound.length, 1);
  assert.deepEqual(Object.keys(outbound[0]).sort(), ['idempotencyKey', 'payload', 'recipient', 'requestId']);
  outbound[0].recipient.name = '변경'; assert.equal(first.requests[0].recipient.name, '김담당');
  const cancelled = Model.cancel(first.projects, first.requests[0].requestId, '취소', '검토자', options.now);
  assert.equal(Model.outbound(cancelled.projects, first.requests.map(item => item.requestId)).length, 1);
});
test('deep link strips query and safely encodes project ids; month boundaries enforce eligibility', () => {
  assert.equal(Model.deepLink('https://example.test/?token=secret', 'p&<x>', '2026-11'), 'https://example.test/#report=p%26%3Cx%3E&month=2026-11');
  assert.equal(Model.candidates([project()], '2026-09', { now: options.now }).length, 0);
});
test('pending request is cancelled with trace when approved PM or lifecycle changes; stale export is blocked', () => {
  for (const change of [{ pm: '이담당' }, { status: '보류' }, { archivedAt: '2026-11-23T00:00:00Z' }]) {
    const first = Model.queue([project()], ['p1'], options); Object.assign(first.projects[0], change);
    assert.equal(Model.outbound(first.projects, [first.requests[0].requestId]).length, 0);
    const synced = Model.sync(first.projects, options.now); const request = synced.projects[0]._reportRequests[0];
    assert.equal(synced.changed, true); assert.equal(request.status, 'cancelled'); assert.match(request.cancellationReason, /변경/); assert.equal(request.events.at(-1).actor, '요청 대상 재확인');
  }
});
test('file preparation records an event without changing delivery status or creating attempts', () => {
  const first = Model.queue([project()], ['p1'], options);
  const result = Model.recordExport(first.projects, [first.requests[0].requestId], '연동 관리자', options.now);
  assert.equal(result.requests.length, 1);
  const request = result.projects[0]._reportRequests[0];
  assert.equal(request.status, 'awaiting_integration'); assert.deepEqual(request.attempts, []);
  assert.equal(request.events.at(-1).type, 'export_prepared'); assert.equal(request.events.at(-1).actor, '연동 관리자');
  assert.equal(first.requests[0].events.length, 1);
});
