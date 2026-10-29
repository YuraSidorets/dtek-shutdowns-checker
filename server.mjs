import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { handleDtekRequest } from './src/dtek.mjs';

const files = { '/': ['index.html', 'text/html'], '/style.css': ['style.css', 'text/css'], '/app.mjs': ['app.mjs', 'text/javascript'], '/overlap.mjs': ['overlap.mjs', 'text/javascript'], '/config.mjs': ['config.mjs', 'text/javascript'], '/streets.mjs': ['streets.mjs', 'text/javascript'] };
const port = Number(process.env.PORT || 43187);
createServer(async (req, res) => {
  try {
    const request = new Request(`http://localhost:${port}${req.url}`, { method: req.method });
    const path = new URL(request.url).pathname;
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (path.startsWith('/api/')) {
      const response = await handleDtekRequest(request, { cookie: process.env.DTEK_COOKIE, userAgent: process.env.DTEK_USER_AGENT });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    const file = files[path];
    if (!file) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(await readFile(new URL(`./public/${file[0]}`, import.meta.url)));
  } catch { res.writeHead(500).end('The checker could not load. Please try again.'); }
}).listen(port, '127.0.0.1', () => console.log(`Power overlap: http://127.0.0.1:${port}`));
