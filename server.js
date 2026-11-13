/**
 * 住宅火災及地震基本保險 報價系統 — 伺服器
 * 只依賴 pg（連 Neon），HTTP 使用 Node 內建模組
 */
require('./src/env');
const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./src/db');
const P = require('./src/premium');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// 參考資料快取（費率改了可呼叫 POST /api/refdata/reload）
let cache = null;
async function getRef() {
  if (!cache) {
    const raw = await db.loadRefData();
    cache = { raw, ref: P.buildRef(raw) };
  }
  return cache;
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('資料過大'));
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('JSON 格式錯誤')); }
    });
  });
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(PUBLIC, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

/** 由前端表單組成計算輸入 */
function toCalcInput(b) {
  const months = b.periodStart && b.periodEnd ? P.monthsBetween(b.periodStart, b.periodEnd) : Number(b.periodMonths) || 12;
  return {
    zip: b.locationZip,
    totalFloors: b.totalFloors,
    areaPing: b.areaPing,
    structureCode: b.structureCode,
    roofCode: b.roofCode,
    gradeCode: b.gradeCode,
    decorationPerPing: b.decorationPerPing,
    buildingSumWan: b.buildingSumWan,
    movableAddWan: b.movableAddWan,
    periodMonths: months,
  };
}

const ID_RE = /^[A-Z][12890]\d{8}$|^[A-Z][A-D]\d{8}$|^\d{8}$/;

function validateForSave(b) {
  const errs = [];
  if (!b.insured?.name) errs.push('被保險人姓名');
  if (!b.insured?.id_no || !ID_RE.test(String(b.insured.id_no).toUpperCase())) errs.push('被保險人身分證統編格式');
  if (!b.applicant?.name) errs.push('要保人姓名');
  if (!b.propertyAddr) errs.push('標的物地址');
  if (!b.periodStart || !b.periodEnd) errs.push('保險期間');
  return errs;
}

async function handleApi(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/api/health') return send(res, 200, { ok: true, db: db.usingDb() ? 'neon' : 'memory' });

  if (p === '/api/refdata' && req.method === 'GET') {
    const { raw } = await getRef();
    return send(res, 200, raw);
  }
  if (p === '/api/refdata/reload' && req.method === 'POST') {
    cache = null;
    await getRef();
    return send(res, 200, { ok: true });
  }

  if (p === '/api/suggest' && req.method === 'POST') {
    const b = await readBody(req);
    const { ref } = await getRef();
    return send(res, 200, P.suggest(ref, toCalcInput(b)));
  }

  if (p === '/api/calc' && req.method === 'POST') {
    const b = await readBody(req);
    const { ref } = await getRef();
    return send(res, 200, P.calculate(ref, toCalcInput(b)));
  }

  if (p === '/api/quotes' && req.method === 'GET') {
    const kw = url.searchParams.get('q');
    if (kw) {
      const row = await db.findLatest(kw.trim().toUpperCase());
      return row ? send(res, 200, row) : send(res, 404, { error: '查無前期資料' });
    }
    return send(res, 200, await db.listQuotes());
  }

  if (p === '/api/quotes' && req.method === 'POST') {
    const b = await readBody(req);
    const errs = validateForSave(b);
    if (errs.length) return send(res, 400, { error: `請確認：${errs.join('、')}` });
    const { ref } = await getRef();
    const input = toCalcInput(b);
    const c = P.calculate(ref, input); // 伺服器端重算，不信任前端金額
    const saved = await db.saveQuote({
      quote_no: b.quoteNo || null,
      prev_quote_no: b.prevQuoteNo,
      status: '報價',
      location_zip: b.locationZip,
      total_floors: b.totalFloors || null,
      area_ping: b.areaPing || null,
      build_year: b.buildYear || null,
      structure_code: b.structureCode,
      roof_code: b.roofCode,
      grade_code: b.gradeCode,
      decoration_per_ping: b.decorationPerPing || 0,
      building_sum: c.buildingSum,
      movable_auto_sum: c.movableAutoSum,
      movable_add_sum: c.movableAddSum,
      eq_sum: c.eqSum,
      fire_premium: c.firePremium,
      eq_premium: c.eqPremium,
      total_premium: c.totalPremium,
      calc_detail: c.detail,
      insured: { ...b.insured, id_no: String(b.insured.id_no).toUpperCase() },
      applicant: b.applicant,
      property_zip: b.propertyZip,
      property_addr: b.propertyAddr,
      mail_zip: b.mailZip,
      mail_addr: b.mailAddr,
      period_start: b.periodStart,
      period_end: b.periodEnd,
      period_months: input.periodMonths,
      mortgagee_bank: b.mortgageeBank,
      mortgagee_name: b.mortgageeName,
    });
    return send(res, 200, { quote: saved, calc: c });
  }

  const m = p.match(/^\/api\/quotes\/([A-Za-z0-9]+)$/);
  if (m && req.method === 'GET') {
    const row = await db.getQuote(m[1]);
    return row ? send(res, 200, row) : send(res, 404, { error: '查無此要保號碼' });
  }

  return send(res, 404, { error: 'API not found' });
}

http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) return await handleApi(req, res);
    return serveStatic(req, res);
  } catch (e) {
    console.error(e);
    return send(res, e.message && !e.code ? 400 : 500, { error: e.message || '系統錯誤' });
  }
}).listen(PORT, () => {
  console.log(`住宅火災及地震基本保險報價系統 http://localhost:${PORT}  (資料庫：${db.usingDb() ? 'Neon PostgreSQL' : '記憶體模式－未設定 DATABASE_URL'})`);
});
