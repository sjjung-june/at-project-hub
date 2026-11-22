const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const model = require('../dist/plan-model.js');

function project(monthly, extra = {}) {
  return { startDate: '2026-03-10', endDate: '2026-05-20', planMode: 'cumulative-percent-v1', monthly, ...extra };
}
const goals = () => ({ '2026-03': { goal: 0 }, '2026-04': { goal: 50 }, '2026-05': { goal: 100 } });

test('date helpers include partial starting and ending months across a year boundary', () => {
  assert.deepEqual(model.periodMonths('2026-12-31', '2027-02-01'), ['2026-12', '2027-01', '2027-02']);
  assert.deepEqual(model.years('2026-12-31', '2027-02-01'), [2026, 2027]);
  assert.deepEqual(model.periodMonths('2026-03-10', '2026-05-20'), ['2026-03', '2026-04', '2026-05']);
  assert.deepEqual(model.periodMonths('2026-03-10', '2026-03-10'), ['2026-03']);
});

test('month enumeration does not truncate long valid plans', () => {
  const long = model.months('2021-01', '2026-02');
  assert.equal(long.length, 62);
  assert.equal(long.at(-1), '2026-02');
});

test('date helpers reject malformed dates, impossible dates and reversed intervals', () => {
  for (const value of ['2026-02-29', '2026-04-31', '1900-02-29', '2026-1-01', '0000-01-01', '', null]) assert.equal(model.isDate(value), false);
  assert.equal(model.isDate('2024-02-29'), true);
  assert.equal(model.isDate('2000-02-29'), true);
  assert.deepEqual(model.months('2026-13', '2027-01'), []);
  assert.deepEqual(model.months('2026-03', '2026-02'), []);
  assert.deepEqual(model.periodMonths('2026-03-20', '2026-03-10'), []);
  assert.deepEqual(model.years('invalid', '2026-01-01'), []);
});

test('zero is a valid value and percentages have strict bounds', () => {
  assert.equal(model.hasValue(0), true);
  assert.equal(model.hasValue('  '), false);
  assert.equal(model.percent('0'), 0);
  assert.equal(model.percent('32.5'), 32.5);
  for (const value of ['', ' ', null, undefined, -1, 100.01, Infinity, NaN, true, [], {}, 'abc']) assert.equal(model.percent(value), null);
});

test('valid plans require a monotone cumulative trajectory ending at 100%', () => {
  assert.deepEqual(model.validatePlan(project(goals())), []);
  const monthly = { '2026-03': { goal: 20 }, '2026-04': { goal: 10 }, '2026-05': { goal: 90 } };
  const errors = model.validatePlan(project(monthly));
  assert.ok(errors.some(error => error.month === '2026-04' && error.field === 'goal'));
  assert.ok(errors.some(error => error.month === '2026-05' && /100/.test(error.message)));
});

test('all active months require a valid goal while inactive saved months are ignored', () => {
  const monthly = goals();
  monthly['2026-03'].goal = '';
  monthly['2026-04'].goal = 101;
  monthly['2026-02'] = { goal: 999 };
  assert.deepEqual(model.validatePlan(project(monthly)).map(error => error.month), ['2026-03', '2026-04']);
  assert.equal(model.validatePlan({ startDate: '', endDate: '' }).length, 2);
  assert.equal(model.validatePlan({ startDate: '2026-05-20', endDate: '2026-03-10' })[0].field, 'endDate');
});

test('cumulative reports compare month balances directly and recover a previous delay', () => {
  const monthly = {
    '2026-03': { goal: 20, actual: 10, reason: '장비 지연', catchup: '4월 만회' },
    '2026-04': { goal: 50, actual: 50 },
    '2026-05': { goal: 100, actual: '' }
  };
  const task = project(monthly);
  assert.deepEqual(model.validateReports(task, monthly, '2026-04'), []);
  assert.equal(model.summary(task, '2026-03').label, '지연');
  const result = model.summary(task, '2026-04');
  assert.equal(result.label, '정상');
  assert.equal(result.goal, 50);
  assert.equal(result.actual, 50);
  assert.equal(result.gap, 0);
});

