"""Pilot personas: owner, participant, team lead, other team, head.
Real DB + HTTP integration; no in-memory repository substitutes.
"""
from copy import deepcopy
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from app.main import create_app
from app.config import Settings
from app.auth import get_actor
from app.schemas import Actor
from app.domain.plans import totals
from app.attachments import safe_filename, validate_content
from app.errors import DomainError
from test_postgres import pool


def sample():
    return {'title':'[파일럿] 다개년 공정 개선','team':'AT팀','tech':['DRAM ALL'],'startDate':'2024-12-01','endDate':'2025-02-28','stepPlanMode':'weighted-steps-v1','steps':[{'id':'a','name':'분석','weight':40,'startDate':'2024-12-01','endDate':'2024-12-31','completionCriteria':'분석 보고서 검토 완료','evidenceRequired':True,'monthly':{'2024-12':{'goal':100}}},{'id':'b','name':'검증','weight':60,'startDate':'2025-01-01','endDate':'2025-02-28','monthly':{'2025-01':{'goal':50},'2025-02':{'goal':100}}}]}


@pytest.fixture
def pilot(pool,tmp_path):
    settings=Settings(_env_file=None,app_env='test',attachment_dir=tmp_path,attachment_max_bytes=1024)
    app=create_app(settings,pool)
    app.state.person=Actor(id='owner',name='과제 대표',role='project-representative',team='AT팀')
    app.dependency_overrides[get_actor]=lambda:app.state.person
    with TestClient(app) as client:
        yield client,app,tmp_path


def create(client):
    response=client.post('/api/projects',json=sample());assert response.status_code==201,response.text
    return response.json()


def update(client,project,path,body=None):
    response=client.post(f"/api/projects/{project['id']}/{path}",headers={'If-Match':f'"{project["_revision"]}"'},json=body)
    return response


def save(client,p,rows):
    response=client.put(f"/api/projects/{p['id']}/reports",headers={'If-Match':f'"{p["_revision"]}"'},json={'stepReports':rows});assert response.status_code==200,response.text
    return response.json()


def upload(client,p,name='결과.txt',data=b'evidence',step='a',month='2024-12',replacement=None):
    form={'step_id':step,'month':month}
    if replacement:form['replaces_id']=replacement
    return client.post(f"/api/projects/{p['id']}/attachments",headers={'If-Match':f'"{p["_revision"]}"'},data=form,files={'file':(name,data,'text/plain')})


def lead(app):app.state.person=Actor(id='lead',name='소속 팀장',role='team-lead',team='AT팀')


def test_P01_multiyear_evidence_submit_review_freeze_and_plan_change(pilot):
    client,app,root=pilot;p=create(client);pid=p['id']
    assert p['monthly']['2024-12']['goal']==40
    assert p['monthly']['2025-01']['goal']==70
    assert p['monthly']['2025-02']['goal']==100
    # Saved-but-incomplete report cannot be submitted and zero isn't missing.
    bad=update(client,p,'months/2024-12/submit');assert bad.status_code==422
    p=save(client,p,{'a':{'2024-12':{'actual':100}}})
    bad=update(client,p,'months/2024-12/submit');assert bad.status_code==422 and '증빙' in bad.text
    file=upload(client,p);assert file.status_code==201,file.text
    aid=file.json()['attachmentId'];p=file.json()['project']
    # Server accepts authenticated downloads, original filename never becomes disk path.
    download=client.get(f'/api/projects/{pid}/attachments/{aid}/download');assert download.content==b'evidence'
    assert download.headers['x-content-type-options']=='nosniff'
    assert 'attachment;' in download.headers['content-disposition']
    submitted=update(client,p,'months/2024-12/submit');assert submitted.status_code==200,submitted.text
    p=submitted.json();sid=p['_reporting']['2024-12']['id']
    assert update(client,p,'months/2024-12/submit').status_code==409
    assert update(client,p,f'submissions/{sid}/review',{'decision':'approved','comment':'본인 검토'}).status_code==403
    assert upload(client,p).status_code==409
    locked=client.put(f'/api/projects/{pid}/reports',headers={'If-Match':f'"{p["_revision"]}"'},json={'stepReports':{'a':{'2024-12':{'actual':90}}}});assert locked.status_code==409
    lead(app)
    reviewed=update(client,p,f'submissions/{sid}/review',{'decision':'approved','comment':'증빙과 실적 확인'});assert reviewed.status_code==200,reviewed.text
    p=reviewed.json()
    frozen=client.get(f'/api/projects/{pid}/submissions?month=2024-12').json()['submissions'][0]['snapshot']
    assert frozen['monthly']['actual']==40 and frozen['attachments'][0]['id']==aid
    # Next-year reporting carries completed Step; doesn't demand repeated upload.
    app.state.person=Actor(id='owner',name='과제 대표',role='project-representative',team='AT팀')
    p=save(client,p,{'b':{'2025-01':{'actual':40,'reason':'설비 검증 지연','catchup':'2월 추가 검증'},'2025-02':{'actual':100}}})
    assert p['monthly']['2025-01']['actual']==64
    assert p['monthly']['2025-02']['actual']==100
    # Change weights after closing last year: stored closed-month values must not change.
    candidate=deepcopy(p);candidate['steps'][0]['weight']=20;candidate['steps'][1]['weight']=80
    request=update(client,p,'change-requests',{'candidate':candidate,'reason':'차년도 비중 조정'});assert request.status_code==200,request.text
    p=request.json();rid=p['_changeRequests'][-1]['id']
    lead(app)
    approved=update(client,p,f'change-requests/{rid}/decisions',{'decision':'approved','comment':'차년도 계획 검토'});assert approved.status_code==200,approved.text
    p=approved.json()
    assert p['monthly']['2024-12']['actual']==20 # current-plan recalculation is distinguished
    old=client.get(f'/api/projects/{pid}/submissions?month=2024-12').json()['submissions'][0]['snapshot']
    assert old==frozen
    stats=client.get('/api/statistics?month=2024-12').json()
    assert stats['items'][0]['actual']==40
    assert stats['items'][0]['basis']=='approved_snapshot'
    assert stats['counts']['approved']==1
    assert client.get('/api/statistics?month=2025-01').json()['counts']['late']==1
    assert client.get('/api/statistics?month=2025-02').json()['counts']['onTarget']==1
    assert list(root.iterdir()) and client.get(f'/api/projects/{pid}/history').json()['events']


