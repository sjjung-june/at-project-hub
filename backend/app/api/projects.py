import re
from typing import Annotated
from fastapi import APIRouter, Depends, Header, Query, Request, Response
from ..auth import get_actor
from ..errors import DomainError
from ..schemas import Actor, ChangeRequest, Decision, KnowledgeUpdate, KnowledgeDecision, ProjectList, ProjectPlan, ReportUpdate
from ..services import ProjectService

router = APIRouter(prefix="/api/projects", tags=["Projects"])


def get_service(request: Request):
    if request.app.state.pool is None:
        raise DomainError("데이터베이스가 설정되지 않았습니다.", 503)
    return ProjectService(request.app.state.pool)


ActorDep = Annotated[Actor, Depends(get_actor)]
ServiceDep = Annotated[ProjectService, Depends(get_service)]


def get_revision(if_match: Annotated[str | None, Header()] = None):
    if if_match is None or not re.fullmatch(r'(?:[0-9]+|"[0-9]+")', if_match):
        raise DomainError('현재 버전의 If-Match 헤더가 필요합니다.', 409)
    return int(if_match.strip('"'))


RevisionDep = Annotated[int, Depends(get_revision)]


def etag(response, project):
    response.headers["ETag"] = f'"{project["_revision"]}"'
    return project


@router.get("", response_model=ProjectList)
def list_projects(actor: ActorDep, service: ServiceDep, limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0)):
    return {"projects": service.list(limit, offset), "limit": limit, "offset": offset}


@router.post("", status_code=201)
def create_project(payload: ProjectPlan, response: Response, actor: ActorDep, service: ServiceDep):
    return etag(response, service.create(payload, actor))


@router.get("/{project_id}")
def get_project(project_id: str, response: Response, actor: ActorDep, service: ServiceDep):
    return etag(response, service.get(project_id))


@router.put("/{project_id}/reports")
def save_reports(project_id: str, body: ReportUpdate, response: Response, actor: ActorDep, service: ServiceDep, revision: RevisionDep):
    return etag(response, service.reports(project_id, revision, body, actor))


@router.post("/{project_id}/change-requests")
def request_change(project_id: str, body: ChangeRequest, response: Response, actor: ActorDep, service: ServiceDep, revision: RevisionDep):
    return etag(response, service.request_change(project_id, revision, body, actor))


@router.post("/{project_id}/change-requests/{request_id}/decisions")
def decide(project_id: str, request_id: str, body: Decision, response: Response, actor: ActorDep, service: ServiceDep, revision: RevisionDep):
    return etag(response, service.decide(project_id, revision, request_id, body, actor))


@router.get("/{project_id}/history")
def history(project_id: str, actor: ActorDep, service: ServiceDep, limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0), snapshots: bool = False):
    return {"events": service.history(project_id, limit, offset, snapshots), "limit": limit, "offset": offset}


@router.put('/{project_id}/knowledge')
def save_knowledge(project_id: str, body: KnowledgeUpdate, response: Response, actor: ActorDep, service: ServiceDep, revision: RevisionDep):
    return etag(response, service.save_knowledge(project_id, revision, body, actor))


@router.get('/{project_id}/knowledge-context')
def knowledge_context(project_id: str, actor: ActorDep, service: ServiceDep):
    return service.knowledge_context(project_id)


@router.post('/{project_id}/knowledge-decisions')
def decide_knowledge(project_id: str, body: KnowledgeDecision, response: Response, actor: ActorDep, service: ServiceDep, revision: RevisionDep):
    return etag(response,service.decide_knowledge(project_id,revision,body,actor))
