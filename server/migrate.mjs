import {readdir,readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createPool,transaction} from './db.mjs';
export async function migrate(pool){return transaction(pool,async client=>{
  await client.query("SELECT pg_advisory_xact_lock(827351)");
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const applied=new Set((await client.query('SELECT name FROM schema_migrations')).rows.map(row=>row.name));
  for(const name of (await readdir(new URL('./migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort()){
    if(applied.has(name))continue;
    await client.query(await readFile(new URL(`./migrations/${name}`,import.meta.url),'utf8'));
    await client.query('INSERT INTO schema_migrations(name) VALUES($1)',[name]);
  }
});}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const pool=createPool();try{await migrate(pool);console.log('Database migrations applied');}finally{await pool.end();}}
