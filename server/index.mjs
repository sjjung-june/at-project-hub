import {createPool} from './db.mjs';
import {createApp} from './app.mjs';
// Local development is explicit and loopback-only. Production must inject verified SSO.
if(process.env.DEV_AUTH!=='true'||process.env.NODE_ENV==='production')throw new Error('Configure verified corporate SSO using createApp({ pool, authenticate }); DEV_AUTH=true is available only for local development.');
const pool=createPool();
const actor={id:'local-developer',name:'로컬 개발자',role:'at-head',team:'개발팀',authenticated:false};
const app=createApp({pool,authenticate:async()=>actor});
const server=app.listen(Number(process.env.API_PORT||3001),'127.0.0.1',()=>console.log('Local PostgreSQL API: http://127.0.0.1:'+server.address().port));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(async()=>{await pool.end();process.exit(0);}));
