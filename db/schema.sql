
-- 住宅火災及地震基本保險 報價系統 — Neon PostgreSQL schema
-- 可重複執行（IF NOT EXISTS）

-- 郵遞區號 / 造價表地區別
CREATE TABLE IF NOT EXISTS zip_codes (
  zip          VARCHAR(3) PRIMARY KEY,
  county       VARCHAR(10) NOT NULL,
  district     VARCHAR(10) NOT NULL,
  cost_region  SMALLINT NOT NULL CHECK (cost_region BETWEEN 1 AND 5)
);

-- 臺灣地區住宅類建築造價參考表（每坪單價，元）
CREATE TABLE IF NOT EXISTS building_costs (
  version        VARCHAR(12) NOT NULL,          -- 例：114.01.01
  floor_min      SMALLINT NOT NULL,
  floor_max      SMALLINT NOT NULL,
  cost_region    SMALLINT NOT NULL CHECK (cost_region BETWEEN 1 AND 5),
  price_per_ping INTEGER NOT NULL,
  PRIMARY KEY (version, floor_min, cost_region)
);

-- 建築物構造（外牆）
CREATE TABLE IF NOT EXISTS structure_codes (
  code          VARCHAR(2) PRIMARY KEY,
  name          VARCHAR(20) NOT NULL,
  cost_factor   NUMERIC(5,3),        -- 造價表單價乘數（鋼骨 1.16）
  flat_price    INTEGER,             -- 固定每坪單價（磚木石金屬 34,000）
  default_grade VARCHAR(1) NOT NULL  -- 建議建築等級
);

-- 屋頂構造
CREATE TABLE IF NOT EXISTS roof_codes (
  code        VARCHAR(2) PRIMARY KEY,
  name        VARCHAR(20) NOT NULL,
  grade_shift SMALLINT NOT NULL DEFAULT 0
);

-- 建築等級 + 住宅火險費率（每千元）
CREATE TABLE IF NOT EXISTS building_grades (
  code      VARCHAR(1) PRIMARY KEY,
  name      VARCHAR(10) NOT NULL,
  fire_rate NUMERIC(6,4) NOT NULL
);

-- 短期費率（product: FIRE / EQ）
CREATE TABLE IF NOT EXISTS short_rates (
  product VARCHAR(4) NOT NULL,
  months  SMALLINT NOT NULL,
  pct     NUMERIC(5,2) NOT NULL,
  PRIMARY KEY (product, months)
);

-- 參數設定
CREATE TABLE IF NOT EXISTS settings (
  key   VARCHAR(40) PRIMARY KEY,
  value TEXT NOT NULL
);

-- 銀行代號（抵押權人）
CREATE TABLE IF NOT EXISTS banks (
  code VARCHAR(3) PRIMARY KEY,
  name VARCHAR(40) NOT NULL
);

-- 國籍
CREATE TABLE IF NOT EXISTS nationalities (
  code VARCHAR(3) PRIMARY KEY,
  name VARCHAR(20) NOT NULL
);

