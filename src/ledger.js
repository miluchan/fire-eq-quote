/**
 * 保批單帳款檔 ao_plyedr_prem
 * 欄位依資料集規格（序號 1~48；第 9 欄 itakeover_i 轉入公司標示不用，未建）
 * CHAR → VARCHAR（預設空白 ''），DATE → DATE（預設 NULL），DECIMAL → NUMERIC、INTEGER/SMALLINT（預設 0）
 */

// [序號, 欄位, 中文名稱, 型別, 代碼說明]
const LEDGER_FIELDS = [
  [1, 'ipolicy1', '保單號碼1', 'CHAR(20)'],
  [2, 'ipolicy2', '保單號碼2', 'CHAR(20)'],
  [3, 'iendorse', '批單號碼', 'CHAR(20)'],
  [4, 'icard', '保險證號', 'CHAR(20)'],
  [5, 'dplyend', '出單日', 'DATE'],
  [6, 'ftype', '類別型態', 'CHAR(1)', { P: '保單', E: '批加', M: '經紀人變更', N: '經辦人變更', 1: '退保', 2: '抵繳', 3: '改繳', 4: '復效', 5: '註銷', 6: '退票' }],
  [7, 'isub', '出單公司', 'CHAR(2)'],
  [8, 'itakeover', '支付公司', 'CHAR(2)'],
  [10, 'nassured', '保戶名稱', 'CHAR(120)'],
  [11, 'ibroker', '經紀人', 'CHAR(10)'],
  [12, 'icashier', '收費員', 'CHAR(10)'],
  [13, 'mprem', '保費金額', 'DECIMAL(17,4)'],
  [14, 'mdiscount', '折讓金額', 'DECIMAL(17,4)'],
  [15, 'icur', '幣別', 'CHAR(2)'],
  [16, 'aassured', '保戶通訊地址', 'CHAR(50)'],
  [17, 'aassured_a', '保戶戶籍地址', 'CHAR(50)'],
  [18, 'dbegin', '承保始期', 'DATE'],
  [19, 'dend', '承保終期', 'DATE'],
  [20, 'ipay', '收費單/退撥單號', 'CHAR(12)'],
  [21, 'dpay', '收費日期', 'DATE'],
  [22, 'fcommit', '佣金別', 'CHAR(2)', { N: '一般', 1: '大宗' }],
  [23, 'ireplace', '抵繳單號', 'CHAR(20)'],
  [24, 'eprocess', '說明', 'CHAR(60)'],
  [25, 'frcvpay', '收支註記', 'CHAR(1)', { N: '未收費', S: '收費中', P: '已收費', X: '註銷', F: '退保審過' }],
  [26, 'dcancel', '註銷擬辦日', 'DATE'],
  [27, 'idoc_seq', '函證批號', 'CHAR(12)'],
  [28, 'idoc', '函證編號', 'CHAR(12)'],
  [29, 'fpay_cond', '付款狀況', 'CHAR(1)', { 1: '現金', 2: '開票', 3: '匯款' }],
  [30, 'iaccount', '付款帳號', 'CHAR(14)'],
  [31, 'iperiod', '保期', 'CHAR(3)'],
  [32, 'ipd_type', '保期別', 'CHAR(1)'],
  [33, 'ireceived', '部份收費累計次數', 'INTEGER'],
  [34, 'mpartsum', '部份收費累計金額', 'DECIMAL(17,4)'],
  [35, 'pcurrency', '幣別匯率', 'DECIMAL(11,4)'],
  [36, 'iofficer', '經辦人', 'CHAR(10)'],
  [37, 'insure_type', '險別', 'CHAR(2)', { C: '汽車險', F: '火險', M: '水險', O: '其他險' }],
  [38, 'ibig_resource', '大客戶代碼', 'CHAR(4)'],
  [39, 'dacc', '立帳日期', 'DATE'],
  [40, 'puredplyend', '原始出單日', 'DATE'],
  [41, 'mprem_nt', '台幣應收保費', 'DECIMAL(17,0)'],
  [42, 'mcompensation_nt', '代收補償基金', 'DECIMAL(17,0)'],
  [43, 'iacc', '立帳製票號碼', 'CHAR(12)'],
  [44, 'ibatch_no', '批號(大保單用)', 'SMALLINT'],
  [45, 'mdiscount_nt', '台幣折讓金額', 'DECIMAL(17,0)'],
  [46, 'sys_source', '系統來源代號', 'CHAR(10)'],
  [47, 'ibank', '匯款銀行代號', 'CHAR(8)'],
  [48, 'irelative', '車險關連保單號', 'CHAR(20)'],
].map(([seq, name, label, type, codes]) => ({ seq, name, label, type, codes: codes || null }));

