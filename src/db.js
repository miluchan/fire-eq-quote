/**
 * 資料存取層
 * - 有 DATABASE_URL（Vercel × Neon 整合會自動注入）：連 Neon PostgreSQL
 * - 沒有：記憶體模式（用 refdata.js，資料不會保存），只供本機先看畫面
 */
const R = require('./refdata');

let pool = null;
const mem = { quotes: new Map(), seq: new Map(), ledger: [], policySeq: new Map() };
const L = require('./ledger');

function dbUrl() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
}

function usingDb() {
  return Boolean(dbUrl());
}

function getPool() {
  if (!pool) {
    const { Pool, types } = require('pg');
    types.setTypeParser(1082, (v) => v); // DATE 以 'YYYY-MM-DD' 字串回傳，避免時區位移
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
      plans: R.PLANS,
      coverages: R.COVERAGES,
      coverageOptions: R.COVERAGE_OPTIONS,
      coveragePremiums: R.COVERAGE_PREMIUMS,
      coverageRates: R.COVERAGE_RATE_ROWS,
      status1: R.STATUS1,
      status2: R.STATUS2,
    };
  }
  const [zips, costs, structures, roofs, grades, shortRates, settings, banks, nationalities,
    plans, coverages, coverageOptions, coveragePremiums, coverageRates] = await Promise.all([
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
    q('SELECT code, name, kind, prop_label, prop_base_fee::float, prop_rate::float, sort FROM plans WHERE active ORDER BY sort'),
    q('SELECT code, name, sum_label, calc, required, default_on, sort FROM coverages WHERE active ORDER BY sort'),
    q('SELECT coverage_code, value, is_default, sort FROM coverage_options ORDER BY coverage_code, sort'),
    q('SELECT plan_code, coverage_code, value, premium::float, estimated FROM coverage_premiums'),
    q('SELECT plan_code, coverage_code, rate::float FROM coverage_rates'),
  ]);
  return {
    zips, costs, structures, roofs, grades, shortRates,
    settings: Object.fromEntries(settings.map((s) => [s.key, s.value])),
    banks, nationalities,
    plans, coverages, coverageOptions, coveragePremiums, coverageRates,
    status1: R.STATUS1,
    status2: R.STATUS2,
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
  'quote_no', 'prev_quote_no', 'plan_code', 'status1', 'status2', 'location_zip', 'total_floors', 'area_ping', 'build_year',
  'structure_code', 'roof_code', 'grade_code', 'decoration_per_ping',
  'building_sum', 'movable_auto_sum', 'movable_add_sum', 'eq_sum',
  'prop_sum', 'eq_already', 'coverages', 'lines', 'confirmed_at',
  'fire_premium', 'eq_premium', 'home_premium', 'total_premium', 'calc_detail',
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
  if (!usingDb()) {
    const r = mem.quotes.get(quoteNo);
    return r && !r.deleted_at ? r : null;
  }
  const rows = await q('SELECT * FROM quotes WHERE quote_no = $1 AND deleted_at IS NULL', [quoteNo]);
  return rows[0] || null;
}

/** 依報價單號或被保險人身分證/統編，找最近一筆（載入前期資料用） */
async function findLatest(keyword) {
  if (!usingDb()) {
    const list = [...mem.quotes.values()].filter((x) => !x.deleted_at && (x.quote_no === keyword || x.insured?.id_no === keyword));
    return list.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
  }
  const rows = await q(
    `SELECT * FROM quotes WHERE deleted_at IS NULL AND (quote_no = $1 OR insured->>'id_no' = $1)
     ORDER BY created_at DESC LIMIT 1`, [keyword]);
  return rows[0] || null;
}

/** 查詢一覽表：關鍵字（報價單號 / 要保人姓名 / 要保人或被保險人 ID）＋狀態篩選 */
async function listQuotes({ kw = '', status1 = '', status2 = '', limit = 200 } = {}) {
  const k = String(kw).trim();
  if (!usingDb()) {
    const K = k.toUpperCase();
    return [...mem.quotes.values()]
      .filter((x) => !x.deleted_at)
      .filter((x) => !k || x.quote_no.includes(K) || (x.applicant?.name || '').includes(k)
        || (x.applicant?.id_no || '').toUpperCase() === K || (x.insured?.id_no || '').toUpperCase() === K)
      .filter((x) => !status1 || x.status1 === status1)
      .filter((x) => !status2 || x.status2 === status2)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, limit)
      .map((x) => ({
        quote_no: x.quote_no, plan_code: x.plan_code, applicant_name: x.applicant?.name || '',
        period_start: x.period_start, period_end: x.period_end,
        fire_premium: x.fire_premium, eq_premium: x.eq_premium, home_premium: x.home_premium,
        total_premium: x.total_premium, status1: x.status1, status2: x.status2, created_at: x.created_at,
      }));
  }
  return q(
    `SELECT quote_no, plan_code, applicant->>'name' AS applicant_name,
            to_char(period_start, 'YYYY-MM-DD') AS period_start, to_char(period_end, 'YYYY-MM-DD') AS period_end,
            fire_premium, eq_premium, home_premium, total_premium, status1, status2, created_at
       FROM quotes
      WHERE deleted_at IS NULL
        AND ($1 = '' OR quote_no ILIKE '%' || $1 || '%' OR applicant->>'name' ILIKE '%' || $1 || '%'
             OR upper(applicant->>'id_no') = upper($1) OR upper(insured->>'id_no') = upper($1))
        AND ($2 = '' OR status1 = $2)
        AND ($3 = '' OR status2 = $3)
      ORDER BY created_at DESC
      LIMIT $4`, [k, status1, status2, limit]);
}