-- 報價 / 要保書
CREATE TABLE IF NOT EXISTS quotes (
  id               SERIAL PRIMARY KEY,
  quote_no         VARCHAR(20) UNIQUE NOT NULL,     -- 要保號碼
  prev_quote_no    VARCHAR(20),                      -- 前期要保號碼（續保）
  status           VARCHAR(10) NOT NULL DEFAULT '報價',

  -- 承保內容
  location_zip     VARCHAR(3) REFERENCES zip_codes(zip),
  total_floors     SMALLINT,
  area_ping        NUMERIC(10,2),
  build_year       SMALLINT,                         -- 民國年
  structure_code   VARCHAR(2),
  roof_code        VARCHAR(2),
  grade_code       VARCHAR(1),
  decoration_per_ping INTEGER DEFAULT 0,

  -- 保額（元）
  building_sum     BIGINT DEFAULT 0,                 -- 不動產
  movable_auto_sum BIGINT DEFAULT 0,                 -- 自動附加動產
  movable_add_sum  BIGINT DEFAULT 0,                 -- 加保動產
  eq_sum           BIGINT DEFAULT 0,                 -- 基本地震

  -- 保費（元）
  fire_premium     INTEGER DEFAULT 0,
  eq_premium       INTEGER DEFAULT 0,
  total_premium    INTEGER DEFAULT 0,
  calc_detail      JSONB,                            -- 計算明細（費率、短期%、造價版次）

  -- 要保書（被保險人 / 要保人 / 地址 / 期間 / 抵押權人）
  insured          JSONB,
  applicant        JSONB,
  property_zip     VARCHAR(3),
  property_addr    VARCHAR(120),
  mail_zip         VARCHAR(3),
  mail_addr        VARCHAR(120),
  period_start     DATE,
  period_end       DATE,
  period_months    SMALLINT,
  mortgagee_bank   VARCHAR(3),
  mortgagee_name   VARCHAR(60),

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quotes_insured_id ON quotes ((insured->>'id_no'));
CREATE INDEX IF NOT EXISTS idx_quotes_created ON quotes (created_at DESC);

-- 要保號碼流水號（每日）
CREATE TABLE IF NOT EXISTS quote_seq (
  day  DATE PRIMARY KEY,
  last INTEGER NOT NULL
);
-- ═════════════ v3：居家綜合保險 ═════════════
-- 投保方案：財物損害保費 = prop_base_fee + 保額 × prop_rate(‰)
CREATE TABLE IF NOT EXISTS plans (
  code          VARCHAR(4) PRIMARY KEY,
  name          VARCHAR(40) NOT NULL,
  kind          VARCHAR(6) NOT NULL CHECK (kind IN ('FIRE','HOME')),
  prop_label    VARCHAR(60),
  prop_base_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  prop_rate     NUMERIC(8,4) NOT NULL DEFAULT 0,
  sort          SMALLINT NOT NULL DEFAULT 0,
  active        BOOLEAN NOT NULL DEFAULT true
);

-- 險種（第三人責任、附加險）
CREATE TABLE IF NOT EXISTS coverages (
  code       VARCHAR(6) PRIMARY KEY,
  name       VARCHAR(40) NOT NULL,
  sum_label  VARCHAR(60) NOT NULL DEFAULT '',
  calc       VARCHAR(10) NOT NULL CHECK (calc IN ('TABLE','RATE_PROP')),
  required   BOOLEAN NOT NULL DEFAULT false,
  default_on BOOLEAN NOT NULL DEFAULT false,
  sort       SMALLINT NOT NULL DEFAULT 0,
  active     BOOLEAN NOT NULL DEFAULT true
);

-- 險種下拉選項（單位：萬元）
CREATE TABLE IF NOT EXISTS coverage_options (
  coverage_code VARCHAR(6) NOT NULL REFERENCES coverages(code),
  value         VARCHAR(20) NOT NULL,
  is_default    BOOLEAN NOT NULL DEFAULT false,
  sort          SMALLINT NOT NULL DEFAULT 0,
  PRIMARY KEY (coverage_code, value)
);

-- 查表保費（方案 × 險種 × 選項）；estimated = 依比例推估，待公司費率表確認
CREATE TABLE IF NOT EXISTS coverage_premiums (
  plan_code     VARCHAR(4) NOT NULL REFERENCES plans(code),
  coverage_code VARCHAR(6) NOT NULL,
  value         VARCHAR(20) NOT NULL,
  premium       NUMERIC(10,2) NOT NULL,
  estimated     BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (plan_code, coverage_code, value),
  FOREIGN KEY (coverage_code, value) REFERENCES coverage_options(coverage_code, value)
);

-- 依保額計費之險種費率（‰），例：綠能升級
CREATE TABLE IF NOT EXISTS coverage_rates (
  plan_code     VARCHAR(4) NOT NULL REFERENCES plans(code),
  coverage_code VARCHAR(6) NOT NULL REFERENCES coverages(code),
  rate          NUMERIC(8,4) NOT NULL,
  PRIMARY KEY (plan_code, coverage_code)
);

-- 報價單新增欄位（可重複執行）
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS plan_code    VARCHAR(4) NOT NULL DEFAULT 'HF';
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS status1      VARCHAR(6) NOT NULL DEFAULT '報價中';  -- 報價中/已要保/已出單
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS status2      VARCHAR(6) NOT NULL DEFAULT '未繳費';  -- 未繳費/已繳費/已銷帳
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS prop_sum     BIGINT DEFAULT 0;        -- 財物損害保額（元）
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS eq_already   BOOLEAN NOT NULL DEFAULT false; -- 已投保住宅地震險
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS coverages    JSONB;                   -- 勾選險種與選項
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS lines        JSONB;                   -- 試算結果明細
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS home_premium INTEGER DEFAULT 0;       -- 居家保費
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;             -- 確認要保時間
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS issued_at    TIMESTAMPTZ;             -- 出單時間（預留）
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS policy_no    VARCHAR(20);             -- 保單號碼（預留）
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS paid_at      TIMESTAMPTZ;             -- 繳費時間（預留）
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS deleted_at   TIMESTAMPTZ;             -- 軟刪除
CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes (status1, status2) WHERE deleted_at IS NULL;

-- ═════════════ 保批單帳款檔 ═════════════
CREATE TABLE IF NOT EXISTS ao_plyedr_prem (
  id          BIGSERIAL PRIMARY KEY,
  ipolicy1 VARCHAR(20) NOT NULL DEFAULT '',  -- 1 保單號碼1
  ipolicy2 VARCHAR(20) NOT NULL DEFAULT '',  -- 2 保單號碼2
  iendorse VARCHAR(20) NOT NULL DEFAULT '',  -- 3 批單號碼
  icard VARCHAR(20) NOT NULL DEFAULT '',  -- 4 保險證號
  dplyend DATE,  -- 5 出單日
  ftype VARCHAR(1) NOT NULL DEFAULT '',  -- 6 類別型態
  isub VARCHAR(2) NOT NULL DEFAULT '',  -- 7 出單公司
  itakeover VARCHAR(2) NOT NULL DEFAULT '',  -- 8 支付公司
  nassured VARCHAR(120) NOT NULL DEFAULT '',  -- 10 保戶名稱
  ibroker VARCHAR(10) NOT NULL DEFAULT '',  -- 11 經紀人
  icashier VARCHAR(10) NOT NULL DEFAULT '',  -- 12 收費員
  mprem NUMERIC(17,4) NOT NULL DEFAULT 0,  -- 13 保費金額
  mdiscount NUMERIC(17,4) NOT NULL DEFAULT 0,  -- 14 折讓金額
  icur VARCHAR(2) NOT NULL DEFAULT '',  -- 15 幣別
  aassured VARCHAR(50) NOT NULL DEFAULT '',  -- 16 保戶通訊地址
  aassured_a VARCHAR(50) NOT NULL DEFAULT '',  -- 17 保戶戶籍地址
  dbegin DATE,  -- 18 承保始期
  dend DATE,  -- 19 承保終期
  ipay VARCHAR(12) NOT NULL DEFAULT '',  -- 20 收費單/退撥單號
  dpay DATE,  -- 21 收費日期
  fcommit VARCHAR(2) NOT NULL DEFAULT '',  -- 22 佣金別
  ireplace VARCHAR(20) NOT NULL DEFAULT '',  -- 23 抵繳單號
  eprocess VARCHAR(60) NOT NULL DEFAULT '',  -- 24 說明
  frcvpay VARCHAR(1) NOT NULL DEFAULT '',  -- 25 收支註記
  dcancel DATE,  -- 26 註銷擬辦日
  idoc_seq VARCHAR(12) NOT NULL DEFAULT '',  -- 27 函證批號
  idoc VARCHAR(12) NOT NULL DEFAULT '',  -- 28 函證編號
  fpay_cond VARCHAR(1) NOT NULL DEFAULT '',  -- 29 付款狀況
  iaccount VARCHAR(14) NOT NULL DEFAULT '',  -- 30 付款帳號
  iperiod VARCHAR(3) NOT NULL DEFAULT '',  -- 31 保期
  ipd_type VARCHAR(1) NOT NULL DEFAULT '',  -- 32 保期別
  ireceived INTEGER NOT NULL DEFAULT 0,  -- 33 部份收費累計次數
  mpartsum NUMERIC(17,4) NOT NULL DEFAULT 0,  -- 34 部份收費累計金額
  pcurrency NUMERIC(11,4) NOT NULL DEFAULT 0,  -- 35 幣別匯率
  iofficer VARCHAR(10) NOT NULL DEFAULT '',  -- 36 經辦人
  insure_type VARCHAR(2) NOT NULL DEFAULT '',  -- 37 險別
  ibig_resource VARCHAR(4) NOT NULL DEFAULT '',  -- 38 大客戶代碼
  dacc DATE,  -- 39 立帳日期
  puredplyend DATE,  -- 40 原始出單日
  mprem_nt NUMERIC(17,0) NOT NULL DEFAULT 0,  -- 41 台幣應收保費
  mcompensation_nt NUMERIC(17,0) NOT NULL DEFAULT 0,  -- 42 代收補償基金
  iacc VARCHAR(12) NOT NULL DEFAULT '',  -- 43 立帳製票號碼
  ibatch_no SMALLINT NOT NULL DEFAULT 0,  -- 44 批號(大保單用)
  mdiscount_nt NUMERIC(17,0) NOT NULL DEFAULT 0,  -- 45 台幣折讓金額
  sys_source VARCHAR(10) NOT NULL DEFAULT '',  -- 46 系統來源代號
  ibank VARCHAR(8) NOT NULL DEFAULT '',  -- 47 匯款銀行代號
  irelative VARCHAR(20) NOT NULL DEFAULT '',  -- 48 車險關連保單號
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 舊版（v4 只有 1~32 欄）補欄位，可重複執行
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS ipolicy1 VARCHAR(20) NOT NULL DEFAULT '';
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS ipolicy2 VARCHAR(20) NOT NULL DEFAULT '';
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS iendorse VARCHAR(20) NOT NULL DEFAULT '';
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS icard VARCHAR(20) NOT NULL DEFAULT '';
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS dplyend DATE;
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS ftype VARCHAR(1) NOT NULL DEFAULT '';
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS isub VARCHAR(2) NOT NULL DEFAULT '';
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS itakeover VARCHAR(2) NOT NULL DEFAULT '';
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS nassured VARCHAR(120) NOT NULL DEFAULT '';
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS ibroker VARCHAR(10) NOT NULL DEFAULT '';
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS icashier VARCHAR(10) NOT NULL DEFAULT '';
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS mprem NUMERIC(17,4) NOT NULL DEFAULT 0;
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS mdiscount NUMERIC(17,4) NOT NULL DEFAULT 0;
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS icur VARCHAR(2) NOT NULL DEFAULT '';
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS aassured VARCHAR(50) NOT NULL DEFAULT '';
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS aassured_a VARCHAR(50) NOT NULL DEFAULT '';
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS dbegin DATE;
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS dend DATE;
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS ipay VARCHAR(12) NOT NULL DEFAULT '';
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS dpay DATE;
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS fcommit VARCHAR(2) NOT NULL DEFAULT '';
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS ireplace VARCHAR(20) NOT NULL DEFAULT '';
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS eprocess VARCHAR(60) NOT NULL DEFAULT '';
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS frcvpay VARCHAR(1) NOT NULL DEFAULT '';
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS dcancel DATE;
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS idoc_seq VARCHAR(12) NOT NULL DEFAULT '';
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS idoc VARCHAR(12) NOT NULL DEFAULT '';
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS fpay_cond VARCHAR(1) NOT NULL DEFAULT '';
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS iaccount VARCHAR(14) NOT NULL DEFAULT '';
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS iperiod VARCHAR(3) NOT NULL DEFAULT '';
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS ipd_type VARCHAR(1) NOT NULL DEFAULT '';
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS ireceived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS mpartsum NUMERIC(17,4) NOT NULL DEFAULT 0;
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS pcurrency NUMERIC(11,4) NOT NULL DEFAULT 0;
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS iofficer VARCHAR(10) NOT NULL DEFAULT '';
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS insure_type VARCHAR(2) NOT NULL DEFAULT '';
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS ibig_resource VARCHAR(4) NOT NULL DEFAULT '';
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS dacc DATE;
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS puredplyend DATE;
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS mprem_nt NUMERIC(17,0) NOT NULL DEFAULT 0;
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS mcompensation_nt NUMERIC(17,0) NOT NULL DEFAULT 0;
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS iacc VARCHAR(12) NOT NULL DEFAULT '';
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS ibatch_no SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS mdiscount_nt NUMERIC(17,0) NOT NULL DEFAULT 0;
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS sys_source VARCHAR(10) NOT NULL DEFAULT '';
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS ibank VARCHAR(8) NOT NULL DEFAULT '';
ALTER TABLE ao_plyedr_prem ADD COLUMN IF NOT EXISTS irelative VARCHAR(20) NOT NULL DEFAULT '';

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

-- 保單號碼流水號（依字軌分開：PF 住火、CC 汽車強制、AC 汽車任意…，每日從 0001 起）
CREATE TABLE IF NOT EXISTS policy_no_seq (
  prefix VARCHAR(4) NOT NULL,
  day    DATE NOT NULL,
  last   INTEGER NOT NULL,
  PRIMARY KEY (prefix, day)
);
-- 舊版 PF 流水號搬入新表（可重複執行，取較大值）
INSERT INTO policy_no_seq (prefix, day, last)
SELECT 'PF', day, last FROM policy_seq
ON CONFLICT (prefix, day) DO UPDATE SET last = GREATEST(policy_no_seq.last, EXCLUDED.last);

-- 外部系統出單對照（同一來源單號＋保單別只出一次，重送時回傳原保單號）
CREATE TABLE IF NOT EXISTS ext_policy_issue (
  source     VARCHAR(20) NOT NULL,   -- 例：car-online
  ext_ref    VARCHAR(40) NOT NULL,   -- 來源系統報價單號
  kind       VARCHAR(4)  NOT NULL,   -- 保單字軌：CC / AC
  ipolicy1   VARCHAR(20) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source, ext_ref, kind)
);
