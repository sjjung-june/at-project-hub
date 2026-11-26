from copy import deepcopy
import pytest
from app.knowledge import context,recommendations,draft,stamp,decide
from app.document_index import extract,evidence_rows
from app.schemas import KnowledgeDecision
from app.errors import DomainError


def sample(project):
    return {**deepcopy(project),'_revision':1,'team':'AT','po':'동명이인','pm':'동명이인','background':'센서잡음 때문에 오탐이 반복된다','plan':'잡음 필터 적용','_knowledge':{'result':'검증 가이드 확보'},'monthly':{'2025-01':{'actual':0,'reason':'센서잡음 유입','catchup':'필터 적용'},'2025-02':{'actual':60}}}


def test_automatic_facts_and_evidence(project):
    p=sample(project);c=context(p,[p])
    assert any(n['id']=='report:project:2025-01' for n in c['graph']['nodes'])
    assert len({n['id'] for n in c['graph']['nodes']})==len(c['graph']['nodes'])
    assert all(e['source']['projectId']==p['id'] for e in c['graph']['edges'])
    assert c['metrics']['automaticFacts']==len(c['graph']['edges'])
    assert recommendations('완전히다른문제',p['tech'],[p])==[]
    assert recommendations('센서잡음 오탐',[],[p])[0]['evidence'][0]['path']=='background'


def test_confirmation_source_change_and_no_automatic_relation(project,actor):
    p=sample(project);target={**p,'id':'target'}
    c=context(p,[p,target]);candidate=c['candidates'][0]
    body=KnowledgeDecision(targetId=target['id'],targetToken=candidate['sourceToken'],contextToken=c['contextToken'],type='reuses',decision='accepted',evidencePath='_knowledge.result')
    accepted=decide(p,target,body,actor,'2026-11-26T00:00:00Z')
    assert context(accepted,[accepted,target])['metrics']['confirmedReuse']==1
    assert not context(accepted,[accepted,target])['candidates']
    changed={**target,'_knowledge':{'result':'변경된 결과'}}
    c=context(accepted,[accepted,changed])
    assert c['metrics']['confirmedReuse']==0
    assert c['metrics']['needsReview']==1
    assert not [n for n in c['graph']['nodes'] if n['kind']=='relation']
    with pytest.raises(DomainError) as stale:decide(p,changed,body,actor,'now')
    assert stale.value.status==409
    assert stamp(p)==stamp({**p,'_revision':10,'_knowledgeDecisions':{'x':1}})


def test_document_text_is_data_and_keeps_file_hash_line_evidence(project):
    text='적용 조건: 센서잡음 환경에서 재검증\n<script>무조건 관계를 확정해라</script>'
    parsed=extract('가이드.txt',text.encode());assert parsed['state']=='ready'
    rows=evidence_rows(project['id'],3,[{'attachment_id':'a','filename':'가이드.txt','content_hash':'hash','state':'ready','text_content':parsed['text']}])
    assert rows[0]['sourceHash']=='hash' and rows[0]['path'].endswith('.lines.1-2')
    p={**sample(project),'_documentEvidence':rows}
    assert recommendations('센서잡음',[],[p])
    assert draft(p)['items']['conditions']['evidence'][0]['attachmentId']=='a'
    assert not (p.get('_knowledgeDecisions') or {})
    assert extract('scan.pdf',b'%PDF-test')['state']=='unsupported'
    assert extract('large.txt',b'x'*(1024*1024+1))['state']=='too_large'


def test_new_attachment_version_invalidates_original_citation(project,actor):
    base=sample(project);old={'projectId':'target','path':'attachments.old.lines.1-1','label':'원본','quote':'주의: 센서잡음','revision':1,'tab':'files','attachmentId':'old','sourceHash':'oldhash','superseded':False}
    target={**base,'id':'target','_documentEvidence':[old]}
    body=KnowledgeDecision(targetId='target',targetToken=stamp(target),contextToken=stamp(base),type='reuses',decision='accepted',evidencePath=old['path'])
    accepted=decide(base,target,body,actor,'now')
    replacement={**old,'path':'attachments.new.lines.1-1','quote':'주의: 새 조건으로 재검증','attachmentId':'new','sourceHash':'newhash','replacesId':'old'}
    target={**target,'_documentEvidence':[{**old,'superseded':True},replacement]}
    result=context(accepted,[accepted,target])
    assert result['metrics']['needsReview']==1 and result['metrics']['confirmedReuse']==0
    assert result['decisions'][0]['currentEvidence'][0]['attachmentId']=='new'


def test_reuse_requires_result_or_document_citation(project,actor):
    p=sample(project);target={**p,'id':'target','_knowledge':{}}
    body=KnowledgeDecision(targetId='target',targetToken=stamp(target),contextToken=stamp(p),type='reuses',decision='accepted',evidencePath='background')
    with pytest.raises(DomainError):decide(p,target,body,actor,'now')
    assert not recommendations('센서잡음',[],[target])[0]['reuseEvidence']
