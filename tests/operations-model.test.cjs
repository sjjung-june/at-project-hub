const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const PlanModel = require('../dist/plan-model.js');
const model = require('../dist/operations-model.js');

function project(id = 'p1', extra = {}) {
  return { id, title: '검증 과제', team: '공정팀', pm: '박PM', status: '진행',
    startDate: '2026-03-10', endDate: '2026-05-20', planMode: 'cumulative-percent-v1',
    monthly: { '2026-03': { goal: 20 }, '2026-04': { goal: 50 }, '2026-05': { goal: 100 } }, ...extra };
}

test('a project can need missing reports and cumulative catch up at the same time', () => {
  const input = project();
  input.monthly['2026-03'].actual = 10;
  const result = model.buildInbox([input], { month: '2026-05' });
  assert.deepEqual(result.items.map(item => item.kind), ['missing', 'late']);
  assert.deepEqual(result.items[0].months, ['2026-04', '2026-05']);
  assert.equal(result.items[1].lastMonth, '2026-03');
  assert.equal(result.items[1].gap, 10);
  assert.deepEqual(result.counts, { total: 2, totalItems: 2, projects: 1, missing: 1, late: 1, plan: 0, complete: 0 });
});

test('a later recovery clears the old gap but preserves missing historical reports', () => {
  const input = project();
  input.monthly['2026-03'].actual = 10;
  input.monthly['2026-05'].actual = 100;
  const result = model.buildInbox([input], { month: '2026-05' });
  assert.deepEqual(result.items.map(item => item.kind), ['missing']);
  assert.deepEqual(result.items[0].months, ['2026-04']);
});

test('missing periods stop at the end of the project even if the selected month is later', () => {
  const result = model.buildInbox([project()], { month: '2026-08' });
  assert.deepEqual(result.items[0].months, ['2026-03', '2026-04', '2026-05']);
});

test('future and paused projects do not request reports; archived projects never enter the queue', () => {
  const result = model.buildInbox([
    project('future', { startDate: '2099-01-01', endDate: '2099-01-31', monthly: { '2099-01': { goal: 100 } } }),
    project('paused', { status: '보류' }), project('archived', { archivedAt: '2026-06-01T00:00:00Z' })
  ], { month: '2026-05' });
  assert.deepEqual(result.items, []);
});

test('completed projects skip regular reporting and only raise final achievement inconsistencies', () => {
  const complete = project('complete', { status: '완료' });
  complete.monthly['2026-05'].actual = 100;
  assert.deepEqual(model.buildInbox([complete], { month: '2026-05' }).items, []);
  complete.monthly['2026-05'].actual = 90;
  const result = model.buildInbox([complete], { month: '2026-05' });
  assert.deepEqual(result.items.map(item => item.kind), ['complete']);
  assert.equal(result.counts.complete, 1);
});

test('missing, invalid and legacy plans receive a plan action even while paused or completed', () => {
  const result = model.buildInbox([
    project('none', { startDate: '', endDate: '', monthly: {}, status: '보류' }),
    project('invalid', { monthly: { '2026-03': { goal: 20 }, '2026-04': { goal: 10 }, '2026-05': { goal: 100 } } }),
    project('legacy', { planMode: undefined, unit: '건', status: '완료' })
  ], { month: '2026-05' });
  assert.equal(result.counts.plan, 3);
  assert.ok(result.items.every(item => item.kind === 'plan'));
  assert.match(result.items.find(item => item.projectId === 'legacy').description, /누적 진척률/);
});

test('team, PM and action kind filters select independent queue rows and counts', () => {
  const a = project('a');
  a.monthly['2026-03'].actual = 10;
  const b = project('b', { team: '품질팀', pm: '김PM' });
  const result = model.buildInbox([a, b], { month: '2026-05', team: '공정팀', pm: '박PM', kind: 'late' });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].projectId, 'a');
  assert.equal(result.counts.projects, 1);
  assert.equal(result.counts.missing, 0);
  assert.equal(result.counts.late, 1);
  assert.equal(model.buildInbox([a, b], { month: '2026-05', pm: '없는 PM' }).counts.total, 0);
});

