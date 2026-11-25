from copy import deepcopy
from uuid import uuid4
from psycopg.types.json import Jsonb
from .domain import plans, approvals
from .errors import DomainError


def assert_edit(project, actor):
    if not (actor.role in ("at-head", "system-admin") or actor.role == "team-lead" and actor.team == project.get("team") or actor.id == project.get("_ownerId") or actor.id in project.get("_memberIds", [])):
        raise DomainError("이 과제를 수정할 권한이 없습니다.", 403)


def sync_requests(project):
    for request in project.get("_reportRequests", []):
        month = request.get("payload", {}).get("reportMonth")
        active = plans.period(project.get("startDate"), project.get("endDate"))
        valid = isinstance(month, str) and month in active and month <= plans.now_month()
        reported = valid and plans.percent(project.get("monthly", {}).get(month, {}).get("actual")) is not None
        at = approvals.timestamp()
        waiting = ("awaiting_integration", "queued", "sending", "sent", "delivered")
        if request.get("status") in waiting and reported:
            request.update(status="reported", resolvedAt=at)
            request.setdefault("events", []).append({"type": "reported", "at": at, "actor": "실적 입력 확인"})
        elif request.get("status") == "awaiting_integration" and (not valid or project.get("archivedAt") or project.get("status") in ("보류", "완료") or not project.get("pm", "").strip() or project.get("pm", "").strip() != request.get("recipient", {}).get("name", "").strip()):
            reason = "과제 상태·담당자 또는 목표 계획이 변경되어 요청 대상을 다시 확인해야 합니다."
            request.update(status="cancelled", cancelledAt=at, cancelledBy="요청 대상 재확인", cancellationReason=reason)
            request.setdefault("events", []).append({"type": "cancelled", "at": at, "actor": "요청 대상 재확인", "reason": reason})
    return project


def audit_details(before, after, action):
    details={'changes': approvals.changes(before,after) if before else []}
    if not before:return details
    reports=[]
    for kind in ('stepReports','monthly'):
        a,b=before.get(kind,{}),after.get(kind,{})
        if kind=='stepReports':
            groups=[(step_id,a.get(step_id,{}),b.get(step_id,{})) for step_id in a.keys()|b.keys()]
        else:groups=[('',a,b)]
        for step_id,old,new in groups:
            for month in old.keys()|new.keys():
                for field in ('actual','reason','catchup'):
                    previous,current=old.get(month,{}).get(field),new.get(month,{}).get(field)
                    if previous!=current:reports.append({'field':'.'.join(filter(None,[kind,step_id,month,field])),'before':previous,'after':current})
    if reports:details['reportChanges']=reports
    if action=='attachment_uploaded':details['attachment']=after.get('_lastAttachment')
    if before.get('_reporting',{})!=after.get('_reporting',{}):
        details['reportingChanges']={month:{'before':before.get('_reporting',{}).get(month),'after':state} for month,state in after.get('_reporting',{}).items() if before.get('_reporting',{}).get(month)!=state}
    return details


