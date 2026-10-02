'use strict';
// Kompyuterda sinash uchun server: public/ papkadagi sahifalar + /api (Vercel'dagi bilan bir xil kod).
// Ma'lumot data.json faylida (yoki SUPABASE_URL berilsa — Supabase'da).
const http = require('http'), fs = require('fs'), path = require('path');
const { handler } = require('./lib/app');

const PORT = Number(process.env.PORT) || 3000;
const PUB = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.json': 'application/json' };

http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.startsWith('/api/')) return handler(req, res);
  const file = path.join(PUB, p === '/' ? 'index.html' : p);
  if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Topilmadi'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log(`\n  Mehmonxona (sinov rejimi): http://localhost:${PORT}\n  To'xtatish: Ctrl+C\n`);
});

// Vercel'da buni cron-job.org bajaradi; kompyuterda o'zimiz har 20 soniyada
setInterval(() => handler({ method: 'GET', url: '/api/tick', headers: { authorization: 'Bearer ' + (process.env.CRON_SECRET || '') } }, { setHeader() {}, end() {}, statusCode: 0 }), 20000);
