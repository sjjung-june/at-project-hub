import { build } from 'esbuild';
await build({ entryPoints:['src/main.jsx'], bundle:true, outfile:'dist/components.js', format:'iife', minify:true, target:['es2022'], define:{'process.env.NODE_ENV':'"production"'}, legalComments:'eof' });

await build({ entryPoints:['src/pilot/main.jsx'], bundle:true, outfile:'dist/pilot.js', format:'iife', minify:true, target:['es2022'], define:{'process.env.NODE_ENV':'"production"'}, legalComments:'eof' });

// Content versions prevent old cached scripts from surviving a deployment.
const {readFile,writeFile}=await import('node:fs/promises');
const {createHash}=await import('node:crypto');
for(const name of ['index.html','pilot.html']){
  let html=await readFile(`dist/${name}`,'utf8');
  const assets=[...html.matchAll(/(?:src|href)="([\w./-]+\.(?:js|css))(?:\?v=[a-f0-9]+)?"/g)];
  for(const match of assets){
    const bytes=await readFile(`dist/${match[1]}`);
    const hash=createHash('sha256').update(bytes).digest('hex').slice(0,12);
    html=html.replace(match[0],match[0].replace(/=".*"$/,`="${match[1]}?v=${hash}"`));
  }
  await writeFile(`dist/${name}`,html);
}
