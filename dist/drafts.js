// Browser-local working copies stay separate from the saved project records.
(function () {
  'use strict';
  const storageKey = 'at-project-working-drafts-v1';
  const originalOpenForm = openForm;
  const originalSelectPerformance = selectPerformance;
  const originalSubmitForm = submitForm;
  const originalSavePerformance = savePerformance;
  const originalPersistRecords = persistRecords;
  const originalFillEvenGoals = fillEvenGoals;
  const newProjectKey = '__new__';
  let stored;
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey));
    stored = parsed && parsed.version === 1 ? parsed : null;
  } catch (_) { /* An unreadable working copy must not affect saved projects. */ }
  stored = { version: 1, registration: {}, reports: {}, ...(stored || {}) };
  if (!stored.registration || typeof stored.registration !== 'object') stored.registration = {};
  if (!stored.reports || typeof stored.reports !== 'object') stored.reports = {};
  let registrationBaseline = '', reportBaseline = '', saving = null;
  let localSaveFailed = false;
  const recovered = { registration: false, reports: false };
  const clone = value => JSON.parse(JSON.stringify(value));
  const project = id => data.find(record => record.id === id);
  const regKey = () => registrationId || newProjectKey;

  function signature(record) {
    const source = JSON.stringify(record || null);
    let hash = 2166136261;
    for (let index = 0; index < source.length; index++) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${source.length}:${(hash >>> 0).toString(16)}`;
  }

  function writeStore() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(stored));
      localSaveFailed = false;
      return true;
    } catch (_) {
      localSaveFailed = true;
      return false;
    }
  }

  function isVisible(id) {
    const element = document.getElementById(id);
    return element && !element.hidden;
  }

  function registrationSnapshot() {
    const form = document.querySelector('#registrationPage #form');
    if (!form) return null;
    readAnnualGoals();
    return {
      values: [...new FormData(form).entries()].map(([name, value]) => [name, String(value)]),
      monthly: clone(draftMonthly), steps: window.StepUI?.snapshot(), year: goalYear
    };
  }

  function reportSnapshot() {
    if (!performanceId || !document.querySelector('#performanceContent #reportGrid')) return null;
    readReport();
    return { monthly: clone(performanceDraft), stepReports: PlanModel.isWeighted(project(performanceId)) ? window.StepUI?.reportSnapshot() : undefined, year: reportYear };
  }

  function comparable(snapshot) {
    return snapshot ? JSON.stringify({ values: snapshot.values, monthly: snapshot.monthly, steps: snapshot.steps, stepReports: snapshot.stepReports }) : '';
  }

  function stamp(snapshot, record) {
    return { ...snapshot, baseSignature: signature(record),
      baseUpdatedAt: record?.updatedAt || null, updatedAt: new Date().toISOString() };
  }

  function rememberRegistration() {
    if (!isVisible('registrationPage') || saving) return;
    const snapshot = registrationSnapshot();
    if (!snapshot) return;
    const id = regKey();
    if (comparable(snapshot) === registrationBaseline) {
      delete stored.registration[id];
      recovered.registration = false;
    } else stored.registration[id] = stamp(snapshot, project(registrationId));
    writeStore();
    renderNotice('registration');
  }

  function rememberReport() {
    if (!isVisible('performancePage') || saving) return;
    const snapshot = reportSnapshot();
    if (!snapshot) return;
    if (comparable(snapshot) === reportBaseline) {
      delete stored.reports[performanceId];
      recovered.reports = false;
    } else stored.reports[performanceId] = stamp(snapshot, project(performanceId));
    writeStore();
    renderNotice('reports');
  }

  function formattedTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
    }).format(date);
  }

  function renderNotice(kind) {
    const registration = kind === 'registration';
    const host = document.querySelector(registration ? '#registrationPage #form' : '#performanceContent');
    if (!host) return;
    const noticeId = registration ? 'registrationDraftStatus' : 'reportDraftStatus';
    let notice = document.getElementById(noticeId);
    if (!notice) {
      notice = document.createElement('div');
      notice.id = noticeId;
      notice.className = 'local-draft-notice';
      notice.setAttribute('role', 'status');
      host.prepend(notice);
    }
    const id = registration ? regKey() : performanceId;
    const snapshot = stored[kind][id];
    if (localSaveFailed) {
      notice.classList.add('draft-warning');
      notice.innerHTML = '<div><strong>임시저장 공간을 확인해 주세요.</strong><span>현재 입력은 화면에 유지됩니다. 임시저장이 완료되지 않았으므로 화면을 닫기 전에 과제 저장을 이용해 주세요.</span></div>';
      return;
    }
    const current = project(registration ? registrationId : performanceId);
    const stale = snapshot && snapshot.baseSignature !== signature(current);
    notice.classList.toggle('draft-warning', Boolean(stale));
    if (!snapshot) {
      notice.innerHTML = '<div><strong>입력 중인 내용은 이 브라우저에 임시저장됩니다.</strong><span>과제에 반영하려면 아래 저장 버튼을 눌러 주세요.</span></div>';
      return;
    }
    const ready = registration || Boolean(document.querySelector('#performanceContent #reportGrid'));
    notice.innerHTML = `<div><strong>${stale ? '저장된 과제가 변경되어 임시 내용을 자동 복원하지 않았습니다.' : recovered[kind] ? '이 브라우저의 임시 내용을 복원했습니다.' : '이 브라우저에 임시저장됨'}</strong><span>${esc(formattedTime(snapshot.updatedAt))} · ${stale ? '불러오기는 입력 화면에만 적용됩니다. 최신 과제와 비교한 뒤 저장해 주세요.' : '과제에는 아직 반영되지 않았습니다. 저장 버튼으로 확정하세요.'}${!ready ? ' 먼저 과제 목표 계획을 확인해 주세요.' : ''}</span></div><div class="draft-actions">${stale && ready ? `<button type="button" class="text-button" onclick="Drafts.restore('${kind}')">임시 내용 불러오기</button>` : ''}<button type="button" class="text-button" onclick="Drafts.discard('${kind}')">임시 내용 버리기</button></div>`;
  }

  function restoreRegistration(snapshot) {
    const form = document.querySelector('#registrationPage #form');
    if (!form || !Array.isArray(snapshot.values) || !snapshot.monthly || typeof snapshot.monthly !== 'object') return false;
    const values = new Map();
    snapshot.values.forEach(([name, value]) => {
      if (!values.has(name)) values.set(name, []);
      values.get(name).push(String(value));
    });
    [...form.elements].forEach(element => {
      if (!element.name || !['INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName)) return;
      const entries = values.get(element.name) || [];
      if (element.type === 'checkbox' || element.type === 'radio') element.checked = entries.includes(element.value);
      else element.value = entries[0] ?? '';
    });
    window.StepUI?.restore(snapshot.steps);
    draftMonthly = clone(snapshot.monthly);
    goalYear = Number(snapshot.year) || Number(PlanModel.today().slice(0, 4));
    // updatePeriod reads the visible grid before rebuilding; remove the saved
    // grid so that it cannot overwrite recovered goals from another year.
    if (!window.StepUI?.enabled()) document.querySelector('#annualGrid').innerHTML = '';
    updatePeriod();
    // Keep intentionally blank or incomplete draft goals, including the final month.
    draftMonthly = clone(snapshot.monthly);
    renderAnnualGrid();
    renderGoalFeedback();
    return true;
  }

  function restoreReport(snapshot) {
    const current = project(performanceId);
    if (!current || !document.querySelector('#reportGrid') || !snapshot.monthly || typeof snapshot.monthly !== 'object') return false;
    performanceDraft = clone(current.monthly || {});
    // A reporting working copy can recover report fields, never goal values.
    for (const month of PlanModel.periodMonths(current.startDate, current.endDate)) {
      const row = snapshot.monthly[month];
      if (!row || typeof row !== 'object') continue;
      performanceDraft[month] ??= {};
      for (const field of ['actual', 'reason', 'catchup']) {
        if (Object.prototype.hasOwnProperty.call(row, field)) performanceDraft[month][field] = row[field];
        else delete performanceDraft[month][field];
      }
    }
    const yearSelect = document.querySelector('#reportYear');
    if ([...yearSelect.options].some(option => option.value === String(snapshot.year))) {
      reportYear = Number(snapshot.year);
      yearSelect.value = String(reportYear);
    }
    if (PlanModel.isWeighted(current)) StepUI.restoreReports(snapshot.stepReports);
    drawReportGrid();
    reportPreview();
    return true;
  }

  function restore(kind, manual = false) {
    const registration = kind === 'registration';
    const id = registration ? regKey() : performanceId;
    const snapshot = stored[kind]?.[id];
    if (!snapshot) return false;
    const current = project(registration ? registrationId : performanceId);
    if (!manual && snapshot.baseSignature !== signature(current)) return false;
    const restored = registration ? restoreRegistration(snapshot) : restoreReport(snapshot);
    if (!restored) return false;
    if (manual) {
      snapshot.baseSignature = signature(current);
      snapshot.baseUpdatedAt = current?.updatedAt || null;
      writeStore();
    }
    recovered[kind] = true;
    renderNotice(kind);
    toast('이 브라우저의 임시 내용을 복원했습니다. 저장 전 내용을 확인해 주세요.');
    return true;
  }

  openForm = function (...args) {
    const result = originalOpenForm.apply(this, args);
    recovered.registration = false;
    registrationBaseline = comparable(registrationSnapshot());
    restore('registration');
    renderNotice('registration');
    return result;
  };

  selectPerformance = function (...args) {
    const result = originalSelectPerformance.apply(this, args);
    recovered.reports = false;
    reportBaseline = comparable(reportSnapshot());
    if (performanceId) {
      restore('reports');
      renderNotice('reports');
    }
    return result;
  };

  fillEvenGoals = function (...args) {
    const result = originalFillEvenGoals.apply(this, args);
    rememberRegistration();
    return result;
  };

  submitForm = function (...args) {
    saving = { kind: 'registration', id: args[1] || newProjectKey };
    try { return originalSubmitForm.apply(this, args); }
    finally { saving = null; }
  };

  savePerformance = function (...args) {
    saving = { kind: 'reports', id: performanceId };
    try { return originalSavePerformance.apply(this, args); }
    finally { saving = null; }
  };

  persistRecords = function (...args) {
    const result = originalPersistRecords.apply(this, args);
    if (result && saving) {
      delete stored[saving.kind][saving.id];
      recovered[saving.kind] = false;
      writeStore();
      if (saving.kind === 'reports') {
        reportBaseline = comparable(reportSnapshot());
        renderNotice('reports');
      }
    }
    return result;
  };

  function capture(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('#registrationPage #form')) {
      if (target.matches('[name], [data-goal-month]') || target.id === 'goalYear' && stored.registration[regKey()]) rememberRegistration();
    } else if (target.closest('#performanceContent')) {
      if (target.matches('[data-report-month]') || target.id === 'reportYear' && stored.reports[performanceId]) rememberReport();
    }
  }
  document.addEventListener('step-draft-change', event => event.detail === 'registration' ? rememberRegistration() : rememberReport());
  document.addEventListener('input', capture);
  document.addEventListener('change', capture);

  window.Drafts = Object.freeze({
    restore: kind => restore(kind, true),
    discard(kind) {
      if (!['registration', 'reports'].includes(kind)) return;
      const id = kind === 'registration' ? regKey() : performanceId;
      delete stored[kind][id];
      recovered[kind] = false;
      writeStore();
      if (kind === 'registration') {
        const returnPage = registrationReturn;
        openForm(registrationId || undefined);
        registrationReturn = returnPage;
      } else selectPerformance(performanceId);
      toast('임시 내용을 버리고 저장된 내용으로 돌아갔습니다.');
    },
    count: () => Object.keys(stored.registration).length + Object.keys(stored.reports).length
  });

  document.head.insertAdjacentHTML('beforeend', '<style>.local-draft-notice{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:0 0 20px;padding:13px 16px;border:1px solid #dce8f5;border-radius:9px;background:#f4f8fd;color:#526d94;font-size:13px}.local-draft-notice strong,.local-draft-notice span{display:block;line-height:1.6}.local-draft-notice strong{font-size:13px}.local-draft-notice span{font-size:12px;color:#78889f}.local-draft-notice.draft-warning{border-color:#efd7aa;background:#fffbf1;color:#946616}.draft-actions{display:flex;gap:10px;flex-wrap:wrap;flex-shrink:0}.draft-actions .text-button{font-size:12px;white-space:nowrap}@media(max-width:650px){.local-draft-notice{align-items:flex-start;flex-direction:column;gap:7px}}</style>');
})();
