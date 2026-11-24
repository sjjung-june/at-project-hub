"""Disposable full-stack CI smoke: static web + proxy + FastAPI + PostgreSQL.
Not a browser rendering test. Uses only synthetic records in an isolated stack.
"""
import json
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

BASE='http://127.0.0.1:8080'


def call(path,method='GET',body=None,revision=None,expected=200,raw=False,headers=None):
    headers=dict(headers or {})
    if body is not None and not isinstance(body,bytes):
        body=json.dumps(body).encode();headers['Content-Type']='application/json'
    if revision is not None:headers['If-Match']=f'"{revision}"'
    req=Request(BASE+path,data=body,method=method,headers=headers)
    try:
        with urlopen(req,timeout=10) as result:status=result.status;data=result.read();response_headers=result.headers
    except HTTPError as error:
        status=error.code;data=error.read();response_headers=error.headers
    assert status==expected,(path,status,data[:300])
    return (data if raw else json.loads(data)),response_headers


for attempt in range(30):
    try:
        health,_=call('/api/health')
        if health['status']=='ok':break
    except (URLError,AssertionError):time.sleep(1)
else:raise SystemExit('Full stack did not become healthy')
page,_=call('/pilot.html',raw=True);assert 'AT 공용 과제 작업공간' in page.decode()
bundle,_=call('/pilot.js',raw=True);assert len(bundle)>10000
actor,_=call('/api/me');assert actor['id']=='local-developer'
project={'title':'[CI] 파일럿 통합 점검','team':'개발팀','tech':['All Tech'],'startDate':'2025-01-01','endDate':'2025-02-28','stepPlanMode':'weighted-steps-v1','steps':[{'id':'a','name':'분석','weight':40,'startDate':'2025-01-01','endDate':'2025-01-31','monthly':{'2025-01':{'goal':100}}},{'id':'b','name':'검증','weight':60,'startDate':'2025-01-01','endDate':'2025-02-28','monthly':{'2025-01':{'goal':50},'2025-02':{'goal':100}}}]}
p,h=call('/api/projects','POST',project,expected=201);assert h['ETag']=='"1"';pid=p['id']
path=f'/api/projects/{pid}'
p,_=call(path+'/reports','PUT',{'stepReports':{'a':{'2025-01':{'actual':100}},'b':{'2025-01':{'actual':50}}}},revision=p['_revision']);assert p['monthly']['2025-01']['actual']==70
boundary='at-pilot-ci-boundary'
parts=[]
for name,value in [('step_id','a'),('month','2025-01')]:parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="evidence.txt"\r\nContent-Type: text/plain\r\n\r\npilot evidence\r\n--{boundary}--\r\n'.encode())
file,_=call(path+'/attachments','POST',b''.join(parts),revision=p['_revision'],expected=201,headers={'Content-Type':f'multipart/form-data; boundary={boundary}'})
p=file['project'];aid=file['attachmentId']
content,h=call(path+f'/attachments/{aid}/download',raw=True);assert content==b'pilot evidence';assert h['X-Content-Type-Options']=='nosniff'
p,_=call(path+'/months/2025-01/submit','POST',revision=p['_revision']);sid=p['_reporting']['2025-01']['id']
call(path+'/reports','PUT',{'stepReports':{'a':{'2025-01':{'actual':80}}}},revision=p['_revision'],expected=409)
call(path+f'/submissions/{sid}/review','POST',{'decision':'approved','comment':'self review must fail'},revision=p['_revision'],expected=403)
snap,_=call(path+'/submissions?month=2025-01');assert snap['submissions'][0]['snapshot']['monthly']['actual']==70
stats,_=call('/api/statistics?month=2025-01');assert stats['counts']['submitted']==1;assert stats['counts']['onTarget']==1
print('PASS: web assets, proxy headers, DB persistence, multipart evidence, download, submission, month lock, self-review rejection, same-month statistics')
