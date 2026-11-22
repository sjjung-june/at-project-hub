const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const model = require('../dist/approval-model.js');

const author = { id: 'writer', name: '홍 작성', role: 'participant', team: '공정팀' };
const leader = { id: 'lead', name: '김 팀장', role: 'team-lead', team: '공정팀' };
const head = { id: 'head', name: '이 담당장', role: 'at-head', team: 'AT' };
const at = '2026-06-01T00:00:00.000Z';
const clone = value => JSON.parse(JSON.stringify(value));

function project(extra = {}) {
  return { id: 'p1', title: '수율 개선', team: '공정팀', po: '최 PO', pm: '홍 작성', members: '박 참여',
    tech: ['DRAM: Lucy'], special: ['AI'], type: '팀 과제', status: '진행',
    background: '수율 개선 배경', kpi: '수율 2%p 개선', plan: '검증 후 적용',
    startDate: '2026-03-10', endDate: '2026-05-20', startMonth: '2026-03', endMonth: '2026-05',
    planMode: 'cumulative-percent-v1', unit: '%', monthly: {
      '2026-03': { goal: 20, actual: 20 }, '2026-04': { goal: 50, actual: 50 }, '2026-05': { goal: 100 }
    }, ...extra };
}

function request(input = project(), candidate = { ...input, title: '개선 과제 제목' }, extra = {}) {
  return model.createRequest(input, candidate, { actor: author, reason: '검토 결과를 반영합니다.', at, id: 'r1', ...extra });
}

function decide(input, decision = 'approved', actor = leader, extra = {}) {
  return model.decide(input, 'r1', { decision, actor, comment: '변경 내용과 영향을 검토했습니다.', at: '2026-06-02T00:00:00.000Z', ...extra });
}

test('request snapshots detach plan data and exclude report/history/archive injections', () => {
  const input = project({ _history: [{ kind: 'old' }], monthlyArchive: { '2025-01': { actual: 4 } } });
  const candidate = clone(input);
  candidate.title = '새 제목';
  candidate.monthly['2026-03'].actual = 99;
  candidate.monthly['2026-03'].reason = '후보가 주입한 사유';
  candidate._history.push({ kind: 'injected' });
  const result = request(input, candidate);
  assert.equal(input._changeRequests, undefined);
  assert.equal(result.title, input.title);
  assert.deepEqual(result._baseline, model.snapshot(input));
  assert.deepEqual(result._changeRequests[0].candidate.monthly['2026-03'], { goal: 20 });
  assert.equal(result._changeRequests[0].candidate._history, undefined);
  candidate.monthly['2026-03'].goal = 90;
  assert.equal(result._changeRequests[0].candidate.monthly['2026-03'].goal, 20);
  assert.equal(result._audit[0].action, 'change_requested');
  assert.equal(result._audit[0].requestId, 'r1');
  assert.equal(result._audit[0].actor.name, author.name);
  assert.equal(result._audit[0].after.title, '새 제목');
});

test('report-only, array ordering and numeric formatting changes do not request plan approval', () => {
  const input = project({ tech: ['NAND ALL', 'DRAM ALL'] });
  const candidate = clone(input);
  candidate.tech.reverse();
  candidate.monthly['2026-03'] = { goal: '20.0', actual: 80, reason: '주입', catchup: '주입' };
  assert.deepEqual(model.changes(input, candidate), []);
  assert.throws(() => request(input, candidate), /변경된 과제 정보나 목표가 없습니다/);
});

test('request requires a reason and named actor, and prevents overlapping or reused requests', () => {
  assert.throws(() => request(project(), undefined, { reason: '  ' }), /변경 사유/);
  assert.throws(() => request(project(), undefined, { actor: { name: '' } }), /이름/);
  const pending = request();
  assert.throws(() => request(pending, { ...pending, title: '다른 제목' }), /검토 중/);
  const rejected = decide(pending, 'rejected', leader, { comment: '범위를 다시 검토해 주세요.' });
  assert.throws(() => request(rejected), /이미 사용된 변경 요청 번호/);
});

test('invalid monthly goals cannot be requested', () => {
  const input = project(), candidate = clone(input);
  candidate.monthly['2026-04'].goal = 10;
  assert.throws(() => request(input, candidate), /이전 월의 목표 이상/);
  candidate.monthly['2026-04'].goal = 60;
  candidate.monthly['2026-05'].goal = 99;
  assert.throws(() => request(input, candidate), /100%/);
});

