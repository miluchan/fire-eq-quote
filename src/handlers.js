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
    return ok(P.calculate(ref, toCalcInput(body)));
  },

  async quotes({ method, query, body }) {
    need(method, ['GET', 'POST']);
    if (method === 'GET') {
      if (query.q) {
        const row = await db.findLatest(String(query.q).trim().toUpperCase());
        if (!row) throw new HttpError(404, '查無前期資料');
        return ok(row);
      }
      if (query.no) {
        const row = await db.getQuote(String(query.no));
        if (!row) throw new HttpError(404, '查無此要保號碼');
        return ok(row);
      }
      return ok(await db.listQuotes());
    }

    const b = body;
    const errs = validateForSave(b);
    if (errs.length) throw new HttpError(400, `請確認：${errs.join('、')}`);
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
    return ok({ quote: saved, calc: c });
  },

  /**
   * 一次性初始化資料庫：瀏覽器開 /api/init
   * - 資料庫還沒有資料時，任何人可執行一次
   * - 已初始化過再執行，需帶 ?token=（Vercel 環境變數 INIT_TOKEN），避免被他人重跑
   */
  async init({ query }) {
    if (!db.usingDb()) throw new HttpError(400, '尚未設定 DATABASE_URL：請先在 Neon 資料庫頁按 Connect to Project 連到此 Vercel 專案，並 Redeploy');
    let initialized = false;
    try {
      const r = await db.exec('SELECT count(*)::int AS n FROM zip_codes');
      initialized = r.rows[0].n > 0;
    } catch (_) { /* 資料表不存在 → 尚未初始化 */ }
    if (initialized) {
      const token = process.env.INIT_TOKEN;
      if (!token || query.token !== token) {
        return ok({ ok: true, message: '資料庫已初始化過，不需再執行。（如需重灌種子資料，請設定 INIT_TOKEN 環境變數並以 ?token= 呼叫）' });
      }
    }
    await db.exec(SCHEMA);
    await db.exec(buildSeedSql());
    cache = null;
    const r = await db.exec(`SELECT
      (SELECT count(*) FROM zip_codes)::int AS zips,
      (SELECT count(*) FROM building_costs)::int AS costs,
      (SELECT count(*) FROM building_grades)::int AS grades`);
    return ok({ ok: true, message: '✔ 資料表建立完成、種子資料寫入完成', counts: r.rows[0] });
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
