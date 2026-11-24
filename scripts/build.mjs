import { build } from 'esbuild';
await build({ entryPoints:['src/main.jsx'], bundle:true, outfile:'dist/components.js', format:'iife', minify:true, target:['es2022'], define:{'process.env.NODE_ENV':'"production"'}, legalComments:'eof' });
