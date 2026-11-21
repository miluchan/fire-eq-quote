/**
 * 傳票開立：由保批單帳款檔 ao_plyedr_prem 批次產生會計傳票
 *
 * 事件（每天、每種事件各開一張傳票；同一筆帳款同一事件只會開一次）
 *   ISSUE   出單立帳（依出單日 dplyend）  轉帳傳票
 *           借 應收保費（逐張保單）
 *           貸 保費收入（依保單字軌對應科目，彙總）
 *           貸 應付營業稅（保費內含稅：保費 × 稅率 ÷ (1+稅率)，彙總）
 *   RECEIPT 收費沖銷（frcvpay = P，依繳費日 dpay）  收入傳票
 *           借 銀行存款（彙總）
 *           貸 應收保費（逐張保單）
 *
 * 科目代碼、保單字軌對應的收入科目與營業稅率都放在資料表，可直接在 DB 修改
 */

const VOUCHER_SCHEMA = `
-- ═════════ 傳票 ═════════
-- 會計科目（範例科目表，可直接修改名稱或新增）
CREATE TABLE IF NOT EXISTS gl_accounts (
  code     VARCHAR(10) PRIMARY KEY,
  name     VARCHAR(60) NOT NULL,
  category VARCHAR(4)  NOT NULL,             -- 資產 / 負債 / 權益 / 收入 / 費用
  dc       CHAR(1)     NOT NULL,             -- 正常餘額方向 D 借 / C 貸
  active   BOOLEAN     NOT NULL DEFAULT true
);

-- 共用科目對照（應收保費、銀行存款、應付營業稅）
CREATE TABLE IF NOT EXISTS gl_account_map (
  map_key      VARCHAR(20) PRIMARY KEY,      -- AR / BANK / TAX
  account_code VARCHAR(10) NOT NULL REFERENCES gl_accounts(code),
  note         VARCHAR(60) NOT NULL DEFAULT ''
);

-- 保單字軌 → 保費收入科目、營業稅率（新增險種時加一筆即可）
CREATE TABLE IF NOT EXISTS gl_premium_map (
  prefix       VARCHAR(4)  PRIMARY KEY,      -- 保單號碼字軌：PF / CC / AC …
  label        VARCHAR(30) NOT NULL,
  revenue_code VARCHAR(10) NOT NULL REFERENCES gl_accounts(code),
  tax_rate     NUMERIC(5,4) NOT NULL DEFAULT 0.05   -- 0.05 = 5%；強制汽車責任保險 0（免列營業稅銷售額）
);

-- 傳票主檔
CREATE TABLE IF NOT EXISTS gl_voucher (
  voucher_no VARCHAR(16) PRIMARY KEY,        -- V + 民國年月日 + 4 碼
  vdate      DATE        NOT NULL,           -- 傳票日期
  vtype      VARCHAR(10) NOT NULL,           -- ISSUE 出單立帳 / RECEIPT 收費沖銷
  vkind      VARCHAR(6)  NOT NULL,           -- 轉帳傳票 / 收入傳票
  summary    VARCHAR(100) NOT NULL DEFAULT '',
  total_dr   NUMERIC(14,0) NOT NULL,
  total_cr   NUMERIC(14,0) NOT NULL,
  doc_count  INTEGER     NOT NULL DEFAULT 0, -- 來源帳款筆數
  status     VARCHAR(4)  NOT NULL DEFAULT '已開立',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (total_dr = total_cr)
);
CREATE INDEX IF NOT EXISTS gl_voucher_x1 ON gl_voucher (vdate, vtype);

-- 傳票明細
CREATE TABLE IF NOT EXISTS gl_voucher_line (
  voucher_no   VARCHAR(16) NOT NULL REFERENCES gl_voucher(voucher_no),
  line_no      INTEGER     NOT NULL,
  account_code VARCHAR(10) NOT NULL REFERENCES gl_accounts(code),
  dr           NUMERIC(14,0) NOT NULL DEFAULT 0,
  cr           NUMERIC(14,0) NOT NULL DEFAULT 0,
  ipolicy1     VARCHAR(20) NOT NULL DEFAULT '',  -- 子帳：保單號碼（彙總列空白）
  memo         VARCHAR(100) NOT NULL DEFAULT '',
  PRIMARY KEY (voucher_no, line_no)
);
CREATE INDEX IF NOT EXISTS gl_voucher_line_x1 ON gl_voucher_line (ipolicy1) WHERE ipolicy1 <> '';
CREATE INDEX IF NOT EXISTS gl_voucher_line_x2 ON gl_voucher_line (account_code);

-- 帳款 → 傳票對照（同一筆帳款同一事件只開一次）
CREATE TABLE IF NOT EXISTS gl_voucher_src (
  ledger_id  BIGINT      NOT NULL,
  vtype      VARCHAR(10) NOT NULL,
  voucher_no VARCHAR(16) NOT NULL REFERENCES gl_voucher(voucher_no),
  PRIMARY KEY (ledger_id, vtype)
);

-- 範例科目（已存在不覆蓋，保留在 DB 改過的內容）
INSERT INTO gl_accounts (code, name, category, dc) VALUES
  ('1113', '銀行存款',                     '資產', 'D'),
  ('1151', '應收保費',                     '資產', 'D'),
  ('2131', '應付營業稅',                   '負債', 'C'),
  ('4111', '保費收入－火災保險',           '收入', 'C'),
  ('4121', '保費收入－強制汽車責任保險',   '收入', 'C'),
  ('4122', '保費收入－任意汽車保險',       '收入', 'C')
ON CONFLICT (code) DO NOTHING;

INSERT INTO gl_account_map (map_key, account_code, note) VALUES
  ('AR',   '1151', '應收保費'),
  ('BANK', '1113', '收費入帳銀行'),
  ('TAX',  '2131', '保費內含營業稅')
ON CONFLICT (map_key) DO NOTHING;

INSERT INTO gl_premium_map (prefix, label, revenue_code, tax_rate) VALUES
  ('PF', '住宅火災保險',         '4111', 0.05),
  ('CC', '強制汽車責任保險',     '4121', 0),
  ('AC', '任意汽車保險',         '4122', 0.05)
ON CONFLICT (prefix) DO NOTHING;
`;

