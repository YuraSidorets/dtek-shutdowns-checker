import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
await mkdir('dist/pages', { recursive: true });
await cp('public', 'dist/pages', { recursive: true });
await build({ entryPoints: ['src/service.mjs'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['node:buffer'], outfile: 'dist/service.mjs' });
console.log('Built dist/pages and dist/service.mjs');
