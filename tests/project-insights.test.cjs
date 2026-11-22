const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const model = require('../dist/project-insights.js');
const PlanModel = require('../dist/plan-model.js');

function project(monthly, extra = {}) {
  return {
    title: '검증 과제', team: '공정팀', po: '김PO', pm: '박PM', members: '이참여',
    tech: ['DRAM: Lucy'], background: '공정 데이터를 통합합니다.', kpi: '분석 시간 단축', plan: '분석 후 시범 적용',
    startDate: '2026-03-10', endDate: '2026-05-20', planMode: 'cumulative-percent-v1', monthly, ...extra
  };
}
const goals = () => ({ '2026-03': { goal: 20 }, '2026-04': { goal: 50 }, '2026-05': { goal: 100 } });

test('legacy quantities remain uninterpreted and the input is preserved', () => {
  const input = project({ '2026-03': { goal: 10, actual: 5 } }, { planMode: undefined, unit: '건' });
  const before = JSON.stringify(input);
  const result = model.build(input, '2026-05');
  assert.equal(result.mode, 'rule-based');
  assert.equal(result.coverage.legacy, true);
  assert.equal(result.coverage.latestActual, null);
  assert.equal(result.coverage.gap, null);
  assert.match(result.risks[0].evidence, /누적 %로 해석하지 않음/);
  assert.equal(JSON.stringify(input), before);
});

test('missing later reports preserve the latest known cumulative delay and precise evidence', () => {
  const monthly = goals();
  monthly['2026-03'] = { goal: 20, actual: 10 };
  const result = model.build(project(monthly), '2026-05');
  assert.equal(result.coverage.late, true);
  assert.equal(result.coverage.latestMonth, '2026-03');
  assert.equal(result.coverage.gap, 10);
  assert.deepEqual(result.coverage.missingMonths, ['2026-04', '2026-05']);
  assert.deepEqual(result.coverage.missingReasonMonths, ['2026-03']);
  assert.deepEqual(result.coverage.missingCatchupMonths, ['2026-03']);
  assert.ok(result.risks.some(value => /2026-03.*20%.*10%.*10%p/.test(value.evidence)));
  assert.ok(result.risks.some(value => /지연 사유 미입력: 2026-03/.test(value.evidence)));
});

test('a later cumulative recovery clears the old shortage but preserves missing reports', () => {
  const monthly = goals();
  monthly['2026-03'] = { goal: 20, actual: 10, reason: '장비 일정', catchup: '5월 만회' };
  monthly['2026-05'].actual = 100;
  const result = model.build(project(monthly), '2026-05');
  assert.equal(result.coverage.late, false);
  assert.equal(result.coverage.gap, 0);
  assert.equal(result.coverage.statusLabel, '실적 미입력');
  assert.deepEqual(result.coverage.missingMonths, ['2026-04']);
  assert.match(result.strengths[0].text, /이전 누적 부족분을 만회/);
  assert.match(result.strengths[0].evidence, /2026-05.*100%.*100%/);
});

test('future actuals, reasons and Catch Up Plans do not enter observations or change the signature', () => {
  const input = project({
    '2026-03': { goal: 20, actual: 20 },
    '2026-04': { goal: 50, actual: 80, reason: '미래 내용', catchup: '미래 계획' },
    '2026-05': { goal: 100, actual: 100 }
  });
  const result = model.build(input, '2026-03-31');
  assert.equal(result.coverage.dueMonths, 1);
  assert.equal(result.coverage.latestMonth, '2026-03');
  assert.equal(result.coverage.latestActual, 20);
  assert.deepEqual(result.coverage.delayedMonths, []);
  const changed = JSON.parse(JSON.stringify(input));
  changed.monthly['2026-04'] = { goal: 50, actual: 0, reason: '다른 미래', catchup: '' };
  assert.deepEqual(model.build(changed, '2026-03'), result);
  assert.ok(!JSON.stringify(result).includes('미래 내용'));
});

test('zero actual is a valid report and is not marked missing', () => {
  const monthly = goals();
  monthly['2026-03'] = { goal: 0, actual: 0 };
  const result = model.build(project(monthly), '2026-03');
  assert.equal(result.coverage.reportedMonths, 1);
  assert.deepEqual(result.coverage.missingMonths, []);
  assert.equal(result.coverage.latestActual, 0);
  assert.equal(result.coverage.gap, 0);
});

test('input content stays plain text, is bounded in the overview, and never becomes a quality judgment', () => {
  const input = project(goals(), { title: '<img src=x onerror=alert(1)>', background: '<script>alert(1)</script>' + '가'.repeat(200) });
  const result = model.build(input, '2026-02');
  assert.equal(result.title, input.title);
  assert.match(result.overview, /<script>alert\(1\)<\/script>/);
  assert.match(result.overview, /…/);
  assert.ok(result.overview.length < 300);
  assert.ok(!JSON.stringify(result).includes('&lt;'));
  assert.ok(result.strengths.every(value => !/우수|효과적|타당|충분/.test(value.text)));
});

test('the signature is deterministic, independent of key ordering, and updates with relevant inputs', () => {
  const input = project(goals());
  const before = model.build(input, '2026-05');
  assert.deepEqual(model.build(input, '2026-05'), before);
  assert.equal(model.build({ ...input, monthly: Object.fromEntries(Object.entries(input.monthly).reverse()) }, '2026-05').signature, before.signature);
  for (const changed of [
    { ...input, kpi: '새 KPI' },
    { ...input, members: '다른 참여자' },
    { ...input, monthly: { ...input.monthly, '2026-03': { goal: 20, actual: 15 } } }
  ]) assert.notEqual(model.build(changed, '2026-05').signature, before.signature);
});

test('invalid reports expose data issues and do not claim achieved progress', () => {
  const input = project({
    '2026-03': { goal: 20, actual: 80 },
    '2026-04': { goal: 50, actual: 60 },
    '2026-05': { goal: 100, actual: 100 }
  });
  const result = model.build(input, '2026-05');
  assert.equal(result.coverage.reportValidationIssues, 1);
  assert.ok(result.risks.some(value => /2026-04 누적 실적/.test(value.evidence)));
  assert.ok(!result.strengths.some(value => /최근 입력 실적/.test(value.text)));
});

test('browser export resolves PlanModel and uses the same pure API', () => {
  const source = fs.readFileSync(path.join(__dirname, '../dist/project-insights.js'), 'utf8');
  const context = { window: {}, PlanModel };
  vm.runInNewContext(source, context);
  assert.equal(typeof context.window.ProjectInsights.build, 'function');
  const result = context.window.ProjectInsights.build(project(goals()), '2026-05');
  assert.equal(result.signature, model.build(project(goals()), '2026-05').signature);
});