/** 刪除（軟刪除，資料保留） */
async function deleteQuote(quoteNo) {
  if (!usingDb()) {
    const r = mem.quotes.get(quoteNo);
    if (r) r.deleted_at = new Date().toISOString();
    return Boolean(r);
  }
  const rows = await q('UPDATE quotes SET deleted_at = now() WHERE quote_no = $1 AND deleted_at IS NULL RETURNING quote_no', [quoteNo]);
  return rows.length > 0;
}

class DbError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** 台灣今天 'YYYY-MM-DD' */
function taipeiToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * 確認出單（單一交易）：
 * 鎖定報價單 → 檢查「已要保」→ 取保單號 → 寫入 ao_plyedr_prem → 報價單改「已出單」
 * build(q, policyNo, day) 回傳要寫入帳款檔的欄位
 */
async function issuePolicy(quoteNo, build) {
  if (!usingDb()) {
    const q = mem.quotes.get(quoteNo);
    if (!q || q.deleted_at) throw new DbError(404, '查無此報價單號');
    if (q.status1 !== '已要保') throw new DbError(409, `報價單狀態為「${q.status1}」，需「已要保」才能出單`);
    const day = taipeiToday();
    const n = (mem.policySeq.get(day) || 0) + 1;
    mem.policySeq.set(day, n);
    const policyNo = L.policyNoOf(day, n);
    const row = { id: mem.ledger.length + 1, created_at: new Date().toISOString() };
    for (const f of L.LEDGER_FIELDS) row[f.name] = f.type === 'DATE' ? null : /^(DECIMAL|INTEGER|SMALLINT)/.test(f.type) ? 0 : '';
    Object.assign(row, build(q, policyNo, day));
    row.mprem = Number(row.mprem).toFixed(4);
    mem.ledger.push(row);
    Object.assign(q, { status1: '已出單', policy_no: policyNo, issued_at: new Date().toISOString() });
    return { policyNo, ledger: row, quote: q };
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows: [q] } = await client.query(
      'SELECT * FROM quotes WHERE quote_no = $1 AND deleted_at IS NULL FOR UPDATE', [quoteNo]);
    if (!q) throw new DbError(404, '查無此報價單號');
    if (q.status1 !== '已要保') throw new DbError(409, `報價單狀態為「${q.status1}」，需「已要保」才能出單`);
    if (q.policy_no) throw new DbError(409, `此報價單已出單（保單號碼 ${q.policy_no}）`);

    const { rows: [d] } = await client.query(`SELECT to_char((now() AT TIME ZONE 'Asia/Taipei')::date, 'YYYY-MM-DD') AS day`);
    const { rows: [s] } = await client.query(
      `INSERT INTO policy_seq (day, last) VALUES ($1, 1)
       ON CONFLICT (day) DO UPDATE SET last = policy_seq.last + 1 RETURNING last`, [d.day]);
    const policyNo = L.policyNoOf(d.day, s.last);

    const rec = build(q, policyNo, d.day);
    const cols = Object.keys(rec);
    const { rows: [ledger] } = await client.query(
      `INSERT INTO ao_plyedr_prem (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      cols.map((c) => rec[c]));
    const { rows: [quote] } = await client.query(
      `UPDATE quotes SET status1 = '已出單', policy_no = $2, issued_at = now(), updated_at = now()
        WHERE quote_no = $1 RETURNING *`, [quoteNo, policyNo]);
    await client.query('COMMIT');
    return { policyNo, ledger, quote };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** 帳款檔清單（可依保單號碼/報價單號/要保人、收支註記、類別型態篩選） */
async function listLedger({ kw = '', frcvpay = '', ftype = '', limit = 200 } = {}) {
  const k = String(kw).trim();
  if (!usingDb()) {
    return mem.ledger
      .map((r) => {
        const q = [...mem.quotes.values()].find((x) => x.policy_no === r.ipolicy1);
        return { ...r, quote_no: q?.quote_no || '', applicant_name: q?.applicant?.name || '' };
      })
      .filter((r) => !k || r.ipolicy1.includes(k.toUpperCase()) || r.quote_no.includes(k.toUpperCase()) || r.nassured.includes(k))
      .filter((r) => !frcvpay || r.frcvpay === frcvpay)
      .filter((r) => !ftype || r.ftype === ftype)
      .reverse().slice(0, limit);
  }
  return q(
    `SELECT a.id, a.ipolicy1, a.iendorse, a.dplyend, a.ftype, a.insure_type, a.nassured, a.isub, a.mprem, a.icur,
            a.dbegin, a.dend, a.fcommit, a.frcvpay,
            COALESCE(qt.quote_no, '') AS quote_no, COALESCE(qt.applicant->>'name', '') AS applicant_name
       FROM ao_plyedr_prem a
       LEFT JOIN quotes qt ON qt.policy_no = a.ipolicy1
      WHERE ($1 = '' OR a.ipolicy1 ILIKE '%' || $1 || '%' OR qt.quote_no ILIKE '%' || $1 || '%'
             OR a.nassured ILIKE '%' || $1 || '%')
        AND ($2 = '' OR a.frcvpay = $2)
        AND ($3 = '' OR a.ftype = $3)
      ORDER BY a.id DESC
      LIMIT $4`, [k, frcvpay, ftype, limit]);
}

async function getLedger(id) {
  if (!usingDb()) return mem.ledger.find((r) => String(r.id) === String(id)) || null;
  const rows = await q('SELECT * FROM ao_plyedr_prem WHERE id = $1', [Number(id) || 0]);
  return rows[0] || null;
}

module.exports = {
  exec, usingDb, loadRefData, saveQuote, getQuote, findLatest, listQuotes, deleteQuote, nextQuoteNo,
  issuePolicy, listLedger, getLedger,
};
