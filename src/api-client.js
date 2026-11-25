// Shared FastAPI contract. Tokens stay in the corporate session, never local storage.
export function createApiClient({baseUrl='/api',fetchImpl=fetch,getAccessToken}={}){
  async function request(path,{method='GET',revision,body,form,blob=false}={}){
    const headers={Accept:blob?'application/octet-stream':'application/json'};
    if(getAccessToken){const token=await getAccessToken();if(token)headers.Authorization=`Bearer ${token}`;}
    if(body!==undefined)headers['Content-Type']='application/json';
    if(revision!==undefined)headers['If-Match']=`"${revision}"`;
    const response=await fetchImpl(baseUrl+path,{method,headers,credentials:'same-origin',...(form?{body:form}:body===undefined?{}:{body:JSON.stringify(body)})});
    if(blob&&response.ok)return response.blob();
    const result=await response.json().catch(()=>({error:'서버 응답을 확인하지 못했습니다.'}));
    if(!response.ok){const error=new Error(result.error||'요청을 처리하지 못했습니다.');error.status=response.status;throw error;}
    return result;
  }
  const path=id=>`/projects/${encodeURIComponent(id)}`;
  return {
    me:()=>request('/me'),myProjects:()=>request('/me/projects'),list:({limit=100,offset=0}={})=>request(`/projects?limit=${limit}&offset=${offset}`),get:id=>request(path(id)),
    create:project=>request('/projects',{method:'POST',body:project}),
    saveReports:(project,body)=>request(path(project.id)+'/reports',{method:'PUT',revision:project._revision,body}),
    requestChange:(project,candidate,reason)=>request(path(project.id)+'/change-requests',{method:'POST',revision:project._revision,body:{candidate,reason}}),
    decide:(project,requestId,decision,comment)=>request(path(project.id)+`/change-requests/${encodeURIComponent(requestId)}/decisions`,{method:'POST',revision:project._revision,body:{decision,comment}}),
    history:id=>request(path(id)+'/history'),
    attachments:id=>request(path(id)+'/attachments'),
    upload:(project,file,{stepId,month,replacesId}={})=>{const form=new FormData();form.append('file',file);if(stepId)form.append('step_id',stepId);if(month)form.append('month',month);if(replacesId)form.append('replaces_id',replacesId);return request(path(project.id)+'/attachments',{method:'POST',revision:project._revision,form});},
    download:(id,aid)=>request(path(id)+`/attachments/${encodeURIComponent(aid)}/download`,{blob:true}),
    submit:(project,month)=>request(path(project.id)+`/months/${month}/submit`,{method:'POST',revision:project._revision}),
    review:(project,sid,decision,comment)=>request(path(project.id)+`/submissions/${encodeURIComponent(sid)}/review`,{method:'POST',revision:project._revision,body:{decision,comment}}),
    submissions:(id,month)=>request(path(id)+'/submissions'+(month?`?month=${month}`:'')),
    statistics:month=>request(`/statistics?month=${month}`)
  };
}
