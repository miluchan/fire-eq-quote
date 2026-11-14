/**
 * 本機開發伺服器（Vercel 上不會用到這個檔案）
 * 用法：npm run dev → http://localhost:3000
 * 與 Vercel Functions 共用 src/handlers.js，行為一致
 */
require('./src/env');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { run } = require('./src/handlers');
const db = require('./src/db');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (_) { resolve({}); } });
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(/^\/api\/([a-z]+)$/);
  if (m) {
    const r = await run(m[1], {
      method: req.method,
      query: Object.fromEntries(url.searchParams),
      body: req.method === 'POST' ? await readBody(req) : {},
    });
    res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(r.data));
  }
  const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log(`http://localhost:${PORT}  (資料庫：${db.usingDb() ? 'Neon PostgreSQL' : '記憶體模式'})`);
});
