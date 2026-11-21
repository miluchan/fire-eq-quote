// 資料表定義（可重複執行）。db/schema.sql 由此產生：npm run db:sql
module.exports = `
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
` + require('./ledger').LEDGER_SCHEMA + require('./voucher').VOUCHER_SCHEMA;
