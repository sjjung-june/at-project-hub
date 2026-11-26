from typing import Annotated
from fastapi import APIRouter, Depends, File, Form, Request, UploadFile, Response, Query
from fastapi.responses import FileResponse
from .projects import ActorDep, ServiceDep, RevisionDep, etag
from ..attachments import AttachmentService
from ..reporting import ReportingService
from ..schemas import ReportReview, KnowledgeQuery
from ..errors import DomainError

router=APIRouter(prefix='/api',tags=['Pilot workflow'])


def reporting(request:Request):
    if request.app.state.pool is None:raise DomainError('데이터베이스가 설정되지 않았습니다.',503)
    return ReportingService(request.app.state.pool)


def attachments(request:Request):
    if request.app.state.pool is None:raise DomainError('데이터베이스가 설정되지 않았습니다.',503)
    s=request.app.state.settings
    return AttachmentService(request.app.state.pool,s.attachment_dir,s.attachment_max_bytes)


ReportsDep=Annotated[ReportingService,Depends(reporting)]
FilesDep=Annotated[AttachmentService,Depends(attachments)]


@router.get('/me')
def me(actor:ActorDep):return actor


@router.get('/me/projects')
def my_projects(actor:ActorDep,service:ServiceDep):
    projects=service.list_mine(actor)
    return {'projects':projects,'total':len(projects)}


@router.get('/statistics')
def statistics(month:str,actor:ActorDep,service:ReportsDep,team:str|None=None):return service.statistics(month,team)


@router.post('/projects/{pid}/months/{month}/submit')
def submit(pid:str,month:str,response:Response,actor:ActorDep,service:ReportsDep,revision:RevisionDep):
    return etag(response,service.submit(pid,month,revision,actor))


@router.post('/projects/{pid}/submissions/{sid}/review')
def review(pid:str,sid:str,body:ReportReview,response:Response,actor:ActorDep,service:ReportsDep,revision:RevisionDep):
    return etag(response,service.review(pid,sid,revision,body,actor))


@router.get('/projects/{pid}/submissions')
def submissions(pid:str,actor:ActorDep,service:ReportsDep,month:str|None=None):return {'submissions':service.submissions(pid,month)}


@router.get('/projects/{pid}/attachments')
def list_files(pid:str,actor:ActorDep,service:FilesDep):return {'attachments':service.list(pid)}


@router.post('/projects/{pid}/attachments',status_code=201)
def upload(pid:str,actor:ActorDep,service:FilesDep,revision:RevisionDep,file:Annotated[UploadFile,File()],step_id:Annotated[str|None,Form()]=None,month:Annotated[str|None,Form()]=None,replaces_id:Annotated[str|None,Form()]=None):
    try:
        data=file.file.read(service.max_bytes+1)
        result=service.upload(pid,revision,actor,file.filename,data,step_id,month,replaces_id)
        return result
    finally:file.file.close()


@router.get('/projects/{pid}/attachments/{aid}/download')
def download(pid:str,aid:str,actor:ActorDep,service:FilesDep):
    path,name=service.download(pid,aid)
    return FileResponse(path,filename=name,media_type='application/octet-stream',headers={'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store'})


@router.get('/knowledge')
def knowledge_index(actor: ActorDep, service: ServiceDep, limit: int = Query(200, ge=1, le=500), offset: int = Query(0, ge=0)):
    return service.knowledge_index(limit, offset)


@router.post('/knowledge/recommendations')
def recommend_knowledge(body: KnowledgeQuery, actor: ActorDep, service: ServiceDep):
    return service.recommend_knowledge(body)
