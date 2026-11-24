import express from 'express';
import {ApiError,createProjectService} from './project-service.mjs';
// authenticate must validate the corporate SSO session and return server-owned roles.
export function createApp({pool,authenticate}){
  if(typeof authenticate!=='function')throw new Error('An authentication adapter is required');
  const app=express(),service=createProjectService(pool);
  app.disable('x-powered-by');app.use(express.json({limit:'1mb'}));
  app.get('/api/health',async(req,res,next)=>{try{await pool.query('SELECT 1');res.json({status:'ok',database:'postgresql'});}catch(error){next(error);}});
  app.use('/api',async(req,res,next)=>{try{req.actor=await authenticate(req);if(!req.actor?.id)throw new ApiError(401,'로그인이 필요합니다.');next();}catch(error){next(error);}});
  const revision=req=>{const raw=req.get('If-Match');return raw&&/^"?\d+"?$/.test(raw)?Number(raw.replaceAll('"','')):NaN;};
  const send=(res,project,status=200)=>res.status(status).set('ETag',`"${project._revision}"`).json(project);
  const route=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(error){if(!error.status&&error.message&&!(error.code))error=new ApiError(422,error.message);next(error);}};
  app.get('/api/projects',route(async(req,res)=>res.json({projects:await service.list(req.actor)})));
  app.post('/api/projects',route(async(req,res)=>send(res,await service.create(req.body,req.actor),201)));
  app.get('/api/projects/:id',route(async(req,res)=>send(res,await service.get(req.params.id,req.actor))));
  app.put('/api/projects/:id/reports',route(async(req,res)=>send(res,await service.reports(req.params.id,revision(req),req.body,req.actor))));
  app.post('/api/projects/:id/change-requests',route(async(req,res)=>send(res,await service.request(req.params.id,revision(req),req.body.candidate,req.body.reason,req.actor))));
  app.post('/api/projects/:id/change-requests/:requestId/decisions',route(async(req,res)=>send(res,await service.decide(req.params.id,revision(req),req.params.requestId,req.body.decision,req.body.comment,req.actor))));
  app.get('/api/projects/:id/history',route(async(req,res)=>res.json({events:await service.history(req.params.id,req.actor)})));
  app.use('/api',(req,res)=>res.status(404).json({error:'API endpoint not found'}));
  app.use((error,req,res,next)=>{const status=error instanceof ApiError?error.status:error.type==='entity.parse.failed'?400:error.type==='entity.too.large'?413:503;res.status(status).json({error:status===503?'데이터베이스 요청을 처리하지 못했습니다.':error.message});});
  return app;
}