def test_P02_return_correct_and_resubmit_preserves_old_submission(pilot):
    client,app,root=pilot;p=create(client);pid=p['id']
    p=save(client,p,{'a':{'2024-12':{'actual':80,'reason':'분석 보완','catchup':'검토 후 완료'}}})
    p=update(client,p,'months/2024-12/submit').json();sid=p['_reporting']['2024-12']['id']
    app.state.person=Actor(id='other-lead',name='타 팀장',role='team-lead',team='다른 팀')
    assert update(client,p,f'submissions/{sid}/review',{'decision':'returned','comment':'검토'}).status_code==403
    lead(app);result=update(client,p,f'submissions/{sid}/review',{'decision':'returned','comment':'근거 보완 필요'});assert result.status_code==200,result.text
    p=result.json();app.state.person=Actor(id='owner',name='과제 대표',role='project-representative',team='AT팀')
    p=save(client,p,{'a':{'2024-12':{'actual':100}}});file=upload(client,p);p=file.json()['project']
    result=update(client,p,'months/2024-12/submit');assert result.status_code==200,result.text
    p=result.json();assert p['_reporting']['2024-12']['id']!=sid
    submissions=client.get(f'/api/projects/{pid}/submissions').json()['submissions']
    assert len(submissions)==2
    assert next(s for s in submissions if s['id']==sid)['snapshot']['monthly']['actual']==32
    assert next(s for s in submissions if s['id']==sid)['review_comment']=='근거 보완 필요'


def test_P03_attachment_errors_versions_and_transaction_cleanup(pilot):
    client,app,root=pilot;p=create(client);pid=p['id']
    assert upload(client,p,name='malware.exe').status_code==422
    assert upload(client,p,data=b'').status_code==422
    assert upload(client,p,data=b'x'*1025).status_code==413
    assert upload(client,p,step='unknown').status_code==422
    assert upload(client,p,name='fake.pdf').status_code==422
    assert not list(root.iterdir())
    first=upload(client,p);assert first.status_code==201
    p=first.json()['project'];aid=first.json()['attachmentId']
    # Stale upload is rejected without leaving bytes or changing revision.
    stale=upload(client,{**p,'_revision':1});assert stale.status_code==409
    assert len(list(root.iterdir()))==1
    new=upload(client,p,data=b'version two',replacement=aid);assert new.status_code==201
    p=new.json()['project']
    assert client.get(f'/api/projects/{pid}/attachments/{aid}/download').content==b'evidence'
    files=client.get(f'/api/projects/{pid}/attachments').json()['attachments'];assert len(files)==2 and files[0]['replaces_id']==aid
    app.state.person=Actor(id='stranger',name='일반 구성원',role='member',team='AT팀')
    assert upload(client,p).status_code==403
    other=create(client)
    assert client.get(f"/api/projects/{other['id']}/attachments/{aid}/download").status_code==404


def test_P04_same_month_statistics_never_uses_previous_month(pilot):
    client,app,root=pilot;p=create(client)
    p=save(client,p,{'a':{'2024-12':{'actual':100}}})
    result=client.get('/api/statistics?month=2025-01').json()
    assert result['counts']['missing']==1
    assert result['counts']['reported']==0
    assert result['items'][0]['actual'] is None
    assert client.get('/api/statistics?month=2024-11').json()['counts']['notStarted']==1
    assert client.get('/api/statistics?month=2025-03').json()['counts']['ended']==1
    assert client.get('/api/statistics?month=2025-01&team=타팀').json()['counts']['eligible']==0
    assert client.get('/api/statistics?month=2025-13').status_code==422


def test_P05_public_auth_is_required_for_files_and_reporting():
    app=create_app(Settings(_env_file=None,app_env='test'))
    with TestClient(app) as client:
        assert client.get('/api/projects/x/attachments').status_code==401
        assert client.get('/api/projects/x/attachments/y/download').status_code==401
        assert client.get('/api/statistics?month=2025-01').status_code==401
        assert client.get('/api/me').status_code==401


@pytest.mark.parametrize('name',['file.exe','file.html','file.svg','', 'x'*201+'.txt'])
def test_P06_unsupported_filenames(name):
    with pytest.raises(DomainError):safe_filename(name)


def test_P07_filename_is_never_a_storage_path():
    assert safe_filename('../../evidence.txt')=='evidence.txt'
    assert safe_filename('C:\\temp\\evidence.txt')=='evidence.txt'
    with pytest.raises(DomainError):validate_content('image.png',b'<html>')