test('zero is a report and must not be changed to a missing value', () => {
  const input = project();
  input.monthly['2026-03'] = { goal: 0, actual: 0 };
  assert.deepEqual(model.buildInbox([input], { month: '2026-03' }).items, []);
});

test('future selected months are capped at the current Seoul month and malformed values use the current month', () => {
  const input = project();
  assert.deepEqual(model.buildInbox([input], { month: '2099-12' }), model.buildInbox([input], { month: PlanModel.monthNow() }));
  assert.deepEqual(model.buildInbox([input], { month: '2026-13' }), model.buildInbox([input]));
});

test('All Tech covers family filters while the All Tech filter selects only explicit all-tech projects', () => {
  const all = { tech: ['All Tech'] };
  for (const filter of ['DRAM', 'NAND', 'HBM', 'DRAM: Lucy']) assert.equal(model.matchesTech(all, filter), true);
  assert.equal(model.matchesTech(all, 'All Tech'), true);
  assert.equal(model.matchesTech({ tech: ['DRAM ALL', 'HBM: HBM3E'] }, 'All Tech'), false);
  assert.equal(model.matchesTech({ tech: ['DRAM: Lucy'] }, 'DRAM'), true);
  assert.equal(model.matchesTech({ tech: ['NAND ALL'] }, 'NAND'), true);
  assert.equal(model.matchesTech({ tech: ['DRAM ALL'] }, 'DRAM: Lucy'), true);
  assert.equal(model.matchesTech({ tech: ['DRAM: Lucy'] }, 'HBM'), false);
  assert.equal(model.matchesTech(null, ''), true);
});

test('history records monthly report changes separately from goals with readable labels', () => {
  const before = project();
  const after = structuredClone(before);
  after.monthly['2026-03'] = { goal: 30, actual: 20, reason: '장비 대기', catchup: '4월 추가 검증' };
  const result = model.changes(before, after);
  assert.deepEqual(result.map(change => change.field), ['monthly.2026-03.goal', 'monthly.2026-03.actual', 'monthly.2026-03.reason', 'monthly.2026-03.catchup']);
  assert.equal(result[0].label, '2026-03 누적 목표 (%)');
  assert.equal(result[0].before, '20');
  assert.equal(result[0].after, '30');
  assert.equal(result[3].after, '4월 추가 검증');
});

test('timestamps, history, metadata, selection ordering and numeric formatting do not create false history', () => {
  const before = project('p', { tech: ['HBM: HBM3', 'DRAM: Lucy'], special: ['AI', 'DT'], createdAt: 'old', updatedAt: 'old', history: [] });
  const after = structuredClone(before);
  after.tech.reverse(); after.special.reverse(); after.monthly['2026-03'].goal = '20.0';
  after.createdAt = 'new'; after.updatedAt = 'new'; after.history = [{ anything: 'ignored' }]; after.internalMeta = 'new';
  assert.deepEqual(model.changes(before, after), []);
});

test('new records and archive or restore operations produce clear history entries', () => {
  const input = project();
  assert.deepEqual(model.changes(null, input), [{ field: 'title', label: '과제 등록', before: '', after: '검증 과제' }]);
  const archived = { ...input, archivedAt: '2026-06-01T00:00:00Z' };
  assert.deepEqual(model.changes(input, archived), [{ field: 'archivedAt', label: '보관 상태', before: '운영 중', after: '보관' }]);
  assert.deepEqual(model.changes(archived, input), [{ field: 'archivedAt', label: '보관 상태', before: '보관', after: '운영 중' }]);
});

test('the browser export and all operations preserve inputs', () => {
  const input = project();
  const after = structuredClone(input);
  after.title = '<새 이름>';
  const original = JSON.stringify({ input, after });
  const source = fs.readFileSync(path.join(__dirname, '../dist/operations-model.js'), 'utf8');
  const context = { window: {}, PlanModel };
  vm.runInNewContext(source, context);
  assert.equal(context.window.OperationsModel.buildInbox([input], { month: '2026-05' }).counts.projects, 1);
  assert.equal(model.changes(input, after)[0].after, '<새 이름>');
  model.buildInbox([input], { month: '2026-05' }); model.matchesTech(input, 'DRAM');
  assert.equal(JSON.stringify({ input, after }), original);
});