test('team lead can approve goal changes in their own team while preserving latest reports', () => {
  const input = project(), candidate = clone(input);
  candidate.monthly['2026-04'].goal = 60;
  const pending = request(input, candidate);
  pending.monthly['2026-04'].actual = 55;
  const result = decide(pending);
  assert.equal(result.monthly['2026-04'].goal, 60);
  assert.equal(result.monthly['2026-04'].actual, 55);
  assert.equal(result.monthly['2026-04'].reason, undefined);
  assert.equal(result._baseline.monthly['2026-04'].goal, 50);
  assert.equal(result._changeRequests[0].status, 'approved');
  assert.equal(result._changeRequests[0].reviewer.id, leader.id);
  assert.equal(result._audit[1].before.monthly['2026-04'].goal, 50);
  assert.equal(result._audit[1].after.monthly['2026-04'].goal, 60);
  assert.equal(pending.monthly['2026-04'].goal, 50);
});

test('self review is blocked by either SSO id or normalized name', () => {
  const pending = request();
  assert.throws(() => decide(pending, 'approved', { ...leader, id: author.id }), /본인이 요청/);
  assert.throws(() => decide(pending, 'approved', { ...leader, name: '  홍   작성  ' }), /본인이 요청/);
  assert.throws(() => decide(pending, 'rejected', { ...leader, name: author.name }, { comment: '반려' }), /본인이 요청/);
});

test('different team leads, participants and administrators cannot act as reviewers', () => {
  const pending = request();
  assert.throws(() => decide(pending, 'approved', { ...leader, team: '품질팀' }), /해당 팀/);
  assert.throws(() => decide(pending, 'approved', { ...leader, role: 'participant' }), /해당 팀/);
  assert.throws(() => decide(pending, 'approved', { ...leader, role: 'admin' }), /해당 팀/);
  assert.equal(decide(pending, 'approved', head)._changeRequests[0].status, 'approved');
});

test('team, PO and exact date changes each require the AT head', () => {
  for (const field of ['team', 'po', 'startDate', 'endDate']) {
    const input = project(), candidate = clone(input);
    candidate[field] = { team: '새 팀', po: '새 PO', startDate: '2026-03-11', endDate: '2026-05-21' }[field];
    assert.equal(model.requiredRole(input, candidate), 'at-head');
    const pending = request(input, candidate);
    assert.throws(() => decide(pending), /AT 담당장/);
    assert.equal(decide(pending, 'approved', head)[field], candidate[field]);
  }
});

test('approval detects plan changes after request but permits current report changes', () => {
  const pending = request();
  pending.background = '요청 이후 다른 계획 수정';
  assert.throws(() => decide(pending), /요청 이후/);
  const reportChanged = request();
  reportChanged.monthly['2026-03'] = { goal: 20, actual: 10, reason: '측정 지연', catchup: '재측정' };
  const result = decide(reportChanged);
  assert.deepEqual(result.monthly['2026-03'], reportChanged.monthly['2026-03']);
});

test('period shrink archives reports instead of dropping them; expansion restores them', () => {
  const input = project();
  input.monthly['2026-05'] = { goal: 100, actual: 100, reason: '기록', catchup: '조치' };
  const shorter = clone(input);
  shorter.endDate = '2026-04-30'; shorter.endMonth = '2026-04';
  shorter.monthly = { '2026-03': { goal: 20 }, '2026-04': { goal: 100 } };
  const shrunk = decide(request(input, shorter), 'approved', head);
  assert.equal(shrunk.monthly['2026-05'], undefined);
  assert.deepEqual(shrunk.monthlyArchive['2026-05'], input.monthly['2026-05']);
  const longer = clone(shrunk);
  longer.endDate = '2026-05-20'; longer.endMonth = '2026-05';
  longer.monthly['2026-04'].goal = 50;
  longer.monthly['2026-05'] = { goal: 100, actual: 0, reason: '주입' };
  const pending = model.createRequest(shrunk, longer, { actor: author, reason: '기존 일정 복원', at, id: 'r2' });
  const result = model.decide(pending, 'r2', { decision: 'approved', actor: head, comment: '기존 일정 복원 검토 완료', at });
  assert.deepEqual(result.monthly['2026-05'], input.monthly['2026-05']);
  assert.equal(result.monthlyArchive['2026-05'], undefined);
  assert.equal(result._baseline.endDate, input.endDate);
});

test('completion checks current final actual at both request and approval time', () => {
  const input = project();
  assert.throws(() => request(input, { ...input, status: '완료' }), /종료 월 누적 실적이 100%/);
  input.monthly['2026-05'].actual = 100;
  const pending = request(input, { ...input, status: '완료' });
  pending.monthly['2026-05'].actual = 99;
  assert.throws(() => decide(pending), /종료 월 누적 실적이 100%/);
  pending.monthly['2026-05'].actual = 100;
  assert.equal(decide(pending).status, '완료');
});