test('future reports are rejected while zero reports remain valid', () => {
  const monthly = goals();
  monthly['2026-03'].actual = 0;
  assert.deepEqual(model.validateReports(project(monthly), monthly, '2026-03'), []);
  monthly['2026-04'].actual = 50;
  assert.ok(model.validateReports(project(monthly), monthly, '2026-03').some(error => error.month === '2026-04' && error.field === 'actual'));
  assert.equal(model.summary(project(monthly), '2026-03').actual, 0);
});

test('a gap in reporting does not waive later delay reasons or permit declining actuals', () => {
  const monthly = {
    '2026-03': { goal: 0, actual: 40 },
    '2026-04': { goal: 50, actual: '' },
    '2026-05': { goal: 100, actual: 30 }
  };
  const errors = model.validateReports(project(monthly), monthly, '2026-05');
  assert.deepEqual(errors.map(error => error.field), ['actual', 'reason', 'catchup']);
  monthly['2026-05'].actual = 101;
  assert.ok(model.validateReports(project(monthly), monthly, '2026-05').some(error => /0~100/.test(error.message)));
});

test('missing reports preserve the most recent known delay and expose both flags', () => {
  const monthly = {
    '2026-03': { goal: 20, actual: 10, reason: '지연', catchup: '만회' },
    '2026-04': { goal: 50, actual: '' },
    '2026-05': { goal: 100 }
  };
  const result = model.summary(project(monthly), '2026-05');
  assert.equal(result.label, '지연');
  assert.equal(result.late, true);
  assert.equal(result.missing, true);
  assert.deepEqual(result.missingMonths, ['2026-04', '2026-05']);
  assert.equal(result.gap, 10);
});

test('later recovery keeps missing-report state without retaining obsolete delay', () => {
  const monthly = {
    '2026-03': { goal: 20, actual: 10, reason: '지연', catchup: '만회' },
    '2026-04': { goal: 50, actual: '' },
    '2026-05': { goal: 100, actual: 100 }
  };
  const result = model.summary(project(monthly), '2026-05');
  assert.equal(result.label, '실적 미입력');
  assert.equal(result.late, false);
  assert.equal(result.missing, true);
  assert.equal(result.actual, 100);
});

test('no reports remain unknown rather than zero and future plans show not started', () => {
  const task = project(goals());
  const result = model.summary(task, '2026-04');
  assert.equal(result.label, '실적 미입력');
  assert.equal(result.actual, null);
  assert.equal(result.gap, null);
  assert.equal(model.summary(task, '2026-02').label, '시작 전');
  assert.equal(model.summary({}, '2026-04').label, '계획 미등록');
});

test('legacy incremental data are not silently reinterpreted as cumulative percentages', () => {
  const legacy = { startMonth: '2026-03', endMonth: '2026-05', unit: '건', monthly: { '2026-03': { goal: 10, actual: 10 } } };
  const before = JSON.stringify(legacy);
  assert.equal(model.summary(legacy, '2026-05').label, '계획 재확인');
  assert.equal(model.summary(project(goals(), { planMode: undefined }), '2026-05').label, '계획 재확인');
  assert.equal(JSON.stringify(legacy), before);
});

test('the browser export uses Seoul time across midnight and year boundaries', () => {
  const source = fs.readFileSync(path.join(__dirname, '../dist/plan-model.js'), 'utf8');
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : ['2026-12-31T16:30:00Z'])); } }
  const context = { window: {}, Intl, Date: FixedDate };
  vm.runInNewContext(source, context);
  assert.equal(context.window.PlanModel.today(), '2027-01-01');
  assert.equal(context.window.PlanModel.monthNow(), '2027-01');
});
