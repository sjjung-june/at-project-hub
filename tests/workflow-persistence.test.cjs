const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const PlanModel = require('../dist/plan-model.js');
const OperationsModel = require('../dist/operations-model.js');
const ApprovalModel = require('../dist/approval-model.js');
const ReportRequestsModel = require('../dist/report-requests-model.js');
const copy = value => JSON.parse(JSON.stringify(value));
const writer = { id: 'writer', name: '예시PO', role: 'project-representative', team: '예시팀' };
const leader = { id: 'leader', name: '예시팀장', role: 'team-lead', team: '예시팀' };
const project = () => ({ id: 'p', title: '예시 과제', team: '예시팀', pm: '예시PM', po: '예시PO',
  tech: ['DRAM ALL'], special: [], unit: '%', planMode: 'cumulative-percent-v1', status: '진행',
  startDate: '2026-10-01', endDate: '2026-12-31', startMonth: '2026-10', endMonth: '2026-12',
  monthly: { '2026-10': { goal: 40, actual: 40 }, '2026-11': { goal: 80 }, '2026-12': { goal: 100 } } });

// Exercise the real persistence boundary without a DOM. UI behavior is checked in CUA.
function harness(input = [project()]) {
  const storage = new Map([['projects', JSON.stringify(input)]]), messages = [];
  const context = { PlanModel, OperationsModel, ApprovalModel, ReportRequestsModel, crypto, Map, Date,
    window: { ReportRequestsModel }, data: copy(input), key: 'projects', failSave: false,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    toast: message => messages.push(message), showPage() {}, detail() {}, openForm() {}, readableTime: String,
    persistRecords(next) { if (context.failSave) return false; context.localStorage.setItem('projects', JSON.stringify(next)); context.data = next; return true; } };
  const source = fs.readFileSync(require.resolve('../dist/approvals.js'), 'utf8');
  vm.createContext(context);
  vm.runInContext(source.slice(0, source.indexOf('  function download')) + '\n})();', context);
  return { context, messages, storage };
}

test('registration captures full plan and all original details, not only its title', () => {
  const { context } = harness([]), record = project(); record.background = '보존할 배경';
  assert.equal(context.persistRecords([record]), true);
  assert.equal(context.data[0]._audit[0].after.background, '보존할 배경');
  assert.equal(context.data[0]._baseline.monthly['2026-11'].goal, 80);
});

test('unapproved direct plan changes and permanent removal leave stored records untouched', () => {
  const { context, storage, messages } = harness(), original = storage.get('projects');
  const changed = copy(context.data); changed[0].monthly['2026-11'].goal = 60;
  assert.equal(context.persistRecords(changed), false);
  assert.equal(context.persistRecords([]), false);
  assert.equal(storage.get('projects'), original);
  assert.match(messages.join(' '), /승인|영구 삭제/);
});

test('approval preserves old history, new request, decision comment and latest actual together', () => {
  const input = project(); input._history = [{ id: 'old', action: '이전 변경', at: '2026-10-01', changes: [] }];
  const { context } = harness([input]);
  const candidate = copy(input); candidate.monthly['2026-11'].goal = 60;
  assert.equal(context.persistRecords([ApprovalModel.createRequest(context.data[0], candidate, { actor: writer, reason: '범위 조정', id: 'r' })]), true);
  const nextReport = copy(context.data); nextReport[0].monthly['2026-11'] = { goal: 80, actual: 70, reason: '예시 지연', catchup: '예시 조치' };
  assert.equal(context.persistRecords(nextReport), true);
  const approved = ApprovalModel.decide(context.data[0], 'r', { actor: leader, decision: 'approved', comment: '검토 완료' });
  assert.equal(context.persistRecords([approved]), true);
  const saved = context.data[0];
  assert.equal(saved.monthly['2026-11'].actual, 70);
  assert.equal(saved.monthly['2026-11'].goal, 60);
  assert.equal(saved._baseline.monthly['2026-11'].goal, 80);
  assert.ok(saved._audit.some(event => event.id === 'old'));
  assert.equal(saved._audit.find(event => event.action === 'change_approved').comment, '검토 완료');
});

test('report request, report entry and request completion are saved as one consistent history', () => {
  const { context } = harness();
  const queue = ReportRequestsModel.queue(context.data, ['p'], { month: '2026-11', dueDate: '2026-11-30', now: '2026-11-23T01:00:00Z', actor: '예시관리자', baseUrl: 'https://example.com' });
  assert.equal(context.persistRecords(queue.projects), true);
  const records = copy(context.data); records[0].monthly['2026-11'] = { goal: 80, actual: 75, reason: '예시 지연', catchup: '예시 조치' };
  assert.equal(context.persistRecords(records), true);
  assert.equal(context.data[0]._reportRequests[0].status, 'reported');
  assert.ok(context.data[0]._audit.some(event => event.action === '실적 입력 요청 생성'));
  assert.ok(context.data[0]._audit.some(event => event.action === '실적 변경'));
  assert.ok(context.data[0]._audit.some(event => event.action === '실적 입력 요청 완료'));
});

test('conflicting tabs and failed saves do not consume pending approvals or modify data', () => {
  const { context, storage } = harness();
  const candidate = { ...context.data[0], title: '검토할 제목' };
  const pending = ApprovalModel.createRequest(context.data[0], candidate, { actor: writer, reason: '표현 보완', id: 'r' });
  context.failSave = true;
  assert.equal(context.persistRecords([pending]), false);
  assert.equal(context.data[0]._changeRequests, undefined);
  context.failSave = false; assert.equal(context.persistRecords([pending]), true);
  const approved = ApprovalModel.decide(context.data[0], 'r', { actor: leader, decision: 'approved', comment: '승인' });
  storage.set('projects', JSON.stringify([{ ...context.data[0], externalUpdate: true }]));
  assert.equal(context.persistRecords([approved]), false);
  assert.equal(context.data[0]._changeRequests[0].status, 'pending');
});
