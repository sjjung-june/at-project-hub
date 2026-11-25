from copy import deepcopy
import re
from uuid import uuid4
from psycopg.types.json import Jsonb
from .domain import plans, approvals
from .errors import DomainError
from .services import ProjectService, assert_edit


def check_month(month):
    if not isinstance(month, str) or not re.fullmatch(r'[0-9]{4}-(0[1-9]|1[0-2])', month):
        raise DomainError('기준 월은 YYYY-MM 형식이어야 합니다.')
    return month


def assert_month_editable(project, month):
    if project.get('_reporting', {}).get(month, {}).get('status') in ('submitted', 'approved'):
        raise DomainError(f'{month} 실적은 제출·확정되어 수정할 수 없습니다. 검토자의 보완 요청 후 수정하세요.', 409)


def assert_reviewer(project, actor, submitter):
    if approvals.same_person(actor.model_dump(), submitter):
        raise DomainError('본인이 제출한 실적은 직접 확정할 수 없습니다.', 403)
    if not (actor.role == 'at-head' or actor.role == 'team-lead' and actor.team == project['team']):
        raise DomainError('소속 팀장 또는 담당만 실적을 검토할 수 있습니다.', 403)


class ReportingService:
    def __init__(self, pool):
        self.pool = pool
        self.projects = ProjectService(pool)

    def submit(self, pid, month, revision, actor):
        check_month(month)
        def change(project, conn):
            assert_edit(project, actor)
            if project.get('archivedAt'):
                raise DomainError('보관 과제는 제출할 수 없습니다.')
            if month not in plans.period(project['startDate'], project['endDate']) or month > plans.now_month():
                raise DomainError('과제 보고 기간과 기준 월을 확인해 주세요.')
            assert_month_editable(project, month)
            # Freeze exactly the submitted month, including goals, weights and evidence.
            current = plans.totals(project)
            if plans.percent(current['monthly'].get(month, {}).get('actual')) is None:
                raise DomainError('해당 월에 시작한 모든 Step의 실적을 입력한 뒤 제출해 주세요.')
            plans.validate_reports(project)
            files = conn.execute('SELECT id,filename,sha256,step_id,report_month FROM attachments WHERE project_id=%s AND (report_month IS NULL OR report_month<=%s) ORDER BY created_at,id', [pid, month]).fetchall()
            for step in project.get('steps',[]):
                if step.get('evidenceRequired') and plans.step_actual(step,month,project.get('stepReports',{}))==100 and not any(f['step_id']==step['id'] for f in files):
                    raise DomainError(f"{step['name']} 완료 증빙을 첨부한 뒤 제출해 주세요.")
            snapshot = {'projectId': pid, 'month': month, 'plan': approvals.snapshot(project), 'monthly': deepcopy(current['monthly'][month]), 'stepReports': {s['id']: {'goal': plans.step_goal(s, month), 'actual': plans.step_actual(s, month, project.get('stepReports', {})), **deepcopy(project.get('stepReports', {}).get(s['id'], {}).get(month, {}))} for s in project.get('steps', [])}, 'attachments': files, 'sourceRevision': project['_revision']}
            sid = str(uuid4())
            conn.execute('INSERT INTO monthly_submissions(id,project_id,report_month,status,snapshot,submitted_by) VALUES(%s,%s,%s,%s,%s,%s)', [sid,pid,month,'submitted',Jsonb(snapshot),Jsonb(actor.model_dump())])
            project.setdefault('_reporting', {})[month] = {'id':sid,'status':'submitted','submittedBy':actor.model_dump(),'submittedAt':approvals.timestamp()}
            return project
        return self.projects._mutate(pid,revision,actor,'report_submitted',change,with_connection=True)

    def review(self, pid, sid, revision, body, actor):
        def change(project, conn):
            row = conn.execute('SELECT * FROM monthly_submissions WHERE id=%s AND project_id=%s FOR UPDATE', [sid,pid]).fetchone()
            if not row:
                raise DomainError('제출 내역을 찾을 수 없습니다.',404)
            if row['status'] != 'submitted':
                raise DomainError('이미 검토된 실적입니다.',409)
            assert_reviewer(project,actor,row['submitted_by'])
            conn.execute('UPDATE monthly_submissions SET status=%s,reviewed_by=%s,review_comment=%s,reviewed_at=now() WHERE id=%s',[body.decision,Jsonb(actor.model_dump()),body.comment.strip(),sid])
            project.setdefault('_reporting', {})[row['report_month']].update(status=body.decision,reviewedBy=actor.model_dump(),comment=body.comment.strip(),reviewedAt=approvals.timestamp())
            return project
        return self.projects._mutate(pid,revision,actor,'report_reviewed',change,with_connection=True)

    def submissions(self,pid,month=None):
        self.projects.get(pid)
        if month is not None:
            check_month(month)
        with self.pool.connection() as conn:
            return conn.execute('SELECT id,report_month,status,snapshot,submitted_by,submitted_at,reviewed_by,review_comment,reviewed_at FROM monthly_submissions WHERE project_id=%s AND (%s::text IS NULL OR report_month=%s) ORDER BY submitted_at DESC,id',[pid,month,month]).fetchall()

    def statistics(self,month,team=None):
        check_month(month)
        if month > plans.now_month():
            raise DomainError('미래 월의 실적 통계는 조회할 수 없습니다.')
        with self.pool.connection() as conn:
            projects=[r['document'] for r in conn.execute('SELECT document FROM projects ORDER BY id')]
            approved={r['project_id']:r['snapshot'] for r in conn.execute("SELECT project_id,snapshot FROM monthly_submissions WHERE report_month=%s AND status='approved'",[month])}
        counts={'eligible':0,'reported':0,'submitted':0,'approved':0,'returned':0,'missing':0,'late':0,'onTarget':0,'unknown':0,'notStarted':0,'ended':0,'paused':0,'archived':0,'invalid':0}
        items=[]
        for project in projects:
            frozen=approved.get(project['id'])
            basis={**project, **frozen['plan']} if frozen else project
            if team and basis['team']!=team:continue
            if basis.get('archivedAt'):
                counts['archived']+=1;continue
            if basis.get('status')=='보류':
                counts['paused']+=1;continue
            try:
                plans.validate_plan(basis)
            except DomainError:
                counts['invalid']+=1;continue
            months=plans.period(basis['startDate'],basis['endDate'])
            if month<months[0]:
                counts['notStarted']+=1;continue
            if month>months[-1]:
                counts['ended']+=1;continue
            counts['eligible']+=1
            row=frozen['monthly'] if frozen else plans.totals(project)['monthly'].get(month,{})
            goal,actual=plans.percent(row.get('goal')),plans.percent(row.get('actual'))
            state=project.get('_reporting',{}).get(month,{}).get('status','draft')
            if state in ('submitted','approved','returned'):counts[state]+=1
            if actual is None:
                counts['missing']+=1;counts['unknown']+=1
            else:
                counts['reported']+=1;counts['late' if actual<goal else 'onTarget']+=1
            items.append({'id':project['id'],'title':basis['title'],'team':basis['team'],'month':month,'goal':goal,'actual':actual,'gap':round(goal-actual,6) if actual is not None else None,'state':state,'basis':'approved_snapshot' if frozen else 'current_plan_draft'})
        denominator=counts['eligible']
        return {'month':month,'team':team,'counts':counts,'coveragePercent':round(counts['reported']/denominator*100,1) if denominator else None,'approvalPercent':round(counts['approved']/denominator*100,1) if denominator else None,'items':items,'notice':'동일 기준 월만 집계합니다. 확정 실적은 당시 계획·증빙을 보존한 확정본을 사용하고 작성 중 실적과 구분합니다. 진척률은 KPI 달성률이 아닙니다.'}
