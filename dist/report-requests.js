// Corporate messenger handoff preparation; delivery requires a server adapter and SSO identities.
(function () {
  'use strict';
  const model = ReportRequestsModel;
  const originalPage = showPage, originalPersist = persistRecords;
  let requestMonth = PlanModel.monthNow(), requestDue = '', requestTeam = '';
  let chosenProjects = new Set(), chosenRequests = new Set(), cancelId = '';
  const actor = '시연 사용자 · SSO 미연동';
  const labels = { awaiting_integration: '연동 대기', queued: '전송 대기', sending: '전송 중', sent: '발송 확인', delivered: '전달 확인', reported: '실적 입력 완료', cancelled: '취소', failed: '실패' };
  document.querySelector('#performanceNav').insertAdjacentHTML('beforebegin', '<div id="reportRequestsNav" class="dashnav" role="button" tabindex="0">✉ &nbsp;실적 요청</div>');
  document.querySelector('#operationsPage').insertAdjacentHTML('afterend', '<main id="reportRequestsPage" class="main" hidden></main>');
  document.querySelector('#reportRequestsNav').onclick = () => showPage('reportRequests');
  document.querySelector('#reportRequestsNav').onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showPage('reportRequests'); } };
  persistRecords = function (next) { return originalPersist(model.sync(next).projects); };
  showPage = function (page) {
    document.querySelector('#reportRequestsPage').hidden = page !== 'reportRequests';
    document.querySelector('#reportRequestsNav').classList.toggle('selected', page === 'reportRequests');
    originalPage(page);
    if (page === 'reportRequests') {
      const synced = model.sync(data);
      if (synced.changed) persistRecords(synced.projects);
      renderRequests();
    }
  };
  function dateText(value) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' }).format(date); }
  function allRequests() { return data.flatMap(project => (project._reportRequests || []).map(request => ({ ...request, currentTitle: project.title, team: project.team, projectArchived: Boolean(project.archivedAt) }))).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))); }
  function renderRequests() {
    const candidates = model.candidates(data, requestMonth, { team: requestTeam });
    const available = candidates.filter(item => !item.alreadyRequested);
    chosenProjects = new Set([...chosenProjects].filter(id => available.some(item => item.projectId === id)));
    const history = allRequests(), exportable = model.outbound(data, history.map(item => item.requestId));
    chosenRequests = new Set([...chosenRequests].filter(id => exportable.some(item => item.requestId === id)));
    const teams = [...new Set(data.filter(project => !project.archivedAt).map(project => project.team).filter(Boolean))].sort();
    const holder = document.querySelector('#reportRequestsPage');
    holder.innerHTML = `<div class="top"><div><div class="eyebrow">MONTHLY REPORT REQUESTS</div><h1>실적 입력 요청</h1><p>미입력 과제를 골라 담당 PM에게 보낼 요청을 준비하세요.</p></div><button class="secondary" id="requestsList">전체 과제 보기</button></div>
      <div class="banner request-connection"><strong>사내 메신저 연동 전</strong><span>요청 준비와 이력 관리가 가능합니다. 실제 메시지는 발송되지 않으며, 연동 후 담당자 계정 확인과 발송 결과를 연결합니다.</span></div>
      <section class="panel"><div class="panelhead"><div><h2>요청 대상 선택</h2><p class="integration-help">선택 월의 실적이 없는 진행 과제를 찾습니다. 0%를 입력한 과제와 완료·보류·보관 과제는 제외합니다.</p></div></div>
      <div class="request-filters"><div class="field"><label for="requestMonth">요청 대상 월</label><input id="requestMonth" type="month" max="${PlanModel.monthNow()}" value="${esc(requestMonth)}"></div><div class="field"><label for="requestDue">입력 기한 *</label><input id="requestDue" type="date" min="${PlanModel.today()}" value="${esc(requestDue)}" required></div><div class="field"><label for="requestTeam">소속 팀</label><select id="requestTeam"><option value="">전체 팀</option>${teams.map(team => `<option ${team === requestTeam ? 'selected' : ''}>${esc(team)}</option>`).join('')}</select></div></div>
      <div class="request-selection"><label><input type="checkbox" id="requestSelectAll" ${available.length && chosenProjects.size === available.length ? 'checked' : ''} ${available.length ? '' : 'disabled'}> 요청 가능한 과제 전체 선택</label><span>${available.length}개 요청 가능 · ${chosenProjects.size}개 선택</span></div>
      ${candidates.length ? `<div class="request-candidates">${candidates.map(item => `<label class="request-candidate ${item.alreadyRequested ? 'request-disabled' : ''}"><input type="checkbox" data-request-project="${esc(item.projectId)}" ${chosenProjects.has(item.projectId) ? 'checked' : ''} ${item.alreadyRequested ? 'disabled' : ''}><span><strong>${esc(item.title)}</strong><small>${esc(item.team || '팀 미지정')} · PM ${esc(item.pm)}</small></span>${item.alreadyRequested ? '<span class="request-status">기존 요청 있음</span>' : ''}</label>`).join('')}</div>` : '<div class="empty">현재 조건에서 요청할 미입력 과제가 없습니다.</div>'}
      <div class="request-preview" id="requestPreview"></div><div id="requestErrors" class="form-error-summary" role="alert" hidden></div><div class="actions request-actions"><span>요청은 PM 기준으로 준비됩니다. 실제 수신 계정은 SSO 연동 시 확인합니다.</span><button class="primary" id="prepareRequests" ${chosenProjects.size ? '' : 'disabled'}>요청 준비 ${chosenProjects.size ? `(${chosenProjects.size})` : ''}</button></div></section>
      <section class="panel request-history"><div class="panelhead"><div><h2>요청 이력</h2><p class="integration-help">연동 대기는 미발송 상태입니다. 실적이 입력되면 요청이 완료로 전환됩니다.</p></div><button class="secondary" id="exportRequests" ${chosenRequests.size ? '' : 'disabled'}>연동 요청 파일 ${chosenRequests.size ? `(${chosenRequests.size})` : ''}</button></div>
      ${history.length ? `<div class="request-history-list">${history.map(item => `<article class="request-history-item"><div class="request-history-top"><label class="request-export-choice"><input type="checkbox" data-request-export="${esc(item.requestId)}" aria-label="${esc(item.payload?.title || item.currentTitle)} 연동 요청 파일에 포함" ${chosenRequests.has(item.requestId) ? 'checked' : ''} ${exportable.some(request => request.requestId === item.requestId) ? '' : 'disabled'}><strong>${esc(item.payload?.title || item.currentTitle)}</strong></label><span class="request-status ${item.status === 'reported' ? 'request-reported' : ''}">${esc(labels[item.status] || item.status)}</span></div><p>${esc(item.payload?.reportMonth || '')} 실적 · PM ${esc(item.recipient?.name || '미지정')} · 입력 기한 ${esc(item.payload?.dueDate || '—')}</p><small>${esc(dateText(item.createdAt))} · ${esc(item.createdBy || actor)}</small>${item.cancellationReason ? `<p class="request-cancelled-reason">취소 사유: ${esc(item.cancellationReason)}</p>` : ''}<details><summary>요청 내용과 처리 이력</summary><pre>${esc(item.payload?.message || '')}</pre><ol class="request-events">${(item.events || []).map(event => `<li>${esc(dateText(event.at))} · ${esc(event.type === 'prepared' ? '요청 준비' : event.type === 'cancelled' ? '요청 취소' : event.type === 'reported' ? '실적 입력 확인' : event.type === 'export_prepared' ? '연동 요청 파일 준비' : event.type)} · ${esc(event.actor || '')}${event.reason ? ` · ${esc(event.reason)}` : ''}</li>`).join('')}</ol></details><div class="request-history-actions"><button class="text-button" data-request-open="${esc(item.requestId)}" ${item.projectArchived ? 'disabled' : ''}>실적 입력 화면</button>${item.status === 'awaiting_integration' ? `<button class="text-button" data-request-cancel="${esc(item.requestId)}">요청 취소</button>` : ''}</div>${cancelId === item.requestId ? `<div class="request-cancel-form"><label for="requestCancelReason">취소 사유 *</label><textarea id="requestCancelReason" rows="2" maxlength="2000" placeholder="요청을 취소하는 이유를 작성하세요."></textarea><div><button class="secondary" id="dismissCancel">닫기</button><button class="secondary" id="confirmCancel">취소 확정</button></div></div>` : ''}</article>`).join('')}</div>` : '<div class="empty">아직 준비한 요청이 없습니다.</div>'}</section>`;
    holder.querySelector('#requestsList').onclick = () => showPage('list');
    holder.querySelector('#requestMonth').onchange = event => { requestMonth = model.validMonth(event.target.value) && event.target.value <= PlanModel.monthNow() ? event.target.value : PlanModel.monthNow(); chosenProjects.clear(); renderRequests(); };
    holder.querySelector('#requestDue').onchange = event => { requestDue = event.target.value; drawPreview(); };
    holder.querySelector('#requestTeam').onchange = event => { requestTeam = event.target.value; chosenProjects.clear(); renderRequests(); };
    holder.querySelector('#requestSelectAll').onchange = event => { chosenProjects = new Set(event.target.checked ? available.map(item => item.projectId) : []); renderRequests(); };
    holder.querySelectorAll('[data-request-project]').forEach(input => input.onchange = () => { if (input.checked) chosenProjects.add(input.dataset.requestProject); else chosenProjects.delete(input.dataset.requestProject); renderRequests(); });
    holder.querySelectorAll('[data-request-export]').forEach(input => input.onchange = () => { if (input.checked) chosenRequests.add(input.dataset.requestExport); else chosenRequests.delete(input.dataset.requestExport); renderRequests(); });
    holder.querySelectorAll('[data-request-cancel]').forEach(button => button.onclick = () => { cancelId = button.dataset.requestCancel; renderRequests(); holder.querySelector('#requestCancelReason')?.focus(); });
    holder.querySelectorAll('[data-request-open]').forEach(button => button.onclick = () => { const request = history.find(item => item.requestId === button.dataset.requestOpen); openDeepLink(`#report=${encodeURIComponent(request.projectId)}&month=${request.payload.reportMonth}`); });
    holder.querySelector('#prepareRequests').onclick = prepareRequests;
    holder.querySelector('#exportRequests').onclick = exportRequests;
    const dismiss = holder.querySelector('#dismissCancel'), confirm = holder.querySelector('#confirmCancel');
    if (dismiss) dismiss.onclick = () => { cancelId = ''; renderRequests(); };
    if (confirm) confirm.onclick = () => { const result = model.cancel(data, cancelId, holder.querySelector('#requestCancelReason').value, actor); if (result.error) { showError(result.error); return; } if (!persistRecords(result.projects)) return; cancelId = ''; renderRequests(); toast('요청을 취소하고 사유를 기록했습니다.'); };
    drawPreview();
  }
  function drawPreview() {
    const box = document.querySelector('#requestPreview');
    if (!box) return;
    const items = model.candidates(data, requestMonth, { team: requestTeam }).filter(item => chosenProjects.has(item.projectId) && !item.alreadyRequested);
    box.innerHTML = items.length ? `<h3>메시지 미리보기</h3>${items.map(item => `<details><summary>${esc(item.title)} · PM ${esc(item.pm)}</summary><pre>[AT 과제 실적 입력 요청]\n과제: ${esc(item.title)}\n대상 월: ${esc(requestMonth)}\n담당 PM: ${esc(item.pm)}\n입력 기한: ${esc(requestDue || '기한을 지정해 주세요')}\n누적 진척률(%)을 입력해 주세요. 목표 미달 시 지연 사유와 Catch Up Plan을 함께 작성해 주세요.\n${esc(model.deepLink(location.href, item.projectId, requestMonth))}</pre></details>`).join('')}` : '';
  }
  function showError(message) { const box = document.querySelector('#requestErrors'); box.hidden = false; box.textContent = message; box.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  function prepareRequests() {
    requestDue = document.querySelector('#requestDue').value;
    const result = model.queue(data, [...chosenProjects], { month: requestMonth, dueDate: requestDue, actor, baseUrl: location.href });
    if (result.error) { showError(result.error); return; }
    if (!result.requests.length) { renderRequests(); showError('요청 대상이 변경되었습니다. 최신 실적과 기존 요청을 확인해 주세요.'); return; }
    if (!persistRecords(result.projects)) return;
    chosenProjects.clear(); renderRequests();
    toast(`${result.requests.length}개 요청을 연동 대기로 기록했습니다.${result.skipped.length ? ` 대상이 변경된 ${result.skipped.length}개는 제외했습니다.` : ''}`);
  }
  function exportRequests() {
    const exported = model.recordExport(data, [...chosenRequests], actor);
    const requests = exported.requests;
    if (!requests.length) { toast('연동 대기 중인 요청을 선택해 주세요.', true); return; }
    if (!persistRecords(exported.projects)) return;
    const bundle = { schemaVersion: 'at-report-request-v1', generatedAt: new Date().toISOString(), deliveryStatus: 'not_sent', requests };
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `AT-실적요청-${requestMonth}.json`; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    renderRequests();
    toast('선택한 연동 요청 파일을 내려받았습니다. 메시지는 발송되지 않았습니다.');
  }
  function openDeepLink(hash) {
    const value = typeof hash === 'string' ? hash : '';
    if (!/^#report=[^&]+&month=\d{4}-(?:0[1-9]|1[0-2])$/.test(value)) return false;
    let projectId, month;
    try { const params = new URLSearchParams(value.slice(1)); projectId = params.get('report'); month = params.get('month'); } catch { return false; }
    const project = data.find(item => String(item.id) === projectId && !item.archivedAt && !item.deletedAt);
    if (!project || !model.validMonth(month) || month > PlanModel.monthNow() || project.planMode !== 'cumulative-percent-v1' || PlanModel.validatePlan(project).length || !PlanModel.periodMonths(project.startDate, project.endDate).includes(month)) {
      toast('이 실적 입력 링크의 과제 또는 대상 월을 확인할 수 없습니다.', true); return false;
    }
    openPerformance(project.id);
    const year = Number(month.slice(0, 4)), select = document.querySelector('#reportYear');
    if (select && [...select.options].some(option => option.value === String(year))) { select.value = String(year); changeReportYear(year); }
    document.querySelector(`[data-report-month="${month}"][data-report-kind="actual"]`)?.focus();
    return true;
  }
  window.ReportRequests = Object.freeze({ openDeepLink, render: renderRequests });
  window.addEventListener('hashchange', () => openDeepLink(location.hash));
  if (location.hash.startsWith('#report=')) openDeepLink(location.hash);
})();
