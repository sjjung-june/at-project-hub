import {context} from 'esbuild';
const ctx=await context({entryPoints:['src/main.jsx'],bundle:true,outfile:'dist/components.js',format:'iife',target:['es2022'],define:{'process.env.NODE_ENV':'"development"'}});
await ctx.watch();
const server=await ctx.serve({servedir:'dist',host:'127.0.0.1',port:4173});
console.log(`Local: http://127.0.0.1:${server.port}`);
