const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const PlanModel = require('../dist/plan-model.js');

const source = fs.readFileSync(path.join(__dirname, '../dist/drafts.js'), 'utf8');
const storageKey = 'at-project-working-drafts-v1';
const copy = value => JSON.parse(JSON.stringify(value));
const projects = () => ['p', 'q'].map(id => ({ id, title: `Project ${id}`,
  startDate: '2026-01-01', endDate: '2026-01-31',
  monthly: { '2026-01': { goal: 100 } } }));

// These small DOM substitutes test persistence boundaries and wrapper lifecycle.
// Real inputs, navigation and browser reload are also checked in the browser.
function harness(options = {}) {
  const storage = options.storage || new Map();
  const nodes = {}, listeners = {};
  const element = () => ({ hidden: false, innerHTML: '',
    classList: { add() {}, toggle() {} }, setAttribute() {},
    prepend(child) { nodes[child.id] = child; } });
  const form = element();
  form.elements = [
    { name: 'title', tagName: 'INPUT', type: 'text', value: '' },
    { name: 'startDate', tagName: 'INPUT', type: 'date', value: '2026-01-01' },
    { name: 'endDate', tagName: 'INPUT', type: 'date', value: '2026-01-31' },
    { name: 'tech', tagName: 'INPUT', type: 'checkbox', value: 'All Tech', checked: false }
  ];
  const registration = element(), reporting = element(), content = element();
  const grid = element(), annual = element();
  const year = { options: [{ value: '2026' }], value: '2026' };
  registration.hidden = reporting.hidden = true;
  class Element {
    constructor(kind) { this.kind = kind; }
    closest(selector) {
      return this.kind === 'registration' && selector.includes('#registrationPage')
        || this.kind === 'report' && selector === '#performanceContent';
    }
    matches(selector) {
      return selector.includes(this.kind === 'registration' ? '[name]' : '[data-report-month]');
    }
  }
  const context = {
    Date, Intl, JSON, Math, Map, Element, PlanModel, window: {},
    data: copy(options.data || projects()), failSave: false,
    registrationId: '', goalYear: 2026, draftMonthly: {},
    performanceId: '', reportYear: 2026, performanceDraft: {},
    localStorage: { getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value) },
    FormData: class {
      constructor(current) { this.current = current; }
      entries() {
        return this.current.elements.filter(field => field.type !== 'checkbox' || field.checked)
          .map(field => [field.name, field.value])[Symbol.iterator]();
      }
    },
    document: {
      getElementById: id => nodes[id] || ({ registrationPage: registration, performancePage: reporting }[id]),
      querySelector(selector) {
        return ({ '#registrationPage #form': form, '#performanceContent': content,
          '#performanceContent #reportGrid': context.performanceId ? grid : null,
          '#reportGrid': context.performanceId ? grid : null,
          '#annualGrid': annual, '#reportYear': year }[selector]) || null;
      },
      createElement: element, addEventListener: (type, callback) => { listeners[type] = callback; },
      head: { insertAdjacentHTML() {} }
    },
    esc: value => String(value), toast() {}, readAnnualGoals() {}, readReport() {},
    updatePeriod() {}, renderAnnualGrid() {}, renderGoalFeedback() {},
    drawReportGrid() {}, reportPreview() {}, fillEvenGoals() {},
    persistRecords(next) {
      if (context.failSave) return false;
      context.data = copy(next);
      return true;
    }
  };
  context.openForm = function (id) {
    context.registrationId = id || '';
    registration.hidden = false;
    reporting.hidden = true;
    form.elements[0].value = context.data.find(record => record.id === id)?.title || '';
    form.elements[3].checked = false;
    context.draftMonthly = {};
  };
  context.selectPerformance = function (id) {
    context.performanceId = id;
    registration.hidden = true;
    reporting.hidden = false;
    context.performanceDraft = copy(context.data.find(record => record.id === id)?.monthly || {});
  };
  context.submitForm = function () { return context.persistRecords(context.data); };
  context.savePerformance = function () {
    return context.persistRecords(context.data.map(record => record.id === context.performanceId
      ? { ...record, monthly: copy(context.performanceDraft) } : record));
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { context, form, storage,
    input: kind => listeners.input({ target: new Element(kind) }),
    savedDrafts: () => JSON.parse(storage.get(storageKey) || '{"registration":{},"reports":{}}') };
}