/** 記憶體模式（本機無 DB）用的預設設定，內容同上方種子資料 */
const DEFAULT_GL = {
  accounts: [
    { code: '1113', name: '銀行存款', category: '資產', dc: 'D' },
    { code: '1151', name: '應收保費', category: '資產', dc: 'D' },
    { code: '2131', name: '應付營業稅', category: '負債', dc: 'C' },
    { code: '4111', name: '保費收入－火災保險', category: '收入', dc: 'C' },
    { code: '4121', name: '保費收入－強制汽車責任保險', category: '收入', dc: 'C' },
    { code: '4122', name: '保費收入－任意汽車保險', category: '收入', dc: 'C' },
  ],
  map: { AR: '1151', BANK: '1113', TAX: '2131' },
  premium: {
    PF: { label: '住宅火災保險', revenue_code: '4111', tax_rate: 0.05 },
    CC: { label: '強制汽車責任保險', revenue_code: '4121', tax_rate: 0 },
    AC: { label: '任意汽車保險', revenue_code: '4122', tax_rate: 0.05 },
  },
};

const VTYPES = {
  ISSUE: { kind: '轉帳傳票', label: '出單立帳' },
  RECEIPT: { kind: '收入傳票', label: '收費沖銷' },
};

const prefixOf = (policyNo) => (String(policyNo).match(/^[A-Z]+/) || [''])[0];
const roc = (iso) => { const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${Number(y) - 1911}${m}${d}`; };
const amountOf = (row) => Math.round(Number(row.mprem_nt) || Number(row.mprem) || 0);

/** 保費內含營業稅：稅額 = 保費 × 稅率 ÷ (1 + 稅率)，四捨五入到元 */
function splitTax(premium, rate) {
  const r = Number(rate) || 0;
  const tax = r > 0 ? Math.round((premium * r) / (1 + r)) : 0;
  return { tax, net: premium - tax };
}

/**
 * 由待開立的帳款組出傳票（純計算，不寫 DB）
 * issueRows：尚未開立「出單立帳」的帳款；receiptRows：尚未開立「收費沖銷」的帳款
 * 回傳 { vouchers: [{ vtype, vkind, vdate, summary, lines, ledgerIds, totalDr, totalCr }], skipped: [{ ipolicy1, vtype, reason }] }
 */
function buildVouchers(issueRows, receiptRows, gl) {
  const skipped = [];
  const vouchers = [];
  const name = (code) => (gl.accounts.find((a) => a.code === code) || {}).name || code;

  const byDay = (rows, dateKey) => {
    const m = new Map();
    for (const r of rows) {
      const d = String(r[dateKey] || '').slice(0, 10);
      if (!m.has(d)) m.set(d, []);
      m.get(d).push(r);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  };
  const finish = (v) => {
    v.lines = v.lines.map((l, i) => ({ line_no: i + 1, ...l, account_name: name(l.account_code) }));
    v.totalDr = v.lines.reduce((s, l) => s + l.dr, 0);
    v.totalCr = v.lines.reduce((s, l) => s + l.cr, 0);
    if (v.totalDr !== v.totalCr) throw new Error(`傳票借貸不平衡（${v.vdate} ${v.vtype}）`);
    vouchers.push(v);
  };

  // 出單立帳
  for (const [day, rows] of byDay(issueRows, 'dplyend')) {
    const debits = [];
    const credits = new Map(); // 科目 → 金額
    const ids = [];
    for (const r of rows) {
      const amt = amountOf(r);
      const pm = gl.premium[prefixOf(r.ipolicy1)];
      if (!pm) { skipped.push({ ipolicy1: r.ipolicy1, vtype: 'ISSUE', reason: `保單字軌 ${prefixOf(r.ipolicy1) || '(無)'} 未設定收入科目（gl_premium_map）` }); continue; }
      if (amt <= 0) { skipped.push({ ipolicy1: r.ipolicy1, vtype: 'ISSUE', reason: '保費為 0' }); continue; }
      const { tax, net } = splitTax(amt, pm.tax_rate);
      debits.push({ account_code: gl.map.AR, dr: amt, cr: 0, ipolicy1: r.ipolicy1, memo: `${pm.label} ${r.nassured || ''}`.trim() });
      credits.set(pm.revenue_code, (credits.get(pm.revenue_code) || 0) + net);
      if (tax) credits.set(gl.map.TAX, (credits.get(gl.map.TAX) || 0) + tax);
      ids.push(r.id);
    }
    if (!ids.length) continue;
    const creditLines = [...credits.entries()]
      .sort(([a], [b]) => (a === gl.map.TAX) - (b === gl.map.TAX) || a.localeCompare(b))
      .map(([code, amt]) => ({ account_code: code, dr: 0, cr: amt, ipolicy1: '', memo: code === gl.map.TAX ? '保費內含營業稅' : '保費收入' }));
    finish({
      vtype: 'ISSUE', vkind: VTYPES.ISSUE.kind, vdate: day,
      summary: `${roc(day)} 出單立帳 ${ids.length} 筆`,
      lines: [...debits, ...creditLines], ledgerIds: ids,
    });
  }

  // 收費沖銷
  for (const [day, rows] of byDay(receiptRows, 'dpay')) {
    const credits = [];
    const ids = [];
    let total = 0;
    for (const r of rows) {
      const amt = amountOf(r);
      if (amt <= 0) { skipped.push({ ipolicy1: r.ipolicy1, vtype: 'RECEIPT', reason: '保費為 0' }); continue; }
      credits.push({ account_code: gl.map.AR, dr: 0, cr: amt, ipolicy1: r.ipolicy1, memo: `收費 ${r.nassured || ''}`.trim() });
      total += amt;
      ids.push(r.id);
    }
    if (!ids.length) continue;
    finish({
      vtype: 'RECEIPT', vkind: VTYPES.RECEIPT.kind, vdate: day,
      summary: `${roc(day)} 保費收款 ${ids.length} 筆`,
      lines: [{ account_code: gl.map.BANK, dr: total, cr: 0, ipolicy1: '', memo: '保費收款' }, ...credits],
      ledgerIds: ids,
    });
  }

  // 同一天先立帳再收款
  vouchers.sort((a, b) => a.vdate.localeCompare(b.vdate) || (a.vtype === 'ISSUE' ? -1 : 1));
  return { vouchers, skipped };
}

module.exports = { VOUCHER_SCHEMA, DEFAULT_GL, VTYPES, prefixOf, splitTax, buildVouchers };
