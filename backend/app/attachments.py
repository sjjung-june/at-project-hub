from hashlib import sha256
from pathlib import Path
from uuid import uuid4
from psycopg.types.json import Jsonb
from .domain import plans
from .errors import DomainError
from .services import ProjectService, assert_edit
from .reporting import check_month, assert_month_editable

ALLOWED = {'.pdf': 'application/pdf', '.txt':'text/plain', '.csv':'text/csv', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation'}


def safe_filename(value):
    name=(value or '').replace('\\','/').split('/')[-1]
    name=''.join(c for c in name if c.isprintable() and c not in '\r\n').strip()
    if not name or len(name)>200 or Path(name).suffix.lower() not in ALLOWED:
        raise DomainError('첨부 가능한 파일은 PDF·Office 문서·이미지·TXT·CSV이며 파일명은 200자 이하여야 합니다.')
    return name


def validate_content(name,data):
    suffix=Path(name).suffix.lower()
    if not data:
        raise DomainError('빈 파일은 첨부할 수 없습니다.')
    prefixes={'.pdf':b'%PDF-', '.png':b'\x89PNG\r\n\x1a\n', '.jpg':b'\xff\xd8\xff', '.jpeg':b'\xff\xd8\xff', '.docx':b'PK', '.xlsx':b'PK', '.pptx':b'PK'}
    if suffix in prefixes and not data.startswith(prefixes[suffix]):
        raise DomainError('파일 내용과 확장자가 일치하지 않습니다.')
    if suffix in ('.txt','.csv'):
        try:data.decode('utf-8-sig')
        except UnicodeDecodeError:raise DomainError('TXT·CSV는 UTF-8 파일로 첨부해 주세요.') from None


class AttachmentService:
    def __init__(self,pool,directory,max_bytes):
        self.pool,self.root,self.max_bytes=pool,Path(directory),max_bytes
        self.projects=ProjectService(pool)

    def list(self,pid):
        self.projects.get(pid)
        with self.pool.connection() as conn:
            return conn.execute('SELECT id,project_id,step_id,report_month,filename,content_type,size_bytes,sha256,replaces_id,created_by,created_at FROM attachments WHERE project_id=%s ORDER BY created_at DESC,id',[pid]).fetchall()

    def upload(self,pid,revision,actor,filename,data,step_id=None,month=None,replaces_id=None):
        name=safe_filename(filename)
        if len(data)>self.max_bytes:
            raise DomainError(f'파일은 {self.max_bytes//1024//1024}MB 이하로 첨부해 주세요.',413)
        validate_content(name,data)
        aid=str(uuid4());key=aid;path=self.root/key
        saved=False
        def change(project,conn):
            nonlocal saved
            assert_edit(project,actor)
            if project.get('archivedAt'):raise DomainError('보관 과제에는 첨부할 수 없습니다.')
            if step_id and step_id not in {s['id'] for s in project.get('steps',[])}:raise DomainError('등록되지 않은 Step입니다.')
            if month:
                check_month(month);assert_month_editable(project,month)
                if month not in plans.period(project['startDate'],project['endDate']):raise DomainError('과제 기간에 속한 월을 선택해 주세요.')
            if replaces_id:
                old=conn.execute('SELECT id,step_id,report_month FROM attachments WHERE id=%s AND project_id=%s',[replaces_id,pid]).fetchone()
                if not old or old['step_id']!=step_id or old['report_month']!=month:raise DomainError('같은 Step·보고 월에 연결된 파일만 새 버전으로 등록할 수 있습니다.')
            self.root.mkdir(parents=True,exist_ok=True)
            # Unpredictable storage keys; original filenames never become disk paths.
            with path.open('xb') as stream:stream.write(data)
            saved=True
            conn.execute('INSERT INTO attachments(id,project_id,step_id,report_month,filename,content_type,size_bytes,sha256,storage_key,replaces_id,created_by) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',[aid,pid,step_id,month,name,ALLOWED[Path(name).suffix.lower()],len(data),sha256(data).hexdigest(),key,replaces_id,Jsonb(actor.model_dump())])
            project['_lastAttachment']={'id':aid,'filename':name,'stepId':step_id,'month':month,'sha256':sha256(data).hexdigest()}
            return project
        try:
            project=self.projects._mutate(pid,revision,actor,'attachment_uploaded',change,with_connection=True)
            return {'project':project,'attachmentId':aid}
        except Exception:
            if saved:path.unlink(missing_ok=True)
            raise

    def download(self,pid,aid):
        self.projects.get(pid)
        with self.pool.connection() as conn:
            row=conn.execute('SELECT filename,storage_key FROM attachments WHERE id=%s AND project_id=%s',[aid,pid]).fetchone()
        if not row:raise DomainError('첨부파일을 찾을 수 없습니다.',404)
        # Stored keys are generated UUIDs; validate again before resolving any file.
        try:uuid=__import__('uuid').UUID(row['storage_key'])
        except (ValueError,TypeError):raise DomainError('첨부파일 저장 정보를 확인해 주세요.',503) from None
        path=self.root/str(uuid)
        if not path.is_file():raise DomainError('첨부파일을 불러오지 못했습니다. 관리자에게 확인해 주세요.',503)
        return path,row['filename']
