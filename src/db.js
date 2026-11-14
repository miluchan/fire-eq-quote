/**
 * 資料存取層
 * - 有 DATABASE_URL（Vercel × Neon 整合會自動注入）：連 Neon PostgreSQL
 * - 沒有：記憶體模式（用 refdata.js，資料不會保存），只供本機先看畫面
 */
const R = require('./refdata');

let pool = null;
const mem = { quotes: new Map(), seq: new Map() };

function dbUrl() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
}

function usingDb() {
  return Boolean(dbUrl());
}

function getPool() {
  if (!pool) {
    const { Pool } = require('pg');
    const url = dbUrl();
    pool = new Pool({
      connectionString: url,
      ssl: /sslmode=/.test(url) ? undefined : { rejectUnauthorized: true },
      max: 3, // Serverless：每個函式實例只開少量連線（走 Neon pooler）
      idleTimeoutMillis: 10000,
    });
  }
  return pool;
}

/** 直接執行（可多句 SQL，初始化用） */
async function exec(sql) {
  return getPool().query(sql);
}

async function q(sql, params) {
  return (await getPool().query(sql, params)).rows;
}

/** 載入所有參考資料（下拉選單 + 計算用費率表） */
async function loadRefData() {
  if (!usingDb()) {
    return {
      zips: R.ZIPS,
      costs: R.BUILDING_COSTS.flatMap(([min, max, ...p]) =>
        p.map((v, i) => ({ version: R.BUILDING_COST_VERSION, floor_min: min, floor_max: max, cost_region: i + 1, price_per_ping: v }))),
      structures: R.STRUCTURES,
      roofs: R.ROOFS,
      grades: R.GRADES,
      shortRates: Object.entries(R.SHORT_RATES).flatMap(([product, l]) => l.map(([months, pct]) => ({ product, months, pct }))),
      settings: Object.fromEntries(Object.entries(R.SETTINGS).map(([k, v]) => [k, String(v)])),
      banks: R.BANKS.map(([code, name]) => ({ code, name })),
      nationalities: R.NATIONALITIES.map(([code, name]) => ({ code, name })),
    };
  }
  const [zips, costs, structures, roofs, grades, shortRates, settings, banks, nationalities] = await Promise.all([
    q('SELECT zip, county, district, cost_region FROM zip_codes ORDER BY zip'),
    q(`SELECT version, floor_min, floor_max, cost_region, price_per_ping FROM building_costs
       WHERE version = (SELECT max(version) FROM building_costs) ORDER BY floor_min, cost_region`),
    q('SELECT code, name, cost_factor::float, flat_price, default_grade FROM structure_codes ORDER BY code'),
    q('SELECT code, name, grade_shift FROM roof_codes ORDER BY code'),
    q('SELECT code, name, fire_rate::float FROM building_grades ORDER BY code'),
    q('SELECT product, months, pct::float FROM short_rates ORDER BY product, months'),
    q('SELECT key, value FROM settings'),
    q('SELECT code, name FROM banks ORDER BY code'),
    q('SELECT code, name FROM nationalities ORDER BY CASE WHEN code = \'158\' THEN 0 ELSE 1 END, code'),
  ]);
  return {
    zips, costs, structures, roofs, grades, shortRates,
    settings: Object.fromEntries(settings.map((s) => [s.key, s.value])),
    banks, nationalities,
  };
}

/** 產生要保號碼：H + 民國年月日(7) + 流水號(4)，例 H11511130001 */
async function nextQuoteNo() {
  const now = new Date(Date.now() + 8 * 3600 * 1000); // 台灣時間
  const day = now.toISOString().slice(0, 10);
  const roc = `${now.getUTCFullYear() - 1911}${day.slice(5, 7)}${day.slice(8, 10)}`;
  let n;
  if (!usingDb()) {
    n = (mem.seq.get(day) || 0) + 1;
    mem.seq.set(day, n);
  } else {
    const rows = await q(
      `INSERT INTO quote_seq (day, last) VALUES ($1, 1)
       ON CONFLICT (day) DO UPDATE SET last = quote_seq.last + 1 RETURNING last`, [day]);
    n = rows[0].last;
  }
  return `H${roc}${String(n).padStart(4, '0')}`;
}

const COLS = [
  'quote_no', 'prev_quote_no', 'status', 'location_zip', 'total_floors', 'area_ping', 'build_year',
  'structure_code', 'roof_code', 'grade_code', 'decoration_per_ping',
  'building_sum', 'movable_auto_sum', 'movable_add_sum', 'eq_sum',
  'fire_premium', 'eq_premium', 'total_premium', 'calc_detail',
  'insured', 'applicant', 'property_zip', 'property_addr', 'mail_zip', 'mail_addr',
  'period_start', 'period_end', 'period_months', 'mortgagee_bank', 'mortgagee_name',
];

async function saveQuote(rec) {
  if (!rec.quote_no) rec.quote_no = await nextQuoteNo();
  if (!usingDb()) {
    const prev = mem.quotes.get(rec.quote_no);
    const row = { ...prev, ...rec, updated_at: new Date().toISOString(), created_at: prev?.created_at || new Date().toISOString() };
    mem.quotes.set(rec.quote_no, row);
    return row;
  }
  const vals = COLS.map((c) => {
    const v = rec[c];
    if (v === undefined || v === '') return null;
    return typeof v === 'object' && v !== null && !(v instanceof Date) ? JSON.stringify(v) : v;
  });
  const placeholders = COLS.map((_, i) => `$${i + 1}`).join(', ');
  const updates = COLS.filter((c) => c !== 'quote_no').map((c) => `${c} = EXCLUDED.${c}`).join(', ');
  const rows = await q(
    `INSERT INTO quotes (${COLS.join(', ')}) VALUES (${placeholders})
     ON CONFLICT (quote_no) DO UPDATE SET ${updates}, updated_at = now()
     RETURNING *`, vals);
  return rows[0];
}

async function getQuote(quoteNo) {
  if (!usingDb()) return mem.quotes.get(quoteNo) || null;
  const rows = await q('SELECT * FROM quotes WHERE quote_no = $1', [quoteNo]);
  return rows[0] || null;
}

/** 依要保號碼或被保險人身分證/統編，找最近一筆（載入前期資料用） */
async function findLatest(keyword) {
  if (!usingDb()) {
    const list = [...mem.quotes.values()].filter((x) => x.quote_no === keyword || x.insured?.id_no === keyword);
    return list.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
  }
  const rows = await q(
    `SELECT * FROM quotes WHERE quote_no = $1 OR insured->>'id_no' = $1
     ORDER BY created_at DESC LIMIT 1`, [keyword]);
  return rows[0] || null;
}

async function listQuotes(limit = 50) {
  if (!usingDb()) return [...mem.quotes.values()].slice(-limit).reverse();
  return q(`SELECT quote_no, status, insured->>'name' AS insured_name, total_premium, created_at
            FROM quotes ORDER BY created_at DESC LIMIT $1`, [limit]);
}

module.exports = { exec, usingDb, loadRefData, saveQuote, getQuote, findLatest, listQuotes, nextQuoteNo };