function colSql(f) {
  let m;
  if ((m = f.type.match(/^CHAR\((\d+)\)$/))) return `${f.name} VARCHAR(${m[1]}) NOT NULL DEFAULT ''`;
  if ((m = f.type.match(/^DECIMAL\((\d+),(\d+)\)$/))) return `${f.name} NUMERIC(${m[1]},${m[2]}) NOT NULL DEFAULT 0`;
  if (f.type === 'INTEGER' || f.type === 'SMALLINT') return `${f.name} ${f.type} NOT NULL DEFAULT 0`;
  if (f.type === 'DATE') return `${f.name} DATE`;
  throw new Error('unknown type ' + f.type);
}

const LEDGER_SCHEMA = `
-- ═════════════ 保批單帳款檔 ═════════════
CREATE TABLE IF NOT EXISTS ao_plyedr_prem (
  id          BIGSERIAL PRIMARY KEY,
${LEDGER_FIELDS.map((f) => `  ${colSql(f)},  -- ${f.seq} ${f.label}`).join('\n')}
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 舊版（v4 只有 1~32 欄）補欄位，可重複執行
${LEDGER_FIELDS.map((f) => `ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS ${colSql(f)};`).join('\n')}

-- 索引鍵（依規格）
DROP INDEX IF EXISTS ux_plyedr_prem_key;
DROP INDEX IF EXISTS idx_plyedr_prem_dplyend;
CREATE UNIQUE INDEX IF NOT EXISTS ao_plyedr_ix_1 ON ao_plyedr_prem (ipolicy1, ipolicy2, iendorse);
CREATE INDEX IF NOT EXISTS ao_plyedr_ix_2 ON ao_plyedr_prem (iendorse);
CREATE INDEX IF NOT EXISTS ao_plyedr_ix_3 ON ao_plyedr_prem (icard);
CREATE INDEX IF NOT EXISTS ao_plyedr_ix_4 ON ao_plyedr_prem (icashier);
CREATE INDEX IF NOT EXISTS ao_plyedr_prem_x1 ON ao_plyedr_prem (dplyend, ftype, ipolicy1, ipolicy2, iendorse);
CREATE INDEX IF NOT EXISTS ao_plyedr_prem_x2 ON ao_plyedr_prem (dpay, ftype, frcvpay, ipolicy1, ipolicy2, iendorse);

-- 補齊 v4 已出單資料的新寫入項目（只補空的，可重複執行）
UPDATE ao_plyedr_prem a
   SET insure_type = 'PF', puredplyend = a.dplyend, mprem_nt = round(a.mprem),
       nassured = COALESCE(LEFT(q.insured->>'name', 120), '')
  FROM quotes q
 WHERE q.policy_no = a.ipolicy1 AND a.ftype = 'P' AND a.insure_type = '';

-- 保單號碼每日流水號（PF + 民國年月日 + 4 碼）
CREATE TABLE IF NOT EXISTS policy_seq (
  day  DATE PRIMARY KEY,
  last INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_quotes_policy_no ON quotes (policy_no) WHERE policy_no IS NOT NULL;
`;

/** 西元 'YYYY-MM-DD' → 民國 'YYYMMDD'（例 2026-11-16 → 1151116） */
function rocCompact(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${Number(y) - 1911}${m}${d}`;
}

const policyNoOf = (day, n) => `PF${rocCompact(day)}${String(n).padStart(4, '0')}`;

/**
 * 出單時寫入帳款檔的內容（未列欄位一律留預設空白）
 * @param q        報價單（quotes 列）
 * @param policyNo 保單號碼
 * @param day      出單日 'YYYY-MM-DD'
 * @param zips     Map<zip, {county, district}>
 */
function buildPolicyLedger(q, policyNo, day, zips) {
  const z = zips.get(q.mail_zip) || {};
  const addr = `${q.mail_zip || ''}${z.county || ''}${z.district || ''}${q.mail_addr || ''}`.slice(0, 50);
  return {
    ipolicy1: policyNo,
    dplyend: day,
    ftype: 'P',
    isub: '00',
    mprem: Number(q.total_premium || 0),
    icur: 'NT',
    aassured: addr,
    dbegin: q.period_start ? String(q.period_start).slice(0, 10) : null,
    dend: q.period_end ? String(q.period_end).slice(0, 10) : null,
    fcommit: 'N',
    frcvpay: 'N',
    nassured: String(q.insured?.name || '').slice(0, 120), // 保戶名稱 = 被保險人姓名
    insure_type: 'PF',                                   // 險別
    puredplyend: day,                                    // 原始出單日 = 出單日
    mprem_nt: Math.round(Number(q.total_premium || 0)),  // 台幣應收保費 = mprem
  };
}

module.exports = { LEDGER_FIELDS, LEDGER_SCHEMA, rocCompact, policyNoOf, buildPolicyLedger };
