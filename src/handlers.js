/**
 * API 處理邏輯（Vercel Functions 與本機 server.js 共用）
 * 每個 handler 收 { method, query, body }，回傳 { status, data }
 */
const db = require('./db');
const P = require('./premium');
const SCHEMA = require('./schema');
const { buildSeedSql } = require('./seed');

// 參考資料快取：Serverless 實例存活期間沿用，60 秒後重新讀 DB（改費率後最多 1 分鐘生效）
let cache = null;
let cachedAt = 0;
async function getRef() {
  if (!cache || Date.now() - cachedAt > 60000) {
    const raw = await db.loadRefData();
    cache = { raw, ref: P.buildRef(raw) };
    cachedAt = Date.now();
  }
  return cache;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const ok = (data) => ({ status: 200, data });
const need = (method, allowed) => {
  if (!allowed.includes(method)) throw new HttpError(405, `不支援 ${method}`);
};

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
    planCode: b.planCode || 'HF',
    propSumWan: b.propSumWan,
    eqAlready: Boolean(b.eqAlready),
    coverages: b.coverages || {},
    periodMonths: months,
  };
}

/** 身分證 / 新舊式居留證 / 統一編號 檢核 */
function validId(v) {
  v = String(v || '').toUpperCase();
  if (/^\d{8}$/.test(v)) {
    const w = [1, 2, 1, 2, 1, 2, 4, 1];
    let sum = 0;
    for (let i = 0; i < 8; i++) { const p = Number(v[i]) * w[i]; sum += Math.floor(p / 10) + (p % 10); }
    return sum % 5 === 0 || (v[6] === '7' && (sum + 1) % 5 === 0);
  }
  if (!/^[A-Z][12890A-D]\d{8}$/.test(v)) return false;
  const letters = 'ABCDEFGHJKLMNPQRSTUVXYWZIO';
  const code = letters.indexOf(v[0]) + 10;
  const second = /[A-D]/.test(v[1]) ? (letters.indexOf(v[1]) + 10) % 10 : Number(v[1]);
  const digits = [Math.floor(code / 10), code % 10, second, ...v.slice(2).split('').map(Number)];
  const w = [1, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1];
  return digits.reduce((s2, d, i) => s2 + d * w[i], 0) % 10 === 0;
}

/** 儲存報價單：只檢查最基本欄位；確認要保：要保書全部必填 */
function validate(b, action) {
  const errs = [];
  if (!b.applicant?.name) errs.push('要保人姓名');
  if (!b.periodStart || !b.periodEnd) errs.push('保險期間');
  if (action === 'confirm') {
    if (!b.insured?.name) errs.push('被保險人姓名');
    if (!validId(b.insured?.id_no)) errs.push('被保險人身分證統編');
    if (!validId(b.applicant?.id_no)) errs.push('要保人身分證統編');
    for (const [who, label] of [['insured', '被保險人'], ['applicant', '要保人']]) {
      const bd = b[who]?.birthday;
      if (bd && !/^\d{7}$/.test(bd)) errs.push(`${label}生日格式(CYYMMDD)`);
    }
    if (!b.propertyAddr) errs.push('標的物地址');
    if (!b.mailAddr) errs.push('通訊地址');
  }
  return errs;
}

