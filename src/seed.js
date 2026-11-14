// 由 src/refdata.js 產生種子資料 SQL；直接執行本檔會輸出 db/schema.sql + db/seed.sql
// 用法：node scripts/gen-seed.js
const fs = require('fs');
const path = require('path');
const R = require('./refdata');

const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const rows = (arr) => arr.map((r) => `(${r.map(q).join(', ')})`).join(',\n  ');

function buildSeedSql() {
  const out = [];
  out.push('-- 自動產生：node scripts/gen-seed.js（請勿手改，改 src/refdata.js 後重產）');
  out.push('BEGIN;');

  out.push(`INSERT INTO zip_codes (zip, county, district, cost_region) VALUES\n  ${rows(R.ZIPS.map((z) => [z.zip, z.county, z.district, z.cost_region]))}\nON CONFLICT (zip) DO UPDATE SET county=EXCLUDED.county, district=EXCLUDED.district, cost_region=EXCLUDED.cost_region;`);

  const bc = [];
  for (const [min, max, ...prices] of R.BUILDING_COSTS) {
    prices.forEach((p, i) => bc.push([R.BUILDING_COST_VERSION, min, max, i + 1, p]));
  }
  out.push(`INSERT INTO building_costs (version, floor_min, floor_max, cost_region, price_per_ping) VALUES\n  ${rows(bc)}\nON CONFLICT (version, floor_min, cost_region) DO UPDATE SET floor_max=EXCLUDED.floor_max, price_per_ping=EXCLUDED.price_per_ping;`);

  out.push(`INSERT INTO structure_codes (code, name, cost_factor, flat_price, default_grade) VALUES\n  ${rows(R.STRUCTURES.map((s) => [s.code, s.name, s.cost_factor, s.flat_price, s.default_grade]))}\nON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, cost_factor=EXCLUDED.cost_factor, flat_price=EXCLUDED.flat_price, default_grade=EXCLUDED.default_grade;`);

  out.push(`INSERT INTO roof_codes (code, name, grade_shift) VALUES\n  ${rows(R.ROOFS.map((s) => [s.code, s.name, s.grade_shift]))}\nON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, grade_shift=EXCLUDED.grade_shift;`);

  // 費率：只在不存在時寫入，避免覆蓋已調整成公司報備費率的資料
  out.push(`INSERT INTO building_grades (code, name, fire_rate) VALUES\n  ${rows(R.GRADES.map((g) => [g.code, g.name, g.fire_rate]))}\nON CONFLICT (code) DO NOTHING;`);

  const sr = [];
  for (const [prod, list] of Object.entries(R.SHORT_RATES)) list.forEach(([m, p]) => sr.push([prod, m, p]));
  out.push(`INSERT INTO short_rates (product, months, pct) VALUES\n  ${rows(sr)}\nON CONFLICT (product, months) DO UPDATE SET pct=EXCLUDED.pct;`);

  out.push(`INSERT INTO settings (key, value) VALUES\n  ${rows(Object.entries(R.SETTINGS).map(([k, v]) => [k, String(v)]))}\nON CONFLICT (key) DO NOTHING;`);

  out.push(`INSERT INTO banks (code, name) VALUES\n  ${rows(R.BANKS)}\nON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name;`);
  out.push(`INSERT INTO nationalities (code, name) VALUES\n  ${rows(R.NATIONALITIES)}\nON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name;`);

  out.push('COMMIT;');
  return out.join('\n\n') + '\n';
}

if (require.main === module) {
  const dir = path.join(__dirname, '..', 'db');
  fs.writeFileSync(path.join(dir, 'schema.sql'), require('./schema'));
  fs.writeFileSync(path.join(dir, 'seed.sql'), buildSeedSql());
  console.log('written db/schema.sql, db/seed.sql');
}

module.exports = { buildSeedSql };
