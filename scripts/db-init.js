// 建立資料表並寫入種子資料到 Neon
// 用法：DATABASE_URL=... npm run db:init
require('../src/env');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { buildSeedSql } = require('./gen-seed');

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('請先設定 DATABASE_URL（Neon 連線字串）');
    process.exit(1);
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
    console.log('✔ schema 建立完成');
    await client.query(buildSeedSql());
    console.log('✔ 種子資料寫入完成');
    const { rows } = await client.query('SELECT count(*)::int AS n FROM zip_codes');
    console.log(`  郵遞區號 ${rows[0].n} 筆`);
  } finally {
    await client.end();
  }
})().catch((e) => {
  console.error('✘ 初始化失敗：', e.message);
  process.exit(1);
});