const handlers = {
  async health() {
    return ok({ ok: true, db: db.usingDb() ? 'neon' : 'memory' });
  },

  async refdata({ method }) {
    need(method, ['GET']);
    return ok((await getRef()).raw);
  },

  async suggest({ method, body }) {
    need(method, ['POST']);
    const { ref } = await getRef();
    return ok(P.suggest(ref, toCalcInput(body)));
  },

  async calc({ method, body }) {
    need(method, ['POST']);
    const { ref } = await getRef();
    return ok(P.calcAny(ref, toCalcInput(body)));
  },

  async quotes({ method, query, body }) {
    need(method, ['GET', 'POST', 'DELETE']);

    if (method === 'GET') {
      if (query.q) { // 載入前期資料
        const row = await db.findLatest(String(query.q).trim().toUpperCase());
        if (!row) throw new HttpError(404, '查無前期資料');
        return ok(row);
      }
      if (query.no) {
        const row = await db.getQuote(String(query.no));
        if (!row) throw new HttpError(404, '查無此報價單號');
        return ok(row);
      }
      return ok(await db.listQuotes({ kw: query.kw || '', status1: query.status1 || '', status2: query.status2 || '' }));
    }

    if (method === 'DELETE') {
      const row = await db.getQuote(String(query.no || ''));
      if (!row) throw new HttpError(404, '查無此報價單號');
      if (row.status1 !== '報價中') throw new HttpError(409, `「${row.status1}」的報價單不可刪除`);
      await db.deleteQuote(row.quote_no);
      return ok({ ok: true });
    }

    // POST：action = save（儲存報價單）/ confirm（確認要保）
    const b = body;
    const action = b.action === 'confirm' ? 'confirm' : 'save';
    const existing = b.quoteNo ? await db.getQuote(b.quoteNo) : null;
    if (b.quoteNo && !existing) throw new HttpError(404, '查無此報價單號（可能已刪除）');
    if (existing && existing.status1 !== '報價中') {
      throw new HttpError(409, `此報價單狀態為「${existing.status1}」，不可修改`);
    }
    const errs = validate(b, action);
    if (errs.length) throw new HttpError(400, `請確認：${errs.join('、')}`);

    const { ref } = await getRef();
    const input = toCalcInput(b);
    const c = P.calcAny(ref, input); // 伺服器端重算，不信任前端金額
    const isFire = c.kind === 'FIRE';
    const saved = await db.saveQuote({
      quote_no: existing?.quote_no || null,
      prev_quote_no: b.prevQuoteNo,
      plan_code: c.planCode,
      status1: action === 'confirm' ? '已要保' : '報價中',
      status2: existing?.status2 || '未繳費',
      confirmed_at: action === 'confirm' ? new Date().toISOString() : null,
      location_zip: b.locationZip,
      total_floors: b.totalFloors || null,
      area_ping: b.areaPing || null,
      build_year: b.buildYear || null,
      structure_code: b.structureCode,
      roof_code: b.roofCode,
      grade_code: b.gradeCode,
      decoration_per_ping: isFire ? b.decorationPerPing || 0 : 0,
      building_sum: isFire ? c.buildingSum : 0,
      movable_auto_sum: isFire ? c.movableAutoSum : 0,
      movable_add_sum: isFire ? c.movableAddSum : 0,
      prop_sum: isFire ? 0 : c.propSum,
      eq_already: isFire ? false : c.eqAlready,
      coverages: isFire ? null : c.selections,
      lines: c.lines,
      eq_sum: c.eqSum,
      fire_premium: c.firePremium,
      eq_premium: c.eqPremium,
      home_premium: c.homePremium,
      total_premium: c.totalPremium,
      calc_detail: c.detail,
      insured: { ...b.insured, id_no: String(b.insured?.id_no || '').toUpperCase() },
      applicant: { ...b.applicant, id_no: String(b.applicant?.id_no || '').toUpperCase() },
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
    return ok({ quote: saved, calc: c });
  },

  /**
   * 建立／更新資料表＋寫入種子資料：瀏覽器開 /api/init
   * 可重複執行、不會刪除資料；費率類資料若已存在不覆蓋（保留在 DB 調整過的費率）
   * 每次部署新版（資料表有變動）後執行一次即可
   */
  async init() {
    if (!db.usingDb()) throw new HttpError(400, '尚未設定 DATABASE_URL：請先在 Neon 資料庫頁按 Connect to Project 連到此 Vercel 專案，並 Redeploy');
    await db.exec(SCHEMA);
    await db.exec(buildSeedSql());
    cache = null;
    const r = await db.exec(`SELECT
      (SELECT count(*) FROM zip_codes)::int AS zips,
      (SELECT count(*) FROM plans)::int AS plans,
      (SELECT count(*) FROM coverages)::int AS coverages,
      (SELECT count(*) FROM coverage_premiums)::int AS coverage_premiums,
      (SELECT count(*) FROM quotes WHERE deleted_at IS NULL)::int AS quotes`);
    return ok({ ok: true, message: '✔ 資料表建立／更新完成、種子資料寫入完成', counts: r.rows[0] });
  },
};

/** 統一執行並轉成 HTTP 回應 */
async function run(name, { method, query = {}, body = {} }) {
  try {
    const h = handlers[name];
    if (!h) throw new HttpError(404, 'API not found');
    return await h({ method, query, body: body || {} });
  } catch (e) {
    if (e.status) return { status: e.status, data: { error: e.message } };
    if (e.code) { // PostgreSQL 錯誤
      console.error(e);
      return { status: 500, data: { error: `資料庫錯誤：${e.message}` } };
    }
    // 計算引擎的輸入檢核錯誤（如「請輸入總樓層數」）
    return { status: 400, data: { error: e.message || '系統錯誤' } };
  }
}

/** Vercel Function 包裝 */
function vercel(name) {
  return async (req, res) => {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
    const r = await run(name, { method: req.method, query: req.query || {}, body });
    res.setHeader('Cache-Control', 'no-store');
    res.status(r.status).json(r.data);
  };
}

module.exports = { run, vercel };
