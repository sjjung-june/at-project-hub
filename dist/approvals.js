// Local workflow demonstration. Corporate identity and server authorization are not connected.
(function () {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  const previousPersist = persistRecords, previousShowPage = showPage;
  const previousDetail = detail, previousOpenForm = openForm;
  const actionLabels = { change_requested: '변경 승인 요청', change_approved: '변경 승인 및 반영', change_rejected: '변경 요청 반려', change_withdrawn: '변경 요청 철회' };
  const labels = { pending: '승인 대기', approved: '승인됨', rejected: '반려됨', withdrawn: '철회됨' };
  let selectedStatus = 'pending', selectedProject = '', actorOverride = null;
  const localActor = name => ({ id: 'demo:' + String(name).trim(), name: String(name).trim(), role: 'participant', authenticated: false });
  const actorName = actor => typeof actor === 'string' ? actor : actor?.name || '시연 사용자';
  const time = value => { try { return readableTime(value); } catch { return String(value || ''); } };
  const get = id => data.find(project => project.id === id);
  const auditEvents = project => project._audit || (project._history || []).map(event => ({ ...event, legacy: true }));
  const event = (action, details = {}) => ({ id: crypto.randomUUID(), at: new Date().toISOString(), actor: actorOverride || localActor('시연 사용자'), action, ...details });

  // One write covers project state, decisions, requests and the complete local audit.
  persistRecords = function (next) {
    try {
      const stored = localStorage.getItem(key);
      if (stored && JSON.stringify(JSON.parse(stored)) !== JSON.stringify(data)) throw new Error('다른 화면에서 저장 내용이 변경되었습니다. 초안은 유지됩니다. 새로고침 후 최신 내용을 확인해 주세요.');
      if (data.some(project => !next.some(record => record.id === project.id))) throw new Error('과제를 영구 삭제할 수 없습니다. 보관 승인 요청을 이용해 주세요.');
      if (window.ReportRequestsModel) next = ReportRequestsModel.sync(next).projects;
      const now = new Date().toISOString();
      const enriched = next.map(input => {
        const previous = get(input.id), record = clone(input);
        if (!previous) {
          record._baseline = ApprovalModel.snapshot(record);
          record._audit = [event('과제 등록', { before: null, after: clone(ApprovalModel.snapshot(record)), changes: OperationsModel.changes(null, record) })];
          record.createdAt = now;
        } else {
          const planChanges = ApprovalModel.changes(previous, record);
          const newlyApproved = (record._changeRequests || []).find(request => request.status === 'approved' && (previous._changeRequests || []).some(old => old.id === request.id && old.status === 'pending'));
          if (planChanges.length && !newlyApproved) throw new Error('과제 정보와 목표는 변경 승인 후 반영할 수 있습니다.');
          if (planChanges.length && JSON.stringify(ApprovalModel.snapshot(record)) !== JSON.stringify(newlyApproved.candidate)) throw new Error('승인된 변경안과 저장 내용이 일치하지 않습니다.');
          record._audit = [...new Map([...auditEvents(previous), ...(record._audit || [])].map(item => [item.id, clone(item)])).values()];
          record._baseline = clone(previous._baseline || record._baseline || ApprovalModel.snapshot(previous));
          const reportChanges = OperationsModel.changes(previous, record).filter(change => /\.actual$|\.reason$|\.catchup$/.test(change.field));
          // Moving preserved reports into/out of the archive is covered by the approval event.
          if (reportChanges.length && !newlyApproved) record._audit.push(event('실적 변경', { changes: reportChanges, before: clone(PlanModel.isWeighted(previous)?{monthly:previous.monthly,stepReports:previous.stepReports}:previous.monthly || {}), after: clone(PlanModel.isWeighted(record)?{monthly:record.monthly,stepReports:record.stepReports}:record.monthly || {}) }));
          if (JSON.stringify(previous.monthlyArchive || {}) !== JSON.stringify(record.monthlyArchive || {})) record._audit.push(event('기간 외 월별 기록 보관·복원', { requestId: newlyApproved?.id || '', before: clone(previous.monthlyArchive || {}), after: clone(record.monthlyArchive || {}), changes: [] }));
          const previousRequests = previous._reportRequests || [];
          for (const request of record._reportRequests || []) {
            const before = previousRequests.find(old => old.requestId === request.requestId);
            if (!before || JSON.stringify(before) !== JSON.stringify(request)) {
              const action = !before ? '실적 입력 요청 생성' : request.status === 'cancelled' ? '실적 입력 요청 취소' : request.status === 'reported' ? '실적 입력 요청 완료' : before.status === request.status ? '실적 입력 요청 내보내기' : '실적 입력 요청 상태 변경';
              record._audit.push(event(action, { requestId: request.requestId, reason: request.cancellationReason || '', before: before ? clone(before) : null, after: clone(request), changes: [{ label: '실적 요청 상태', before: before?.status || '없음', after: request.status }] }));
            }
          }
        }
        if (!previous || JSON.stringify(previous) !== JSON.stringify(record)) {
          record.updatedAt = now;
          record._revision = (previous?._revision || 0) + 1;
        }
        return record;
      });
      return previousPersist(enriched);
    } catch (error) {
      toast(error.message || '변경사항을 저장하지 못했습니다. 입력 내용은 유지됩니다.', true);
      return false;
    }
  };

  function download(filename, content) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2)], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const requestStatusLabels = { awaiting_integration: '연동 대기', queued: '전송 대기', sending: '전송 중', sent: '발송 확인', delivered: '전달 확인', reported: '실적 입력 완료', cancelled: '취소', failed: '실패' };
  const changeValue = (change, side) => change.label === '실적 요청 상태' ? requestStatusLabels[change[side]] || historyValue(change[side]) : historyValue(change[side]);
  function diffMarkup(changes) {
    return changes?.length ? `<div class="approval-diff-wrap"><table class="approval-diff"><thead><tr><th>변경 항목</th><th>변경 전</th><th>변경 후</th></tr></thead><tbody>${changes.map(change => `<tr><th scope="row">${esc(change.label)}</th><td>${esc(changeValue(change,'before'))}</td><td>${esc(changeValue(change,'after'))}</td></tr>`).join('')}</tbody></table></div>` : '<p class="integration-help">상세 변경 항목이 없는 이전 기록입니다.</p>';
  }
  function baselineMarkup(project) {
    const baseline = project._baseline;
    if (!baseline) return '<p class="integration-help">기능 도입 전 과제입니다. 첫 변경 요청 시 현재 계획을 최초 보존 기준으로 기록합니다.</p>';
    const original = { ...baseline, stepReports:project.stepReports, monthly: Object.fromEntries(Object.entries(baseline.monthly || {}).map(([month, row]) => [month, { ...row, actual: (!PlanModel.isWeighted(baseline)&&PlanModel.isWeighted(project)?project.legacyAggregateReports?.monthly?.[month]?.actual:project.monthly?.[month]?.actual) ?? project.monthlyArchive?.[month]?.actual }])) };
    const initial = PlanModel.summary(original), current = progress(project);
    return `<div class="baseline-metrics"><div><span>최초 보존 계획 기준</span><strong>${esc(initial.label)}</strong><p>${esc(initial.note)}</p></div><div><span>현재 승인 계획 기준</span><strong>${esc(current.label)}</strong><p>${esc(current.note)}</p></div></div><details class="baseline-details"><summary>최초 보존 계획과 현재 계획 비교</summary>${diffMarkup(ApprovalModel.changes(baseline, project))}</details>`;
  }
  function history(project) {
    const events = auditEvents(project).map((item, index) => ({ ...item, _order: index })).sort((a, b) => String(b.at).localeCompare(String(a.at)) || b._order - a._order);
    return `<details class="history-panel"><summary>전체 활동 이력 <span>${events.length}건</span></summary><p class="history-notice">요청·승인·반려·철회·실적·메신저 요청을 기록합니다. 건수 제한 없이 이 브라우저에 보관하며, 인증된 변경자와 서버 감사 기록은 SSO 연결 후 적용됩니다. 과거에 이미 삭제된 기록은 복원할 수 없습니다.</p><div class="history-tools"><button class="secondary" type="button" data-export-history="${esc(project.id)}">이력 전체 내보내기</button></div>${events.map(item => `<article class="history-event"><div><strong>${esc(actionLabels[item.action] || item.action)}</strong><span>${esc(time(item.at))} · ${esc(actorName(item.actor))}${item.legacy ? ' · 이전 기록' : ' · 시연'}</span></div>${item.reason ? `<p class="audit-reason"><strong>변경·요청 사유</strong> ${esc(item.reason)}</p>` : ''}${item.comment ? `<p class="audit-reason"><strong>검토 의견</strong> ${esc(item.comment)}</p>` : ''}${item.requestId ? `<small class="audit-reference">요청 ${esc(item.requestId)}</small>` : ''}${diffMarkup(item.changes)}${item.before !== undefined || item.after !== undefined ? `<details class="audit-snapshot"><summary>보존된 상세 기록</summary><pre>${esc(JSON.stringify({ before: item.before, after: item.after }, null, 2))}</pre></details>` : ''}</article>`).join('') || '<p class="integration-help">아직 저장된 변경 이력이 없습니다.</p>'}</details>`;
  }
  historyMarkup = history;
  historyValue = value => Array.isArray(value) ? value.join(', ') : value == null || value === '' ? '미입력' : typeof value === 'object' ? JSON.stringify(value) : String(value);

  document.querySelector('#operationsNav').insertAdjacentHTML('afterend', '<div id="approvalsNav" class="dashnav" role="button" tabindex="0">✓ &nbsp;변경 승인 <span id="approvalNavCount"></span></div>');
  document.querySelector('#operationsPage').insertAdjacentHTML('afterend', '<main id="approvalsPage" class="main" hidden></main><main id="archivePage" class="main" hidden></main>');
  document.querySelector('#approvalsNav').onclick = () => showPage('approvals');
  document.querySelector('#approvalsNav').onkeydown = e => { if (e.key === 'Enter') showPage('approvals'); };
  document.querySelector('#listPage .panelhead').insertAdjacentHTML('beforeend', '<button class="text-button" type="button" id="archiveLink">보관 과제</button>');
  document.querySelector('#archiveLink').onclick = () => showPage('archive');
  const workflowLinks = document.createElement('div'); workflowLinks.className = 'workflow-links';
  workflowLinks.innerHTML = '<button class="secondary" type="button" data-workflow-approval>변경 승인함</button><button class="secondary" type="button" data-workflow-requests>실적 입력 요청</button>';
  workflowLinks.querySelector('[data-workflow-approval]').onclick = () => openApprovals();
  workflowLinks.querySelector('[data-workflow-requests]').onclick = () => showPage('reportRequests');
  document.querySelector('#listPage .operations-entry').after(workflowLinks);
  showPage = function (page) {
    document.querySelector('#approvalsPage').hidden = page !== 'approvals';
    document.querySelector('#archivePage').hidden = page !== 'archive';
    document.querySelector('#approvalsNav').classList.toggle('selected', page === 'approvals');
    previousShowPage(page);
    if (page === 'approvals') renderApprovals();
    if (page === 'archive') renderArchive();
    refreshBadge();
  };
  function refreshBadge() {
    const count = data.flatMap(project => project._changeRequests || []).filter(request => request.status === 'pending').length;
    document.querySelector('#approvalNavCount').textContent = count || '';
  }
  function requestFields(project) {
    return `<section class="form-section approval-request-fields"><h2>변경 승인 요청</h2><p>현재 계획은 승인 전까지 유지됩니다. 시작·종료일, 소속 팀, PO, 보관·복구 변경은 AT 담당장 검토 대상으로 분류합니다.</p><div class="grid"><div class="field"><label for="changeRequester">요청자 이름 · 시연 *</label><input id="changeRequester" name="changeRequester" value="${esc(project.po || project.pm || '시연 요청자')}" maxlength="100"><p class="integration-help">SSO 연결 후 로그인 사용자로 자동 지정됩니다.</p></div><div class="field"><label for="changeReason">변경 사유 *</label><textarea id="changeReason" name="changeReason" maxlength="2000" placeholder="변경 배경과 일정·목표에 미치는 영향을 작성하세요."></textarea></div></div></section>`;
  }
  function requestFromForm(candidate, previous) {
    try {
      const actor = { ...localActor(document.querySelector('#changeRequester')?.value || ''), role: 'project-representative', team: previous.team };
      const reason = document.querySelector('#changeReason')?.value || '';
      const updated = ApprovalModel.createRequest(previous, candidate, { actor, reason });
      if (!persistRecords(data.map(project => project.id === updated.id ? updated : project))) return false;
      render(); refreshBadge();
      selectedStatus = 'pending'; selectedProject = previous.id; showPage('approvals');
      toast('변경 승인을 요청했습니다. 승인 전까지 기존 과제와 목표를 유지합니다.');
      return true;
    } catch (error) { showRegistrationErrors([{ message: error.message }]); return false; }
  }
  openForm = function (id) {
    if (id && get(id)?.archivedAt) { toast('보관된 과제는 복구 승인 후 수정할 수 있습니다.', true); return; }
    previousOpenForm(id);
    if (!id) return;
    const pending = (get(id)._changeRequests || []).find(request => request.status === 'pending');
    const actions = document.querySelector('#registrationPage .registration-actions');
    if (pending) {
      const banner = document.createElement('div'); banner.className = 'approval-pending-notice';
      banner.innerHTML = '<strong>승인 대기 중인 변경 요청이 있습니다.</strong><p>추가 변경을 요청하려면 기존 요청을 철회하거나 검토를 완료해 주세요.</p><button type="button" class="text-button">대기 중인 요청 보기</button>';
      banner.querySelector('button').onclick = () => openApprovals(id);
      actions.before(banner); actions.querySelector('[type="submit"]').disabled = true;
    }
  };

  function requests() {
    return data.flatMap(project => (project._changeRequests || []).map(request => ({ project, request }))).sort((a, b) => b.request.requestedAt.localeCompare(a.request.requestedAt));
  }
  function renderApprovals() {
    const all = requests(), visible = all.filter(({ project, request }) => (!selectedStatus || request.status === selectedStatus) && (!selectedProject || project.id === selectedProject));
    const host = document.querySelector('#approvalsPage');
    host.innerHTML = `<div class="top"><div><div class="eyebrow">CHANGE APPROVAL</div><h1>과제 변경 승인</h1><p>변경 전후를 비교하고 사유를 검토한 뒤 반영하세요.</p></div><button class="secondary" type="button" id="approvalBack">전체 과제 보기</button></div><div class="banner">승인 절차 시연 · SSO 미연동 상태입니다. 이름·역할 입력은 검토 흐름을 확인하기 위한 것이며 실제 계정 권한을 부여하지 않습니다.</div><div class="approval-tabs">${[['pending','승인 대기'],['approved','승인'],['rejected','반려'],['withdrawn','철회'],['','전체']].map(([status, label]) => `<button class="${selectedStatus === status ? 'active' : ''}" data-approval-status="${status}">${label} <strong>${all.filter(item => !status || item.request.status === status).length}</strong></button>`).join('')}</div><div class="field approval-project-filter"><label for="approvalProjectFilter">과제</label><select id="approvalProjectFilter"><option value="">전체 과제</option>${data.filter(project => project._changeRequests?.length).map(project => `<option value="${esc(project.id)}" ${selectedProject === project.id ? 'selected' : ''}>${esc(project.title)}</option>`).join('')}</select></div><div class="approval-cards">${visible.map(({ project, request }) => {
      const role = ApprovalModel.requiredRole(request.base, request.candidate), pending = request.status === 'pending';
      return `<article class="panel approval-card" data-approval-card="${esc(request.id)}"><div class="approval-card-head"><div><span class="approval-state ${esc(request.status)}">${labels[request.status] || esc(request.status)}</span><h2>${esc(project.title)}</h2><p>${esc(request.base.team || project.team)} · 요청자 ${esc(actorName(request.requester))} · ${esc(time(request.requestedAt))}</p></div><button class="text-button" type="button" data-approval-detail="${esc(project.id)}">과제 상세</button></div><div class="approval-reason"><strong>변경 사유</strong><p>${esc(request.reason)}</p></div><p class="approval-reviewer">검토 역할: ${role === 'at-head' ? 'AT 담당장' : '소속 팀장 또는 AT 담당장'} · 요청 ${esc(request.id)}</p>${diffMarkup(request.changes)}${pending ? `<details class="approval-review"><summary>승인 / 반려 / 철회 처리</summary><div class="grid"><div class="field"><label>처리자 이름 · 시연 *</label><input data-review-name aria-label="처리자 이름 · 시연" maxlength="100" placeholder="실제 요청자와 다른 검토자 이름"></div><div class="field"><label>처리 역할 · 시연</label><select data-review-role aria-label="처리 역할 · 시연"><option value="team-lead" ${role === 'team-lead' ? 'selected' : ''}>팀장</option><option value="at-head" ${role === 'at-head' ? 'selected' : ''}>AT 담당장</option><option value="requester">요청자 · 철회 전용</option></select></div><div class="field"><label>소속 팀 · 팀장 검토 시 확인</label><input data-review-team aria-label="소속 팀 · 팀장 검토" value="${esc(request.base.team || '')}" maxlength="100"></div><div class="field"><label>검토 의견 / 반려·철회 사유 *</label><textarea data-review-comment aria-label="검토 의견 / 반려·철회 사유" maxlength="2000" placeholder="처리 사유를 남겨 주세요."></textarea></div></div><div class="approval-error" role="alert" hidden></div><div class="approval-decision-actions"><button class="secondary" data-decision="withdrawn">요청 철회</button><button class="secondary danger" data-decision="rejected">반려</button><button class="primary" data-decision="approved">승인 및 반영</button></div></details>` : `<div class="approval-result"><strong>${esc(labels[request.status])}</strong><p>${esc(actorName(request.reviewer || request.decidedBy || request.decisionActor || request.requester))} · ${esc(time(request.decidedAt || request.updatedAt || request.requestedAt))}</p><p>${esc(request.comment || request.decisionComment || '')}</p></div>`}</article>`;
    }).join('') || '<div class="panel empty">이 조건에 해당하는 변경 요청이 없습니다.</div>'}</div>`;
    host.querySelector('#approvalBack').onclick = () => showPage('list');
    host.querySelector('#approvalProjectFilter').onchange = e => { selectedProject = e.target.value; renderApprovals(); };
    host.querySelectorAll('[data-approval-status]').forEach(button => button.onclick = () => { selectedStatus = button.dataset.approvalStatus; renderApprovals(); });
    host.querySelectorAll('[data-approval-detail]').forEach(button => button.onclick = () => detail(button.dataset.approvalDetail));
    host.querySelectorAll('[data-approval-card]').forEach(card => card.querySelectorAll('[data-decision]').forEach(button => button.onclick = () => decide(card, button.dataset.decision)));
  }
  function decide(card, decision) {
    const errorBox = card.querySelector('.approval-error');
    try {
      const item = requests().find(item => item.request.id === card.dataset.approvalCard);
      if (!item) throw new Error('변경 요청을 찾을 수 없습니다.');
      const name = card.querySelector('[data-review-name]').value.trim(), role = card.querySelector('[data-review-role]').value, comment = card.querySelector('[data-review-comment]').value.trim();
      if (!name) throw new Error('처리자 이름을 입력해 주세요.');
      if (!comment) throw new Error('처리 사유 또는 검토 의견을 입력해 주세요.');
      const actor = { ...localActor(name), role, team: card.querySelector('[data-review-team]').value.trim() };
      const updated = ApprovalModel.decide(item.project, item.request.id, { decision, actor, comment });
      if (!persistRecords(data.map(project => project.id === updated.id ? updated : project))) return;
      render(); refreshBadge(); renderApprovals();
      toast(decision === 'approved' ? '변경안을 승인하고 반영했습니다. 최신 실적은 유지됩니다.' : decision === 'rejected' ? '변경 요청을 반려했습니다. 기존 계획을 유지합니다.' : '변경 요청을 철회했습니다.');
    } catch (error) { errorBox.hidden = false; errorBox.textContent = error.message; errorBox.scrollIntoView({ block: 'nearest' }); }
  }
  function openApprovals(id) { closeModal(); selectedProject = id || ''; selectedStatus = ''; showPage('approvals'); }
  detail = function (id) {
    if (!get(id)) return;
    previousDetail(id);
    const project = get(id), section = document.createElement('section'); section.className = 'baseline-panel';
    section.innerHTML = '<h3>계획 기준 및 변경 승인</h3>' + baselineMarkup(project) + `<button class="secondary" data-show-approvals>변경 요청 ${project._changeRequests?.length || 0}건 보기</button>`;
    section.querySelector('[data-show-approvals]').onclick = () => openApprovals(id);
    document.querySelector('#dialog .actions').before(section);
    const remove = document.querySelector('#dialog .actions .danger');
    if (remove) { remove.textContent = project.archivedAt ? '복구 승인 요청' : '보관 승인 요청'; remove.onclick = () => archiveRequest(id); }
    if (project.archivedAt) document.querySelectorAll('#dialog .actions button:not(.danger)').forEach(button => { button.disabled = true; });
    document.querySelectorAll('[data-export-history]').forEach(button => button.onclick = () => exportHistory(button.dataset.exportHistory));
  };
  function archiveRequest(id) {
    const project = get(id); if (!project) return;
    closeModal(); showPage('approvals');
    const host = document.querySelector('#approvalsPage'), box = document.createElement('section'); box.className = 'panel archive-request-form';
    box.innerHTML = `<h2>${project.archivedAt ? '복구' : '보관'} 승인 요청 · ${esc(project.title)}</h2><p>AT 담당장 승인 후 반영됩니다. 과제 데이터와 활동 이력은 보존합니다.</p><div class="grid"><div class="field"><label>요청자 이름 · 시연 *</label><input data-archive-name aria-label="보관·복구 요청자 이름" value="${esc(project.po || project.pm || '시연 요청자')}" maxlength="100"></div><div class="field"><label>요청 사유 *</label><textarea data-archive-reason aria-label="보관·복구 요청 사유" maxlength="2000"></textarea></div></div><div class="approval-error" role="alert" hidden></div><div class="actions"><button type="button" class="secondary" data-archive-cancel>취소</button><button type="button" class="primary" data-archive-submit>승인 요청</button></div>`;
    host.querySelector('.banner').after(box);
    box.querySelector('[data-archive-cancel]').onclick = renderApprovals;
    box.querySelector('[data-archive-submit]').onclick = () => {
      try {
        const current = get(id), actor = { ...localActor(box.querySelector('[data-archive-name]').value), team: current.team };
        const candidate = { ...current, archivedAt: current.archivedAt ? null : new Date().toISOString() };
        const updated = ApprovalModel.createRequest(current, candidate, { actor, reason: box.querySelector('[data-archive-reason]').value });
        if (!persistRecords(data.map(record => record.id === id ? updated : record))) return;
        selectedProject = id; selectedStatus = 'pending'; renderApprovals(); refreshBadge(); toast('보관·복구 승인을 요청했습니다.');
      } catch (error) { const area = box.querySelector('.approval-error'); area.hidden = false; area.textContent = error.message; }
    };
  }
  removeItem = archiveRequest;
  function renderArchive() {
    const archived = data.filter(project => project.archivedAt);
    const host = document.querySelector('#archivePage');
    host.innerHTML = `<div class="top"><div><div class="eyebrow">PROJECT ARCHIVE</div><h1>보관 과제</h1><p>보관된 과제의 데이터와 이력을 확인하고 복구를 요청하세요.</p></div><button class="secondary" data-archive-back>전체 과제 보기</button></div><div class="approval-cards">${archived.map(project => `<article class="panel approval-card"><h2>${esc(project.title)}</h2><p>${esc(project.team)} · 보관 ${esc(time(project.archivedAt))}</p><div class="actions"><button class="secondary" data-archive-detail="${esc(project.id)}">상세 및 이력</button><button class="primary" data-archive-restore="${esc(project.id)}">복구 승인 요청</button></div></article>`).join('') || '<div class="panel empty">보관된 과제가 없습니다.</div>'}</div>`;
    host.querySelector('[data-archive-back]').onclick = () => showPage('list');
    host.querySelectorAll('[data-archive-detail]').forEach(button => button.onclick = () => detail(button.dataset.archiveDetail));
    host.querySelectorAll('[data-archive-restore]').forEach(button => button.onclick = () => archiveRequest(button.dataset.archiveRestore));
  }
  function exportHistory(id) {
    const project = get(id); if (!project) return;
    download('AT-project-history-' + id + '.json', { exportedAt: new Date().toISOString(), identity: 'demo-unconnected', project: clone(project), audit: clone(auditEvents(project)) });
  }
  window.ApprovalWorkflow = Object.freeze({ requestFields, requestFromForm, open: openApprovals, exportHistory, withActor(actor, task) { actorOverride = actor; try { return task(); } finally { actorOverride = null; } } });
  refreshBadge(); render();
})();
