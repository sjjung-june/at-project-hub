// Explicit adapter for the future shared-DB UI. The published demo still uses local storage.
export function createApiClient({baseUrl='/api',fetchImpl=fetch}={}){
  async function request(path,{method='GET',revision,body}={}){
    const headers={Accept:'application/json'};
    if(body!==undefined)headers['Content-Type']='application/json';
    if(revision!==undefined)headers['If-Match']=`"${revision}"`;
    const response=await fetchImpl(baseUrl+path,{method,headers,credentials:'same-origin',...(body===undefined?{}:{body:JSON.stringify(body)})});
    const result=await response.json();
    if(!response.ok){const error=new Error(result.error||'API 요청 실패');error.status=response.status;throw error;}
    return result;
  }
  const path=id=>`/projects/${encodeURIComponent(id)}`;
  return {list:()=>request('/projects'),get:id=>request(path(id)),create:project=>request('/projects',{method:'POST',body:project}),saveReports:(project,body)=>request(path(project.id)+'/reports',{method:'PUT',revision:project._revision,body}),requestChange:(project,candidate,reason)=>request(path(project.id)+'/change-requests',{method:'POST',revision:project._revision,body:{candidate,reason}}),decide:(project,requestId,decision,comment)=>request(path(project.id)+`/change-requests/${encodeURIComponent(requestId)}/decisions`,{method:'POST',revision:project._revision,body:{decision,comment}}),history:id=>request(path(id)+'/history')};
}
