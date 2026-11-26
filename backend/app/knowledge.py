"""Evidence-backed knowledge projection. No external model or network calls."""
import hashlib
import json
import re
from copy import deepcopy
from .errors import DomainError

FIELDS = ('title','background','kpi','plan')
KNOWLEDGE_FIELDS = ('problem','approach','result','lessons','conditions','nextSteps')
STOP = {'과제','체험','예시','검증','계획','목표','개선','데이터','step','legacy','all','tech'}


def tokens(text):
    import unicodedata
    return list(dict.fromkeys(t for t in re.findall(r'[a-z0-9가-힣]{2,}', unicodedata.normalize('NFKC',str(text or '')).lower()) if t not in STOP))[:80]


def stamp(project):
    data = {key:project.get(key) for key in (*FIELDS,'team','tech','po','pm','members','steps','monthly','stepReports','_lastAttachment','_poId','_pmId','_teamId','_memberIds')}
    data['knowledge'] = {key:(project.get('_knowledge') or {}).get(key,'') for key in KNOWLEDGE_FIELDS}
    data['artifacts']=(project.get('_knowledge') or {}).get('artifacts',[])
    return hashlib.sha256(json.dumps(data,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()


def sources(project):
    rows=[]
    def add(path,label,quote,tab='plan',month=None):
        if quote is not None and str(quote).strip():
            rows.append({'projectId':project['id'],'path':path,'label':label,'quote':str(quote)[:4000],'revision':project.get('_revision',0),'tab':tab,**({'month':month} if month else {})})
    for key in FIELDS:add(key,{'title':'과제 제목','background':'배경·목표','kpi':'KPI','plan':'추진 계획'}[key],project.get(key))
    for key in KNOWLEDGE_FIELDS:add('_knowledge.'+key,'작성한 경험 카드',(project.get('_knowledge') or {}).get(key),'knowledge')
    for step in project.get('steps',[]):add('steps.'+step['id']+'.name','Step',step.get('name'))
    for month,row in sorted(project.get('monthly',{}).items()):
        for key,label in (('actual','누적 실적'),('reason','지연 사유'),('catchup','만회 계획')):
            add(f'monthly.{month}.{key}',f'{month} {label}',row.get(key),'report',month)
    for step in project.get('steps',[]):
        for month,row in sorted(project.get('stepReports',{}).get(step['id'],{}).items()):
            for key,label in (('reason','지연 사유'),('catchup','만회 계획')):
                add(f"stepReports.{step['id']}.{month}.{key}",f"{step['name']} · {month} {label}",row.get(key),'report',month)
    for index,artifact in enumerate((project.get('_knowledge') or {}).get('artifacts',[])):
        add(f'_knowledge.artifacts.{index}','결과물 문서',artifact['title']+'\n'+artifact['url'],'knowledge')
    rows.extend(project.get('_documentEvidence',[]))
    return rows


def recommendations(query, tech, projects, exclude_id=None):
    terms=tokens(query)
    if not terms:return []
    result=[]
    for project in projects:
        if project['id']==exclude_id:continue
        best=None
        for source in sources(project):
            if source.get('superseded'):continue
            words=tokens(source['quote'])
            matched=[t for t in terms if any(t==w or len(t)>=3 and len(w)>=3 and (t in w or w in t) for w in words)]
            if not matched:continue
            score=len(matched)*10+(2 if source['path']=='title' else 0)
            if not best or score>best[0]:best=(score,source,matched)
        if not best:continue
        common=[t for t in tech if t!='All Tech' and not t.endswith(' ALL') and t in project.get('tech',[])]
        result.append({'projectId':project['id'],'title':project['title'],'team':project.get('team',''),'sourceRevision':project.get('_revision',0),'sourceToken':stamp(project),'score':best[0]+len(common),'evidence':[best[1]],'reuseEvidence':[s for s in sources(project) if not s.get('superseded') and (s['path']=='_knowledge.result' or s['path'].startswith(('_knowledge.artifacts.','attachments.')))][:1],'matchedTerms':best[2],'method':'lexical-v1','notice':'문구 일치 후보 · 의미상 관계는 확인이 필요합니다.'})
    return sorted(result,key=lambda r:(-r['score'],r['projectId']))[:5]


def draft(project):
    rows=sources(project)
    items={}
    def add(field,source,prefix=''):
        if source:items[field]={'text':prefix+source['quote'],'evidence':[source]}
    add('problem',next((s for s in rows if s['path']=='background'),None))
    add('approach',next((s for s in rows if s['path']=='plan'),None))
    actuals=[s for s in rows if s['path'].startswith('monthly.') and s['path'].endswith('.actual')]
    if actuals:
        source=actuals[-1]
        add('result',source,source['month']+' 입력된 누적 진척률: ')
        items['result']['text']+='% · 업무 효과는 별도 확인이 필요합니다.'
    reasons=[s for s in rows if s['path'].endswith('.reason')]
    catchups=[s for s in rows if s['path'].endswith('.catchup')]
    add('lessons',reasons[-1] if reasons else None,'기록된 지연 사유: ')
    add('nextSteps',catchups[-1] if catchups else None,'기록된 만회 계획: ')
    for field,terms in (('lessons',('주의','시행착오','실패')),('conditions',('적용 조건','재사용','제약'))):
        if field not in items:
            doc=next((s for s in rows if s['path'].startswith('attachments.') and not s.get('superseded') and any(t in s['quote'] for t in terms)),None)
            add(field,doc,'첨부 문서 기록 발췌: ')
    return {'items':items,'notice':'기록을 인용한 초안입니다. 재사용 조건·성과 해석은 작성자가 확인해 주세요.'}


def evidence_current(evidence,project):
    live={s['path']:s for s in sources(project)}
    return bool(evidence) and all(e['path'] in live and not live[e['path']].get('superseded') and e['quote']==live[e['path']]['quote'] and (not e.get('sourceHash') or e['sourceHash']==live[e['path']].get('sourceHash')) for e in evidence)


def current_evidence(previous,target):
    rows=sources(target);result=[]
    by_file={s.get('attachmentId'):s for s in rows if s.get('attachmentId')}
    for old in previous:
        live=next((s for s in rows if s['path']==old['path']),None)
        if live and not live.get('superseded'):result.append(live);continue
        old_id=old.get('attachmentId')
        if not old_id:continue
        for candidate in rows:
            if candidate.get('superseded') or not candidate.get('attachmentId'):continue
            source=candidate
            visited=set()
            while source and source.get('replacesId') and source.get('attachmentId') not in visited:
                visited.add(source.get('attachmentId'))
                if source['replacesId']==old_id:
                    result.append(candidate);break
                source=by_file.get(source['replacesId'])
            if result:break
    return result[:3] or ([] if any(e.get('attachmentId') for e in previous) else [s for s in rows if s['path']=='title'])


def context(project, projects, attachments=()):
    nodes=[{'id':'project:'+project['id'],'kind':'project','label':project['title']}]
    edges=[]
    def add(node_id,kind,label,path,tab='plan',**extra):
        source={'projectId':project['id'],'path':path,'revision':project.get('_revision',0),'tab':tab,**extra}
        if not any(n['id']==node_id for n in nodes):nodes.append({'id':node_id,'kind':kind,'label':label,'source':source})
        edges.append({'from':'project:'+project['id'],'to':node_id,'kind':kind,'source':source})
    if project.get('team'):add('organization:'+project['_teamId'] if project.get('_teamId') else 'team-assignment:'+project['id'],'team',project['team']+('' if project.get('_teamId') else ' · 조직 식별자 연결 전'),'team')
    for tech in project.get('tech',[]):add('tech:'+tech,'tech',tech,'tech')
    for step in project.get('steps',[]):add(f"step:{project['id']}:{step['id']}",'step',f"{step['name']} · {step['weight']}%",'steps.'+step['id'])
    for role in ('po','pm'):
        if project.get(role):
            account=project.get('_'+role+'Id')
            add('person:'+account if account else f"assignment:{project['id']}:{role.upper()}",'person',role.upper()+' · '+project[role]+('' if account else ' · 계정 연결 전'),role)
    for index,name in enumerate(filter(None,(s.strip() for s in re.split(r'[,\n]',project.get('members',''))))):
        add(f"assignment:{project['id']}:member:{index}",'person','참여자 · '+name+' · 계정 연결 전','members')
    for account in project.get('_memberIds',[]):add('person:'+account,'person','참여 계정 · '+account,'_memberIds')
    for month,row in sorted(project.get('monthly',{}).items()):
        if row.get('actual') is not None and row.get('actual')!='':add(f"report:{project['id']}:{month}",'report',f"{month} · 누적 {row['actual']}%",'monthly.'+month,'report',month=month)
    for file in attachments:add('file:'+file['id'],'file',file['filename'],'attachments.'+file['id'],'files',attachmentId=file['id'])
    indexed={p['id']:p for p in projects}
    decisions=[]
    for decision in (project.get('_knowledgeDecisions') or {}).values():
        target=indexed.get(decision['targetId'])
        decisions.append({**decision,'stale':not target or not evidence_current(decision.get('evidence',[]),target) or (not evidence_current(decision['contextEvidence'],project) if decision.get('contextEvidence') else decision['contextToken']!=stamp(project)),'title':target['title'] if target else '조회할 수 없는 과제','available':bool(target),'currentTargetToken':stamp(target) if target else '', 'currentEvidence':current_evidence(decision.get('evidence',[]),target) if target else []})
    automatic_count=len(edges)
    for d in decisions:
        if d['decision']=='accepted' and not d['stale']:
            nodes.append({'id':'project:'+d['targetId'],'kind':'relation','label':d['title'],'source':d['evidence'][0] if d['evidence'] else None})
            edges.append({'from':'project:'+project['id'],'to':'project:'+d['targetId'],'kind':d['type'],'source':d['evidence'][0] if d['evidence'] else None})
    evidence=sources(project)
    query=' '.join(str(project.get(k) or '') for k in ('title','background','plan'))+' '+' '.join(s['quote'] for s in evidence if s['path'].endswith('.reason'))
    candidates=[r for r in recommendations(query,project.get('tech',[]),projects,project['id']) if not any(d['targetId']==r['projectId'] for d in decisions)]
    return {'graph':{'nodes':nodes,'edges':edges},'evidence':evidence,'draft':draft(project),'candidates':candidates,'decisions':decisions,'contextToken':stamp(project),'metrics':{'automaticFacts':automatic_count,'sourcedFacts':sum(bool(e.get('source')) for e in edges),'confirmedReuse':sum(d['decision']=='accepted' and d['type']=='reuses' and not d['stale'] for d in decisions),'needsReview':sum(bool(d['stale']) for d in decisions)},'notice':'입력 기록 자동 연결 · 문구 기반 추천 · 사내 AI 연동 전'}


def decide(project, target, body, actor, at):
    if not target or target['id']==project['id']:raise DomainError('연결할 과제를 확인해 주세요.')
    if body.targetToken!=stamp(target) or body.contextToken!=stamp(project):raise DomainError('근거 기록이 변경되었습니다. 후보를 새로 불러와 확인해 주세요.',409)
    cited=[s for s in sources(target) if s['path']==body.evidencePath] if body.evidencePath else [s for s in sources(target) if s['path'] in ('title','background')]
    if body.type=='reuses' and body.decision=='accepted' and not any(s['path']=='_knowledge.result' or s['path'].startswith(('_knowledge.artifacts.','attachments.')) for s in cited):
        raise DomainError('결과 활용은 경험 카드의 결과 또는 문서 근거를 확인해 주세요.')
    if not cited or any(s.get('superseded') for s in cited):raise DomainError('인용할 근거가 변경되었습니다. 다시 확인해 주세요.',409)
    result=deepcopy(project)
    result.setdefault('_knowledgeDecisions',{})[target['id']]={'targetId':target['id'],'targetToken':stamp(target),'targetRevision':target.get('_revision',0),'contextToken':stamp(project),'type':body.type,'decision':body.decision,'evidence':cited,'contextEvidence':([s for s in sources(project) if s['path'] in ('background','plan')] + [s for s in sources(project) if s['path'].endswith('.reason')][-1:]) or [s for s in sources(project) if s['path']=='title'],'decidedAt':at,'decidedBy':actor.model_dump()}
    return result
