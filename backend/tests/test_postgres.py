import os
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from uuid import uuid4
import pytest
import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool
from fastapi.testclient import TestClient
from app.db import migrate
from app.main import create_app
from app.config import Settings
from app.auth import get_actor
from app.schemas import Actor, ProjectPlan, ReportUpdate, ChangeRequest, Decision
from app.services import ProjectService
from app.errors import DomainError


@pytest.fixture
def pool():
    url = os.getenv("TEST_DATABASE_URL")
    if not url:
        pytest.skip("TEST_DATABASE_URL is required for real PostgreSQL tests")
    schema = "fastapi_test_" + uuid4().hex
    with psycopg.connect(url, autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
    try:
        with ConnectionPool(url, kwargs={"options": f"-c search_path={schema}", "row_factory": dict_row}, min_size=1, max_size=4) as pool:
            migrate(pool)
            migrate(pool)
            yield pool
    finally:
        with psycopg.connect(url, autocommit=True) as admin:
            admin.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


def test_database_workflow_locking_rollback_and_audit(pool, project, actor):
    service = ProjectService(pool)
    original = service.create(ProjectPlan.model_validate({**project, "_ownerId": "forged"}), actor)
    pid = original["id"]
    assert original["_ownerId"] == actor.id
    assert original["status"] == "계획"
    assert len(service.list()) == 1
    stranger = Actor(id="stranger", name="일반 사용자", role="member", team="AT팀")
    with pytest.raises(DomainError) as error:
        service.reports(pid, 1, ReportUpdate(stepReports={}), stranger)
    assert error.value.status == 403
    candidate = deepcopy(original)
    candidate["title"] = "승인할 제목"
    pending = service.request_change(pid, 1, ChangeRequest(candidate=ProjectPlan.model_validate(candidate), reason="제목 개선"), actor)
    request_id = pending["_changeRequests"][0]["id"]
    reported = service.reports(pid, 2, ReportUpdate.model_validate({"stepReports": {"a": {"2025-01": {"actual": 100}}, "b": {"2025-01": {"actual": 60}}}}), actor)
    assert reported["monthly"]["2025-01"]["actual"] == 76
    def write():
        try:
            return service.reports(pid, 3, ReportUpdate.model_validate({"stepReports": {"b": {"2025-02": {"actual": 100}}}}), actor)
        except DomainError as e:
            return e.status
    with ThreadPoolExecutor(max_workers=2) as threads:
        outcomes = list(threads.map(lambda _: write(), range(2)))
    assert sum(isinstance(r, dict) for r in outcomes) == 1
    assert 409 in outcomes
    with pytest.raises(DomainError):
        service.decide(pid, 4, request_id, Decision(decision="approved", comment="본인 승인"), actor)
    lead = Actor(id="lead", name="소속 팀장", role="team-lead", team="AT팀")
    approved = service.decide(pid, 4, request_id, Decision(decision="approved", comment="승인 완료"), lead)
    assert approved["title"] == "승인할 제목"
    assert approved["stepReports"]["b"]["2025-01"]["actual"] == 60
    assert approved["_revision"] == 5
    with pytest.raises(DomainError):
        service.reports(pid, 5, ReportUpdate.model_validate({"stepReports": {"unknown": {"2025-01": {"actual": 100}}}}), actor)
    assert service.get(pid)["_revision"] == 5
    assert len(service.history(pid)) == 5
    with pytest.raises(psycopg.Error, match="append-only"):
        with pool.connection() as conn:
            conn.execute("DELETE FROM audit_events WHERE project_id=%s", [pid])
    with pool.connection() as conn:
        assert conn.execute("SELECT count(*) AS count FROM schema_migrations").fetchone()["count"] == 4
        assert conn.execute("SELECT status FROM change_requests WHERE id=%s", [request_id]).fetchone()["status"] == "approved"


def test_postgres_http_contract(pool, project, actor):
    app = create_app(Settings(_env_file=None, app_env="test"), pool=pool)
    app.dependency_overrides[get_actor] = lambda: actor
    with TestClient(app) as client:
        assert client.get("/api/health").json()["framework"] == "fastapi"
        created = client.post("/api/projects", json=project)
        assert created.status_code == 201
        assert created.headers["etag"] == '"1"'
        pid = created.json()["id"]
        assert client.get(f"/api/projects/{pid}").status_code == 200
        assert client.get("/api/projects?limit=1").json()["projects"][0]["id"] == pid
        assert client.get("/api/projects?limit=501").status_code == 422
        assert client.put(f"/api/projects/{pid}/reports", json={"stepReports": {}}).status_code == 409
        invalid = client.put(f"/api/projects/{pid}/reports", headers={"If-Match": '"1"'}, json={"stepReports": {"a": {"2025-01": {"actual": 80}}}})
        assert invalid.status_code == 422
        history = client.get(f"/api/projects/{pid}/history?snapshots=true").json()["events"]
        assert len(history) == 1
        assert history[0]["after_document"]["id"] == pid
        assert client.get("/api/projects/unknown").status_code == 404


def test_knowledge_persistence_authorization_conflict_and_history(pool, actor, project):
    from app.schemas import KnowledgeUpdate
    service = ProjectService(pool)
    first = service.create(ProjectPlan.model_validate(project), actor)
    second = service.create(ProjectPlan.model_validate({**project,'title':'후속 과제'}), actor)
    stranger = Actor(id='stranger',name='구성원',role='member',team='AT팀')
    body = KnowledgeUpdate(problem='공정 변동',approach='단계 검증',result='검증 절차 확보',lessons='데이터 품질 선확인',conditions='동일 환경에서 재검증',status='published',relations=[{'projectId':second['id'],'type':'successor'}],artifacts=[{'title':'검증 가이드','url':'https://docs.example.test/guide'}])
    with pytest.raises(DomainError) as denied:
        service.save_knowledge(first['id'],1,body,stranger)
    assert denied.value.status == 403
    saved = service.save_knowledge(first['id'],1,body,actor)
    assert saved['_revision'] == 2
    assert saved['_knowledge']['updatedBy']['id'] == actor.id
    assert ProjectService(pool).get(first['id'])['_knowledge']['result'] == '검증 절차 확보'
    assert service.knowledge_index()['total'] == 2
    assert all('stepReports' not in p for p in service.knowledge_index()['projects'])
    event = service.history(first['id'])[0]
    assert event['action'] == 'knowledge_saved'
    assert event['details']['knowledgeChanges']['before'] is None
    with pytest.raises(DomainError) as stale:
        service.save_knowledge(first['id'],1,body,actor)
    assert stale.value.status == 409
    for invalid in ({'relations':[{'projectId':first['id'],'type':'related'}]}, {'relations':[{'projectId':'missing','type':'related'}]}, {'status':'published'}):
        with pytest.raises(DomainError):
            service.save_knowledge(first['id'],2,KnowledgeUpdate.model_validate(invalid),actor)
    assert service.get(first['id'])['_revision'] == 2
    candidate = {**saved,'title':'변경된 제목'}
    pending = service.request_change(first['id'],2,ChangeRequest(candidate=ProjectPlan.model_validate(candidate),reason='명칭 정리'),actor)
    lead = Actor(id='lead',name='팀장',role='team-lead',team=actor.team)
    approved = service.decide(first['id'],3,pending['_changeRequests'][-1]['id'],Decision(decision='approved',comment='확인'),lead)
    assert approved['_knowledge'] == saved['_knowledge']


def test_knowledge_auto_projection_document_search_confirm_and_stale_evidence(pool,actor,project,tmp_path):
    from app.schemas import KnowledgeQuery,KnowledgeDecision,KnowledgeUpdate
    from app.attachments import AttachmentService
    from app.knowledge_backfill import backfill
    service=ProjectService(pool)
    a=service.create(ProjectPlan.model_validate({**project,'title':'센서잡음 개선','background':'센서잡음 원인 조사','plan':'잡음 필터 적용'}),actor)
    b=service.create(ProjectPlan.model_validate({**project,'title':'센서잡음 선행 분석','background':'센서잡음 특성 정리'}),actor)
    files=AttachmentService(pool,tmp_path,20*1024*1024)
    uploaded=files.upload(b['id'],1,actor,'가이드.txt','적용 조건: 광학노이즈 환경\n주의: 측정값 재확인'.encode())
    candidates=service.recommend_knowledge(KnowledgeQuery(query='광학노이즈'))['candidates']
    assert candidates[0]['projectId']==b['id']
    assert candidates[0]['evidence'][0]['attachmentId']==uploaded['attachmentId']
    context=service.knowledge_context(a['id']);c=next(x for x in context['candidates'] if x['projectId']==b['id'])
    stranger=Actor(id='visitor',name='일반 구성원',role='member',team='AT팀')
    body=KnowledgeDecision(targetId=b['id'],targetToken=c['sourceToken'],contextToken=context['contextToken'],type='reuses',decision='accepted',evidencePath='background')
    with pytest.raises(DomainError) as denied:service.decide_knowledge(a['id'],1,body,stranger)
    assert denied.value.status==403
    saved=service.decide_knowledge(a['id'],1,body,actor)
    assert service.knowledge_context(a['id'])['metrics']['confirmedReuse']==1
    assert service.history(a['id'])[0]['details']['knowledgeDecisionChanges']['after']
    # Unrelated progress does not invalidate the cited problem statement.
    updated=service.reports(b['id'],2,ReportUpdate.model_validate({'stepReports':{'a':{'2025-01':{'actual':100}},'b':{'2025-01':{'actual':100}}}}),actor)
    assert service.knowledge_context(a['id'])['metrics']['confirmedReuse']==1
    # Changing the quoted problem through the normal approval path requires revalidation.
    pending=service.request_change(b['id'],updated['_revision'],ChangeRequest(candidate=ProjectPlan.model_validate({**updated,'background':'다른 문제로 전환'}),reason='문제 변경'),actor)
    lead=Actor(id='lead',name='팀장',role='team-lead',team=actor.team)
    service.decide(b['id'],pending['_revision'],pending['_changeRequests'][-1]['id'],Decision(decision='approved',comment='확인'),lead)
    current=service.knowledge_context(a['id'])
    assert current['metrics']['confirmedReuse']==0 and current['metrics']['needsReview']==1
    assert not [n for n in current['graph']['nodes'] if n['kind']=='relation']
    with pytest.raises(DomainError) as stale:service.decide_knowledge(a['id'],saved['_revision'],body,actor)
    assert stale.value.status==409
    doc_context=service.knowledge_context(b['id'])
    assert doc_context['documentSources'][0]['state']=='ready'
    assert doc_context['draft']['items']['conditions']['evidence'][0]['attachmentId']==uploaded['attachmentId']
    files.upload(b['id'],service.get(b['id'])['_revision'],actor,'가이드-v2.txt','적용 조건: 주파수노이즈 환경'.encode(),replaces_id=uploaded['attachmentId'])
    assert service.recommend_knowledge(KnowledgeQuery(query='광학노이즈'))['candidates']==[]
    assert service.recommend_knowledge(KnowledgeQuery(query='주파수노이즈'))['candidates'][0]['projectId']==b['id']
    assert backfill(pool,tmp_path)['indexed']==0  # Existing index is idempotent.
    own=service.knowledge_context(a['id'])['draft']['items']['problem']['evidence'][0]
    evidence={'field':'problem',**{k:own[k] for k in ('projectId','path','quote','revision')}}
    service.save_knowledge(a['id'],saved['_revision'],KnowledgeUpdate(problem='확인한 초안',sourceEvidence=[evidence]),actor)
    with pytest.raises(DomainError):service.save_knowledge(a['id'],saved['_revision']+1,KnowledgeUpdate(sourceEvidence=[{**evidence,'quote':'존재하지 않는 인용'}]),actor)