test('rejection requires a reason, preserves project plan and cannot be repeated', () => {
  const pending = request();
  assert.throws(() => decide(pending, 'rejected', leader, { comment: '' }), /반려 사유/);
  const rejected = decide(pending, 'rejected', leader, { comment: '목표 근거 보완' });
  assert.equal(rejected.title, pending.title);
  assert.equal(rejected._changeRequests[0].comment, '목표 근거 보완');
  assert.equal(rejected._audit.at(-1).action, 'change_rejected');
  assert.throws(() => decide(rejected), /이미 처리된/);
});

test('withdrawal belongs only to requester and does not alter project plan', () => {
  const pending = request();
  assert.throws(() => decide(pending, 'withdrawn', leader), /변경 요청자만/);
  const withdrawn = decide(pending, 'withdrawn', author, { comment: '재작성 예정' });
  assert.equal(withdrawn.title, pending.title);
  assert.equal(withdrawn._changeRequests[0].status, 'withdrawn');
  assert.equal(withdrawn._audit.at(-1).action, 'change_withdrawn');
  assert.throws(() => decide(withdrawn, 'withdrawn', author), /이미 처리된/);
});

test('all audit and request entries survive beyond old history limits', () => {
  const input = project({ _audit: Array.from({ length: 130 }, (_, id) => ({ id: `e${id}` })),
    _changeRequests: Array.from({ length: 110 }, (_, id) => ({ id: `old${id}`, status: 'rejected' })) });
  const result = decide(request(input));
  assert.equal(result._audit.length, 132);
  assert.equal(result._changeRequests.length, 111);
  assert.equal(result._audit[0].id, 'e0');
  assert.equal(result._changeRequests[0].id, 'old0');
});

test('legacy and unplanned projects can be archived and restored without data conversion', () => {
  const input = { id: 'old', title: '기존 과제', team: '공정팀', tech: ['DRAM ALL'],
    monthly: { '2025-01': { goal: 1200, actual: 400, reason: '기존 사유' } }, unit: '건' };
  const archived = decide(request(input, { ...input, archivedAt: at }), 'approved', head);
  assert.equal(archived.archivedAt, at);
  assert.deepEqual(archived.monthly, input.monthly);
  assert.equal(archived.unit, '건');
  assert.equal(archived._changeRequests[0].requiredRole, 'at-head');
  const pending = model.createRequest(archived, { ...archived, archivedAt: null },
    { actor: author, reason: '운영 복원', at, id: 'restore' });
  const restored = model.decide(pending, 'restore', { decision: 'approved', actor: head, comment: '운영 재개 승인', at });
  assert.equal(restored.archivedAt, null);
  assert.deepEqual(restored.monthly, input.monthly);
  assert.equal(restored._baseline.archivedAt, null);
});

test('legacy actual units are kept separately instead of silently converted to percent', () => {
  const input = project({ planMode: 'legacy', unit: '건', monthly: { '2026-03': { goal: 200, actual: 150 } } });
  const candidate = project();
  const result = decide(request(input, candidate));
  assert.equal(result.monthly['2026-03'].actual, undefined);
  assert.equal(result.legacyPlan.monthly['2026-03'].actual, 150);
  assert.equal(result.legacyPlan.unit, '건');
});

test('all decisions require a recorded comment or reason', () => {
  const pending = request();
  assert.throws(() => decide(pending, 'approved', leader, { comment: ' ' }), /승인 검토 의견/);
  assert.throws(() => decide(pending, 'withdrawn', author, { comment: '' }), /철회 사유/);
  assert.throws(() => decide(pending, 'rejected', leader, { comment: '' }), /반려 사유/);
});

test('restored archived reports cannot introduce decreasing cumulative actuals', () => {
  const input = project({ startDate: '2026-04-01', startMonth: '2026-04',
    monthly: { '2026-04': { goal: 50, actual: 50 }, '2026-05': { goal: 100 } },
    monthlyArchive: { '2026-03': { goal: 20, actual: 60 } } });
  const candidate = project();
  assert.throws(() => request(input, candidate), /이전 월보다 낮습니다/);
  input.monthlyArchive['2026-03'].actual = 40;
  const pending = request(input, candidate);
  pending.monthly['2026-04'].actual = 30;
  assert.throws(() => decide(pending, 'approved', head), /이전 월보다 낮습니다/);
});

test('browser UMD exports are available without CommonJS', () => {
  const context = vm.createContext({ window: {}, Intl, Date });
  for (const file of ['plan-model.js', 'operations-model.js', 'approval-model.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../dist', file), 'utf8'), context);
    if (file === 'plan-model.js') context.PlanModel = context.window.PlanModel;
    if (file === 'operations-model.js') context.OperationsModel = context.window.OperationsModel;
  }
  assert.equal(typeof context.window.ApprovalModel.createRequest, 'function');
  assert.equal(typeof context.window.ApprovalModel.decide, 'function');
});
