"""Deterministic monthly time travel, including skipped months and human errors."""
from copy import deepcopy
from datetime import datetime
import pytest
from app import clock
from app.domain import plans, approvals
from app.errors import DomainError


def freeze(monkeypatch, value):
    monkeypatch.setattr(clock, 'utc_now', lambda: datetime.fromisoformat(value))


def timeline():
    months = plans.period('2027-12-01', '2028-03-31')
    return {'title':'월별 모사','team':'AT','tech':['All Tech'],'planMode':plans.MODE,
            'stepPlanMode':plans.WEIGHTED,'startDate':'2027-12-01','endDate':'2028-03-31',
            'steps':[{'id':'a','name':'검증','weight':100,'startDate':'2027-12-01','endDate':'2028-03-31',
                      'monthly':{m:{'goal':v} for m,v in zip(months,[25,50,75,100])}}], 'stepReports':{}}


@pytest.mark.parametrize('utc,month', [
    ('2027-12-31T14:59:59+00:00','2027-12'),('2027-12-31T15:00:00+00:00','2028-01'),
    ('2028-02-29T14:59:59+00:00','2028-02'),('2028-02-29T15:00:00+00:00','2028-03')])
def test_seoul_month_rollover_and_leap_year(monkeypatch,utc,month):
    freeze(monkeypatch,utc)
    assert plans.now_month()==month
    assert approvals.timestamp()==utc.replace('+00:00','Z')


def test_month_by_month_skip_then_backfill_after_project_end(monkeypatch):
    p=timeline(); plans.validate_plan(p)
    freeze(monkeypatch,'2027-11-30T14:00:00+00:00')
    assert plans.summary(p)['label']=='시작 전'
    freeze(monkeypatch,'2027-12-15T00:00:00+00:00')
    assert plans.summary(p)['missingMonths']==['2027-12']
    # December is forgotten. January reaches its target but December remains unknown.
    freeze(monkeypatch,'2028-01-31T00:00:00+00:00')
    p['stepReports']={'a':{'2028-01':{'actual':50}}}
    plans.validate_reports(p)
    assert plans.summary(p)['missingMonths']==['2027-12']
    assert 'actual' not in plans.totals(p)['monthly']['2027-12']
    # February lags, March meets only its own incremental target: still behind cumulative plan.
    for utc,month,actual in [('2028-02-29T00:00:00+00:00','2028-02',60),('2028-03-31T00:00:00+00:00','2028-03',85)]:
        freeze(monkeypatch,utc)
        p['stepReports']['a'][month]={'actual':actual,'reason':'검증 일정 지연','catchup':'추가 설비 검증'}
        plans.validate_reports(p)
        assert plans.summary(p)['late']
    # Backfill after the project period; retrospective month retained, clock not falsified.
    freeze(monkeypatch,'2028-04-10T00:00:00+00:00')
    p['stepReports']['a']['2027-12']={'actual':25}
    plans.validate_reports(p)
    assert plans.summary(p)['missingMonths']==[]
    assert plans.summary(p)['late']
    assert approvals.timestamp().startswith('2028-04-10')


@pytest.mark.parametrize('mistake', ['increment','wrong_month','over_100','missing_reason','missing_catchup','backfill_exceeds_later'])
def test_human_input_errors_are_rejected(monkeypatch,mistake):
    freeze(monkeypatch,'2028-01-20T00:00:00+00:00')
    p=timeline();rows={'2027-12':{'actual':25},'2028-01':{'actual':50}}
    p['stepReports']={'a':rows}
    if mistake=='increment':rows['2028-01']['actual']=10
    if mistake=='wrong_month':rows['2028-02']={'actual':75}
    if mistake=='over_100':rows['2028-01']['actual']=101
    if mistake=='missing_reason':rows['2028-01']={'actual':40,'catchup':'추가 검증'}
    if mistake=='missing_catchup':rows['2028-01']={'actual':40,'reason':'검증 지연'}
    if mistake=='backfill_exceeds_later':rows['2027-12']['actual']=60
    before=deepcopy(p)
    with pytest.raises(DomainError):plans.validate_reports(p)
    assert p==before