test('opening untouched forms does not create working copies', () => {
  const { context } = harness();
  context.openForm();
  context.selectPerformance('p');
  assert.equal(context.window.Drafts.count(), 0);
});

test('registration recovery survives reopening and a fresh runtime without saving the project', () => {
  const first = harness();
  first.context.openForm();
  first.form.elements[0].value = 'Recovered title';
  first.form.elements[3].checked = true;
  first.context.draftMonthly = { '2026-01': { goal: '' } };
  first.input('registration');
  assert.equal(first.context.data.length, 2);
  const fresh = harness({ storage: first.storage });
  fresh.context.openForm();
  assert.equal(fresh.form.elements[0].value, 'Recovered title');
  assert.equal(fresh.form.elements[3].checked, true);
  assert.equal(fresh.context.draftMonthly['2026-01'].goal, '');
  assert.equal(fresh.context.data.length, 2);
});

test('switching projects recovers each report independently and saving clears only its working copy', () => {
  const { context, input, savedDrafts } = harness();
  context.selectPerformance('p');
  context.performanceDraft['2026-01'].actual = 75;
  input('report');
  context.selectPerformance('q');
  context.performanceDraft['2026-01'].actual = 45;
  input('report');
  context.selectPerformance('p');
  assert.equal(context.performanceDraft['2026-01'].actual, 75);
  assert.equal(context.data[0].monthly['2026-01'].actual, undefined);
  context.savePerformance();
  assert.equal(context.data[0].monthly['2026-01'].actual, 75);
  assert.deepEqual(Object.keys(savedDrafts().reports), ['q']);
  context.selectPerformance('q');
  assert.equal(context.performanceDraft['2026-01'].actual, 45);
});

test('changed saved data blocks automatic recovery and manual report recovery preserves the new goal', () => {
  const { context, input } = harness();
  context.selectPerformance('p');
  context.performanceDraft['2026-01'].actual = 75;
  input('report');
  context.data[0].monthly['2026-01'].goal = 90;
  context.selectPerformance('p');
  assert.equal(context.performanceDraft['2026-01'].actual, undefined);
  assert.equal(context.window.Drafts.restore('reports'), true);
  assert.equal(context.performanceDraft['2026-01'].actual, 75);
  assert.equal(context.performanceDraft['2026-01'].goal, 90);
  assert.equal(context.data[0].monthly['2026-01'].actual, undefined);
});

test('failed report saves preserve working copies; a later successful save clears them', () => {
  const { context, input } = harness();
  context.selectPerformance('p');
  context.performanceDraft['2026-01'].actual = 75;
  input('report');
  context.failSave = true;
  context.savePerformance();
  assert.equal(context.window.Drafts.count(), 1);
  assert.equal(context.data[0].monthly['2026-01'].actual, undefined);
  context.selectPerformance('p');
  assert.equal(context.performanceDraft['2026-01'].actual, 75);
  context.failSave = false;
  context.savePerformance();
  assert.equal(context.window.Drafts.count(), 0);
  assert.equal(context.data[0].monthly['2026-01'].actual, 75);
});

test('registration working copies clear only after a successful save', () => {
  const { context, form, input } = harness();
  context.openForm();
  form.elements[0].value = 'Keep until committed';
  input('registration');
  context.failSave = true;
  context.submitForm({}, '');
  assert.equal(context.window.Drafts.count(), 1);
  context.failSave = false;
  context.submitForm({}, '');
  assert.equal(context.window.Drafts.count(), 0);
});