class ProjectService:
    def __init__(self, pool):
        self.pool = pool

    def list(self, limit=100, offset=0):
        with self.pool.connection() as conn:
            return [row["document"] for row in conn.execute("SELECT document FROM projects ORDER BY updated_at DESC,id LIMIT %s OFFSET %s", [limit, offset])]

    def list_mine(self, actor):
        # Account IDs are assigned by the trusted organization integration, never display-name matches.
        with self.pool.connection() as conn:
            return [row['document'] for row in conn.execute("SELECT document FROM projects WHERE document->>'_ownerId'=%s OR COALESCE(document->'_memberIds','[]'::jsonb) ? %s OR document->>'_poId'=%s OR document->>'_pmId'=%s ORDER BY updated_at DESC,id", [actor.id,actor.id,actor.id,actor.id])]

    def get(self, project_id):
        with self.pool.connection() as conn:
            row = conn.execute("SELECT document FROM projects WHERE id=%s", [project_id]).fetchone()
            if not row:
                raise DomainError("과제를 찾을 수 없습니다.", 404)
            return row["document"]

    def _save(self, conn, project, before, actor, action):
        project = sync_requests(deepcopy(project))
        project["_revision"] = (before.get("_revision", 0) if before else 0) + 1
        project["updatedAt"] = approvals.timestamp()
        if before:
            conn.execute("UPDATE projects SET title=%s,team=%s,revision=%s,document=%s,updated_at=now() WHERE id=%s", [project["title"], project["team"], project["_revision"], Jsonb(project), project["id"]])
        else:
            project["createdAt"] = project["updatedAt"]
            conn.execute("INSERT INTO projects(id,title,team,revision,document) VALUES(%s,%s,%s,%s,%s)", [project["id"], project["title"], project["team"], project["_revision"], Jsonb(project)])
        for request in project.get("_changeRequests", []):
            conn.execute("INSERT INTO change_requests(id,project_id,status,document) VALUES(%s,%s,%s,%s) ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,document=EXCLUDED.document", [request["id"], project["id"], request["status"], Jsonb(request)])
        conn.execute("INSERT INTO audit_events(id,project_id,action,actor,before_document,after_document,details) VALUES(%s,%s,%s,%s,%s,%s,%s)", [str(uuid4()), project["id"], action, Jsonb(actor.model_dump()), Jsonb(before) if before else None, Jsonb(project), Jsonb(audit_details(before, project, action))])
        return project

    def create(self, payload, actor):
        project = payload.model_dump(exclude_none=True)
        active = plans.period(project["startDate"], project["endDate"])
        project.update(id=str(uuid4()), status="계획", unit="%", stepReports={}, _ownerId=actor.id, _memberIds=[], archivedAt=None)
        plans.validate_plan(project)
        project.update(startMonth=active[0], endMonth=active[-1])
        project = plans.totals(project)
        # Creation accepts goals only, never forged reports, audit or approvals.
        project["_baseline"] = approvals.snapshot(project)
        with self.pool.connection() as conn:
            return self._save(conn, project, None, actor, "project_created")

    def _mutate(self, project_id, revision, actor, action, change, with_connection=False):
        with self.pool.connection() as conn:
            row = conn.execute("SELECT document,revision FROM projects WHERE id=%s FOR UPDATE", [project_id]).fetchone()
            if not row:
                raise DomainError("과제를 찾을 수 없습니다.", 404)
            if revision != row["revision"]:
                raise DomainError("다른 사용자가 수정했습니다. 최신 과제를 다시 불러와 주세요.", 409)
            before = row["document"]
            next_project = change(deepcopy(before), conn) if with_connection else change(deepcopy(before))
            return self._save(conn, next_project, before, actor, action)

    def reports(self, project_id, revision, body, actor):
        def change(project):
            from .reporting import assert_month_editable
            assert_edit(project, actor)
            if project.get("archivedAt"):
                raise DomainError("보관 과제는 실적을 수정할 수 없습니다.")
            active = plans.period(project["startDate"], project["endDate"])
            if plans.weighted(project):
                if body.stepReports is None or body.monthly is not None:
                    raise DomainError("Step별 실적을 입력해 주세요.")
                steps = {s["id"]: s for s in project["steps"]}
                reports = project.setdefault("stepReports", {})
                for step_id, rows in body.stepReports.items():
                    if step_id not in steps:
                        raise DomainError("등록되지 않은 Step입니다.")
                    for month, row in rows.items():
                        assert_month_editable(project, month)
                        if month not in active or month < steps[step_id]["startDate"][:7]:
                            raise DomainError("Step 보고 기간을 확인해 주세요.")
                        reports.setdefault(step_id, {}).setdefault(month, {}).update(row.model_dump(exclude_unset=True))
                project = plans.totals(project, reports)
            else:
                if body.monthly is None or body.stepReports is not None:
                    raise DomainError("과제의 월별 실적을 입력해 주세요.")
                for month, row in body.monthly.items():
                    assert_month_editable(project, month)
                    if month not in active:
                        raise DomainError("과제 보고 기간을 확인해 주세요.")
                    project["monthly"][month].update(row.model_dump(exclude_unset=True))
            plans.validate_reports(project)
            return project
        return self._mutate(project_id, revision, actor, "reports_saved", change)

    def request_change(self, project_id, revision, body, actor):
        def change(project):
            assert_edit(project, actor)
            # Preserve omitted metadata for PATCH-like compatibility with the JS API client.
            candidate = {**project, **body.candidate.model_dump(exclude_unset=True)}
            if not plans.weighted(body.candidate.model_dump()) and "stepPlanMode" in body.candidate.model_fields_set:
                candidate["stepPlanMode"] = None
            candidate["id"] = project_id
            active = plans.period(candidate["startDate"], candidate["endDate"])
            if active:
                candidate.update(startMonth=active[0], endMonth=active[-1])
            return approvals.create_request(project, candidate, body.reason, actor.model_dump())
        return self._mutate(project_id, revision, actor, "change_requested", change)

    def decide(self, project_id, revision, request_id, body, actor):
        return self._mutate(project_id, revision, actor, f"change_{body.decision}", lambda project: approvals.decide(project, request_id, body.decision, body.comment, actor.model_dump()))

    def history(self, project_id, limit=100, offset=0, snapshots=False):
        self.get(project_id)
        # Only fixed, server-selected columns appear in this SQL string.
        columns = "id,action,actor,details,created_at" + (",before_document,after_document" if snapshots else "")
        with self.pool.connection() as conn:
            return conn.execute(f"SELECT {columns} FROM audit_events WHERE project_id=%s ORDER BY created_at DESC,id LIMIT %s OFFSET %s", [project_id, limit, offset]).fetchall()
